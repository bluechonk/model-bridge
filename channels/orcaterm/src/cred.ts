/**
 * OrcaTerm 认证：登录（腾讯云 / 微信）、凭据持久化与有效性探测。
 *
 * ## 登录协议（实测，见 channels/orcaterm/docs/PROTOCOL.md）
 *
 * 两条 provider 走同一套骨架（App 建会话 → 平台授权 → 回调换 `ot_session`），
 * 差别只在授权方与回调路径：
 *
 *   | provider  | 授权方 | 回调 |
 *   | --- | --- | --- |
 *   | `txcloud` | cloud.tencent.com/open/authorize | /oauth/callback     |
 *   | `wechat`  | open.weixin.qq.com/connect/qrconnect | /oauth/wechat/bridge |
 *
 * - **微信**：可自建 —— `GET /oauth/wechat/config` 每次返回一套配置
 *   （`appid`/`redirect_uri`/`scope`/新 `state`），据此拼 `qrconnect` 交浏览器显示二维码，
 *   再本地长轮询 `long.open.weixin.qq.com` 拿 `wx_code`，经 `/oauth/wechat/bridge` 换
 *   `ot_session`。**全自动**。
 * - **腾讯云**：CLI 自己生成 `sessionId`，入口接受任意 `session_id` 即 302 到平台
 *   授权页；浏览器完成登录/授权后（`state` 随回调被消费、一次性），CLI 拿**自己的
 *   `sessionId`** 轮询 `POST /cgi/api OAuthExchangeToken` 换 `AccessToken`。
 *   同样**全自动**（用户只需在浏览器登录一次）。
 *
 * 微信路的桥接换 token 按 App 实测证据实现（登录后 cookie 落盘见 `ot_session`），
 * CLI 侧待真机点验一次；腾讯云路已真机跑通。见 docs/PROTOCOL.md §1 与 FINDINGS.md。
 *
 * ## 铁律
 *
 * token 原文不进日志/输出，只给指纹与脱敏形态。
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

import { credentialsPath, ensureDir, login as sharedLogin } from "@modelmux/gateway";

const { fetchWithTimeout, hostOf, decodeJwtPayload, jwtExpMs } = sharedLogin;

// ── 常量（实测，见 channels/orcaterm/docs/PROTOCOL.md）──────────────────────────

export const DEFAULT_BASE_URL = "https://orcaterm.com";

/** 微信登录配置（每次返回新的 appid/redirect_uri/scope/state，故可自建二维码）。 */
const WECHAT_CONFIG_URL = `${DEFAULT_BASE_URL}/oauth/wechat/config?source=desktop`;
/** 微信回调：带 wx code 命中后由后端下发 ot_session。 */
const WECHAT_BRIDGE_URL = `${DEFAULT_BASE_URL}/oauth/wechat/bridge`;
const WECHAT_QR_CONNECT_URL = "https://open.weixin.qq.com/connect/qrconnect";
const WECHAT_LONG_POLL_URL = "https://long.open.weixin.qq.com/connect/l/qrconnect";

/** 腾讯云开放平台给 OrcaTerm 的 app_id（客户端可见，非密钥）。 */
export const TXCLOUD_APP_ID = "100045893348";
/**
 * OrcaTerm 的 OAuth 入口。
 *
 * ⚠ 实测：带**任意** `session_id` 即 302 到平台授权页，`state` 由服务端生成
 * （每次调用都不同）—— 所以腾讯云的登录 URL **可以自建**，不需要桌面 App 给 state。
 */
const OAUTH_AUTHORIZE_URL = `${DEFAULT_BASE_URL}/oauth/authorize`;

/** 只读探测端点（`refresh()` 用；可用 `ORCATERN_USER_INFO_URL` 覆盖以便离线测试）。 */
export const USER_INFO_URL_DEFAULT = `${DEFAULT_BASE_URL}/cgi/v2/user/getInfo`;

