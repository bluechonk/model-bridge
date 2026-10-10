/**
 * Raccoon（商汤小浣熊）认证：手机号 AES-128-CFB 加密、网页登录（授权码）/短信登录、
 * 续期与凭据持久化。
 *
 * ## 本模块承载的渠道知识（每条都是实测结论，见 docs/protocols/raccoon/PROTOCOL.md）
 *
 * 1. **手机号必须 AES-128-CFB 加密**（密钥 `senseraccoon2023`，16 字节 ⇒ AES-128，
 *    输出 `base64(iv ‖ ciphertext)`）。**不加密的后果**：`send_sms` 回
 *    `100003 params_encryted_error`。
 *    ⚠ 零依赖：用 `node:crypto` 的 `createCipheriv("aes-128-cfb", …)`（CFB128）；
 *    密钥是 16 字节，写成 `aes-256-cfb` 会因长度不足而抛错。
 * 2. **网页登录走 `/code/authorize` 授权码链路**（官方桌面端
 *    `electron/main/desktopLogin.js` 同款）：`login_source=desktop` +
 *    `appname=办公小浣熊客户端` → 登录成功回调 `office-raccoon://auth/callback?code=…`
 *    → `POST …/login_with_authorization_code` 换 token。回调由**用户把整条 URL
 *    粘贴回来**（本插件是宿主机里的普通 Node 进程，注册不了自定义协议）。
 *    ⚠ 别用 `/login/mp?code=…` 那条：它只给**官方手机 App 扫码**用，网页端没有该
 *    路由，浏览器打开是死链（真机踩过）。
 * 3. **过期时间取值优先级**：`expires_at`（显式）→ **JWT 的 `exp`**（本地 base64url
 *    解码 payload，**只解码不验签**）。回退到 JWT 是**必需的**：老凭据/手工导入的
 *    凭据可能没有 `expires_at`，只读它会让过期判定**恒为 false** → `refreshAll`
 *    永远跳过这些账号 → 「凭据悄悄过期、续期从不触发」的静默失效。
 * 4. **续期只返回新的 access_token 时必须保留旧 refresh_token** ——
 *    否则续期一次就把账号变成不可续期。HTTP 401 **或** `code === 200003` 是终态
 *    （提示重新登录，**不重试**）。
 * 5. **`nickname` 是服务端自动生成的默认名**（实测 `RaccoonAva`），登录**不回传**
 *    用户昵称 —— 多账号消歧要靠 `phone`（`uid` 优先 `user_id`，其次 `phone`）。
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

import { credentialsPath, ensureDir, login as sharedLogin } from "@model-bridge/gateway";

/** 接口基址。 */
export const DEFAULT_BASE_URL = "https://xiaohuanxiong.com";

export const AUTH_PREFIX = "/api/web/auth/v1";
export const LLM_PREFIX = "/api/web/llm/v2";
export const POINTS_PREFIX = "/api/web/points/v1";
export const DESKTOP_PREFIX = "/api/web/desktop/v1";

export const SEND_SMS_PATH = `${AUTH_PREFIX}/send_sms`;
export const LOGIN_WITH_SMS_PATH = `${AUTH_PREFIX}/login_with_sms`;
export const REFRESH_PATH = `${AUTH_PREFIX}/refresh`;
export const USER_INFO_PATH = `${AUTH_PREFIX}/user_info`;
/** 授权码换凭证（网页登录第二步）。 */
export const EXCHANGE_PATH = `${AUTH_PREFIX}/login_with_authorization_code`;

/** 上游约定：授权码不存在 / 已过期 / 已消费（换码时按终态处理）。 */
export const AUTHORIZATION_CODE_NOT_FOUND = 200035;

/** 客户端身份（`X-Client-Platform` 猜错会被拒）。 */
export const CLIENT_PLATFORM = "desktop-windows";
export const CLIENT_VERSION = "v1.0.35";
export const USER_AGENT = "Raccoon Work/1.0.35 (Windows)";

/** 手机号加密密钥（**公开常量**，客户端硬编码在前端 bundle 里，不是安全边界）。 */
export const PHONE_CIPHER_SECRET = Buffer.from("senseraccoon2023", "utf8");

