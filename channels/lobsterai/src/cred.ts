/**
 * LobsterAI 凭据：浏览器授权登录（本地回调 + authCode）、凭据持久化与静默续期。
 *
 * ## 与 CodeBuddy 系最大的结构差异
 *
 * `POST /api/auth/refresh` 的请求体**不是只带 refreshToken**，还要带
 * `firstKeyfrom` / `latestKeyfrom` / `uuid` —— 这三个字段是登录那一刻生成的
 * 客户端状态，服务端不返回，**丢了就只能重新登录**（`lobsterai.ts:72-77`）。
 * 故它们是凭据的一等字段，落盘时必须原样保留。
 *
 * ## 落盘字段名刻意保持 snake_case
 *
 * 内存里用 TS 惯用的 camelCase，磁盘上写 `access_token` / `first_keyfrom` /
 * `latest_keyfrom` / `user_id` / `expires_at` —— 与旧实现同形：
 * 用户从旧实现迁移过来时**无需重新登录**（`load()` 同时认两种写法）。
 *
 * ## 登录/续期的终点判定
 *
 * - 续期：HTTP 401/403 → 终态；信封失败且 `classifyError` 判出 `session-dead`
 *   → 终态；`code:0` 但 `accessToken` 为空 → 终态；其余（网络抖动 / 5xx / 429）
 *   → 普通 Error，走可重试路径。
 * - `latestKeyfrom` **刻意不更新为当前时刻**：严格对齐旧实现
 *   （只改 token 与过期时间，`LatestKeyfrom` 永久停在登录那一刻），续期时原样回发。
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

import { credentialsPath, ensureDir, login as sharedLogin } from "@model-bridge/gateway";
import * as upstream from "./upstream.js";

/**
 * 上游 API 基址。
 *
 * 与 `upstream.DEFAULT_BASE_URL` 同源（单一真相源在 upstream；那里不导入 cred，
 * 因此这里单向引用不会形成循环）。
 */
export const DEFAULT_BASE_URL = upstream.DEFAULT_BASE_URL;

/** 登录门户基址（与 API 同 IP 不同路径）。 */
export const DEFAULT_PORTAL_BASE = "https://lobsterai.youdao.com";

/** 本地回调路径（对齐 Go `cmd/login/main.go` 的 `callbackPath`）。 */
export const CALLBACK_PATH = "/auth/callback";

/** 登录流程总超时（10 分钟，对齐 Go 的回调窗口）。 */
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/** 控制面请求超时（exchange / refresh；对话流式请求不适用）。 */
export const REQUEST_TIMEOUT_MS = 30_000;

const NOT_LOGGED_IN_MSG = "no credentials found; start the gateway to log in";

/** 磁盘上不存在可用凭据。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message: string = NOT_LOGGED_IN_MSG) {
    super(message);
  }
}

/** 刷新令牌已被服务端作废：重试无意义，只能重新登录。 */
export class RefreshTokenExpiredError extends Error {
  override name = "RefreshTokenExpiredError";
}

/**
 * 一份凭据。
 *
 * `domain` 恒为空串 —— LobsterAI 是单一域名渠道，契约仍要求该字段存在。
 */
export interface Credentials {
  /** 推理用的访问令牌（契约要求的属性名；磁盘字段为 `access_token`）。 */
  readonly accessToken: string;
  readonly refreshToken: string;
  /** 毫秒时间戳字符串（`expiresIn` 相对秒 → 当前时刻换算，或 JWT exp）。 */
  readonly expiresAt: string;
  /** 账号唯一 ID（四级回退：user.id → user.userId → user.yid → sha256(token)[:16]）。 */
  readonly uid: string;
  /** 有道 yid（refresh 请求体里的 `userId`，与 uid 不一定相同）。 */
  readonly userId: string;
  readonly nickname: string;
  /** 安装 UUID：exchange/refresh 必带，**不能每次刷新都重新生成**。 */
  readonly uuid: string;
  /** 首次登录时间戳（毫秒字符串）。 */
  readonly firstKeyfrom: string;
  /** 最近活动时间戳（毫秒字符串）—— 刻意停在登录那一刻，续期原样回发。 */
  readonly latestKeyfrom: string;
  /** 绑定的域；本渠道无此概念，恒 `""`。 */
  readonly domain: string;
  readonly obtainedAt: string;
  readonly source: string;
}

