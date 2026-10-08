/**
 * Gemini Code Assist（Google）凭据：真实 Google OAuth 授权码登录（本地双栈回调）、
 * 凭据持久化与静默续期。
 *
 * ## 依据（docs/protocols/gemini/PROTOCOL.md §2）
 *
 * - 授权 URL 参数：`client_id / response_type=code / redirect_uri / scope / state /
 *   access_type=offline / include_granted_scopes=true / prompt=consent`
 * - 回调地址 `http://localhost:<port>/oauth-callback`（host 必须是 `localhost`）
 * - ⚠ **必须同时监听 127.0.0.1 与 [::1]** —— 浏览器常把 `localhost` 解析成 IPv6
 * - ⚠ **必须先监听再拼 URL** —— 端口被占时回退别的端口，先拼 URL 会
 *   `redirect_uri_mismatch`
 * - ⚠ **`state` 必须校验**，不匹配一律拒绝（本实现里共享回调原语无法回 400，
 *   故在流程层拒绝，见 `startCallbackServer().wait(_, expectedState)`）
 * - 授权流程总预算 **6 分钟**（3 分钟会把带二次验证的正常用户掐掉）
 * - token 端点**强制校验客户端身份**：exchange / refresh 表单**必须**带
 *   `client_secret`（只发 client_id 会回 `invalid_request: client_secret is missing`）
 * - ⚠ 令牌请求**刻意不设 `User-Agent`**（伪装只用在 Cloud Code 端点）
 * - Google 偶尔轮换 refresh_token：响应给了新的必须回写
 * - 身份从 `id_token` 解（`sub` / `email`，**不验签**）；userinfo 是兜底
 * - 凭据过期判定含 **60 秒余量**
 *
 * ## 登录原语全部复用共享层
 *
 * `openBrowser` / `str` / `nowIso` / `fetchWithTimeout` / `randomHex` /
 * `decodeJwtPayload` / `parseExpireTime` 与回调服务器骨架
 * (`loginFlow.startCallbackServer`) 都来自 `@model-bridge/gateway` —— 本模块只补
 * 渠道知识（Google 的 URL / 表单 / 响应解析）与 **IPv6 监听补层**。
 */

import { readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

import {
  credentialsPath,
  ensureDir,
  login as sharedLogin,
  loginFlow,
} from "@model-bridge/gateway";

import * as upstream from "./upstream.js";

/** 推理端点（轮换用，见 upstream）。登录不依赖它，但契约要求本模块导出。 */
export const DEFAULT_BASE_URL = upstream.DEFAULT_BASE_URL;

/** OAuth 授权页 / 令牌 / 身份 / 撤销端点（GOOGLE，逐字常量）。 */
export const OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const OAUTH_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
export const OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/**
 * Google OAuth 客户端凭据（随客户端分发，非机密；PROTOCOL §2.3 逐字常量）。
 *
 * 可被 `CMDC_PAK_GOOGLE_CLIENT_ID` / `CMDC_PAK_GOOGLE_CLIENT_SECRET` 覆盖。
 */
export const GEMINI_DEFAULT_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const GEMINI_DEFAULT_CLIENT_SECRET = "GOCSPX-REVOKED";

/** 回调路径（`http://localhost:<port>/oauth-callback`）。 */
export const CALLBACK_PATH = "/oauth-callback";
/** 回调兜底端口（被占用时回退随机端口）。 */
export const CALLBACK_PORT = 8845;

/** 登录总预算 6 分钟（PROTOCOL §2.2：3 分钟会掐掉带二次验证的正常用户）。 */
export const LOGIN_TIMEOUT_MS = 6 * 60 * 1000;
/** 令牌 / 身份请求超时（PROTOCOL §1.2：OAuth 20s）。 */
export const HTTP_TIMEOUT_MS = 20_000;
/** 凭据过期余量（PROTOCOL §1.2 / §2.6）。 */
export const EXPIRY_LEAD_MS = 60_000;

/** OAuth scope 清单（六项逐字，PROTOCOL §2.4）。 */
export const OAUTH_SCOPES: readonly string[] = [
  "openid",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

const NOT_LOGGED_IN_MSG = "未找到可用凭据，请先运行 gemini login";

/** 磁盘上没有可用凭据。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message: string = NOT_LOGGED_IN_MSG) {
    super(message);
  }
}

/**
 * refresh_token 已失效 —— 终态，只能重新登录。
 *
 * ⚠ `name` 必须是**字符串** `'RefreshTokenExpiredError'`（PROTOCOL §7）：
 * 判据是结构化比较 + 文案正则兜底，写成类名会让第一个分支恒不命中。
 */
export class RefreshTokenExpiredError extends Error {
  override name = "RefreshTokenExpiredError";
}

/** 取值收窄（转发共享层原语）。 */
const str = sharedLogin.str;
/** 当前时间 RFC3339（转发共享层原语）。 */
const nowIso = sharedLogin.nowIso;

/** 凭据（内存形态；磁盘字段名与 PROTOCOL §2.1 一致）。 */
export interface Credentials {
  /** 访问令牌（推理请求用）。 */
  readonly accessToken: string;
  /** 刷新令牌（静默续期用；Google 偶尔会轮换）。 */
  readonly refreshToken: string;
  readonly tokenType: string;
  /** 令牌有效期（秒，取自 `expires_in`，缺省 3600）。 */
  readonly expiresIn: number;
  readonly scope: string;
  /** 到期时刻（**RFC3339 字符串**，由 expires_in 自算）。 */
  readonly expiry: string;
  /** 账号标识（id_token 的 `sub`，兜底 userinfo 的 `id`）。 */
  readonly uid: string;
  readonly email: string;
  /** 探测到的 Google Cloud 项目（缺失时上游回落 `aicode-consumers`）。 */
  readonly cloudaicompanionProject: string;
  /** 绑定的域（推理端点主机名）。 */
  readonly domain: string;
  readonly obtainedAt?: string;
}

export const EMPTY_CREDENTIALS: Credentials = {
  accessToken: "",
  refreshToken: "",
  tokenType: "",
  expiresIn: 0,
  scope: "",
  expiry: "",
  uid: "",
  email: "",
  cloudaicompanionProject: "",
  domain: "",
};

/** client_id 解析：环境变量覆盖 > 逐字常量。 */
export function clientId(): string {
  const override = process.env["CMDC_PAK_GOOGLE_CLIENT_ID"];
  return override && override.trim() ? override.trim() : GEMINI_DEFAULT_CLIENT_ID;
}

/** client_secret 解析：环境变量覆盖 > 逐字常量。 */
export function clientSecret(): string {
  const override = process.env["CMDC_PAK_GOOGLE_CLIENT_SECRET"];
  return override && override.trim() ? override.trim() : GEMINI_DEFAULT_CLIENT_SECRET;
}

/** 授权页 URL（`GEMINI_AUTHORIZE_URL` 可覆盖，便于离线自检）。 */
export function authorizeEndpoint(): string {
  return process.env["GEMINI_AUTHORIZE_URL"] || OAUTH_AUTHORIZE_URL;
}

/** 令牌端点 URL（`GEMINI_TOKEN_URL` 可覆盖，便于离线自检）。 */
export function tokenEndpoint(): string {
  return process.env["GEMINI_TOKEN_URL"] || OAUTH_TOKEN_URL;
}

/** userinfo 端点 URL（`GEMINI_USERINFO_URL` 可覆盖，便于离线自检）。 */
export function userinfoEndpoint(): string {
  return process.env["GEMINI_USERINFO_URL"] || OAUTH_USERINFO_URL;
}

/** realm 解析：单域渠道，仅支持默认端点（`GEMINI_BASE_URL` 可覆盖，便携/测试用）。 */
export function resolveBaseUrl(_realm = "auto"): string {
  const override = process.env["GEMINI_BASE_URL"];
  return override && override.trim() ? override.trim().replace(/\/+$/, "") : DEFAULT_BASE_URL;
}

// ── 过期判定 ─────────────────────────────────────────────────────────────────

/** 凭据到期时刻（毫秒）；无法解析返回 null。 */
export function expiresAtMs(c: Credentials): number | null {
  return sharedLogin.parseExpireTime(c.expiry);
}

/** 凭据是否已过期（余量 60 秒；无从判断时保守返回 false）。 */
export function isExpired(c: Credentials, leadMs = EXPIRY_LEAD_MS): boolean {
  return sharedLogin.isExpiredAt(expiresAtMs(c), leadMs);
}

// ── 授权 URL 与本地双栈回调 ──────────────────────────────────────────────────

/**
 * 构造授权 URL（参数逐字，PROTOCOL §2.2）。
 *
 * ⚠ `redirect_uri` 必须是**实际监听**的地址 —— 先监听再拼 URL（否则端口回退时
 * 会 `redirect_uri_mismatch`）。
 */
export function buildAuthorizeUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPES.join(" "),
    state,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
  });
  return `${authorizeEndpoint()}?${params.toString()}`;
}

