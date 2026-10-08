/**
 * Cline 认证：WorkOS 设备码登录、凭据持久化与令牌续期。
 *
 * ## 本模块承载的渠道知识（每条都是实测结论，见 docs/protocols/cline/PROTOCOL.md）
 *
 * 1. **`workos:` 前缀绝不可剥**：令牌值必须保留服务端下发的 `workos:` 前缀。
 *    剥掉 → `401`，而报文是 "make sure you're using the latest version of Cline"
 *    —— 与真实原因毫不相干，会被误判成「客户端版本过旧」。
 *    故实现为**幂等补齐**：缺了加上、有了原样返回（`ensureTokenPrefix`）。
 * 2. **续期字段是驼峰** `refreshToken` + `grantType`（不是 OAuth 标准的
 *    `refresh_token` / `grant_type`）：写错字段名服务端只回一个泛化的认证失败，
 *    极难定位。
 * 3. **响应判据是 `success && data.accessToken`**，不是裸 `accessToken`
 *    —— 只看裸字段会把失败信封当成功；但**裸响应**（无 `data` 信封）也要兼容。
 * 4. **轮询的「等待」判据是响应体 `error` 字段**（`authorization_pending`），
 *    **不是 HTTP 状态码**：按状态码判会把「用户还没点授权」误报成失败；
 *    `slow_down` 必须**真的累积退避**（每次 +1s）。
 * 5. 2xx 但缺 token → **服务端异常**（不是「继续等用户」），立即报错，否则死循环到超时。
 */

import { readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";

import { credentialsPath, ensureDir, login as sharedLogin } from "@model-bridge/gateway";

/** Cline 接口基址。 */
export const DEFAULT_BASE_URL = "https://api.cline.bot";

/** WorkOS 账号基址（设备码授权走这里）。 */
export const WORKOS_BASE_URL = "https://api.workos.com";

/** WorkOS 公开客户端 id（随客户端分发，非机密）。 */
export const WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";

/** 令牌前缀 —— 本渠道最大的坑，见文件头注释。 */
export const CLINE_TOKEN_PREFIX = "workos:";

/** 设备码授权端点的 grant_type。 */
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

const HTTP_TIMEOUT_MS = 30_000;
/** 轮询间隔下限 1s —— 服务端可能下发 0 或负数。 */
const POLL_INTERVAL_FLOOR_MS = 1000;
const POLL_INTERVAL_DEFAULT_MS = 5000;
/** 网络失败容忍次数（连续），超过即终态失败。 */
const MAX_CONSECUTIVE_FAILURES = 5;
/** 设备码默认有效期（服务端通常下发 expires_in）。 */
const DEVICE_CODE_TTL_SECONDS = 300;

const NOT_LOGGED_IN_MSG = "未找到可用凭据，请先运行 cline login";

/** 磁盘上没有可用凭据。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message: string = NOT_LOGGED_IN_MSG) {
    super(message);
  }
}

/** 刷新令牌已作废（终态，重试无用，必须重新登录）。 */
export class RefreshTokenExpiredError extends Error {
  override name = "RefreshTokenExpiredError";
}

/** 凭据在内存里的形态（磁盘字段为 snake_case，见 `load`）。 */
export interface Credentials {
  /** 推理用令牌，**带 `workos:` 前缀**。 */
  readonly accessToken: string;
  readonly refreshToken: string;
  /** 余额查询必需的账号标识，形如 `usr-01M3…`。 */
  readonly accountId: string;
  /** 账号标识（= `accountId`；契约要求）。 */
  readonly uid: string;
  /** Cline 只有一个域，无 domain 概念 → 恒空串。 */
  readonly domain: string;
  /** 令牌到期时刻（**毫秒**）；未知为 null。 */
  readonly expireTime: number | null;
  readonly email: string;
  readonly nickname: string;
  readonly tokenType: string;
  readonly obtainedAt: string;
  readonly source: string;
}

export const EMPTY_CREDENTIALS: Credentials = {
  accessToken: "",
  refreshToken: "",
  accountId: "",
  uid: "",
  domain: "",
  expireTime: null,
  email: "",
  nickname: "",
  tokenType: "",
  obtainedAt: "",
  source: "",
};

/** 取值收窄（转发共享层原语）。 */
const str = sharedLogin.str;

/** 当前时间的 ISO 字串（转发共享层原语）。 */
const nowIso = sharedLogin.nowIso;

/**
 * 幂等补齐 `workos:` 前缀。
 *
 * ⚠ 本模块（以及 `upstream.buildHeaders()`）**绝不发送无前缀的令牌**：
 * 剥前缀 = 401 + 误导文案。空串保持空串（不凭空造出 `workos:`）。
 */
export function ensureTokenPrefix(token: string): string {
  if (!token) return "";
  return token.startsWith(CLINE_TOKEN_PREFIX) ? token : `${CLINE_TOKEN_PREFIX}${token}`;
}

/** 从令牌里剥掉前缀 —— **只用于解码 JWT**，绝不用于请求头。 */
export function stripTokenPrefix(token: string): string {
  return token.startsWith(CLINE_TOKEN_PREFIX)
    ? token.slice(CLINE_TOKEN_PREFIX.length)
    : token;
}

/**
 * 解码 JWT 载荷（**只解码不验签**，仅用于排查/补字段）。
 *
 * ⚠ 传 `CLINE_TOKEN_PREFIX` 让共享层先剥前缀 —— 本渠道令牌带 `workos:` 前缀。
 */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  return sharedLogin.decodeJwtPayload(token, CLINE_TOKEN_PREFIX);
}

function intOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * `expiresAt` 归一成毫秒时间戳。
 *
 * 实测是 ISO 8601 字符串（`2026-09-25T05:23:47.000Z`）；同时兼容数字
 * （10 位当秒、13 位当毫秒）。无法解析返回 null（不编造）。
 */
export function parseExpireTime(value: unknown): number | null {
  return sharedLogin.parseExpireTime(value);
}

/** 凭据是否已过期（expireTime 未知时保守返回 false —— 不能凭空判定过期）。 */
export function isExpired(c: Credentials): boolean {
  return sharedLogin.isExpiredAt(c.expireTime);
}

/** 接口基址解析：显式参数 > 环境变量（测试/便携）> 默认。 */
function apiBase(override?: string): string {
  return override || process.env["CLINE_API_BASE_URL"] || DEFAULT_BASE_URL;
}

/** WorkOS 基址解析：环境变量可覆盖（测试用），默认官方地址。 */
function workosBase(override?: string): string {
  return override || process.env["CLINE_WORKOS_BASE_URL"] || WORKOS_BASE_URL;
}

/** 仅供测试：覆盖接口基址（避免真出网）。 */
export function setApiBaseUrl(url: string): void {
  process.env["CLINE_API_BASE_URL"] = url;
}

/** 仅供测试：覆盖 WorkOS 基址。 */
export function setWorkosBaseUrl(url: string): void {
  process.env["CLINE_WORKOS_BASE_URL"] = url;
}

/**
 * 从磁盘读取凭据（磁盘字段是 snake_case，见 PROTOCOL §2.3）。
 *
 * - 文件缺失 / JSON 损坏 / `access_token` 为空 → `NotLoggedInError`
 * - **老凭据缺 `workos:` 前缀时不拒绝，就地补齐**（手写/外部导入的凭据常见）
 * - 同时兼容 camelCase 字段名（早期实现写过 camelCase）
 */
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

  const accessToken = ensureTokenPrefix(str(rec["access_token"] ?? rec["accessToken"]));
  if (!accessToken) throw new NotLoggedInError();
  const accountId = str(rec["account_id"] ?? rec["accountId"]);
  return {
    accessToken,
    refreshToken: str(rec["refresh_token"] ?? rec["refreshToken"]),
    accountId,
    uid: accountId,
    domain: "",
    expireTime: parseExpireTime(rec["expire_time"] ?? rec["expireTime"] ?? rec["expiresAt"]),
    email: str(rec["email"]),
    nickname: str(rec["nickname"]),
    tokenType: str(rec["token_type"] ?? rec["tokenType"]),
    obtainedAt: str(rec["obtained_at"] ?? rec["obtainedAt"]),
    source: str(rec["source"]),
  };
}

