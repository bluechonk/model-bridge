/**
 * CatPaw 认证：真实 URL 登录流程、凭证持久化与有效性探测。
 *
 * ## 登录协议（实测，见 docs/protocols/catpaw/PROTOCOL.md）
 *
 *   1. GET  {LOGIN_CONFIG_URL}                          → { loginEntryUrl }
 *   2. auth_url = `${loginEntryUrl}?sid=&state=&redirect=`（三参数缺一不可；
 *      缺 `redirect` 网关直接 400 —— 但它只是形式要求，见下）
 *      → 302 到 passport.meituan.com 登录页
 *   3. 用户在浏览器完成登录（唯一人工步骤）
 *   4. GET {POLL_TOKEN_URL}?sid=...  每 1s 轮询，≤10 分钟 → token
 *   5. GET {CURRENT_USER_URL}（`X-Auth-Token`）取 uid —— 账号池靠它认「同一账号」
 *
 * ⚠ **没有本地回调服务器**：早期实现起过 loopback 回调与轮询并行 race，
 * 但三次真机登录回调一次都没赢（`source` 恒为 `catpaw-login-poll`），
 * 已删除。轮询通道独立于 redirect（`sid` 是我们自己生成的），
 * 不需要浏览器把任何东西打回本地。详见 `login()` 的注释。
 *
 * 返回的是与桌面端登录同一身份的不透明 SSO token（非 JWT）。
 * 落盘到 `~/.model-bridge/catpaw/credentials.json`。
 *
 * ## 凭据读取策略（按用户规则 #4）
 *
 * 凭据只来自「真实 URL 登录落盘」的文件。**不得**从妙手桌面端的本地文件
 * （catx-credential.json / auth.json / Local Storage 等）读取登录态。
 *
 * ## 铁律
 *
 * token 原文不进日志/输出，只给指纹与脱敏形态。
 */

import { readFileSync } from "node:fs";
import { writeFile, rename, chmod } from "node:fs/promises";

import { credentialsPath, ensureDir, login as sharedLogin } from "@model-bridge/gateway";

const {
  fetchWithTimeout,
  openBrowser,
  randomHex,
  sha256Hex,
  str,
  nowIso,
} = sharedLogin;

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 登录配置端点（返回 loginEntryUrl）。 */
export const LOGIN_CONFIG_URL = "https://catx.nocode.cn/api/gateway/passport/login-config";
/** 令牌轮询端点。 */
export const POLL_TOKEN_URL = "https://catx.nocode.cn/api/gateway/passport/poll-token";
/** 当前用户端点（登录后取 uid；见 `fetchCurrentUserId`）。 */
export const CURRENT_USER_URL = "https://catx.nocode.cn/api/gateway/passport/current-user";
/** 令牌有效性探测端点（`refresh()` 用；401/403 = 确定失效）。 */
export const AUTH_PING_URL = "https://catx.nocode.cn/api/gateway/auth/ping";

/**
 * `refresh()` 实际请求的 ping 地址。
 *
 * 测试/便携场景可用 `CATPAW_AUTH_PING_URL` 覆盖（照 `CLINE_API_BASE_URL`
 * 的惯例）—— 否则「离线自检」会因为一次有效性探测而变成出网测试。
 */
function authPingUrl(): string {
  return process.env["CATPAW_AUTH_PING_URL"] || AUTH_PING_URL;
}

/**
 * `redirect` 参数里用的回调路径。
 *
 * ⚠ 我们**不再监听**这个端口：它只是网关的必填参数（实测缺了 400），
 * token 一律从 `poll-token` 取。留着常量是为了 URL 形态与桌面端一致。
 */
const CALLBACK_PATH = "/callback";

/** 登录轮询周期（毫秒）。 */
const POLL_INTERVAL_MS = 1_000;
/** 登录轮询总超时（毫秒）。 */
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
/** HTTP 请求超时（毫秒）。 */
const HTTP_TIMEOUT_MS = 15_000;

const NOT_LOGGED_IN_MSG =
  "no credentials found; run `catpaw login` to complete browser authorization";

// ── 错误类型 ────────────────────────────────────────────────────────────────

/** 磁盘上不存在可用凭证。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message: string = NOT_LOGGED_IN_MSG) {
    super(message);
  }
}

// ── 类型 ────────────────────────────────────────────────────────────────────

/**
 * 凭据对象。catpaw 的无头登录 token 是不透明 SSO token（非 JWT），
 * 所以没有 uid/domain 可从 token 里解出来 —— 这两字段通常为空。
 */
