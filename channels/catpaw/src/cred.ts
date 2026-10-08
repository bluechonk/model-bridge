/**
 * CatPaw 认证：真实 URL 登录流程、凭证持久化与有效性探测。
 *
 * ## 登录协议（实测，见 docs/protocols/catpaw/PROTOCOL.md）
 *
 *   1. GET  {LOGIN_CONFIG_URL}                          → { loginEntryUrl }
 *   2. 本地起一个 loopback 回调服务器（动态端口），redirect 指向
 *      `http://127.0.0.1:<实际端口>/callback`（**必须是 POST**）
 *   3. auth_url = `${loginEntryUrl}?sid=&state=&redirect=`（三参数缺一不可）
 *      → 302 到 passport.meituan.com 登录页
 *   4. 用户在浏览器完成登录（唯一人工步骤）
 *   5. **双通道并行**（对齐妙手桌面端 `CatxPassportLoginProvider` 实现）：
 *      - 通道 A：浏览器 `GET` 或 `POST /callback`（query / JSON / 表单三种形态都收）
 *      - 通道 B：GET {POLL_TOKEN_URL}?sid=...  每 1s 轮询，≤10 分钟
 *      `Promise.race` 谁先拿到 token 谁赢 —— 任一通道成功即视为登录成功；
 *      赢家出现后**立刻取消另一条通道**（否则登录成功了进程还要空转到超时）。
 *   6. GET {CURRENT_USER_URL}（`X-Auth-Token`）取 uid —— 账号池靠它认「同一账号」
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
import { createServer, type Server } from "node:http";

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
 * 测试/便携场景可用 `CATPAW_AUTH_PING_URL` 覆盖（照 `MINIMAX_ACCOUNT_BASE_URL`
 * 的惯例）—— 否则「离线自检」会因为一次有效性探测而变成出网测试。
 */
function authPingUrl(): string {
  return process.env["CATPAW_AUTH_PING_URL"] || AUTH_PING_URL;
}
/** 本地回调路径（对齐妙手桌面端实现的 `callback`）。 */
const CALLBACK_PATH = "/callback";

/** 登录轮询周期（毫秒）。 */
const POLL_INTERVAL_MS = 1_000;
/** 登录轮询总超时（毫秒）。 */
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
/** HTTP 请求超时（毫秒）。 */
const HTTP_TIMEOUT_MS = 15_000;
/** 本地回调 body 上限（64 KiB，对齐官方实现）。 */
const CALLBACK_BODY_MAX = 65_536;

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

/** 从 loginEntryUrl + redirect 拼 auth_url，同时返回 sid/state（供 poll 与回调校验）。 */
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

// ── 本地回调服务器（对齐妙手桌面端 `Bx()` 实现）──────────────────────────────

/** 回调服务器的对外契约。 */
interface CallbackServer {
  /** 实际监听端口（请求 0 或端口被占时会退到随机端口，调用方须用此值重算 URL）。 */
  readonly port: number;
  /**
   * 等首个**校验通过**的回调（超时抛错）。
   *
   * ⚠ 只认 `{token, state}` 且 state 与本次登录一致的回调；
   * state 不匹配的请求会被就地拒绝（400）并**继续等待** —— 见 `login()` 里的说明。
   */
  wait(timeoutMs: number): Promise<{ token: string; state: string }>;
  /** 关闭服务器（幂等；未等到回调时会让 wait 拒绝）。 */
  close(): void;
}

/**
 * 启动本地回调服务器。
 *
 * `expectedState` 是本次登录的 state：不匹配的回调一律拒绝且**不 settle**
 * （可能是上一轮登录残留的标签页、或本机其它进程的注入）。详见 `login()`。
 */