/** 以 0600 权限原子写入凭据（临时文件 + rename，崩溃不留下半截 JSON）。 */
export async function save(c: Credentials): Promise<void> {
  ensureDir();
  const path = credentialsPath();
  const tmp = `${path}.tmp`;
  const payload = {
    access_token: ensureTokenPrefix(c.accessToken),
    refresh_token: c.refreshToken,
    account_id: c.accountId,
    expire_time: c.expireTime,
    email: c.email,
    nickname: c.nickname,
    token_type: c.tokenType,
    obtained_at: c.obtainedAt || nowIso(),
    source: c.source,
  };
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

/** 解析后的令牌信封（注册与续期同构）。 */
export interface TokenEnvelope {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  email: string;
  nickname: string;
  expireTime: number | null;
  tokenType: string;
}

/**
 * 解析注册/续期响应。
 *
 * ⚠ **判据是 `success && data.accessToken`**，不是裸 `accessToken`：
 * 失败信封（`{success:false,error}`）里也可能带各种字段，只看裸字段会把它当成功。
 * 但**裸响应**（无 `data` 信封，如 `{"accessToken":"workos:bare-token"}`）必须兼容。
 */
export function parseTokenEnvelope(payload: unknown): TokenEnvelope {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("令牌响应不是 JSON 对象");
  }
  const rec = payload as Record<string, unknown>;
  // 失败信封：明确声明 success 为 false 即失败（文案带上游原因）
  if (rec["success"] === false) {
    throw new Error(`Cline 返回失败: ${str(rec["error"]) || str(rec["message"]) || "未知原因"}`);
  }
  const data = rec["data"];
  const env =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : rec; // 兼容裸响应（无 data 信封）

  const accessToken = ensureTokenPrefix(str(env["accessToken"]));
  if (!accessToken) throw new Error("令牌响应里没有 accessToken（success 信封也不完整）");

  const userInfo = env["userInfo"];
  const info =
    userInfo && typeof userInfo === "object" && !Array.isArray(userInfo)
      ? (userInfo as Record<string, unknown>)
      : {};
  const nickname = [str(info["firstName"]), str(info["lastName"])]
    .filter(Boolean)
    .join(" ")
    .trim();

  return {
    accessToken,
    refreshToken: str(env["refreshToken"]),
    accountId: str(info["clineUserId"]),
    email: str(info["email"]),
    nickname: str(info["nickname"]) || nickname,
    expireTime: parseExpireTime(env["expiresAt"]),
    tokenType: str(env["tokenType"]),
  };
}

/** 客户端伪装头（注册/续期/对话/余额共用，见 PROTOCOL §2.1）。 */
export function clientHeaders(): Record<string, string> {
  return {
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    "X-IS-MULTIROOT": "false",
    "X-CLIENT-TYPE": "cline-sdk",
  };
}

async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = HTTP_TIMEOUT_MS, ...rest } = init;
  return fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
}

// ── WorkOS 设备码授权（三步登录的第 1、2 步）──────────────────────────────────

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

/** 第 1 步：请求设备码。三字段（device_code/user_code/verification_uri）齐备才通过。 */
export async function requestDeviceCode(baseOverride?: string): Promise<DeviceCode> {
  const base = workosBase(baseOverride);
  let resp: Response;
  try {
    resp = await fetchJson(`${base}/user_management/authorize/device`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: WORKOS_CLIENT_ID }).toString(),
    });
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
  const deviceCode = str(payload["device_code"]);
  const userCode = str(payload["user_code"]);
  const verificationUri = str(payload["verification_uri"]);
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error("设备码响应缺少 device_code / user_code / verification_uri");
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: str(payload["verification_uri_complete"]),
    expiresIn: intOrNull(payload["expires_in"]) ?? DEVICE_CODE_TTL_SECONDS,
    interval: intOrNull(payload["interval"]) ?? POLL_INTERVAL_DEFAULT_MS / 1000,
  };
}

/** 轮询间隔（毫秒）：下限 1s —— 服务端可能下发 0 或负数。 */
export function pollIntervalMs(device: Pick<DeviceCode, "interval">): number {
  const seconds = Number.isFinite(device.interval) ? device.interval : 5;
  return Math.max(POLL_INTERVAL_FLOOR_MS, Math.trunc(seconds * 1000));
}