/** access_token 寿命约 3 小时（实测 `exp - nbf = 10805s`），提前 300s 视为需要续期。 */
export const TOKEN_REFRESH_WINDOW_SECONDS = 300;

/** 等待用户完成网页登录（粘贴回调）的时限。 */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// ── 网页登录（授权码）常量 ────────────────────────────────────────────────────

/** 授权页路径（官方桌面端同款）。 */
export const AUTHORIZE_PATH = "/code/authorize";
/** 官方桌面端上报的登录来源。 */
export const AUTHORIZE_LOGIN_SOURCE = "desktop";
/** 官方桌面端上报的客户端名（**不是** 网站自己的「小浣熊官网」）。 */
export const AUTHORIZE_APPNAME = "办公小浣熊客户端";
/** 回调深链（官方客户端注册的自定义协议；我们靠用户粘贴回收）。 */
export const CALLBACK_SCHEME = "office-raccoon";
export const CALLBACK_HOST = "auth";
export const CALLBACK_PATH = "/callback";

const HTTP_TIMEOUT_MS = 60_000;
const NOT_LOGGED_IN_MSG = "No usable credential found, run `raccoon login` first";

/** 磁盘上没有可用凭据。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message: string = NOT_LOGGED_IN_MSG) {
    super(message);
  }
}

/** 登录态已过期（终态，重试无用，必须重新登录）。 */
export class RefreshTokenExpiredError extends Error {
  override name = "RefreshTokenExpiredError";
}

/** 磁盘布局（snake_case；兼容 camelCase 读取）。 */
export interface Credentials {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** `user_id`（来自 JWT `sub`）优先，其次 `phone` —— 服务端 `name` 是自动生成的默认名。 */
  readonly uid: string;
  /** Raccoon 端点固定 → 恒空串。 */
  readonly domain: string;
  readonly officeIdentity: string;
  readonly userId: string;
  readonly nickname: string;
  readonly phone: string;
  /** 设备指纹（32 位 hex）。 */
  readonly deviceId: string;
  /** **毫秒时间戳字符串**（显式字段优先，其次 JWT `exp` 推算）。 */
  readonly expiresAt: string;
  readonly obtainedAt: string;
  readonly source: string;
}

export const EMPTY_CREDENTIALS: Credentials = {
  accessToken: "",
  refreshToken: "",
  uid: "",
  domain: "",
  officeIdentity: "",
  userId: "",
  nickname: "",
  phone: "",
  deviceId: "",
  expiresAt: "",
  obtainedAt: "",
  source: "",
};

/** 取值收窄（转发共享层原语）。 */
const str = sharedLogin.str;

/** 当前时间的 ISO 字串（转发共享层原语）。 */
const nowIso = sharedLogin.nowIso;

/** 生成 32 位 hex 设备指纹 / 扫码 code（转发共享层原语）。 */
export function randomHex32(): string {
  return sharedLogin.randomHex(16);
}

// ── 手机号加密（AES-128-CFB）──────────────────────────────────────────────────

/**
 * 手机号加密：`base64(iv ‖ ciphertext)`。
 *
 * ⚠ iv 每次随机（同一明文两次密文不同）；CFB 是流密码，密文与明文等长。
 */
export function encryptPhone(phone: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cfb", PHONE_CIPHER_SECRET, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(phone, "utf8")), cipher.final()]);
  return Buffer.concat([iv, ciphertext]).toString("base64");
}

/** 解密（仅供测试/诊断：验证本地加密确实可逆）。 */
export function decryptPhone(blob: string): string {
  const raw = Buffer.from(blob, "base64");
  const iv = raw.subarray(0, 16);
  const decipher = createDecipheriv("aes-128-cfb", PHONE_CIPHER_SECRET, iv);
  return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString("utf8");
}

/** 手机号本地校验（与客户端一致）。 */
export function isValidPhone(phone: string): boolean {
  return /^1[3-9]\d{9}$/.test(phone);
}

// ── JWT / 过期判定 ────────────────────────────────────────────────────────────