export const EMPTY_CREDENTIALS: Credentials = {
  accessToken: "",
  refreshToken: "",
  expiresAt: "",
  uid: "",
  userId: "",
  nickname: "",
  uuid: "",
  firstKeyfrom: "",
  latestKeyfrom: "",
  domain: "",
  obtainedAt: "",
  source: "",
};

/**
 * 取值收窄：本例**额外接受有限数字**（上游信封里 uid 等字段可能是数字），
 * 故不转发共享层的 `str`（那个只放行字符串）。
 */
function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** 当前时间的 ISO 字串（转发共享层原语）。 */
const nowIso = sharedLogin.nowIso;

/** 从 JWT 载荷提取 `exp` → 毫秒（转发共享层原语）。 */
function jwtExpMs(token: string): number {
  return sharedLogin.jwtExpMs(token);
}

/**
 * uid 末级回退：`sha256(accessToken)` 的 hex 前 16 位。
 *
 * 与 Go 的 `fmt.Sprintf("%x", sha256.Sum256(...))[:16]` 逐字节一致 ——
 * 这是与 `lobsterai2api` 生成的凭据文件对照的前提。
 * ⚠️ 刻意**不在 yid 与哈希之间插 JWT `sub`**：Go 没有这一级，
 * 插进去会让同一账号在两边得到不同 uid（见 PROTOCOL §2.4）。
 */
export function uidFallbackHash(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
}

/** uid 四级回退（登录/续期响应的 user 对象）。 */
export function uidFromUser(user: Record<string, unknown>, accessToken: string): string {
  for (const key of ["id", "userId", "yid"]) {
    const value = str(user[key]);
    if (value) return value;
  }
  return uidFallbackHash(accessToken);
}

/**
 * 手机号脱敏归一化到只露末 2 位（幂等，且只对「像手机号」的输入生效）。
 *
 * 服务端把手机号本身当昵称下发且只脱敏到「露末 4 位」（实测 `130****1100`），
 * 归一化后为 `130******00`；真实昵称（如 `用户26815487395`）原样返回。
 */
export function normalizeNickname(value: string): string {
  const trimmed = value.trim();
  const masked = /^(\d{3})(\*+)(\d{2,4})$/.exec(trimmed);
  if (masked) return `${masked[1]}${"*".repeat(trimmed.length - 5)}${trimmed.slice(-2)}`;
  if (/^1\d{10}$/.test(trimmed)) return `${trimmed.slice(0, 3)}${"*".repeat(6)}${trimmed.slice(-2)}`;
  return trimmed;
}

/**
 * 过期时刻：`expiresIn`（相对秒，基准 **当前时刻**）→ JWT `exp` → 空串。
 *
 * ⚠️ 基准取当前时刻而非 JWT `iat`（Go 用 `time.Now()`）；无法解析时留空，
 * 调用方据此**不判定过期**。
 */
export function expiresAtFrom(
  payload: Record<string, unknown>,
  accessToken: string,
  nowMs = Date.now(),
): string {
  const raw = payload["expiresIn"];
  const seconds =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseFloat(raw) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return String(Math.trunc(nowMs + seconds * 1000));
  const exp = jwtExpMs(accessToken);
  return exp > 0 ? String(exp) : "";
}

/** 控制面请求头（exchange / refresh 用，**不带 Authorization**）。 */
export function anonymousHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": upstream.USER_AGENT,
  };
}

/** 上游基址：优先已保存的配置（含测试/自托管覆盖），否则默认域名。 */
function configuredBase(): string {
  try {
    return upstream.loadConfig()[0].baseUrl || DEFAULT_BASE_URL;
  } catch {
    return DEFAULT_BASE_URL;
  }
}

/**
 * 解析登录用 base url。
 *
 * 本渠道**只有一个域名**，故 realm 只作兼容参数：`auto` / 空串 / 已知别名
 * 都返回已配置的基址（默认 `https://lobsterai-server.youdao.com`）；
 * 未知 realm 抛错，避免用户以为自己在切环境却什么也没变。
 */
export function resolveBaseUrl(realm = "auto"): string {
  const known = new Set(["auto", "", "default", "lobsterai", "intl", "cn"]);
  if (!known.has(realm)) throw new Error(`unknown realm: ${realm} (LobsterAI has a single domain)`);
  return configuredBase();
}

// ── 凭据读写 ─────────────────────────────────────────────────────────────────

