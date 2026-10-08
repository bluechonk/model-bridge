/**
 * MiniMax Code 渠道认证：OAuth 设备码 + PKCE 登录、凭据持久化、令牌续期。
 *
 * 实现依据：`docs/protocols/minimax/PROTOCOL.md`（§1 端点、§2 认证）。
 *
 * ## 本模块承载的渠道知识（每条都有规格依据）
 *
 * 1. **登录是 OAuth 设备码 + PKCE**（§2.3）：`POST {account}/oauth2/device/code`
 *    申请设备码 → 用户在浏览器授权 → `POST {account}/oauth2/token` 轮询换令牌。
 *    ⚠ 绝不从其它应用的本地文件读取登录态；授权链接是真实 URL。
 * 2. **轮询必须认两种「还在等」形态**（§2.3）：HTTP 200 + `{"status":"pending"}`
 *    （MiniMax 自有）与 非 200 + `{"error":"authorization_pending"}`（OAuth 标准）。
 *    源码注释明确：「只认标准形态会立刻抛错，用户来不及授权」。
 *    `slow_down` 两形态都处理，`intervalMs += 5000`。
 * 3. **`access_token` 不是 JWT**（§2.1）：`mmoat_` 前缀、60 字符、0 个点 ⇒
 *    `jwtExpMs` 对真实凭据恒返回 0，**必须**由 `expires_in` 自算 `expires_at`。
 * 4. **令牌响应硬校验**（§2.3）：`access_token` 非空、`refresh_token` 非空
 *    （缺失回退上一个）、`token_type.toLowerCase() === 'bearer'`、`expires_in`
 *    正数、**`scope` 必须含产品 scope（`agent.default`）**。
 * 5. 登录原语（`openBrowser` / `str` / `fetchWithTimeout` / `b64url` / `jwtExpMs`）与
 *    设备码轮询骨架（`pollDeviceCode`）**复用共享层** `@model-bridge/gateway`，不重写。
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";

import {
  credentialsPath,
  ensureDir,
  login as sharedLogin,
  loginFlow,
} from "@model-bridge/gateway";

/** OAuth 账号基址（设备码申请 / 令牌轮询 / 续期都在这里，§1）。 */
export const ACCOUNT_BASE_URL = "https://account.minimax.cn";

/** 业务 API 基址（模型目录 / 对话 / 签到 / 积分，§1）。 */
export const API_BASE_URL = "https://agent.minimax.cn";

/**
 * 登录默认基址（= 账号基址）。
 *
 * 共享 CLI 的 `login` 子命令会把它（或 `resolveBaseUrl()` 的结果）作为
 * `baseUrl` 传给 `login()`，故本值必须是登录端点所在域。
 */
export const DEFAULT_BASE_URL = ACCOUNT_BASE_URL;

/** 公开客户端 id（随客户端分发，非机密，§2.3）。 */
export const CLIENT_ID = "mcode-public";

/** 产品 scope（令牌响应必须含它，否则拒绝，§2.3）。 */
export const PRODUCT_SCOPE = "agent.default";

/** 设备码/续期的 audience（§2.3）。 */
export const AUDIENCE = "agent-backend";

/** 设备码轮询的 grant_type（§2.3）。 */
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** 设备码请求**缺省**轮询间隔（秒，服务端未下发 `interval` 时用，§2.3）。 */
export const DEFAULT_DEVICE_INTERVAL_SEC = 5;

/** `slow_down` 每次抬高的毫秒数（规格明确 5000，§2.3）。 */
export const SLOW_DOWN_STEP_MS = 5000;

const HTTP_TIMEOUT_MS = 30_000;
/** OAuth 请求超时（§1：OAuth 20s）。 */
const OAUTH_TIMEOUT_MS = 20_000;

/** 凭据里的令牌前缀（凭据 ref 形如 `MINIMAX_ACCESS_TOKEN`，§2.3）。 */
export const TOKEN_PREFIX = "mmoat_";
export const REFRESH_PREFIX = "mmort_";

const NOT_LOGGED_IN_MSG = "no credentials found; run `minimax login` first";

/** 磁盘上不存在可用凭据。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message: string = NOT_LOGGED_IN_MSG) {
    super(message);
  }
}

/** 取值收窄（复用共享层原语）。 */
const str = sharedLogin.str;

/**
 * 凭据（磁盘字段为 snake_case，见 §2.1；同时保留契约要求的 `uid` / `domain`）。
 */