/** 解码 JWT 载荷（**只解码不验签**；转发共享层原语）。 */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  return sharedLogin.decodeJwtPayload(token);
}

/** 从 JWT 取 `sub`（服务端的用户 id；转发共享层原语）。 */
export function jwtSubject(token: string): string {
  return sharedLogin.jwtSubject(token);
}

/**
 * 过期时刻（毫秒）：**显式 `expires_at` 优先，其次 JWT 的 `exp`**。
 * 都无法解析时返回 null（**不编造**）。转发共享层原语。
 */
export function expiresAtMs(c: Credentials): number | null {
  const explicit = Number.parseInt(c.expiresAt || "0", 10);
  return sharedLogin.resolveExpiresAtMs(
    Number.isFinite(explicit) && explicit > 0 ? explicit : undefined,
    c.accessToken,
  );
}

/** 是否已过期（`expires_at` 缺失时回退 JWT `exp`；都未知则保守 false）。 */
export function isExpired(c: Credentials, leadSeconds = 0): boolean {
  return sharedLogin.isExpiredAt(expiresAtMs(c), leadSeconds * 1000);
}

// ── 业务信封 ──────────────────────────────────────────────────────────────────

/**
 * 业务信封判据（raccoon-oauth.ts:62-73）：
 * `code = record.code if isinstance(record.code, int) else (status if status >= 400 else 0)`。
 *
 * ⚠ 失败可能带 HTTP 400/401，也可能 HTTP 200 + 非 0 code。
 */
export function envelopeCode(payload: unknown, status: number): number {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const code = (payload as Record<string, unknown>)["code"];
    if (typeof code === "number" && Number.isFinite(code)) return code;
  }
  return status >= 400 ? status : 0;
}

/** 错误消息：`message` 与 `details` 用 `: ` 连接。 */
export function envelopeMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const rec = payload as Record<string, unknown>;
  const message = str(rec["message"]);
  const details = typeof rec["details"] === "string" ? rec["details"] : "";
  return [message, details].filter(Boolean).join(": ");
}

function baseUrl(override?: string): string {
  return (override || process.env["RACCOON_API_BASE_URL"] || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 请求头（见 upstream.buildHeaders 的三种形态说明）。 */
function headers(c: Credentials, opts: { jsonBody?: boolean; platform?: boolean } = {}): Record<string, string> {
  const out: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${c.accessToken}`,
    "X-Org-Code": c.officeIdentity || "",
    "X-Raccoon-Language": "zh",
    "User-Agent": USER_AGENT,
  };
  if (opts.jsonBody) out["Content-Type"] = "application/json";
  if (opts.platform) {
    out["X-Client-Platform"] = CLIENT_PLATFORM;
    out["X-Client-Version"] = CLIENT_VERSION;
    if (c.deviceId) out["X-Client-Device-ID"] = c.deviceId;
  }
  return out;
}

interface ApiResult {
  status: number;
  code: number;
  payload: Record<string, unknown>;
  data: Record<string, unknown>;
}

/** 发一个业务请求并解析信封（不抛业务码错误，由调用方判定）。 */
async function apiCall(
  url: string,
  init: { method: string; body?: string; headers: Record<string, string>; timeoutMs?: number },
): Promise<ApiResult> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(init.timeoutMs ?? HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Request ${url} failed: ${String(err)}`);
  }
  let payload: unknown = null;
  try {
    payload = await resp.json();
  } catch {
    /* 非 JSON（网关错误页）→ envelopeCode 按状态码推导 */
  }
  const code = envelopeCode(payload, resp.status);
  const record = isRecord(payload) ? payload : {};
  const data = isRecord(record["data"]) ? record["data"] : {};
  return { status: resp.status, code, payload: record, data };
}

// ── 网页登录（授权码） ────────────────────────────────────────────────────────

export interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (message: string) => void;
  /**
   * 回调 URL 的来源。优先级：本字段 → 环境变量 `RACCOON_LOGIN_CALLBACK` → stdin。
   * 正式 CLI 不传（提示用户粘贴）；测试与脚本用它注入。
   */
  callback?: string | (() => Promise<string>);
  /** 等待回调的时限（默认 5 分钟）。 */
  timeoutMs?: number;
}