/** 磁盘布局（snake_case）。 */
export interface DiskCredentials {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  uid: string;
  user_id: string;
  nickname: string;
  uuid: string;
  first_keyfrom: string;
  latest_keyfrom: string;
  obtained_at: string;
  source: string;
}

function fromDisk(rec: Record<string, unknown>): Credentials {
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = str(rec[key]);
      if (value) return value;
    }
    return "";
  };
  return {
    accessToken: pick("access_token", "accessToken"),
    refreshToken: pick("refresh_token", "refreshToken"),
    expiresAt: pick("expires_at", "expiresAt"),
    uid: pick("uid", "user_id", "userId"),
    userId: pick("user_id", "userId", "yid"),
    nickname: normalizeNickname(pick("nickname")),
    uuid: pick("uuid"),
    firstKeyfrom: pick("first_keyfrom", "firstKeyfrom"),
    latestKeyfrom: pick("latest_keyfrom", "latestKeyfrom"),
    domain: pick("domain"),
    obtainedAt: pick("obtained_at", "obtainedAt"),
    source: pick("source"),
  };
}

function toDisk(c: Credentials): DiskCredentials {
  return {
    access_token: c.accessToken,
    refresh_token: c.refreshToken,
    expires_at: c.expiresAt,
    uid: c.uid,
    user_id: c.userId,
    nickname: c.nickname,
    uuid: c.uuid,
    first_keyfrom: c.firstKeyfrom,
    latest_keyfrom: c.latestKeyfrom,
    obtained_at: c.obtainedAt || nowIso(),
    source: c.source,
  };
}

/**
 * 从磁盘读取凭据。
 *
 * 文件缺失 / JSON 损坏 / `access_token` 为空一律抛 `NotLoggedInError`。
 * 老凭据缺 `uid` 时用 `sha256(accessToken)[:16]` 补上（而不是拒绝整条凭据）。
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
    throw new NotLoggedInError();
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new NotLoggedInError();
  const c = fromDisk(data as Record<string, unknown>);
  if (!c.accessToken) throw new NotLoggedInError();
  // 老凭据缺 uid 时补上，而不是拒绝整条凭据（否则用户必须重新登录）。
  return c.uid ? c : { ...c, uid: uidFallbackHash(c.accessToken) };
}

/**
 * 原子写盘（临时文件 + rename）并置 0600。
 *
 * Windows 上 chmod 语义有限，仍保持一致以免其它平台漏掉权限收敛。
 */
export async function save(c: Credentials): Promise<void> {
  ensureDir();
  const path = credentialsPath();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(toDisk(c), null, 2)}\n`, "utf8");
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

// ── 登录 ─────────────────────────────────────────────────────────────────────

/** 一次登录会话的客户端状态。 */
export interface LoginSession {
  /** 安装 UUID（exchange/refresh 必带）。 */
  uuid: string;
  /** 首次登录时间戳（毫秒字符串）。 */
  firstKeyfrom: string;
  /** 回调校验用的随机 state。 */
  state: string;
}

export function newLoginSession(nowMs = Date.now()): LoginSession {
  return { uuid: randomUUID(), firstKeyfrom: String(nowMs), state: randomUUID() };
}

/** 登录门户基址；`LOBSTERAI_PORTAL_BASE` 可覆盖（自托管 / 测试）。 */
export function portalBase(): string {
  const override = process.env["LOBSTERAI_PORTAL_BASE"];
  return override && override.trim() ? override.trim().replace(/\/+$/, "") : DEFAULT_PORTAL_BASE;
}

/**
 * 构造登录 URL。
 *
 * ⚠️ hash 段 `#/login` **必须显式拼装**（不能用 `URL.searchParams` —— 那会把
 * 查询串放在 `#` 之前，portal 拿不到参数）；`redirect_uri` 必须是
 * `http://127.0.0.1:{port}/auth/callback` 形态（portal 会校验）。
 */
export function buildLoginUrl(port: number, state: string, portal = portalBase()): string {
  const redirect = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const query = new URLSearchParams({ source: "electron", redirect_uri: redirect, state });
  return `${portal}/portal#/login?${query.toString()}`;
}

/** Windows 下用 `cmd /c start "" "{url}"` 打开浏览器（空标题防 `&` 截断 URL）。 */
export function openBrowser(url: string): void {
  sharedLogin.openBrowser(url);
}