export interface Credentials {
  /** 访问令牌（`mmoat_` 前缀，**非 JWT**）。 */
  readonly accessToken: string;
  /** 刷新令牌（`mmort_` 前缀）。 */
  readonly refreshToken: string;
  /** 令牌类型（恒 `'Bearer'`）。 */
  readonly tokenType: string;
  /** 到期时刻（**毫秒**）；未知为 null。 */
  readonly expiresAt: number | null;
  /** 授权范围（必须含 `agent.default`）。 */
  readonly scope: string;
  /** 账号标识（磁盘 `account_id`）—— 契约要求的稳定账号去重键。 */
  readonly uid: string;
  /** 昵称（磁盘 `nickname`）。 */
  readonly nickname: string;
  /** 本渠道单一域，无 domain 概念 → 恒空串（契约要求）。 */
  readonly domain: string;
  readonly obtainedAt: string;
}

export const EMPTY_CREDENTIALS: Credentials = {
  accessToken: "",
  refreshToken: "",
  tokenType: "Bearer",
  expiresAt: null,
  scope: PRODUCT_SCOPE,
  uid: "",
  nickname: "",
  domain: "",
  obtainedAt: "",
};

/**
 * 解析 `expires_at` 字段（§2.1：毫秒时间戳**字符串**；读取时 `> 1e12` 视为毫秒否则秒）。
 *
 * ⚠ 阈值是 **1e12**（不是共享层 `parseExpireTime` 的 1e11）—— 本渠道规格明确写死
 * 这条判据，故不直接复用共享层的秒/毫秒归一。无法解析返回 null（不编造）。
 */