/** 本地回调服务器：等浏览器重定向回本机端口，取出 query 参数。 */
export interface CallbackServer {
  /** 实际监听端口（须用它重算授权 URL）。 */
  readonly port: number;
  /** 等首个回调；给出 `expectedState` 时校验 state（不匹配抛错）。 */
  wait(timeoutMs: number, expectedState?: string): Promise<Record<string, string>>;
  /** 关闭服务器（幂等）。 */
  close(): void;
}

/**
 * 启动本地回调服务器（复用共享骨架 + 补 [::1] 监听）。
 *
 * ⚠ 共享的 `loginFlow.startCallbackServer` 只监听 `127.0.0.1`，而浏览器常把
 * `localhost` 解析成 IPv6（`[::1]`）—— 故这里在**共享服务器之上**补一个同端口的
 * `[::1]` 监听。两者都收到回调即 settle。IPv6 不可用的环境自动降级为只监听 IPv4
 * （浏览器会回退 IPv4，功能不受影响）。
 *
 * ⚠ **先监听再返回 port**：调用方必须用返回的 `port` 重算授权 URL。
 */
export async function startCallbackServer(
  options: { port?: number; pathPrefix?: string; html?: string } = {},
): Promise<CallbackServer> {
  const pathPrefix = options.pathPrefix ?? CALLBACK_PATH;
  const port = options.port ?? CALLBACK_PORT;

  // IPv4：复用共享原语（含端口被占回退随机端口的逻辑）
  const primary = await loginFlow.startCallbackServer({ port, pathPrefix });

  // IPv6 补层：同端口 `[::1]`
  const v6 = await startV6Companion(primary.port, pathPrefix);

  return {
    port: primary.port,
    async wait(timeoutMs: number, expectedState?: string): Promise<Record<string, string>> {
      let flat: Record<string, string>;
      const candidates: Array<Promise<Record<string, string>>> = [primary.wait(timeoutMs)];
      if (v6) candidates.push(v6.wait(timeoutMs));
      // 落败的一方稍后仍会 reject（超时/关闭）—— 先吞掉避免 unhandled rejection
      for (const p of candidates) void p.catch(() => {});
      flat = await Promise.race(candidates);
      if (expectedState !== undefined && str(flat["state"]) !== expectedState) {
        // ⚠ state 校验（PROTOCOL §2.2）：共享回调原语无法回 400，故在流程层拒绝 ——
        // 拒绝即不会走 token 交换，安全后果与非 400 一致。
        throw new Error("OAuth state 校验失败：回调 state 与本次登录不一致（已拒绝该授权）");
      }
      return flat;
    },
    close(): void {
      primary.close();
      v6?.close();
    },
  };
}

interface V6Companion {
  wait(timeoutMs: number): Promise<Record<string, string>>;
  close(): void;
}

/** 在 `[::1]:port` 上补一个监听（只做 query 提取，settle 语义与共享骨架同构）。 */
async function startV6Companion(port: number, pathPrefix: string): Promise<V6Companion | null> {
  let settle: (value: Record<string, string>) => void = () => {};
  let fail: (err: Error) => void = () => {};
  const params = new Promise<Record<string, string>>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  void params.catch(() => {});
  let settled = false;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://[::1]");
    if (pathPrefix && !url.pathname.startsWith(pathPrefix)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const flat: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (!(key in flat)) flat[key] = value; // 同名参数取第一个
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><meta charset=utf-8><title>授权完成</title><p>授权已完成，可以关闭本页。</p>");
    if (!settled) {
      settled = true;
      settle(flat);
    }
  });

  return await new Promise<V6Companion | null>((resolve) => {
    // IPv6 不可用（ENOTSUP / EADDRNOTAVAIL 等）→ 降级为只监听 IPv4，不致命
    server.once("error", () => resolve(null));
    server.listen(port, "::1", () => {
      resolve({
        wait(timeoutMs: number): Promise<Record<string, string>> {
          return new Promise<Record<string, string>>((res, rej) => {
            const timer = setTimeout(() => {
              if (!settled) {
                settled = true;
                rej(new Error(`等待授权回调超时（${Math.round(timeoutMs / 1000)} 秒）`));
              }
            }, timeoutMs);
            timer.unref?.();
            params.then(
              (value) => {
                clearTimeout(timer);
                res(value);
              },
              (err: Error) => {
                clearTimeout(timer);
                rej(err);
              },
            );
          });
        },
        close(): void {
          try {
            server.close();
            server.closeAllConnections?.();
          } catch {
            /* 已关闭 */
          }
          if (!settled) {
            settled = true;
            fail(new Error("回调服务器已关闭"));
          }
        },
      });
    });
  });
}