/** provider 选择（非交互场景）。 */
const PROVIDER_ENV = "ORCATERN_LOGIN_PROVIDER";
/** 只读探测端点覆盖（离线测试用）。 */
const USER_INFO_URL_ENV = "ORCATERN_USER_INFO_URL";

const FETCH_TIMEOUT_MS = 30_000;
/** 扫码长轮询总上限。 */
const SCAN_TIMEOUT_MS = 5 * 60 * 1000;
/** 等用户完成浏览器登录、轮询换 token 的上限（与 catpaw 的 10 分钟窗口对齐）。 */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/** 轮询间隔。 */
const POLL_INTERVAL_MS = 2000;
/** CAPI 入口（`action` 走 body）。 */
const CAPI_URL = `${DEFAULT_BASE_URL}/cgi/api`;

// ── 登录方式 ──────────────────────────────────────────────────────────────────

export type LoginProvider = "txcloud" | "wechat";

/** 菜单顺序即此顺序。 */
export const PROVIDERS: readonly LoginProvider[] = ["txcloud", "wechat"];

export const PROVIDER_LABELS: Record<LoginProvider, string> = {
  txcloud: "腾讯云账号 (Tencent Cloud)",
  wechat: "微信登录 (WeChat QR)",
};

/** 非交互时的默认 provider：微信（唯一可全自动完成的路径）。 */
export const DEFAULT_PROVIDER: LoginProvider = "wechat";

/** 菜单输入的解析结果：`"default"` = 空输入用默认；`"invalid"` = 认不出的输入。 */
export type ProviderChoice = LoginProvider | "default" | "invalid";

/** 解析菜单输入（数字与英文别名都认，便于自动化）。 */
export function parseProviderChoice(raw: string): ProviderChoice {
  const text = raw.trim().toLowerCase();
  if (text === "") return "default";
  if (text === "1" || text === "txcloud" || text === "tencent" || text === "cloud") return "txcloud";
  if (text === "2" || text === "wechat" || text === "wx" || text === "weixin") return "wechat";
  return "invalid";
}

// ── 交互输入（提示写 stderr —— `--json` 时 stdout 要保持干净）──────────────────────

export interface LinePrompt {
  ask(prompt: string): Promise<string | null>;
}

class StdinPrompt implements LinePrompt {
  private readonly rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: Boolean(process.stdin.isTTY),
  });
  private readonly lines = this.rl[Symbol.asyncIterator]();

  async ask(prompt: string): Promise<string | null> {
    if (prompt) process.stderr.write(prompt);
    const { value, done } = await this.lines.next();
    return done ? null : String(value);
  }

  close(): void {
    this.rl.close();
  }
}

/** 交互式选择登录方式；EOF（stdin 关闭）回落默认。 */
export async function chooseProviderInteractively(
  defaultProvider: LoginProvider,
  prompt: LinePrompt,
): Promise<LoginProvider> {
  const defaultIndex = PROVIDERS.indexOf(defaultProvider) + 1;
  process.stderr.write(
    [
      "Select login method:",
      ...PROVIDERS.map((p, i) => `  ${i + 1}) ${PROVIDER_LABELS[p]}`),
      `Choice [1/${PROVIDERS.length}] (default: ${defaultIndex}): `,
    ].join("\n") + "\n",
  );
  for (;;) {
    const line = await prompt.ask("");
    if (line === null) return defaultProvider;
    const choice = parseProviderChoice(line);
    if (choice === "invalid") {
      process.stderr.write("Invalid choice: enter 1 (Tencent Cloud) or 2 (WeChat).\n");
      continue;
    }
    return choice === "default" ? defaultProvider : choice;
  }
}

// ── URL 构造（纯函数，便于测试）────────────────────────────────────────────────

/** 微信 `qrconnect`：浏览器打开该 URL 即显示二维码页。 */
export function buildWechatQrConnectUrl(cfg: {
  appid: string;
  redirectUri: string;
  scope: string;
  state: string;
}): string {
  return (
    WECHAT_QR_CONNECT_URL +
    `?appid=${encodeURIComponent(cfg.appid)}` +
    `&redirect_uri=${encodeURIComponent(cfg.redirectUri)}` +
    "&response_type=code" +
    `&scope=${encodeURIComponent(cfg.scope)}` +
    `&state=${encodeURIComponent(cfg.state)}`
  );
}