export interface PollOptions {
  /** 注入 sleep（测试用，避免真等）；默认真定时器。 */
  sleep?: (ms: number) => Promise<void>;
  onStatus?: (message: string) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 第 2 步：轮询 authenticate 直到拿到令牌。
 *
 * 状态机（见文件头注释 4、5）：
 * - 200 + `{error:"authorization_pending"}` → **不是错误**，继续按 interval 轮询
 * - 200 + `{error:"slow_down"}` → `intervalMs += 1000` 后继续（真实累积退避）
 * - `access_denied` / `expired_token` / `invalid_grant` → 终态失败
 * - 其它非 2xx → 终态失败
 * - 2xx 但缺 token → 服务端异常（立即失败，不死循环）
 * - 网络异常容忍 5 次连续失败
 */
export async function pollDeviceToken(
  device: DeviceCode,
  baseOverride?: string,
  options: PollOptions = {},
): Promise<Record<string, unknown>> {
  const base = workosBase(baseOverride);
  const sleep = options.sleep ?? defaultSleep;
  const { onStatus } = options;
  let intervalMs = pollIntervalMs(device);
  const deadline = Date.now() + Math.max(1, device.expiresIn) * 1000;
  let failures = 0;

  for (;;) {
    if (Date.now() >= deadline) throw new Error("设备码授权超时，请重新运行 cline login");

    let resp: Response;
    try {
      resp = await fetchJson(`${base}/user_management/authenticate`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT_TYPE,
          device_code: device.deviceCode,
          client_id: WORKOS_CLIENT_ID,
        }).toString(),
      });
      failures = 0;
    } catch (err) {
      failures += 1;
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error(`轮询设备码连续 ${failures} 次网络失败: ${String(err)}`);
      }
      await sleep(intervalMs);
      continue;
    }

    let payload: Record<string, unknown> = {};
    try {
      payload = (await resp.json()) as Record<string, unknown>;
    } catch {
      /* 非 JSON（网关错误页）按下面的状态码分支处理 */
    }
    const error = str(payload["error"]);
    const desc = str(payload["error_description"]);

    // ⚠ 判据是响应体的 error 字段，不是状态码
    if (error === "authorization_pending") {
      await sleep(intervalMs);
      continue;
    }
    if (error === "slow_down") {
      intervalMs += 1000; // 必须真的累积：每次都加，不重置
      onStatus?.(`服务端要求放慢轮询，间隔调整为 ${intervalMs / 1000}s`);
      await sleep(intervalMs);
      continue;
    }
    if (error) {
      throw new Error(`设备码授权失败: ${error}${desc ? ` (${desc})` : ""}`);
    }
    if (resp.status >= 200 && resp.status < 300) {
      if (typeof payload["access_token"] === "string" && payload["access_token"]) {
        return payload;
      }
      // 2xx 但没有 token：服务端异常，继续等只会死循环到超时
      throw new Error("设备码授权返回 2xx 但没有 access_token（服务端异常）");
    }
    throw new Error(`设备码授权失败: HTTP ${resp.status}`);
  }
}

/**
 * 第 3 步：拿 WorkOS 令牌换 Cline 自己的令牌（body 字段是**驼峰**）。
 */