// ── 令牌交换与续期 ───────────────────────────────────────────────────────────

interface TokenPayload {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  scope: string;
  idToken: string;
}

/**
 * 令牌请求（exchange / refresh 共用）。
 *
 * ⚠ 表单**必须**带 `client_secret`（缺则 `invalid_request: client_secret is missing`）。
 * ⚠ **刻意不设 `User-Agent`**（伪装只用在 Cloud Code 端点）。
 */
async function postToken(form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> | null }> {
  let resp: Response;
  try {
    resp = await sharedLogin.fetchWithTimeout(
      tokenEndpoint(),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
      },
      HTTP_TIMEOUT_MS,
    );
  } catch (err) {
    throw new Error(`令牌请求失败: ${String(err)}`);
  }
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await resp.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = null;
  }
  return { status: resp.status, body };
}

/** 归一化 `expires_in`：缺失或非正数一律 3600（PROTOCOL §2.6）。 */
function normalizeExpiresIn(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number.parseInt(value.trim(), 10);
    if (n > 0) return n;
  }
  return 3600;
}

/** 由 `expires_in` 自算 RFC3339 到期时刻。 */
function expiryFromExpiresIn(expiresIn: number, nowMs = Date.now()): string {
  return new Date(nowMs + expiresIn * 1000).toISOString();
}

/** 解析令牌响应（exchange / refresh 同构）。 */
function parseTokenPayload(body: Record<string, unknown> | null): TokenPayload {
  if (!body) throw new Error("令牌响应不是合法 JSON 对象");
  const accessToken = str(body["access_token"]);
  if (!accessToken) {
    const err = str(body["error"]);
    throw new Error(
      `令牌响应里没有 access_token${err ? `（error=${err}）` : ""}`,
    );
  }
  return {
    accessToken,
    refreshToken: str(body["refresh_token"]),
    tokenType: str(body["token_type"]),
    expiresIn: normalizeExpiresIn(body["expires_in"]),
    scope: str(body["scope"]),
    idToken: str(body["id_token"]),
  };
}

/** 从 id_token 解身份（**不验签**）；缺字段返回空串。 */
function identityFromIdToken(idToken: string): { sub: string; email: string } {
  if (!idToken) return { sub: "", email: "" };
  const claims = sharedLogin.decodeJwtPayload(idToken);
  return { sub: str(claims["sub"]), email: str(claims["email"]) };
}

/** userinfo 兜底（字段名是 `id`（映射为 sub）与 `email`）。 */
async function fetchUserinfo(accessToken: string): Promise<{ sub: string; email: string }> {
  try {
    const resp = await sharedLogin.fetchWithTimeout(
      userinfoEndpoint(),
      { headers: { Authorization: `Bearer ${accessToken}` } },
      HTTP_TIMEOUT_MS,
    );
    if (!resp.ok) return { sub: "", email: "" };
    const data: unknown = await resp.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) return { sub: "", email: "" };
    const rec = data as Record<string, unknown>;
    return { sub: str(rec["id"]), email: str(rec["email"]) };
  } catch {
    return { sub: "", email: "" };
  }
}

/**
 * 用授权码换令牌（`grant_type=authorization_code`）。
 *
 * ⚠ 表单带 `client_secret`（硬约束）；**不设 User-Agent**。
 */