/** 授权码换 token（回调收到 code 后立即在进程内发起）。 */
export async function exchange(
  base: string,
  authCode: string,
  session: LoginSession,
): Promise<Credentials> {
  const version = await upstream.resolveClientVersion();
  const body: Record<string, string> = {
    authCode,
    firstKeyfrom: session.firstKeyfrom,
    // 登录时用**当前时刻**（与续期相反：续期原样回发登录时的存储值）。
    latestKeyfrom: String(Date.now()),
    uuid: session.uuid,
    version,
  };
  const resp = await fetch(`${base.replace(/\/+$/, "")}/api/auth/exchange`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: anonymousHeaders(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await resp.text().catch(() => "");
  let env: Record<string, unknown> | null = null;
  try {
    env = JSON.parse(text) as Record<string, unknown>;
  } catch {
    env = null;
  }
  if (!resp.ok) throw new Error(`exchange failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
  const data =
    env && typeof env["data"] === "object" && env["data"] !== null
      ? (env["data"] as Record<string, unknown>)
      : null;
  if (!env || env["code"] !== 0 || !data) {
    throw new Error(
      `exchange failed: code=${String(env?.["code"])} ` +
        `msg=${String(env?.["msg"] ?? env?.["message"] ?? "")}`,
    );
  }
  const accessToken = str(data["accessToken"]);
  if (!accessToken) throw new Error("exchange returned an empty access token");
  const user =
    data["user"] && typeof data["user"] === "object"
      ? (data["user"] as Record<string, unknown>)
      : {};
  return {
    ...EMPTY_CREDENTIALS,
    accessToken,
    refreshToken: str(data["refreshToken"]),
    expiresAt: expiresAtFrom(data, accessToken),
    uid: uidFromUser(user, accessToken),
    userId: str(user["yid"]),
    nickname: normalizeNickname(str(user["nickname"])),
    uuid: session.uuid,
    firstKeyfrom: session.firstKeyfrom,
    latestKeyfrom: body["latestKeyfrom"]!,
    obtainedAt: nowIso(),
    source: "lobsterai-login",
  };
}

export interface CallbackServer {
  port: number;
  close: () => Promise<void>;
  /** 授权成功并完成 exchange 后 resolve；失败/超时 reject。 */
  result: Promise<Credentials>;
}

/**
 * 启动本地回调服务器（127.0.0.1 随机空闲端口，路径 `/auth/callback`）。
 *
 * `code` 非空且 `state` **严格相等**才继续，否则 400（防 CSRF / 串号）。
 * 成功页文案逐字「登录成功，可以关闭此窗口了」；exchange 失败回 500。
 */
export function startCallbackServer(
  session: LoginSession,
  base: string,
  options: { timeoutMs?: number } = {},
): Promise<CallbackServer> {
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
  return new Promise<CallbackServer>((resolveReady, rejectReady) => {
    let settle: (c: Credentials) => void = () => {};
    let fail: (err: Error) => void = () => {};
    const result = new Promise<Credentials>((res, rej) => {
      settle = res;
      fail = rej;
    });
    const timer = setTimeout(() => {
      fail(new Error(`no login detected within ${Math.round(timeoutMs / 1000)}s`));
      server.close();
    }, timeoutMs);
    // 不让定时器把进程吊住（CLI 退出 / 测试结束时立即释放）。
    timer.unref?.();

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";
      if (!code || state !== session.state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>授权失败：state 校验不通过，请重新登录。</h1>");
        return;
      }
      exchange(base, code, session).then(
        (c) => {
          clearTimeout(timer);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h1>登录成功，可以关闭此窗口了</h1>");
          settle(c);
        },
        (err: unknown) => {
          clearTimeout(timer);
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h1>登录失败，请回到终端查看原因。</h1>");
          fail(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });

    server.on("error", (err) => rejectReady(err));
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number } | null)?.port ?? 0;
      resolveReady({
        port,
        close: () =>
          new Promise<void>((done) => {
            clearTimeout(timer);
            server.close(() => done());
            server.closeAllConnections?.();
          }),
        result,
      });
    });
  });
}

export interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (message: string) => void;
}

/** 完整登录流程：本地回调服务器 + 打开浏览器 + exchange + 落盘。 */
export async function login(baseUrl?: string, options: LoginOptions = {}): Promise<Credentials> {
  const base = (baseUrl ?? resolveBaseUrl()) || DEFAULT_BASE_URL;
  const session = newLoginSession();
  const callback = await startCallbackServer(session, base);
  const url = buildLoginUrl(callback.port, session.state);
  // ⚠️ 拿到 URL 后**立刻**回调（界面据此弹窗），不等浏览器启动结果。
  options.onUrl?.(url);
  options.onStatus?.(`authorization page opened, waiting for authorization (up to ${LOGIN_TIMEOUT_MS / 60000} min)...`);
  openBrowser(url);
  try {
    const c = await callback.result;
    await save(c);
    options.onStatus?.("authorization succeeded; credentials saved.");
    return c;
  } finally {
    await callback.close();
  }
}

// ── 续期 ─────────────────────────────────────────────────────────────────────

/**
 * 用存储的 `refresh_token` 静默续期。
 *
 * 请求体 = keyfrom 身份载荷（**用凭据里存储的 firstKeyfrom / latestKeyfrom**，
 * 不是当前时刻）+ `refreshToken`；`uuid` / `userId` 仅非空时带该键。
 * 服务端可能不返回新 `refreshToken` → **保留旧值**（不能覆盖成空串）。
 *
 * 终态（抛 `RefreshTokenExpiredError`）：401/403、信封失败且判出 `session-dead`、
 * `code:0` 但 `accessToken` 为空。其余抛普通 Error，由调用方走可重试路径。
 */
export async function refresh(c: Credentials): Promise<Credentials> {
  if (!c.refreshToken) throw new Error("no refresh token available; login again");
  const base = configuredBase();
  const version = await upstream.resolveClientVersion();

  const body: Record<string, unknown> = {
    firstKeyfrom: c.firstKeyfrom ?? "",
    // ⚠️ 用**存储值**：对齐 Go —— `RefreshToken` 只改 token 与过期时间，
    // `LatestKeyfrom` 永久停在登录那一刻，续期时原样回发。
    latestKeyfrom: c.latestKeyfrom ?? "",
    version,
    refreshToken: c.refreshToken,
  };
  if (c.uuid) body["uuid"] = c.uuid;
  if (c.userId) body["userId"] = c.userId;

  let resp: Response;
  try {
    resp = await fetch(`${base.replace(/\/+$/, "")}/api/auth/refresh`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: anonymousHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`refresh request failed: ${String(err)}`);
  }

  const text = await resp.text().catch(() => "");
  if (resp.status === 401 || resp.status === 403) {
    throw new RefreshTokenExpiredError(`refresh token is invalid (HTTP ${resp.status}); please log in again`);
  }
  if (upstream.classifyError(resp.status, text) === "session-dead") {
    throw new RefreshTokenExpiredError("server marked the session as dead; please log in again");
  }
  let env: Record<string, unknown> | null = null;
  try {
    env = JSON.parse(text) as Record<string, unknown>;
  } catch {
    env = null;
  }
  if (resp.status !== 200 || !env) {
    throw new Error(`refresh failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
  }
  const data =
    env["data"] && typeof env["data"] === "object" && env["data"] !== null
      ? (env["data"] as Record<string, unknown>)
      : null;
  if (env["code"] !== 0 || !data) {
    throw new Error(
      `refresh failed: code=${String(env["code"])} msg=${String(env["msg"] ?? env["message"] ?? "")}`,
    );
  }
  const accessToken = str(data["accessToken"]);
  if (!accessToken) {
    throw new RefreshTokenExpiredError("refresh returned code:0 but accessToken is empty; please log in again");
  }
  const user =
    data["user"] && typeof data["user"] === "object"
      ? (data["user"] as Record<string, unknown>)
      : {};
  const next: Credentials = {
    ...c,
    accessToken,
    // ⚠️ 不返回新 refreshToken 时保留旧值（覆盖成空串会让下次续期必然失败）。
    refreshToken: str(data["refreshToken"]) || c.refreshToken,
    expiresAt: expiresAtFrom(data, accessToken),
    // 身份字段一律沿用旧值：refresh 响应只带令牌，不含稳定的 account 对象。
    uid: c.uid || uidFromUser(user, accessToken),
    userId: c.userId || str(user["yid"]),
    nickname: c.nickname || normalizeNickname(str(user["nickname"])),
    obtainedAt: c.obtainedAt,
    source: c.source,
  };
  await save(next);
  return next;
}