/** OrcaTerm OAuth 入口 URL（带 `session_id`，值任意；orcaterm 会 302 到平台授权页）。 */
export function buildAuthEntryUrl(
  provider: LoginProvider,
  sessionId: string,
  baseUrl = DEFAULT_BASE_URL,
): string {
  return (
    `${baseUrl}/oauth/authorize?provider=${provider}` +
    `&source=desktop&session_id=${encodeURIComponent(sessionId)}`
  );
}

/**
 * 解析入口的 302，拿到平台授权页的直达 URL。
 *
 * `state` 由 orcaterm 服务端生成并登记（实测每次调用都不同），**必须**用服务端
 * 下发的那一条 —— 自造 state 会在回调处被判 `INVALID_CALLBACK` / `STATE_EXPIRED`。
 *
 * ⚠ 实测 `return_url` 虽被入口接受，但登录完成后**不会**跳转到它（Google 历史无回环记录），
 * 故这里不依赖它；token 改由 `sessionId` 轮询换取（见 `loginByTxcloud`）。
 */
export async function resolvePlatformAuthorizeUrl(
  sessionId: string,
  baseUrl = DEFAULT_BASE_URL,
): Promise<string> {
  const res = await fetchWithTimeout(
    buildAuthEntryUrl("txcloud", sessionId, baseUrl),
    { redirect: "manual" },
    FETCH_TIMEOUT_MS,
  );
  const loc = res.headers.get("location");
  if (!loc) throw new Error(`unexpected /oauth/authorize response (HTTP ${res.status}, no Location)`);
  return loc;
}

/** 在响应 JSON 里递归找 `AccessToken`（成功/失败的包层可能不同，别写死路径）。 */
export function findAccessToken(value: unknown): string {
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findAccessToken(v);
      if (hit) return hit;
    }
    return "";
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "AccessToken" && typeof v === "string" && v.split(".").length === 3) return v;
      const hit = findAccessToken(v);
      if (hit) return hit;
    }
  }
  return "";
}

/** 取响应里的错误描述（仅用于状态提示）。 */
export function exchangeError(json: unknown): string {
  const err = (json as { data?: { Response?: { Error?: { Code?: string; Message?: string } } } })?.data
    ?.Response?.Error;
  return err ? `${err.Code ?? "?"}: ${err.Message ?? ""}` : "no AccessToken in response";
}

/**
 * 用 `sessionId` 换 token —— 桌面 App 的 `TokenManager` 走的就是这一步。
 *
 * 实测：`sessionId` 是**我们自己生成**的那个（见 `buildAuthEntryUrl`），
 * 浏览器登录完成后即可换取；未完成/不存在时统一报 `TOKEN_EXPIRED`
 * （所以轮询只能看「有没有 AccessToken」，不能靠错误码分支）。
 */