function startCallbackServer(expectedState: string): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let settle: (v: { token: string; state: string }) => void = () => {};
    let fail: (e: Error) => void = () => {};
    let settled = false;
    const params = new Promise<{ token: string; state: string }>((res, rej) => {
      settle = res;
      fail = rej;
    });
    void params.catch(() => {});

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Private-Network": "true",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      // 回调可能是 GET（query）或 POST（JSON / 表单）。参考实现两种都收：
      // 登录页的 CSP 允许 `form-action http://127.0.0.1:*`，即表单提交，
      // 而表单方法由页面决定 —— 只认 POST 会在页面用 GET 时静默失联。
      if (req.method === "GET") {
        const q = url.searchParams;
        finish(q.get("token") ?? "", q.get("state") ?? "");
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, POST, OPTIONS" });
        res.end("Method Not Allowed");
        return;
      }

      let body = "";
      let tooLarge = false;
      req.on("data", (chunk: Buffer) => {
        if (tooLarge) return;
        body += chunk.toString("utf8");
        if (body.length > CALLBACK_BODY_MAX) {
          tooLarge = true;
          body = "";
        }
      });
      req.on("end", () => {
        if (tooLarge) {
          res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Payload Too Large");
          return;
        }
        const parsed = parseCallbackBody(body, req.headers["content-type"]);
        finish(parsed.token, parsed.state);
      });
      req.on("error", () => {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Bad Request");
      });

      /** 校验并回页面；只有 state 匹配且 token 非空才 settle。 */
      function finish(token: string, state: string): void {
        if (!token) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(CALLBACK_FAIL_HTML);
          return;
        }
        if (state !== expectedState) {
          // 不是本次登录的回调：拒绝，但**不结束等待**（真回调可能还在路上）。
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(CALLBACK_STALE_HTML);
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(CALLBACK_OK_HTML);
        if (!settled) {
          settled = true;
          settle({ token, state });
        }
      }
    });

    server.once("error", (err: NodeJS.ErrnoException) => reject(err));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number } | null;
      const port = addr?.port ?? 0;
      resolve({
        port,
        wait(timeoutMs: number) {
          return new Promise<{ token: string; state: string }>((res, rej) => {
            const timer = setTimeout(() => {
              if (!settled) {
                settled = true;
                rej(new Error(`等待授权回调超时（${Math.round(timeoutMs / 1000)} 秒）`));
              }
            }, timeoutMs);
            params.then(
              (v) => {
                clearTimeout(timer);
                res(v);
              },
              (e: Error) => {
                clearTimeout(timer);
                rej(e);
              },
            );
          });
        },
        close() {
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

/** 解析回调 body：JSON `{token,state}` 或 query 形式 `token=...&state=...`。 */
function parseCallbackBody(body: string, contentType?: string | string[]): {
  token: string;
  state: string;
} {
  if (!body) return { token: "", state: "" };
  const ct = Array.isArray(contentType)
    ? (contentType[0] ?? "")
    : (contentType ?? "");
  if (ct.toLowerCase().includes("application/json")) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      return {
        token: typeof parsed["token"] === "string" && parsed["token"] ? parsed["token"] : "",
        state: typeof parsed["state"] === "string" ? parsed["state"] : "",
      };
    } catch {
      return { token: "", state: "" };
    }
  }
  const params = new URLSearchParams(body);
  return { token: params.get("token") ?? "", state: params.get("state") ?? "" };
}

/** 登录成功页（提示可关闭）。 */
const CALLBACK_OK_HTML = [
  "<!DOCTYPE html>",
  '<html lang="zh-CN">',
  "<head>",
  '<meta charset="UTF-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  "<title>登录成功 - CatPaw</title>",
  "<style>",
  "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;",
  "display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;",
  "background:#f7f8fa;color:#1f2329;text-align:center;padding:24px;box-sizing:border-box}",
  ".card{background:#fff;border-radius:12px;padding:40px 32px;box-shadow:0 2px 12px rgba(0,0,0,0.06);max-width:360px;width:100%}",
  "h1{font-size:18px;margin:0 0 12px}",
  "p{font-size:14px;color:#646a73;line-height:1.6;margin:0}",
  "</style>",
  "</head>",
  "<body>",
  '<div class="card">',
  "<h1>登录成功</h1>",
  "<p>已返回 CatPaw，可关闭此页面。</p>",
  "</div>",
  "</body>",
  "</html>",
].join("\n");

/** 登录失败页（未获取到 token）。 */
const CALLBACK_FAIL_HTML = [
  "<!DOCTYPE html>",
  '<html lang="zh-CN">',
  "<head>",
  '<meta charset="UTF-8">',
  "<title>登录失败 - CatPaw</title>",
  "</head>",
  "<body>",
  "<p>未获取到登录票据，请返回 CatPaw 重新发起登录。</p>",
  "</body>",
  "</html>",
].join("\n");

/**
 * 过期回调页（state 不属于本次登录）。
 *
 * 常见于「上一轮登录残留的标签页」或本机其它进程的注入 —— 不是本次登录失败，
 * 所以提示用户「请用刚打开的那个页面完成登录」，而不是笼统报失败。
 */
const CALLBACK_STALE_HTML = [
  "<!DOCTYPE html>",
  '<html lang="zh-CN">',
  "<head>",
  '<meta charset="UTF-8">',
  "<title>请重新发起登录 - CatPaw</title>",
  "</head>",
  "<body>",
  "<p>这个授权页已过期（不属于本次登录），请在**最新打开的那个**授权页完成登录。</p>",
  "</body>",
  "</html>",
].join("\n");

/**
 * 轮询 poll-token，成功返回 token 字符串，超时返回 null。
 *
 * `signal` 用于外部取消（回调通道先拿到 token 时不再白轮询）。
 * 返回 `null` 有两种含义：超时，或被取消 —— 调用方按「没拿到 token」处理即可。
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
 * **双通道并行**（对齐妙手桌面端 `CatxPassportLoginProvider.login()`）：
 *   - 先起本地 loopback 回调服务器（动态端口），redirect 指向真实监听的 `/callback`
 *   - 拼 auth_url → onUrl(auth_url) → 打开浏览器
 *   - 并行：① 等浏览器 `POST /callback`（body `{token,state}`）
 *            ② 每 1s 轮询 `poll-token?sid=`
 *   - `Promise.race` 谁先拿到 token 谁赢；输的那一方被取消
 *
 * 关键：**redirect 必须是真实监听中的地址**。如果只写死一个端口而没起服务器，
 * passport 登录成功后会把 token POST 到一个没人收的端口 —— 表现就是
 * "登录失败 - 未获取到登录票据"（这正是旧实现的问题）。
 */
export async function login(baseUrl: string, options: LoginOptions = {}): Promise<Credentials> {
  const { onUrl, onStatus } = options;
  void baseUrl; // catpaw 只有一个登录域，参数仅作兼容保留

  onStatus?.("获取登录入口…");
  const loginEntryUrl = await fetchLoginEntryUrl();

  // sid/state 先定下来：回调服务器需要 state 做校验，所以它必须先起。
  const sid = randomHex(16);
  const state = randomHex(16);

  // ① 先起本地回调服务器（动态端口，失败不阻塞——降级为纯 poll）
  //    ⚠ 必须在**拼 auth_url 之前**起好：redirect 要指向真实监听中的端口。
  let callback: CallbackServer | null = null;
  try {
    callback = await startCallbackServer(state);
  } catch {
    callback = null;
  }

  const redirect = callback
    ? `http://127.0.0.1:${callback.port}${CALLBACK_PATH}`
    : `http://127.0.0.1:0${CALLBACK_PATH}`; // 兜底；无服务器时纯 poll
  const finalAuthUrl = buildAuthUrl(loginEntryUrl, redirect, sid, state);

  onUrl?.(finalAuthUrl);
  const channel = callback ? "回调 + 轮询" : "轮询";
  onStatus?.(`请在浏览器完成登录（${channel}双通道，登录成功后页面会显示"登录成功"）`);
  if (process.env["CATPAW_NO_BROWSER"] !== "1") openBrowser(finalAuthUrl);

  if (!sid) throw new Error("无法从 auth_url 解析 sid");

  onStatus?.("等待授权中（最多 10 分钟）…");

  // ② 双通道并行：谁先拿到 token 谁赢。
  //
  // 两条通道都用 `AbortController` 绑到同一个 signal：赢家出现后立刻取消另一条。
  // ⚠ 不取消的话，轮询循环会一直跑到 10 分钟超时，**登录成功了进程也不退出**
  // （实测：回调 0.2s 拿到 token，poll 仍在每秒请求，CLI 挂到超时才肯结束）。
  const abort = new AbortController();
  const pollPromise = pollToken(sid, abort.signal).catch(() => null);

  let token = "";
  let source = "catpaw-login";
  try {
    if (callback) {
      // state 不匹配的回调在服务器里就地拒绝、不 settle，所以这里拿到的必然匹配；
      // 仍然再校验一次（纵深防御，且防「空 state」这类畸形请求）。
      const won = await Promise.race([
        callback.wait(LOGIN_WINDOW_MS).then((cb) => {
          if (cb.state !== state) throw new Error("回调 state 与本次登录不一致");
          if (!cb.token) throw new Error("回调返回了空 token");
          return { token: cb.token, channel: "callback" as const };
        }),
        pollPromise.then((t) => ({ token: t ?? "", channel: "poll" as const })),
      ]);
      token = won.token;
      source = `catpaw-login-${won.channel}`;
    } else {
      const t = await pollPromise;
      if (!t) throw new Error("轮询超时：10 分钟内未检测到登录");
      token = t;
      source = "catpaw-login-poll";
    }
  } finally {
    // 关掉回调服务器、取消还在跑的轮询（幂等）
    abort.abort();
    callback?.close();
  }

  if (!token) throw new Error("轮询超时：10 分钟内未检测到登录");

  // ③ 取 uid：账号池靠它认「同一个账号」（见 fetchCurrentUserId）
  onStatus?.("登录成功，正在获取账号信息…");
  const uid = await fetchCurrentUserId(token);

  const c = fromToken(token, source, uid);
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