export async function registerToken(
  workosAccessToken: string,
  workosRefreshToken: string,
  baseOverride?: string,
): Promise<Credentials> {
  const base = apiBase(baseOverride);
  let resp: Response;
  try {
    resp = await fetchJson(`${base}/api/v1/auth/register`, {
      method: "POST",
      headers: {
        ...clientHeaders(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        accessToken: workosAccessToken,
        refreshToken: workosRefreshToken,
      }),
    });
  } catch (err) {
    throw new Error(`注册 Cline 令牌失败: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new RefreshTokenExpiredError("注册时 Cline 拒绝了 WorkOS 令牌，请重新登录");
  }
  if (resp.status !== 200) throw new Error(`注册 Cline 令牌失败: HTTP ${resp.status}`);
  const env = parseTokenEnvelope(await resp.json().catch(() => null));
  const c: Credentials = {
    ...EMPTY_CREDENTIALS,
    accessToken: env.accessToken,
    // 服务端偶尔不回 refreshToken：退回 WorkOS 的那个（续期会失败但能报出清晰原因，
    // 总好过凭据里干脆没有可续期字段）
    refreshToken: env.refreshToken || workosRefreshToken,
    accountId: env.accountId,
    uid: env.accountId,
    expireTime: env.expireTime,
    email: env.email,
    nickname: env.nickname,
    tokenType: env.tokenType || "Bearer",
    obtainedAt: nowIso(),
    source: "cline-workos-device",
  };
  await save(c);
  return c;
}

export interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (message: string) => void;
  /** 仅供测试：注入 sleep。 */
  sleep?: (ms: number) => Promise<void>;
  /** 仅供测试：覆盖 WorkOS 基址。 */
  workosBaseUrl?: string;
}

/** 在系统浏览器打开 URL（失败不影响流程，用户可复制链接）。 */
export function openBrowser(url: string): void {
  sharedLogin.openBrowser(url);
}

/**
 * 完整设备码登录：设备码 → 轮询 → 注册 → 落盘。
 *
 * `onUrl` 在拿到 URL 后**立刻**回调（界面据此弹窗）；优先用
 * `verification_uri_complete`（自带 user_code，用户少一步输入）。
 */
export async function login(baseUrl?: string, options: LoginOptions = {}): Promise<Credentials> {
  const apiBaseUrl = apiBase(baseUrl);
  const { onUrl, onStatus, sleep } = options;

  const device = await requestDeviceCode(options.workosBaseUrl);
  const url = device.verificationUriComplete || device.verificationUri;
  onUrl?.(url);
  onStatus?.(`请在浏览器打开 ${url} 完成授权（user_code: ${device.userCode}）`);
  if (process.env["CLINE_NO_BROWSER"] !== "1") openBrowser(url);

  const pollOptions: PollOptions = {};
  if (sleep) pollOptions.sleep = sleep;
  if (onStatus) pollOptions.onStatus = onStatus;
  const tokens = await pollDeviceToken(device, options.workosBaseUrl, pollOptions);
  onStatus?.("授权成功，正在换取 Cline 令牌…");
  return registerToken(str(tokens["access_token"]), str(tokens["refresh_token"]), apiBaseUrl);
}

/**
 * 续期：`POST /api/v1/auth/refresh`，body 是**驼峰** `{refreshToken, grantType}`。
 *
 * 终态判定（见 PROTOCOL §2.6）：
 * - HTTP 401/403 → `RefreshTokenExpiredError`
 * - 200 但缺 accessToken → `RefreshTokenExpiredError`
 * - 传输层失败 / 5xx / 429 → 普通 Error（可重试）
 *
 * 续期后**保留** `account_id` / `email` / `nickname`。
 */
export async function refresh(c: Credentials, baseOverride?: string): Promise<Credentials> {
  if (!c.refreshToken) throw new Error("凭据里没有 refresh_token，无法静默续期");
  const base = apiBase(baseOverride);

  let resp: Response;
  try {
    resp = await fetchJson(`${base}/api/v1/auth/refresh`, {
      method: "POST",
      headers: {
        ...clientHeaders(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ refreshToken: c.refreshToken, grantType: "refresh_token" }),
    });
  } catch (err) {
    throw new Error(`续期请求失败（可重试）: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new RefreshTokenExpiredError("刷新令牌已失效，请重新登录");
  }
  if (resp.status !== 200) {
    throw new Error(`续期失败（可重试）: HTTP ${resp.status}`);
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    throw new RefreshTokenExpiredError(`续期响应不是合法 JSON: ${String(err)}`);
  }

  let env: TokenEnvelope;
  try {
    env = parseTokenEnvelope(payload);
  } catch (err) {
    // 200 但拿不到新 accessToken：刷新令牌已被上游作废（终态），不是可重试错误
    throw new RefreshTokenExpiredError(String(err));
  }

  const next: Credentials = {
    ...EMPTY_CREDENTIALS,
    accessToken: env.accessToken,
    refreshToken: env.refreshToken || c.refreshToken, // 服务端可能只回 access_token
    accountId: env.accountId || c.accountId, // 续期响应不带 userInfo → 保留旧值
    uid: env.accountId || c.accountId,
    domain: "",
    expireTime: env.expireTime ?? c.expireTime,
    email: env.email || c.email,
    nickname: env.nickname || c.nickname,
    tokenType: env.tokenType || c.tokenType || "Bearer",
    obtainedAt: nowIso(),
    source: c.source,
  };
  await save(next);
  return next;
}

/** 解析登录基址：单域渠道，无 realm 概念（参数仅为满足契约）。 */
export function resolveBaseUrl(_realm = "auto"): string {
  return apiBase();
}
