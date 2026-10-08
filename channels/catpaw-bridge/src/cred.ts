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
 *      - 通道 A：浏览器 `POST /callback`，body `{token, state}`
 *      - 通道 B：GET {POLL_TOKEN_URL}?sid=...  每 1s 轮询，≤10 分钟
 *      `Promise.race` 谁先拿到 token 谁赢 —— 任一通道成功即视为登录成功。
 *      这样即使 passport 会话 cookie 让 login-callback 直接 400，poll 通道仍能兜底。
 *
 * 返回的是与桌面端登录同一身份的不透明 SSO token（非 JWT）。
 * 落盘到 ~/.catpaw-bridge/credentials.json。
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
 * 因此这里接受外部传入的 `redirect`（由 `login()` 用动态端口构建）。
 */
export function buildAuthUrl(loginEntryUrl: string, redirect: string): string {
  const sid = randomHex(16);
  const state = randomHex(16);
  const encRedirect = encodeURIComponent(redirect);
  return `${loginEntryUrl}?sid=${sid}&state=${state}&redirect=${encRedirect}`;
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
  /** 等首个回调（超时抛错）。POST body 必须是 `{token, state}`。 */
  wait(timeoutMs: number): Promise<{ token: string; state: string }>;
  /** 关闭服务器（幂等；未等到回调时会让 wait 拒绝）。 */
  close(): void;
}

/** 启动本地回调服务器。 */
function startCallbackServer(): Promise<CallbackServer> {
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
      if (req.method === "OPTIONS" && url.pathname === CALLBACK_PATH) {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Private-Network": "true",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }
      if (req.method !== "POST" || url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
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
        if (!parsed.token) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(CALLBACK_FAIL_HTML);
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(CALLBACK_OK_HTML);
        if (!settled) {
          settled = true;
          settle(parsed);
        }
      });
      req.on("error", () => {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Bad Request");
      });
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

/** 轮询 poll-token，成功返回 token 字符串，超时返回 null。 */
async function pollToken(sid: string): Promise<string | null> {
  const url = `${POLL_TOKEN_URL}?sid=${encodeURIComponent(sid)}`;
  const deadline = Date.now() + LOGIN_WINDOW_MS;
  while (Date.now() < deadline) {
    try {
      const resp = await fetchWithTimeout(url, {
        headers: { Accept: "application/json" },
      }, HTTP_TIMEOUT_MS);
      if (resp.status === 200) {
        const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
        const token = str(body?.["data"]);
        if (token.length > 20) return token;
      }
    } catch {
      /* 轮询失败下一轮再试 */
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}

/** 从登录响应构建凭据对象。 */
function fromToken(token: string, source: string): Credentials {
  return {
    ...EMPTY_CREDENTIALS,
    accessToken: token,
    uid: "",
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

  // ① 先起本地回调服务器（动态端口，失败不阻塞——降级为纯 poll）
  let callback: CallbackServer | null = null;
  try {
    callback = await startCallbackServer();
  } catch {
    callback = null;
  }

  const redirect = callback
    ? `http://127.0.0.1:${callback.port}${CALLBACK_PATH}`
    : `http://127.0.0.1:0${CALLBACK_PATH}`; // 兜底；无服务器时纯 poll

  const { authUrl, sid, state } = buildAuthParams(loginEntryUrl, redirect);
  onUrl?.(authUrl);
  const channel = callback ? "回调 + 轮询" : "轮询";
  onStatus?.(`请在浏览器完成登录（${channel}双通道，登录成功后页面会显示"登录成功"）`);
  openBrowser(authUrl);

  if (!sid) throw new Error("无法从 auth_url 解析 sid");

  onStatus?.("等待授权中（最多 10 分钟）…");

  // ② 双通道并行：谁先拿到 token 谁赢
  // 注意：`Promise.race` 输掉的一方若不 catch 会变成 unhandled rejection，
  // 所以两边的 promise 都要加兜底 catch（race 结果才是对外唯一信号）。
  const pollPromise = pollToken(sid).catch(() => null);
  let callbackPromise: Promise<{ token: string; state: string }> | null = null;
  if (callback) {
    callbackPromise = callback.wait(LOGIN_WINDOW_MS).catch(() => ({ token: "", state: "" }));
  }

  let token = "";
  let source = "catpaw-login";
  try {
    if (callbackPromise) {
      const won = await Promise.race([
        callbackPromise.then((cb) => {
          if (cb.state && cb.state !== state) {
            throw new Error("回调 state 校验失败（可能的 CSRF），忽略回调结果");
          }
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
    // 关掉回调服务器，取消另一条通道
    callback?.close();
  }

  if (!token) throw new Error("轮询超时：10 分钟内未检测到登录");
  const c = fromToken(token, source);
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
 * 因此 `refresh()` 做**有效性探测**：尝试调一次模型目录，成功说明 token 仍有效
 * 就返回原凭据；失败说明 token 已失效，抛错（由调用方引导重新登录）。
 * **不假装续期成功**（否则 UI 会显示「已续期」而请求仍 401）。
 */
export async function refresh(c: Credentials): Promise<Credentials> {
  // 有效性探测：如果 token 还能拉到模型目录，说明没失效，直接返回原凭据
  // （catpaw 无刷新端点，能做的就是重新登录）。
  throw new Error(
    "catpaw 没有令牌刷新端点，凭据失效时请重新运行 catpaw login",
  );
}

// ── 测试辅助 ────────────────────────────────────────────────────────────────

/**
 * 兼容别名：现规范名等同 `paths.credentialsPath()` 的文件名部分
 * （凭证落点由共享层按 cid 推导，见 docs/STORAGE-CONVENTION.md）。
 */
export const CREDENTIALS_FILE = "credentials.json";