export function parseExpiresAt(value: unknown): number | null {
  const text =
    typeof value === "number"
      ? String(Math.trunc(value))
      : typeof value === "string"
        ? value.trim()
        : "";
  if (!text || !/^\d+$/.test(text)) return null;
  const n = Number.parseInt(text, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? n : n * 1000;
}

/** 从 base URL 提取主机名（转发共享层原语）。 */
export function hostOf(baseUrl: string): string {
  return sharedLogin.hostOf(baseUrl);
}

/** 登录基址：显式参数 > 环境变量（测试/便携）> 默认账号基址；单域渠道无 realm。 */
export function resolveBaseUrl(_realm = "auto"): string {
  return process.env["MINIMAX_ACCOUNT_BASE_URL"] || DEFAULT_BASE_URL;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * PKCE 对（§2.3）：
 *   - `code_verifier = base64url(randomBytes(32))`
 *   - `code_challenge = base64url(sha256(verifier, 'ascii'))`
 *
 * 共享层提供 `b64url` 与 `sha256Hex`，但**没有**「sha256 裸字节再 base64url」的组合，
 * 故这里用 `node:crypto` 直接算（仍是零第三方依赖）。
 */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = sharedLogin.b64url(randomBytes(32));
  const challenge = sharedLogin.b64url(createHash("sha256").update(verifier, "ascii").digest());
  return { verifier, challenge };
}

// ── 凭据读取 / 持久化 ─────────────────────────────────────────────────────────

/** 从磁盘读取凭据（snake_case 字段；兼容驼峰历史字段）。 */
export function load(): Credentials {
  let raw: string;
  try {
    raw = readFileSync(credentialsPath(), "utf8");
  } catch {
    throw new NotLoggedInError();
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new NotLoggedInError(`凭据文件损坏（${credentialsPath()}），请重新登录`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new NotLoggedInError("凭据文件结构不对，请重新登录");
  }
  const rec = data as Record<string, unknown>;

  const accessToken = str(rec["access_token"]) || str(rec["accessToken"]);
  if (!accessToken) throw new NotLoggedInError();

  const uid = str(rec["account_id"]) || str(rec["accountId"]) || str(rec["uid"]);
  return {
    accessToken,
    refreshToken: str(rec["refresh_token"]) || str(rec["refreshToken"]),
    tokenType: str(rec["token_type"]) || str(rec["tokenType"]) || "Bearer",
    expiresAt: parseExpiresAt(rec["expires_at"] ?? rec["expiresAt"]),
    scope: str(rec["scope"]),
    uid,
    nickname: str(rec["nickname"]),
    domain: str(rec["domain"]),
    obtainedAt: str(rec["obtained_at"]) || str(rec["obtainedAt"]),
  };
}

/** 磁盘序列化（snake_case，字段名与 §2.1 一致）。 */
function toDisk(c: Credentials): string {
  const disk: Record<string, unknown> = {
    access_token: c.accessToken,
    refresh_token: c.refreshToken,
    token_type: c.tokenType || "Bearer",
    expires_at: c.expiresAt === null ? "" : String(c.expiresAt),
    scope: c.scope,
  };
  if (c.uid) disk["account_id"] = c.uid;
  if (c.nickname) disk["nickname"] = c.nickname;
  if (c.domain) disk["domain"] = c.domain;
  if (c.obtainedAt) disk["obtained_at"] = c.obtainedAt;
  return `${JSON.stringify(disk, null, 2)}\n`;
}

/** 以 0600 权限原子写入凭据（临时文件 + rename，崩溃不留下半截 JSON）。 */
export async function save(c: Credentials): Promise<void> {
  ensureDir();
  const path = credentialsPath();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, toDisk(c), "utf8");
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

/** 凭据是否已过期（到期时刻未知时保守返回 false —— 不能凭空判定过期）。 */
export function isExpired(c: Credentials): boolean {
  return sharedLogin.isExpiredAt(c.expiresAt, 60_000);
}

// ── 令牌响应解析 ──────────────────────────────────────────────────────────────

/** 解析后的令牌授予（设备码换令牌与续期同构）。 */
export interface TokenGrant {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scope: string;
  expiresAt: number;
  accountId: string;
  nickname: string;
}

/**
 * 解析令牌响应并**硬校验**（§2.3）。
 *
 * @param previousRefreshToken 续期场景下保留旧 refresh_token（响应常不回刷新令牌）
 */
export function parseTokenGrant(
  payload: Record<string, unknown>,
  previousRefreshToken = "",
): TokenGrant {
  const accessToken = str(payload["access_token"]) || str(payload["accessToken"]);
  if (!accessToken) throw new Error("令牌响应缺少 access_token");

  const refreshToken =
    str(payload["refresh_token"]) || str(payload["refreshToken"]) || previousRefreshToken;
  if (!refreshToken) throw new Error("令牌响应缺少 refresh_token（也无法回退到上一个）");

  const tokenType = str(payload["token_type"]) || str(payload["tokenType"]);
  if (tokenType.toLowerCase() !== "bearer") {
    throw new Error(`令牌响应的 token_type 不是 bearer（收到 '${tokenType}'）`);
  }

  const expiresIn =
    typeof payload["expires_in"] === "number"
      ? payload["expires_in"]
      : Number.parseInt(str(payload["expires_in"]), 10);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("令牌响应的 expires_in 不是正数");
  }

  const scope = str(payload["scope"]);
  const scopes = scope.split(/[\s,]+/).filter(Boolean);
  if (!scopes.includes(PRODUCT_SCOPE)) {
    throw new Error(`令牌响应的 scope 未含产品 scope '${PRODUCT_SCOPE}'（收到 '${scope}'）`);
  }

  // ⚠ access_token 非 JWT（mmoat_ 前缀）⇒ jwtExpMs 恒返回 0 ⇒ 走 expires_in 自算。
  const jwtExp = sharedLogin.jwtExpMs(accessToken);
  const expiresAt = jwtExp > 0 ? jwtExp : Date.now() + expiresIn * 1000;

  const info = objOrNull(payload["user_info"]) ?? objOrNull(payload["userInfo"]);
  const accountId =
    str(payload["account_id"]) ||
    str(payload["accountId"]) ||
    str(info?.["account_id"]) ||
    str(info?.["id"]);
  const nickname = str(payload["nickname"]) || str(info?.["nickname"]) || str(info?.["name"]);

  return { accessToken, refreshToken, tokenType, scope, expiresAt, accountId, nickname };
}

function objOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function grantToCredentials(g: TokenGrant, base: Partial<Credentials> = {}): Credentials {
  return {
    accessToken: g.accessToken,
    refreshToken: g.refreshToken,
    tokenType: g.tokenType || "Bearer",
    expiresAt: g.expiresAt,
    scope: g.scope,
    uid: g.accountId || base.uid || "",
    nickname: g.nickname || base.nickname || "",
    domain: "",
    obtainedAt: sharedLogin.nowIso(),
  };
}

// ── OAuth 设备码 + PKCE 登录 ──────────────────────────────────────────────────

interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (msg: string) => void;
  /** 仅供测试：注入 sleep（避免真等）。 */
  sleep?: (ms: number) => Promise<void>;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<Response> {
  return sharedLogin.fetchWithTimeout(url, init, timeoutMs);
}

/** 设备码响应（§2.3 第 3 步）。 */
export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

/** 校验并归一设备码响应（§2.3 第 3 步）。 */
export function parseDeviceCode(payload: Record<string, unknown>): DeviceCode {
  const deviceCode = str(payload["device_code"]);
  const userCode = str(payload["user_code"]);
  // verification_uri 或 verification_url 二者之一即可（§2.3）
  const verificationUri = str(payload["verification_uri"]) || str(payload["verification_url"]);
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error("设备码响应缺少 device_code / user_code / verification_uri");
  }
  const expiresIn =
    typeof payload["expires_in"] === "number"
      ? payload["expires_in"]
      : Number.parseInt(str(payload["expires_in"]), 10);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("设备码响应缺少有效的 expires_in");
  }
  const intervalRaw =
    typeof payload["interval"] === "number"
      ? payload["interval"]
      : Number.parseInt(str(payload["interval"]), 10);
  const interval =
    Number.isFinite(intervalRaw) && intervalRaw > 0 ? intervalRaw : DEFAULT_DEVICE_INTERVAL_SEC;
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: str(payload["verification_uri_complete"]),
    expiresIn: Math.trunc(expiresIn),
    interval,
  };
}