/** 一次登录的 state（32 位 hex）；回调时逐字比对，防「别人的 code 换进你的账号」。 */
export function newLoginState(): string {
  return randomHex32();
}

/**
 * 授权页 URL（官方桌面端「网页登录」入口，实测自 `electron/main/desktopLogin.js`）。
 *
 * ⚠ 不要用 `/login/mp?code=…`：那条只给**官方手机 App 扫码**用，网页端没有该路由，
 * 浏览器打开是死链（真机踩过，见 docs/protocols/raccoon/PROTOCOL.md §2.4）。
 * 我们额外带 `state`（官方不带）；参考实现（agent2api / xiaohuanxiong2api）同样带。
 */
export function authorizeUrl(state: string, baseOverride?: string): string {
  const url = new URL(AUTHORIZE_PATH, baseUrl(baseOverride));
  url.searchParams.set("login_source", AUTHORIZE_LOGIN_SOURCE);
  url.searchParams.set("appname", AUTHORIZE_APPNAME);
  url.searchParams.set("state", state);
  return url.toString();
}

/** 回调 URL 不合法（协议/主机/路径不对、缺 code、state 不匹配）。 */
export class LoginCallbackError extends Error {
  override name = "LoginCallbackError";
}

export interface LoginCallback {
  code: string;
  /** 是否逐字校验过 state（裸 code 兜底路径与「回调没带 state」均为 false）。 */
  stateVerified: boolean;
}

/**
 * 解析回调 URL：`office-raccoon://auth/callback?code=…&state=…`。
 *
 * 逐项比对 scheme/host/path —— 不能前缀匹配（`office-raccoon://auth/callback@evil`
 * 会被前缀放行）。state 的处置：带且不等 → 拒绝（这条回调不属于本次登录）；
 * 没带 → 放行但标记未校验（官方页面的回调形态可能不带 state）。
 * 兜底：整段文本不是 URL 但像授权码时按裸 code 处理（stateVerified=false）。
 */
export function parseLoginCallback(raw: string, expectedState = ""): LoginCallback {
  const text = (raw ?? "").trim();
  if (!text) throw new LoginCallbackError("empty callback");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    if (/^[A-Za-z0-9._~-]{6,}$/.test(text)) return { code: text, stateVerified: false };
    throw new LoginCallbackError(`not a callback url: ${text.slice(0, 120)}`);
  }
  if (url.protocol !== `${CALLBACK_SCHEME}:`) {
    throw new LoginCallbackError(`unexpected scheme: ${url.protocol}`);
  }
  if (url.hostname.toLowerCase() !== CALLBACK_HOST) {
    throw new LoginCallbackError(`unexpected callback host: ${url.hostname}`);
  }
  if (url.pathname !== CALLBACK_PATH) {
    throw new LoginCallbackError(`unexpected callback path: ${url.pathname}`);
  }
  const code = (url.searchParams.get("code") ?? "").trim();
  if (!code) throw new LoginCallbackError("callback has no code");
  const state = (url.searchParams.get("state") ?? "").trim();
  if (expectedState && state && state !== expectedState) {
    throw new LoginCallbackError("state mismatch: the callback belongs to another login attempt");
  }
  return { code, stateVerified: Boolean(expectedState && state === expectedState) };
}