export interface Credentials {
  /** 不透明 SSO token（上游请求里放在 Cookie: X-Passport-Token）。 */
  accessToken: string;
  /** 用户 uid（登录链路不返回，运行期由上游请求补空）。 */
  uid: string;
  /** 登录域（无头登录不涉及多域，通常为空）。 */
  domain: string;
  /** 凭证来源，如 "catpaw-login-poll"。 */
  source: string;
  /** 获得时刻（ISO 8601）。 */
  obtainedAt: string;
}

export const EMPTY_CREDENTIALS: Credentials = {
  accessToken: "",
  uid: "",
  domain: "",
  source: "",
  obtainedAt: "",
};

// ── 登录基址 ────────────────────────────────────────────────────────────────

/** 默认登录基址（catpaw 无独立登录域，登录走 passport 网关）。 */
export const DEFAULT_BASE_URL = "https://catx.nocode.cn";

/** 解析登录基址。catpaw 只有一个域，realm 参数仅作兼容保留。 */
export function resolveBaseUrl(realm = "auto"): string {
  return DEFAULT_BASE_URL;
}

// ── 工具 ────────────────────────────────────────────────────────────────────

/** 32 位无横线 hex（对应 M-TRACEID 的形状）。 */
export function traceId(): string {
  return randomHex(16);
}

/** token 的 sha256 指纹（脱敏输出用）。 */
export function fingerprint(token: string): string {
  return sha256Hex(token).slice(0, 16);
}

/** 脱敏形态：前缀…[长度]。 */
export function maskSecret(token: string): string {
  if (!token) return "";
  const head = token.slice(0, 6);
  const len = token.length;
  return `${head}…[${len}]`;
}

// ── 读取 ────────────────────────────────────────────────────────────────────

/** 从磁盘读取凭据。缺失 / 损坏 / 空 token 一律抛 NotLoggedInError。 */
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
  const rec = data as Record<string, unknown>;
  const accessToken = str(rec["access_token"]) || str(rec["accessToken"]);
  if (!accessToken) throw new NotLoggedInError();
  return {
    accessToken,
    uid: str(rec["uid"]),
    domain: str(rec["domain"]),
    source: str(rec["source"]) || "catpaw-login-poll",
    obtainedAt: str(rec["obtained_at"]) || str(rec["obtainedAt"]) || nowIso(),
  };
}

// ── 写入 ────────────────────────────────────────────────────────────────────

/**
 * 以 0600 权限写入凭据文件。先写临时文件再原子替换：
 * 写入过程崩溃不会留下半截 JSON 导致凭证损坏。
 */
export async function save(c: Credentials): Promise<void> {
  ensureDir();
  const path = credentialsPath();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(c, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

// ── 登录 ────────────────────────────────────────────────────────────────────

/** 解析 login-config 响应，取出 loginEntryUrl。 */
async function fetchLoginEntryUrl(): Promise<string> {
  const resp = await fetchWithTimeout(LOGIN_CONFIG_URL, {
    headers: { Accept: "application/json" },
  }, HTTP_TIMEOUT_MS);
  if (resp.status !== 200) throw new Error(`login-config 请求失败: HTTP ${resp.status}`);
  let body: unknown;
  try {
    body = await resp.json();
  } catch (err) {
    throw new Error(`login-config 请求失败: invalid JSON: ${String(err)}`);
  }
  const data =
    body && typeof body === "object" && !Array.isArray(body)
      ? ((body as Record<string, unknown>)["data"] as Record<string, unknown> | undefined)
      : undefined;
  const entry = str(data?.["loginEntryUrl"]);
  if (!entry) throw new Error("login-config 未返回 loginEntryUrl");
  return entry;
}

/**
 * 拼出完整 auth_url（三参数缺一不可）。
 *
 * redirect 必须是**真实监听中的**本地回调地址，否则 passport 登录成功后
 * 会把 `POST /callback` 的 token 打到一个没人收的端口（表现为"未获取到登录票据"）。
 *
 * 可选传入已有的 `sid` / `state`：回调服务器要在拼 URL **之前**起好
 * （它需要 state 做校验），所以 `login()` 会先生成再传进来。
 */
export function buildAuthUrl(loginEntryUrl: string, redirect: string, sid?: string, state?: string): string {
  const s = sid ?? randomHex(16);
  const st = state ?? randomHex(16);
  const encRedirect = encodeURIComponent(redirect);
  return `${loginEntryUrl}?sid=${s}&state=${st}&redirect=${encRedirect}`;
}

/** 从 loginEntryUrl + redirect 拼 auth_url，同时返回 sid/state（供轮询用）。 */
export function buildAuthParams(loginEntryUrl: string, redirect: string): {
  authUrl: string;
  sid: string;
  state: string;
} {
  const sid = randomHex(16);
  const state = randomHex(16);
  const encRedirect = encodeURIComponent(redirect);
  const authUrl = `${loginEntryUrl}?sid=${sid}&state=${state}&redirect=${encRedirect}`;
  return { authUrl, sid, state };
}

/**
 * 轮询 poll-token，成功返回 token 字符串，超时返回 null。
 *
 * 这是**唯一**的取 token 通道（本地回调那条路已删除，理由见 `login()`）。
 * `signal` 用于外部取消；返回 `null` 表示超时或被取消 —— 调用方按「没拿到」处理。
 */
async function pollToken(sid: string, signal?: AbortSignal): Promise<string | null> {
  const url = `${POLL_TOKEN_URL}?sid=${encodeURIComponent(sid)}`;
  const deadline = Date.now() + LOGIN_WINDOW_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) return null;
    try {
      const resp = await fetchWithTimeout(url, {
        headers: { Accept: "application/json" },
        ...(signal ? { signal } : {}),
      }, HTTP_TIMEOUT_MS);
      if (resp.status === 200) {
        const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
        const token = str(body?.["data"]);
        if (token.length > 20) return token;
      }
    } catch {
      if (signal?.aborted) return null;
      /* 轮询失败下一轮再试 */
    }
    // 可被 signal 唤醒的等待：取消时立刻结束，不必等满 1 秒
    await new Promise<void>((r) => {
      if (signal?.aborted) return r();
      const timer = setTimeout(r, POLL_INTERVAL_MS);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          r();
        },
        { once: true },
      );
    });
  }
  return null;
}