export async function exchangeCode(code: string, redirectUri: string): Promise<TokenPayload> {
  const { status, body } = await postToken({
    client_id: clientId(),
    client_secret: clientSecret(),
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  if (status !== 200) {
    const err = body ? str(body["error"]) : "";
    throw new Error(`授权码交换失败: HTTP ${status}${err ? `（error=${err}）` : ""}`);
  }
  return parseTokenPayload(body);
}

/** 探测 project（best-effort）：失败返回空串（上游会回落 `aicode-consumers`）。 */
async function probeProject(accessToken: string): Promise<string> {
  try {
    const resp = await sharedLogin.fetchWithTimeout(
      upstream.loadCodeAssistUrl(),
      {
        method: "POST",
        headers: upstream.buildHeaders({ accessToken }),
        body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
      },
      15_000,
    );
    if (!resp.ok) return "";
    const data: unknown = await resp.json();
    return upstream.extractProject(data);
  } catch {
    return "";
  }
}

export interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (msg: string) => void;
}

/**
 * 完整登录：起本地双栈回调 → 拼授权 URL（**先监听后拼**）→ 等回调（校验 state）→
 * 授权码换令牌 → 解身份 → 落盘。
 */
export async function login(baseUrl?: string, options: LoginOptions = {}): Promise<Credentials> {
  const { onUrl, onStatus } = options;
  const state = sharedLogin.randomHex(16); // randomBytes(16) → 32 hex
  const callback = await startCallbackServer({ pathPrefix: CALLBACK_PATH });
  try {
    const redirectUri = `http://localhost:${callback.port}${CALLBACK_PATH}`;
    const authorizeUrl = buildAuthorizeUrl(redirectUri, state);
    onUrl?.(authorizeUrl); // 拿到 URL 立刻回调（界面据此弹窗）
    onStatus?.(`已打开浏览器授权页，等待回调（本地端口 ${callback.port}）…`);
    if (process.env["GEMINI_NO_BROWSER"] !== "1") sharedLogin.openBrowser(authorizeUrl);

    const flat = await callback.wait(LOGIN_TIMEOUT_MS, state);
    const code = str(flat["code"]);
    if (!code) {
      const err = str(flat["error"]);
      throw new Error(
        `回调里没有授权码${err ? `（Google 返回 error=${err}）` : ""}`,
      );
    }
    const tokens = await exchangeCode(code, redirectUri);
    let identity = identityFromIdToken(tokens.idToken);
    if (!identity.sub || !identity.email) {
      const fallback = await fetchUserinfo(tokens.accessToken);
      identity = {
        sub: identity.sub || fallback.sub,
        email: identity.email || fallback.email,
      };
    }
    const project = await probeProject(tokens.accessToken);

    const c: Credentials = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenType: tokens.tokenType || "Bearer",
      expiresIn: tokens.expiresIn,
      scope: tokens.scope || OAUTH_SCOPES.join(" "),
      expiry: expiryFromExpiresIn(tokens.expiresIn),
      uid: identity.sub,
      email: identity.email,
      cloudaicompanionProject: project,
      domain: sharedLogin.hostOf(resolveBaseUrl(baseUrl)),
      obtainedAt: nowIso(),
    };
    await save(c);
    onStatus?.("授权成功，凭据已保存。");
    return c;
  } finally {
    callback.close();
  }
}

// ── 凭据读写 ─────────────────────────────────────────────────────────────────

/** 内存形态 → 磁盘形态（字段名与 PROTOCOL §2.1 一致，snake_case）。 */
function toDisk(c: Credentials): string {
  const disk: Record<string, unknown> = {
    access_token: c.accessToken,
    refresh_token: c.refreshToken,
    token_type: c.tokenType,
    expires_in: c.expiresIn,
    scope: c.scope,
    expiry: c.expiry, // RFC3339 字符串
    sub: c.uid,
    email: c.email,
    cloudaicompanionProject: c.cloudaicompanionProject,
  };
  if (c.obtainedAt) disk["obtained_at"] = c.obtainedAt;
  return `${JSON.stringify(disk, null, 2)}\n`;
}