/**
 * 第 1 步：申请设备码（`application/x-www-form-urlencoded`）。
 *
 * ⚠ PKCE verifier 由调用方持有并复用（挑战在此发出、校验在轮询里发），
 * 故本函数**必须**接收与挑战配对的 `pkce`。
 */
export async function requestDeviceCode(
  account: string,
  pkce: { verifier: string; challenge: string } = generatePkce(),
): Promise<DeviceCode> {
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${trimSlash(account)}/oauth2/device/code`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody({
          client_id: CLIENT_ID,
          scope: PRODUCT_SCOPE,
          audience: AUDIENCE,
          code_challenge: pkce.challenge,
          code_challenge_method: "S256",
        }),
      },
      OAUTH_TIMEOUT_MS,
    );
  } catch (err) {
    throw new Error(`申请设备码失败: ${String(err)}`);
  }
  if (!resp.ok) throw new Error(`申请设备码失败: HTTP ${resp.status}`);
  let payload: Record<string, unknown>;
  try {
    payload = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`设备码响应不是合法 JSON: ${String(err)}`);
  }
  return parseDeviceCode(payload);
}

/** 轮询间隔（毫秒）：把 `interval`（秒）转毫秒，下限 1s。 */
export function pollIntervalMs(device: Pick<DeviceCode, "interval">): number {
  const seconds = Number.isFinite(device.interval) ? device.interval : DEFAULT_DEVICE_INTERVAL_SEC;
  return Math.max(1000, Math.trunc(seconds * 1000));
}

/**
 * 第 2 步：轮询令牌端点，直到授权完成/失败（§2.3）。
 *
 * 状态机（两条「还在等」形态都要认）：
 *   - HTTP 200 + `status:"pending"` → pending
 *   - 非 200 + `error:"authorization_pending"` → pending
 *   - `status|error` = slow_down → slow_down（骨架累积抬高 5s）
 *   - denied / access_denied → 用户取消（终态）
 *   - expired / expired_token → 过期（终态）
 *   - 2xx 且有 access_token → done
 *   - 其余 → fatal
 */
export async function pollDeviceToken(
  account: string,
  pkce: { verifier: string },
  device: DeviceCode,
  options: { sleep?: (ms: number) => Promise<void>; onStatus?: (msg: string) => void } = {},
): Promise<Record<string, unknown>> {
  return loginFlow.pollDeviceCode<Record<string, unknown>>({
    intervalMs: pollIntervalMs(device),
    expiresInSec: device.expiresIn,
    slowDownStepMs: SLOW_DOWN_STEP_MS,
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    attempt: async () => {
      const resp = await fetchWithTimeout(
        `${trimSlash(account)}/oauth2/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: formBody({
            grant_type: DEVICE_GRANT_TYPE,
            device_code: device.deviceCode,
            client_id: CLIENT_ID,
            code_verifier: pkce.verifier,
          }),
        },
        OAUTH_TIMEOUT_MS,
      );
      let payload: Record<string, unknown> = {};
      try {
        payload = (await resp.json()) as Record<string, unknown>;
      } catch {
        /* 非 JSON（网关错误页）按下面的状态码分支处理 */
      }
      const status = str(payload["status"]).toLowerCase();
      const error = str(payload["error"]).toLowerCase();

      if (status === "denied" || status === "access_denied" || error === "access_denied") {
        return { kind: "fatal", error: new Error("授权被拒绝（用户取消）") };
      }
      if (status === "expired" || status === "expired_token" || error === "expired_token") {
        return { kind: "fatal", error: new Error("设备码已过期，请重新登录") };
      }
      if (status === "slow_down" || error === "slow_down") {
        return { kind: "slow_down" };
      }
      // ⚠ 两条「还在等」形态都要认：形态一 HTTP 200 + status:pending；
      // 形态二 非 200 + error:authorization_pending。判据先于状态码判断。
      if (status === "pending" || error === "authorization_pending") {
        return { kind: "pending" };
      }
      if (resp.status >= 200 && resp.status < 300) {
        if (str(payload["access_token"])) return { kind: "done", value: payload };
        // 2xx 但既不是 pending 也没有令牌 → 服务端异常，继续等只会死循环到超时
        return {
          kind: "fatal",
          error: new Error("令牌轮询返回 2xx 但没有 access_token（服务端异常）"),
        };
      }
      return {
        kind: "fatal",
        error: new Error(`令牌轮询失败：HTTP ${resp.status}${error ? ` (${error})` : ""}`),
      };
    },
  });
}