/**
 * 拉取当前登录用户（uid）。
 *
 * 参考实现（HITZY2002 / icebears111 catpaw2api）登录后都有这一步：`poll-token`
 * 只给不透明 token，**uid 要另取**。`uid` 不是可有可无的展示字段 —— 账号池靠它
 * 认「同一个账号」（`accountKey` 在 uid 为空时退化成按 token 建键，而 token
 * 每次登录都变，于是同一账号会被重复记成多条）。
 *
 * 失败不阻塞登录：拿不到 uid 就留空，由账号池按 token 退化处理。
 */
export async function fetchCurrentUserId(token: string): Promise<string> {
  try {
    const resp = await fetchWithTimeout(CURRENT_USER_URL, {
      headers: { "X-Auth-Token": token, Accept: "application/json" },
    }, HTTP_TIMEOUT_MS);
    if (resp.status !== 200) return "";
    const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
    const data = body?.["data"];
    if (!data || typeof data !== "object" || Array.isArray(data)) return "";
    const rec = data as Record<string, unknown>;
    // 字段名以参考实现为准（userId）；其余为历史/变体写法。
    //
    // ⚠ 不能直接用共享的 `str()`：它只认字符串，而上游实测返回的是**数字**
    //   （`"userId": 4522314126`）—— 用 `str()` 会把 uid 静默丢成空串，
    //   账号池随即退化成按 token 建键（同一账号登录两次记成两条）。
    for (const key of ["userId", "uid", "user_id", "id"]) {
      const value = rec[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    return "";
  } catch {
    return "";
  }
}

/** 从登录响应构建凭据对象。 */
function fromToken(token: string, source: string, uid = ""): Credentials {
  return {
    ...EMPTY_CREDENTIALS,
    accessToken: token,
    uid,
    domain: "",
    source: source || "catpaw-login",
    obtainedAt: nowIso(),
  };
}

export interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (message: string) => void;
}

/**
 * 运行交互式浏览器登录并持久化结果。
 *
 * ## 只有一条取 token 通道：轮询 `poll-token?sid=`
 *
 * 早期实现还起了一个本地 loopback 回调服务器，与轮询并行 `Promise.race`
 * （对齐桌面端 `CatxPassportLoginProvider`）。**实测三次真机登录，回调通道一次都没赢**
 * （`source` 恒为 `catpaw-login-poll`），所以把它删掉了：
 *
 * - 桌面端能收到回调，是因为它自己就是那个「客户端」；我们只是复刻它的 URL 形态，
 *   网关并不保证把 token POST 回 `127.0.0.1`（参考实现 `catpaw2api` 的注释也写
 *   「回调到 127.0.0.1 打不开属正常，靠 poll-token 通道取 token」）。
 * - 多一条通道就多一份维护面：GET/POST/表单三种形态、state 校验、过期标签页……
 *   而它一次都没成功过 —— 那些复杂度是纯负债。
 * - 轮询通道**独立于** redirect：`sid` 是我们自己生成的，`poll-token?sid=` 就能换 token，
 *   不依赖浏览器把任何东西打回本地。
 *
 * `redirect` 参数仍然必须传（实测不带它网关直接 400），但只作为协议要求的形式参数 ——
 * 我们不再监听那个端口，也就不再需要它「真实可达」。
 *
 * 流程：拼 auth_url（sid/state/redirect）→ 交给用户打开 → 每 1s 轮询 → 取 uid → 落盘。
 */
export async function login(baseUrl: string, options: LoginOptions = {}): Promise<Credentials> {
  const { onUrl, onStatus } = options;
  void baseUrl; // catpaw 只有一个登录域，参数仅作兼容保留

  onStatus?.("获取登录入口…");
  const loginEntryUrl = await fetchLoginEntryUrl();

  // redirect 是网关的**必填**参数（实测缺它直接 400），但只是形式要求：
  // 我们不监听该端口，token 一律从 poll-token 取。
  const sid = randomHex(16);
  const state = randomHex(16);
  const redirect = `http://127.0.0.1:37890${CALLBACK_PATH}`;
  const finalAuthUrl = buildAuthUrl(loginEntryUrl, redirect, sid, state);

  onUrl?.(finalAuthUrl);
  onStatus?.('请在浏览器完成登录（登录成功后页面会显示"登录成功"）');
  if (process.env["CATPAW_NO_BROWSER"] !== "1") openBrowser(finalAuthUrl);

  onStatus?.("等待授权中（最多 10 分钟）…");

  const token = await pollToken(sid);
  if (!token) throw new Error("轮询超时：10 分钟内未检测到登录");

  // 取 uid：账号池靠它认「同一个账号」（见 fetchCurrentUserId）
  onStatus?.("登录成功，正在获取账号信息…");
  const uid = await fetchCurrentUserId(token);

  const c = fromToken(token, "catpaw-login-poll", uid);
  await save(c);
  return c;
}

/** 从 auth_url 的查询参数里取出 sid。 */
export function extractSid(authUrl: string): string {
  const marker = "sid=";
  const idx = authUrl.indexOf(marker);
  if (idx < 0) return "";
  const rest = authUrl.slice(idx + marker.length);
  const amp = rest.indexOf("&");
  return (amp < 0 ? rest : rest.slice(0, amp)).replace(/\+/g, " ").trim();
}

// ── 刷新 ────────────────────────────────────────────────────────────────────

/**
 * catpaw 没有独立的 token 刷新端点（登录链路只在首次登录时给出 token）。
 *
 * 因此 `refresh()` 做**有效性探测**（`/api/gateway/auth/ping`）：
 *
 * - `401/403` → 令牌**确定失效**，抛错让调用方引导重新登录
 * - `2xx/3xx` → 仍有效，原样返回
 * - 其它（5xx / 网络错误）→ **临时故障**，也返回原凭据
 *
 * ⚠ 早期实现无条件抛错，等于把「上游抖了一下」也判成「需要重新登录」，
 * 网关的 401 失败转移（failover）会因此把好账号踢出轮换。区分依据来自参考实现
 * （`catpaw2api` 的 `Ping()`：只有 401/403 才算失效）。
 */
export async function refresh(c: Credentials): Promise<Credentials> {
  // 顺带回填缺失的 uid（老凭据修复；幂等，uid 已有值时不发请求）
  const withUid = await ensureUid(c);
  let resp: Response;
  try {
    resp = await fetchWithTimeout(authPingUrl(), {
      headers: { "X-Auth-Token": withUid.accessToken, Accept: "application/json" },
    }, HTTP_TIMEOUT_MS);
  } catch (err) {
    // 网络不通：无法判定失效，按「暂时故障」处理，不惊动用户重登
    throw new Error(`catpaw 令牌有效性探测失败（网络错误，可稍后重试）：${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new Error("catpaw 令牌已失效（上游 401/403），请重新运行 `catpaw login`");
  }
  // 其余状态（含 5xx）都按「暂时无法判定失效」处理：返回原凭据，不逼用户重登。
  return withUid;
}

/**
 * 回填缺失的 uid（老凭据修复）。
 *
 * 早期版本的登录链路不取 uid，磁盘上会留下 `uid: ""` 的凭据；账号池因此退化成
 * 按 token 建键（同一账号重复记多条）。这里在**读凭据时顺带补一次**：
 * 拿到 uid 就落盘，拿不到就原样返回 —— 不回填失败不阻塞任何调用方。
 *
 * 幂等：uid 已有值时直接返回，不产生网络请求。
 */
export async function ensureUid(c: Credentials): Promise<Credentials> {
  if (c.uid) return c;
  const uid = await fetchCurrentUserId(c.accessToken);
  if (!uid) return c;
  const next: Credentials = { ...c, uid };
  await save(next);
  return next;
}

// ── 测试辅助 ────────────────────────────────────────────────────────────────

/**
 * 兼容别名：现规范名等同 `paths.credentialsPath()` 的文件名部分
 * （凭证落点由共享层按 cid 推导，见 docs/STORAGE-CONVENTION.md）。
 */
export const CREDENTIALS_FILE = "credentials.json";