/** 文件缺失 / 损坏 / 无 access_token → NotLoggedInError。老凭据缺新字段时能补就补。 */
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
  const accessToken = str(rec["access_token"] ?? rec["accessToken"]);
  if (!accessToken) throw new NotLoggedInError();

  const expiresInRaw = rec["expires_in"];
  return {
    accessToken,
    refreshToken: str(rec["refresh_token"] ?? rec["refreshToken"]),
    tokenType: str(rec["token_type"] ?? rec["tokenType"]),
    expiresIn: normalizeExpiresIn(expiresInRaw),
    scope: str(rec["scope"]),
    expiry: str(rec["expiry"] ?? rec["expiresAt"]),
    uid: str(rec["sub"] ?? rec["uid"]),
    email: str(rec["email"]),
    cloudaicompanionProject: str(
      rec["cloudaicompanionProject"] ?? rec["cloudaicompanion_project"] ?? rec["project"],
    ),
    domain: str(rec["domain"]),
    obtainedAt: str(rec["obtained_at"] ?? rec["obtainedAt"]),
  };
}

/** load() 的宽容版：任何失败返回 null。 */
function tryLoad(): Credentials | null {
  try {
    return load();
  } catch {
    return null;
  }
}

/** 以 0600 权限原子写入凭据（临时文件 + rename）。 */
export async function save(c: Credentials): Promise<void> {
  ensureDir();
  const path = credentialsPath();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, toDisk(c), "utf8");
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

// ── 续期 ─────────────────────────────────────────────────────────────────────

/**
 * 续期串行队列。
 *
 * ⚠ **Google 对 refresh_token 有重放检测**：交错请求会让其中一次拿到
 * `invalid_grant`，进而被误判成「终态失效」把好账号标死（PROTOCOL §7）。
 */
let refreshQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = refreshQueue.then(task, task);
  refreshQueue = run.catch(() => {});
  return run;
}

/**
 * 用 refresh_token 换新令牌（**必须带 client_secret**）。
 *
 * ⚠ Google 偶尔轮换 refresh_token：响应给了新的必须回写。
 * ⚠ 终态判定前先确认「刚才用的那一份 refresh_token 还是不是当前那一份」——
 * 并发下服务端拒的是旧的那份，磁盘上此刻躺着一份新的可用凭据，
 * 这属于「他处已续成功」，不加这层判据一次交错就会把好账号永久标死。
 */
export function refresh(c: Credentials): Promise<Credentials> {
  return serialize(() => refreshInner(c));
}

async function refreshInner(passedIn: Credentials): Promise<Credentials> {
  // 先重读凭据：内存里的那份可能已被其它入口轮换过
  const current = tryLoad();
  const source = current && current.refreshToken ? current : passedIn;
  const refreshToken = source.refreshToken;
  if (!refreshToken) {
    throw new RefreshTokenExpiredError("凭据里没有 refresh_token，需要重新登录");
  }

  const { status, body } = await postToken({
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  if (status !== 200) {
    const err = body ? str(body["error"]) : "";
    const termHint = /invalid_grant|invalid_request/i.test(err) || status === 400 || status === 401;
    if (termHint) {
      // 终态判定前先确认那份 refresh_token 是否还是当前那份
      const latest = tryLoad();
      if (latest && latest.refreshToken && latest.refreshToken !== refreshToken) {
        return latest; // 他处已续成功
      }
      throw new RefreshTokenExpiredError(
        `刷新令牌已失效（HTTP ${status}${err ? ` error=${err}` : ""}），请重新登录`,
      );
    }
    throw new Error(`续期失败（可重试）: HTTP ${status}${err ? ` error=${err}` : ""}`);
  }

  let tokens: TokenPayload;
  try {
    tokens = parseTokenPayload(body);
  } catch (err) {
    const latest = tryLoad();
    if (latest && latest.refreshToken && latest.refreshToken !== refreshToken) return latest;
    throw new RefreshTokenExpiredError(String(err));
  }

  const next: Credentials = {
    accessToken: tokens.accessToken,
    // ⚠ Google 偶尔轮换 refresh_token：新值优先，缺则保留旧的
    refreshToken: tokens.refreshToken || refreshToken,
    tokenType: tokens.tokenType || source.tokenType || "Bearer",
    expiresIn: tokens.expiresIn,
    scope: tokens.scope || source.scope,
    expiry: expiryFromExpiresIn(tokens.expiresIn),
    uid: source.uid,
    email: source.email,
    cloudaicompanionProject: source.cloudaicompanionProject,
    domain: source.domain,
    obtainedAt: nowIso(),
  };
  await save(next);
  return next;
}

/** 在系统浏览器打开 URL（转发共享层原语；失败不影响流程）。 */
export function openBrowser(url: string): void {
  sharedLogin.openBrowser(url);
}