/** 从 stdin 读一行（提示写 stderr —— `--json` 时 stdout 要保持干净的 JSON 流）。 */
function readLineFromStdin(prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let settled = false;
    rl.question(prompt, (answer) => {
      settled = true;
      rl.close();
      resolve(answer);
    });
    rl.once("close", () => {
      if (!settled) reject(new Error("stdin closed before a callback url was provided"));
    });
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** 取回调 URL：注入值 → 环境变量 → stdin 粘贴。 */
async function resolveCallback(options: LoginOptions, timeoutMs: number): Promise<string> {
  const injected = options.callback;
  if (typeof injected === "string" && injected.trim()) return injected.trim();
  if (typeof injected === "function") {
    return withTimeout(injected(), timeoutMs, "waiting for login callback");
  }
  const env = (process.env["RACCOON_LOGIN_CALLBACK"] ?? "").trim();
  if (env) return env;
  if (process.stdin.isTTY || !process.stdin.readableEnded) {
    return withTimeout(
      readLineFromStdin("Paste the full callback url from the browser, then press Enter:\n> "),
      timeoutMs,
      "waiting for pasted callback",
    );
  }
  throw new Error(
    "no callback provided and stdin is not interactive; run login in a terminal or set RACCOON_LOGIN_CALLBACK",
  );
}

/**
 * 网页登录：授权页 → 用户登录 → 回收回调 URL → 授权码换凭证。
 *
 * 回调回收方式见 `resolveCallback`（本插件注册不了 `office-raccoon://` 自定义协议，
 * 所以由用户把地址栏里的整条 URL 粘贴回来 —— 与参考实现 agent2api 的 Docker 形态一致）。
 */
export async function login(baseUrlOverride?: string, options: LoginOptions = {}): Promise<Credentials> {
  const { onUrl, onStatus } = options;
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;

  const state = newLoginState();
  onUrl?.(authorizeUrl(state, baseUrlOverride));
  onStatus?.(
    "Log in with WeChat / SMS / password in the browser; then paste the callback url (office-raccoon://auth/callback?...) back here",
  );

  const raw = await resolveCallback(options, timeoutMs);
  const parsed = parseLoginCallback(raw, state);
  if (!parsed.stateVerified) {
    onStatus?.("callback state not verified (missing state in callback); proceeding");
  }

  const result = await apiCall(`${baseUrl(baseUrlOverride)}${EXCHANGE_PATH}`, {
    method: "POST",
    headers: headers(EMPTY_CREDENTIALS, { jsonBody: true }),
    body: JSON.stringify({ authorization_code: parsed.code }),
  });
  if (result.code === AUTHORIZATION_CODE_NOT_FOUND) {
    throw new Error("authorization code expired or already consumed; please run login again");
  }
  if (result.code !== 0) {
    throw new Error(`Code exchange failed: code=${result.code} ${envelopeMessage(result.payload)}`);
  }
  const accessToken = str(result.data["access_token"]);
  const refreshToken = str(result.data["refresh_token"]);
  if (!accessToken || !refreshToken) throw new Error("Code exchange response has no tokens");

  let c = credentialsFromLogin(accessToken, refreshToken, result.data, "raccoon-web");
  // 昵称/手机号只用于展示：补一次 user_info（失败不影响登录）
  try {
    const info = await fetchUserInfo(c, baseUrlOverride);
    c = {
      ...c,
      phone: str(info["phone"]) || c.phone,
      nickname: str(info["name"]) || c.nickname, // 服务端 name 是自动生成的默认名
      officeIdentity: c.officeIdentity || str(info["office_identity"]),
    };
  } catch {
    /* 失败不影响登录 */
  }
  await save(c);
  return c;
}

function credentialsFromLogin(
  accessToken: string,
  refreshToken: string,
  data: Record<string, unknown>,
  source: string,
): Credentials {
  const userId = jwtSubject(accessToken);
  const deviceId = str(data["device_id"]) || randomHex32();
  return {
    ...EMPTY_CREDENTIALS,
    accessToken,
    refreshToken,
    uid: userId,
    officeIdentity: str(data["office_identity"]),
    userId,
    nickname: str(data["nickname"]),
    phone: str(data["phone"]),
    deviceId,
    expiresAt: expiresAtMs({ ...EMPTY_CREDENTIALS, accessToken, expiresAt: "" })?.toString() ?? "",
    obtainedAt: nowIso(),
    source,
  };
}

/** 短信登录：`send_sms`（需阿里云滑块 captcha_param）→ `login_with_sms`。 */
export async function sendSms(phone: string, captchaParam = "", baseOverride?: string): Promise<void> {
  if (!isValidPhone(phone)) throw new Error(`Invalid phone number: ${phone}`);
  const result = await apiCall(`${baseUrl(baseOverride)}${SEND_SMS_PATH}`, {
    method: "POST",
    headers: headers(EMPTY_CREDENTIALS, { jsonBody: true, platform: true }),
    body: JSON.stringify({
      captcha_param: captchaParam,
      nation_code: "86",
      // ⚠ 手机号必须 AES-128-CFB 加密，否则 100003 params_encryted_error
      phone: encryptPhone(phone),
    }),
  });
  if (result.code !== 0) {
    throw new Error(`Failed to send SMS: code=${result.code} ${envelopeMessage(result.payload)}`);
  }
}

/** 短信验证码登录（body 里的手机号同样是密文）。 */
export async function loginWithSms(
  phone: string,
  smsCode: string,
  baseOverride?: string,
): Promise<Credentials> {
  const result = await apiCall(`${baseUrl(baseOverride)}${LOGIN_WITH_SMS_PATH}`, {
    method: "POST",
    headers: headers(EMPTY_CREDENTIALS, { jsonBody: true, platform: true }),
    body: JSON.stringify({ nation_code: "86", phone: encryptPhone(phone), sms_code: smsCode }),
  });
  if (result.code !== 0) {
    throw new Error(`SMS login failed: code=${result.code} ${envelopeMessage(result.payload)}`);
  }
  const accessToken = str(result.data["access_token"]);
  const refreshToken = str(result.data["refresh_token"]);
  if (!accessToken) throw new Error("SMS login response has no access_token");
  const c: Credentials = {
    ...credentialsFromLogin(accessToken, refreshToken, result.data, "raccoon-sms"),
    phone,
  };
  await save(c);
  return c;
}

// ── 续期 ──────────────────────────────────────────────────────────────────────

/**
 * 续期：`POST {AUTH}/refresh` body `{refresh_token}`。
 *
 * - HTTP 401 **或** `code === 200003` → 终态（「登录态已过期，请重新登录」）
 * - 服务端可能**只返回新的 access_token** → **保留旧 refresh_token**
 * - 服务端不返回的附加字段（昵称、身份、设备号）也要保留
 */
export async function refresh(c: Credentials, baseOverride?: string): Promise<Credentials> {
  if (!c.refreshToken) throw new RefreshTokenExpiredError("Credential has no refresh_token, cannot refresh");
  const result = await apiCall(`${baseUrl(baseOverride)}${REFRESH_PATH}`, {
    method: "POST",
    headers: headers(EMPTY_CREDENTIALS, { jsonBody: true }),
    body: JSON.stringify({ refresh_token: c.refreshToken }),
  });
  if (result.status === 401 || result.code === 200003) {
    throw new RefreshTokenExpiredError("Login state expired, please log in again");
  }
  if (result.code !== 0) {
    throw new Error(`Refresh failed: code=${result.code} ${envelopeMessage(result.payload)}`);
  }
  const accessToken = str(result.data["access_token"]);
  if (!accessToken) throw new Error("Refresh response has no access_token (retryable)");
  const refreshToken = str(result.data["refresh_token"]) || c.refreshToken;
  const next: Credentials = {
    ...c, // 附加字段（昵称、身份、设备号）全部保留
    accessToken,
    refreshToken,
    uid: jwtSubject(accessToken) || c.userId || c.phone,
    userId: jwtSubject(accessToken) || c.userId,
    expiresAt:
      expiresAtMs({ ...c, accessToken, expiresAt: "" })?.toString() ?? c.expiresAt,
    obtainedAt: nowIso(),
  };
  await save(next);
  return next;
}

// ── 用户信息 ──────────────────────────────────────────────────────────────────

/** 用户信息（**失败返回空对象而不是抛错**：只用于昵称展示）。 */
export async function fetchUserInfo(
  c: Credentials,
  baseOverride?: string,
): Promise<Record<string, unknown>> {
  try {
    const result = await apiCall(`${baseUrl(baseOverride)}${USER_INFO_PATH}`, {
      method: "GET",
      headers: headers(c),
    });
    if (result.code !== 0) return {};
    return result.data;
  } catch {
    return {};
  }
}

/**
 * 昵称修复（启动时主动补一次）：**幂等**，已有 `phone` 就不再拉；
 * **不发写请求**（只 GET user_info），失败不阻塞启动。
 */
export async function syncProfile(c: Credentials, baseOverride?: string): Promise<Credentials> {
  if (c.phone) return c; // 已有 phone → 不再请求（幂等）
  const info = await fetchUserInfo(c, baseOverride);
  const phone = str(info["phone"]);
  const name = str(info["name"]);
  if (!phone && !name) return c;
  const next: Credentials = {
    ...c,
    phone: phone || c.phone,
    nickname: c.nickname || name, // 不覆盖已有昵称
    officeIdentity: c.officeIdentity || str(info["office_identity"]),
    uid: c.userId || phone || c.phone,
  };
  await save(next);
  return next;
}

// ── 凭据落盘 ──────────────────────────────────────────────────────────────────

function writeSyncAtomic(path: string, payload: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/**
 * 读凭据。
 *
 * - 文件缺失 / JSON 损坏 / 缺 `access_token` → `NotLoggedInError`
 * - **老凭据缺 `device_id` → 补生成 32 位 hex 并写回磁盘**（不拒绝整条凭据）
 * - `expires_at` 缺失 → 由 JWT `exp` 推算（静默失效的根源，见文件头注释 3）
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
    throw new NotLoggedInError(`Credential file is corrupted (${credentialsPath()}), please log in again`);
  }
  if (!isRecord(data)) throw new NotLoggedInError("Credential file has an invalid structure, please log in again");
  const accessToken = str(data["access_token"] ?? data["accessToken"]);
  if (!accessToken) throw new NotLoggedInError();

  const refreshToken = str(data["refresh_token"] ?? data["refreshToken"]);
  const officeIdentity = str(data["office_identity"] ?? data["officeIdentity"]);
  const userId = str(data["user_id"] ?? data["userId"]);
  const nickname = str(data["nickname"]);
  const phone = str(data["phone"]);
  const obtainedAt = str(data["obtained_at"] ?? data["obtainedAt"]);
  let deviceId = str(data["device_id"] ?? data["deviceId"]);
  const expiresAt =
    str(data["expires_at"] ?? data["expiresAt"]) ||
    (expiresAtMs({ ...EMPTY_CREDENTIALS, accessToken, expiresAt: "" })?.toString() ?? "");

  let patchNeeded = false;
  if (!deviceId) {
    deviceId = randomHex32();
    patchNeeded = true;
  }
  const c: Credentials = {
    accessToken,
    refreshToken,
    uid: userId || phone,
    domain: "",
    officeIdentity,
    userId,
    nickname,
    phone,
    deviceId,
    expiresAt,
    obtainedAt,
    source: str(data["source"]),
  };
  if (patchNeeded) {
    // 老凭据补字段后写回（不拒绝整条凭据）；load 是同步函数 → 同步原子写
    try {
      ensureDir();
      writeSyncAtomic(credentialsPath(), {
        access_token: c.accessToken,
        refresh_token: c.refreshToken,
        office_identity: c.officeIdentity,
        user_id: c.userId,
        nickname: c.nickname,
        phone: c.phone,
        device_id: c.deviceId,
        expires_at: c.expiresAt,
        obtained_at: c.obtainedAt,
        source: c.source,
      });
    } catch {
      /* 写不回也不影响本次读取 */
    }
  }
  return c;
}

/** 原子写凭据（0600）。 */
export async function save(c: Credentials): Promise<void> {
  ensureDir();
  const path = credentialsPath();
  const tmp = `${path}.tmp`;
  const payload = {
    access_token: c.accessToken,
    refresh_token: c.refreshToken,
    office_identity: c.officeIdentity,
    user_id: c.userId,
    nickname: c.nickname,
    phone: c.phone,
    device_id: c.deviceId,
    expires_at: c.expiresAt,
    obtained_at: c.obtainedAt || nowIso(),
    source: c.source,
  };
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

/** 登录基址：Raccoon 端点固定，无 realm 概念（参数仅为满足契约）。 */
export function resolveBaseUrl(_realm = "auto"): string {
  return baseUrl();
}