export async function exchangeSessionToken(
  sessionId: string,
  baseUrl = DEFAULT_BASE_URL,
): Promise<{ token: string; raw: unknown } | { error: string; raw: unknown }> {
  const res = await fetchWithTimeout(
    `${baseUrl === DEFAULT_BASE_URL ? CAPI_URL : `${baseUrl}/cgi/api`}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "OAuthExchangeToken", data: { sessionId } }),
    },
    FETCH_TIMEOUT_MS,
  );
  const json = (await res.json().catch(() => ({}))) as unknown;
  const token = findAccessToken(json);
  return token ? { token, raw: json } : { error: exchangeError(json), raw: json };
}

// ── 凭据 ──────────────────────────────────────────────────────────────────────

/** 未登录。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message = "not logged in; run `mx login orcaterm` first") {
    super(message);
  }
}

export interface Credentials {
  /** `ot_session` 的原文（HS256 JWT）。 */
  accessToken: string;
  /** OrcaTerm 用户 id（JWT `userId`）。 */
  uid: string;
  domain: string;
  /** 登录方式（wechat / txcloud）。 */
  provider: string;
  obtainedAt: string;
  expiresAt: string;
}

const EMPTY_CREDENTIALS: Credentials = {
  accessToken: "",
  uid: "",
  domain: "",
  provider: "",
  obtainedAt: "",
  expiresAt: "",
};

/** 解析 `ot_session`（JWT）→ 凭据字段；解析不出来也不抛（只是拿不到 uid/exp）。 */
export function decodeOtSession(token: string, provider = "wechat", baseUrl = DEFAULT_BASE_URL): Credentials {
  const payload = decodeJwtPayload(token);
  const uid = String(payload["userId"] ?? payload["uid"] ?? "");
  const expMs = jwtExpMs(token);
  return {
    accessToken: token,
    uid,
    domain: hostOf(baseUrl),
    provider,
    obtainedAt: sharedLogin.nowIso(),
    expiresAt: expMs > 0 ? new Date(expMs).toISOString() : "",
  };
}

/** token 指纹（只给脱敏形态，原文不进日志）。 */
export function fingerprint(token: string): string {
  if (!token) return "(none)";
  return `${token.slice(0, 8)}…${token.slice(-4)} (len ${token.length})`;
}

// ── 落盘 ──────────────────────────────────────────────────────────────────────

export function resolveBaseUrl(_realm = "auto"): string {
  return DEFAULT_BASE_URL;
}

/** 读凭据；缺失/损坏/空 token → `NotLoggedInError`。 */
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
    throw new NotLoggedInError(`credentials file is corrupt (${credentialsPath()}); please log in again`);
  }
  if (typeof data !== "object" || data === null) {
    throw new NotLoggedInError("credentials file has an unexpected structure; please log in again");
  }
  const rec = data as Record<string, unknown>;
  const accessToken = String(rec["accessToken"] ?? rec["access_token"] ?? "");
  if (!accessToken) throw new NotLoggedInError();
  return {
    ...EMPTY_CREDENTIALS,
    accessToken,
    uid: String(rec["uid"] ?? rec["userId"] ?? ""),
    domain: String(rec["domain"] ?? ""),
    provider: String(rec["provider"] ?? ""),
    obtainedAt: String(rec["obtainedAt"] ?? rec["obtained_at"] ?? ""),
    expiresAt: String(rec["expiresAt"] ?? rec["expires_at"] ?? ""),
  };
}

/** 原子写凭据（0600）。 */
export async function save(c: Credentials): Promise<void> {
  ensureDir();
  const path = credentialsPath();
  const tmp = `${path}.tmp`;
  const payload = {
    accessToken: c.accessToken,
    uid: c.uid,
    domain: c.domain,
    provider: c.provider,
    obtainedAt: c.obtainedAt || sharedLogin.nowIso(),
    expiresAt: c.expiresAt,
  };
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

// ── 换 token ──────────────────────────────────────────────────────────────────

/** 从响应头里取 `ot_session`（含 fallback：有些中转会把 token 放 body）。 */
function readOtSession(res: Response): string {
  const all = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const raw = all.length > 0 ? all : [res.headers.get("set-cookie") ?? ""];
  for (const line of raw) {
    const m = line.match(/(?:^|;\s*)ot_session=([^;]+)/);
    if (m?.[1]) return decodeURIComponent(m[1]);
  }
  return "";
}

/**
 * 访问回调/桥接 URL，取出 `ot_session`。
 *
 * `redirect: "manual"`：回调命中后后端可能 302，我们只要 Set-Cookie，不跟跳。
 */
async function exchangeForSession(callbackUrl: string): Promise<string> {
  const res = await fetchWithTimeout(callbackUrl, { redirect: "manual" }, FETCH_TIMEOUT_MS);
  const token = readOtSession(res);
  if (!token) {
    throw new Error(
      `callback did not return ot_session (HTTP ${res.status}); ` +
        `token 交换形态待验证，见 channels/orcaterm/docs/PROTOCOL.md §3`,
    );
  }
  return token;
}

// ── 登录 ──────────────────────────────────────────────────────────────────────

export interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (msg: string) => void;
  /** 显式指定 provider；不给时按 env / 交互菜单决定。 */
  provider?: LoginProvider;
}

/** 微信：config → 二维码页 URL → 长轮询 → 桥接换 token。 */
async function loginByWechat(options: LoginOptions, baseUrl: string): Promise<Credentials> {
  const { onUrl, onStatus } = options;
  onStatus?.("fetching wechat login config...");
  const cfgRes = await fetchWithTimeout(WECHAT_CONFIG_URL, {}, FETCH_TIMEOUT_MS);
  const cfg = (await cfgRes.json()) as {
    code?: number;
    data?: { appid?: string; redirect_uri?: string; scope?: string; state?: string };
  };
  const d = cfg.data ?? {};
  if (cfg.code !== 0 || !d.appid || !d.redirect_uri || !d.state) {
    throw new Error(`unexpected /oauth/wechat/config response: ${JSON.stringify(cfg).slice(0, 200)}`);
  }
  const qrUrl = buildWechatQrConnectUrl({
    appid: d.appid,
    redirectUri: d.redirect_uri,
    scope: d.scope ?? "snsapi_login",
    state: d.state,
  });
  onUrl?.(qrUrl);
  onStatus?.("open the URL and scan the QR code with WeChat");

  const xmlRes = await fetchWithTimeout(qrUrl + "&f=xml", {}, FETCH_TIMEOUT_MS);
  const xmlText = await xmlRes.text();
  const uuid = xmlText.match(/<uuid>(?:<!\[CDATA\[)?([^<\]]+)/)?.[1];
  if (!uuid) throw new Error(`wechat did not return a uuid: ${xmlText.slice(0, 200)}`);

  // 长轮询：408 等待 / 404 已扫待确认 / 405 已确认 / 403 取消 / 402 过期
  onStatus?.("waiting for scan...");
  const longPoll = `${WECHAT_LONG_POLL_URL}?uuid=${uuid}`;
  const deadline = Date.now() + SCAN_TIMEOUT_MS;
  let last = "";
  let wxCode = "";
  while (Date.now() < deadline) {
    let text: string;
    try {
      const res = await fetchWithTimeout(longPoll + (last ? `&last=${last}` : ""), {}, 35_000);
      text = await res.text();
    } catch {
      await sleep(2000);
      continue;
    }
    const errcode = text.match(/wx_errcode\s*=\s*(\d+)/)?.[1] ?? "";
    if (errcode && errcode !== last) onStatus?.(`wechat scan state=${errcode}`);
    if (errcode === "405") {
      wxCode = text.match(/wx_code\s*=\s*'([^']*)'/)?.[1] ?? "";
      break;
    }
    if (errcode === "402") throw new Error("QR code expired; run login again");
    if (errcode === "403") throw new Error("login canceled on the phone");
    last = errcode || last;
    await sleep(1000);
  }
  if (!wxCode) throw new Error("timed out waiting for the WeChat scan");

  onStatus?.("exchanging wx code for an OrcaTerm session...");
  const bridgeUrl = `${WECHAT_BRIDGE_URL}?code=${encodeURIComponent(wxCode)}&state=${encodeURIComponent(d.state)}`;
  const token = await exchangeForSession(bridgeUrl);
  onStatus?.(`session acquired (${fingerprint(token)})`);
  return decodeOtSession(token, "wechat", baseUrl);
}

/**
 * 腾讯云：本地生成 `sessionId` → 打开授权页 → **轮询** `OAuthExchangeToken(sessionId)` 换 token。
 *
 * 三条实测结论（前两条推翻了早期假设）：
 * - `return_url` 在入口被接受，但**登录后不会被跳转**（Chrome 历史里没有回环访问记录），故不靠回调；
 * - 会话**一次性**：浏览器命中 `/oauth/callback` 后 `state` 即失效（回放报 `STATE_EXPIRED`）；
 * - 但 `sessionId` 归我们所有 —— 浏览器完成登录后**由我们主动换取**，这正是桌面 App 的路径。
 */
async function loginByTxcloud(options: LoginOptions, baseUrl: string): Promise<Credentials> {
  const { onUrl, onStatus } = options;
  const sessionId = randomUUID();
  onStatus?.(`creating an OAuth session (${sessionId.slice(0, 8)}…)`);
  const loginUrl = await resolvePlatformAuthorizeUrl(sessionId, baseUrl);
  onUrl?.(loginUrl);
  onStatus?.("log in in the browser; this command finishes automatically once authorized");

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    const result = await exchangeSessionToken(sessionId, baseUrl);
    if ("token" in result) {
      onStatus?.(`session acquired (${fingerprint(result.token)})`);
      return decodeOtSession(result.token, "txcloud", baseUrl);
    }
    if (result.error !== lastError) {
      onStatus?.(`waiting for login… (${result.error})`);
      lastError = result.error;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("timed out waiting for the browser login to complete");
}

/** 决定用哪条路：显式 > env > （TTY 弹菜单）> 默认微信。 */
async function resolveProvider(options: LoginOptions, prompt: LinePrompt | null): Promise<LoginProvider> {
  if (options.provider) return options.provider;
  const fromEnv = parseProviderChoice(process.env[PROVIDER_ENV] ?? "");
  if (fromEnv !== "invalid" && fromEnv !== "default") return fromEnv;
  if (prompt) return chooseProviderInteractively(DEFAULT_PROVIDER, prompt);
  return DEFAULT_PROVIDER;
}

/**
 * 登录（`mx login orcaterm` 的落点）。
 *
 * provider 选择：显式 `options.provider` > `ORCATERN_LOGIN_PROVIDER` >
 * TTY 下弹菜单 > 默认 `wechat`。
 */
export async function login(baseUrl = DEFAULT_BASE_URL, options: LoginOptions = {}): Promise<Credentials> {
  const interactive = Boolean(process.stdin.isTTY) && !options.provider && !process.env[PROVIDER_ENV];
  const prompt = interactive ? new StdinPrompt() : null;
  try {
    const provider = await resolveProvider(options, prompt);
    options.onStatus?.(`login provider: ${provider}`);
    const creds =
      provider === "wechat"
        ? await loginByWechat(options, baseUrl)
        : await loginByTxcloud(options, baseUrl);
    await save(creds);
    options.onStatus?.(`logged in as uid=${creds.uid || "(unknown)"} (provider=${provider})`);
    return creds;
  } finally {
    if (prompt) prompt.close();
  }
}

/** `mx login --wechat orcaterm`：强制走微信扫码（共享层的可选钩子）。 */
export function loginWechat(baseUrl = DEFAULT_BASE_URL, options: LoginOptions = {}): Promise<Credentials> {
  return login(baseUrl, { ...options, provider: "wechat" });
}

// ── 有效性探测（`refresh()`）────────────────────────────────────────────────────

function userInfoUrl(): string {
  return process.env[USER_INFO_URL_ENV] || USER_INFO_URL_DEFAULT;
}

/**
 * 续期（本渠道无刷新端点，故做**有效性探测**）。
 *
 * 契约（CONTRACT-TS §5.1/§6）：无续期端点时 `refresh()` 只探测；失效必须抛错，
 * 不能假装续期成功。只有 401/403 判失效 —— 其它状态（含 5xx）当抖动。
 */
export async function refresh(c: Credentials): Promise<Credentials> {
  if (!c.accessToken) throw new NotLoggedInError();
  const res = await fetchWithTimeout(
    userInfoUrl(),
    { headers: { Cookie: `ot_session=${c.accessToken}` } },
    FETCH_TIMEOUT_MS,
  );
  if (res.status === 401 || res.status === 403) {
    throw new NotLoggedInError("OrcaTerm session expired; run `mx relogin orcaterm`");
  }
  return c;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