/**
 * 运行一次完整的设备码 + PKCE 登录并持久化结果（§2.3）。
 *
 * ⚠ `onUrl` 必须在拿到 URL 后**立刻**回调（界面据此弹窗），再开浏览器。
 * 优先用 `verification_uri_complete`（自带 user_code，用户少一步输入）。
 */
export async function login(baseUrl?: string, options: LoginOptions = {}): Promise<Credentials> {
  const account = trimSlash(baseUrl || resolveBaseUrl());
  const { onUrl, onStatus, sleep } = options;

  const pkce = generatePkce();
  const device = await requestDeviceCode(account, pkce);
  const url = device.verificationUriComplete || device.verificationUri;
  onUrl?.(url);
  onStatus?.(`请在浏览器打开 ${url} 完成授权（user_code: ${device.userCode}）`);
  if (process.env["MINIMAX_NO_BROWSER"] !== "1") sharedLogin.openBrowser(url);

  const pollOptions: { sleep?: (ms: number) => Promise<void>; onStatus?: (msg: string) => void } = {};
  if (sleep) pollOptions.sleep = sleep;
  if (onStatus) pollOptions.onStatus = onStatus;
  const payload = await pollDeviceToken(account, pkce, device, pollOptions);

  const c = grantToCredentials(parseTokenGrant(payload));
  await save(c);
  onStatus?.("授权成功，凭据已保存。");
  return c;
}

/**
 * 续期：`POST {account}/oauth2/token`，body `grant_type=refresh_token` +
 * `refresh_token` + `client_id` + `scope` + `audience`（§2.3）。
 *
 * 响应同样过 `parseTokenGrant`（保留旧 refresh_token 与账号字段）。
 */
export async function refresh(c: Credentials, baseUrl?: string): Promise<Credentials> {
  if (!c.refreshToken) throw new Error("凭据里没有 refresh_token，无法续期，请重新登录");
  const account = trimSlash(baseUrl || resolveBaseUrl());

  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${account}/oauth2/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody({
          grant_type: "refresh_token",
          refresh_token: c.refreshToken,
          client_id: CLIENT_ID,
          scope: c.scope || PRODUCT_SCOPE,
          audience: AUDIENCE,
        }),
      },
      OAUTH_TIMEOUT_MS,
    );
  } catch (err) {
    throw new Error(`续期请求失败（可重试）: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new NotLoggedInError("刷新令牌已失效，请重新登录");
  }
  if (resp.status !== 200) throw new Error(`续期失败（可重试）: HTTP ${resp.status}`);

  let payload: Record<string, unknown>;
  try {
    payload = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`续期响应不是合法 JSON: ${String(err)}`);
  }
  // 终态：200 但拿不到令牌 ⇒ 刷新令牌被作废（不再可重试）
  let grant: TokenGrant;
  try {
    grant = parseTokenGrant(payload, c.refreshToken);
  } catch (err) {
    throw new NotLoggedInError(String(err));
  }
  const next = grantToCredentials(grant, c);
  await save(next);
  return next;
}
