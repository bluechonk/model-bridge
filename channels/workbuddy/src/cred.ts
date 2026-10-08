/**
 * 认证状态：浏览器设备登录流程、凭证持久化与访问令牌刷新。
 *
 * 登录协议（实测，与国际版 workbuddyai 同一套插件端点）：
 *   1. `POST {base}/v2/plugin/auth/state?platform=workbuddy`（匿名头）→ {state, authUrl}
 *   2. 浏览器打开 authUrl，人工授权（唯一人工步骤）
 *   3. `GET {base}/v2/plugin/auth/token?state=...` 每 5s 轮询，≤5 分钟 → 令牌
 *   4. 落盘为 credentials.json（Go 风格字段名）
 * 刷新：`POST /v2/plugin/auth/refresh`（纯 HTTP，无需浏览器）
 *
 * ⚠ 本渠道**只有一个域**（国内版 codebuddy.ai）。账号属于哪个域就必须用哪个渠道
 * 登录：国内账号走本渠道，国际账号走 `workbuddyai` —— 不再有 `--realm` 二选一。
 */

import { readFileSync } from "node:fs";
import { writeFile, rename, chmod } from "node:fs/promises";

import {
  credentialsPath,
  ensureDir,
  login as sharedLogin,
} from "@model-bridge/gateway";

/** 登录基址（国内版 CodeBuddy）。 */
export const DEFAULT_BASE_URL = "https://www.codebuddy.ai";

/** 向插件端点标识本客户端。 */
const PLATFORM_QS = "platform=workbuddy";

const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const MAX_LOGIN_ROUNDS = 2;
const HTTP_TIMEOUT_MS = 30_000;

const NOT_LOGGED_IN_MSG = "no credentials found; start the gateway to log in";

/** 磁盘上不存在可用凭证。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message: string = NOT_LOGGED_IN_MSG) {
    super(message);
  }
}

/** credentials.json 的磁盘布局。JSON 字段名与 Go 版一致（camelCase）。 */
export interface Credentials {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scope: string;
  sessionState: string;
  domain: string;
  uid: string;
  expiresIn: string;
  expiresAt: unknown;
  refreshExpiresIn: string;
  refreshExpiresAt: unknown;
  obtainedAt: string;
  source: string;
}

export const EMPTY_CREDENTIALS: Credentials = {
  accessToken: "",
  refreshToken: "",
  tokenType: "",
  scope: "",
  sessionState: "",
  domain: "",
  uid: "",
  expiresIn: "",
  expiresAt: null,
  refreshExpiresIn: "",
  refreshExpiresAt: null,
  obtainedAt: "",
  source: "",
};

/** 取值收窄（转发共享层原语，见 `@model-bridge/gateway` 的 `login.ts`）。 */
const str = sharedLogin.str;

/**
 * 解析登录基址。
 *
 * 国内版**只有一个域**，`realm` 参数仅作兼容保留（共享层 CLI 会传进来）。
 */
export function resolveBaseUrl(_realm = "auto"): string {
  return DEFAULT_BASE_URL;
}

/** 从 base URL 提取主机名（转发共享层原语）。 */
export function hostOf(baseUrl: string): string {
  return sharedLogin.hostOf(baseUrl);
}

/** 从 JWT 载荷提取 sub 声明（转发共享层原语）。 */
function jwtSub(token: string): string {
  return sharedLogin.jwtSubject(token);
}

/** 当前时间的 RFC3339 字串（转发共享层原语）。 */
const nowRfc3339 = sharedLogin.nowIso;

/**
 * 从磁盘读取凭证。
 *
 * 文件缺失 / JSON 损坏 / accessToken 为空时一律抛 NotLoggedInError。
 * uid 为空时从 JWT sub 提取补上。
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
  const rec = data as Record<string, unknown>;
  const c: Credentials = {
    accessToken: str(rec["accessToken"]),
    refreshToken: str(rec["refreshToken"]),
    tokenType: str(rec["tokenType"]),
    scope: str(rec["scope"]),
    sessionState: str(rec["sessionState"]),
    domain: str(rec["domain"]),
    uid: str(rec["uid"]),
    expiresIn: str(rec["expiresIn"]),
    expiresAt: rec["expiresAt"] ?? null,
    refreshExpiresIn: str(rec["refreshExpiresIn"]),
    refreshExpiresAt: rec["refreshExpiresAt"] ?? null,
    obtainedAt: str(rec["obtainedAt"]),
    source: str(rec["source"]),
  };
  if (!c.accessToken) throw new NotLoggedInError();
  if (!c.uid) c.uid = jwtSub(c.accessToken);
  return c;
}

/**
 * 以 0600 权限写入凭证文件（Windows 上 chmod 意义有限，仍保持一致）。
 *
 * 先写临时文件再原子替换：写入过程崩溃不会留下半截 JSON 导致凭证损坏。
 */
export async function save(c: Credentials): Promise<void> {
  ensureDir();
  const path = credentialsPath();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(c, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

function fromToken(
  access: string,
  refresh: string,
  tokenType: string,
  scope: string,
  session: string,
  domain: string,
): Credentials {
  return {
    ...EMPTY_CREDENTIALS,
    accessToken: access,
    refreshToken: refresh,
    tokenType,
    scope,
    sessionState: session,
    domain,
    uid: jwtSub(access),
    obtainedAt: nowRfc3339(),
    source: "workbuddy-login-poll",
  };
}

/** 把请求标记为匿名（未鉴权）的插件端点头。 */
function anonHeaders(): Record<string, string> {
  return {
    "X-No-Authorization": "true",
    "X-No-User-Id": "true",
    "X-No-Enterprise-Id": "true",
    "X-No-Department-Info": "true",
  };
}

function anyToStr(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

function unixAfter(startMs: number, value: unknown): number | null {
  let seconds: number;
  if (typeof value === "number") seconds = value;
  else if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return null;
    seconds = parsed;
  } else return null;
  return Math.trunc(startMs / 1000 + seconds);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = HTTP_TIMEOUT_MS, ...rest } = init;
  return sharedLogin.fetchWithTimeout(url, rest, timeoutMs);
}

async function createLoginState(
  baseUrl: string,
): Promise<Record<string, unknown>> {
  const resp = await fetchWithTimeout(`${baseUrl}/v2/plugin/auth/state?${PLATFORM_QS}`, {
    method: "POST",
    body: "{}",
    headers: { ...anonHeaders(), "Content-Type": "application/json" },
  });
  if (resp.status !== 200) throw new Error(`create login link: HTTP ${resp.status}`);
  let env: Record<string, unknown>;
  try {
    env = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`create login link: invalid JSON: ${String(err)}`);
  }
  if (env["code"] !== 0 || !env["data"]) {
    throw new Error(
      `failed to create login link: code=${String(env["code"])} msg=${String(env["msg"] ?? "")}`,
    );
  }
  const state = env["data"] as Record<string, unknown>;
  if (!state["state"]) throw new Error("login state is empty");
  return state;
}

async function pollToken(baseUrl: string, state: string): Promise<Record<string, unknown> | null> {
  const url = `${baseUrl}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`;
  const deadline = Date.now() + LOGIN_WINDOW_MS;
  while (Date.now() < deadline) {
    try {
      const resp = await fetchWithTimeout(url, { headers: anonHeaders() });
      if (resp.status === 200) {
        const env = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
        if (env && env["code"] === 0 && env["data"]) {
          const data = env["data"] as Record<string, unknown>;
          if (data["accessToken"]) return data;
        }
      }
    } catch {
      /* 轮询失败下一轮再试 */
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}

/**
 * Windows 下用 `cmd /c start "" "{url}"` 打开浏览器（转发共享层原语）。
 *
 * ⚠ 空标题 `""` 不可省：否则 URL 里的 `&` 会被 cmd 当命令分隔符截断。
 */
export function openBrowser(url: string): void {
  sharedLogin.openBrowser(url);
}

export interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (message: string) => void;
}

/** 运行交互式浏览器登录并持久化结果。 */
export async function login(baseUrl: string, options: LoginOptions = {}): Promise<Credentials> {
  const base = baseUrl || DEFAULT_BASE_URL;
  const { onUrl, onStatus } = options;

  for (let round = 1; round <= MAX_LOGIN_ROUNDS; round += 1) {
    const state = await createLoginState(base);
    let authUrl = str(state["authUrl"]);
    if (!authUrl) {
      authUrl = `${base}/login?${PLATFORM_QS}&state=${encodeURIComponent(str(state["state"]))}`;
    }
    onUrl?.(authUrl);
    onStatus?.(
      `第 ${round}/${MAX_LOGIN_ROUNDS} 轮：已打开浏览器授权页，` +
        `等待授权中（最多 ${LOGIN_WINDOW_MS / 60000} 分钟）…`,
    );
    openBrowser(authUrl);
    const token = await pollToken(base, str(state["state"]));
    if (!token) {
      onStatus?.(`第 ${round} 轮等待超时，准备重试…`);
      continue;
    }
    const c = fromToken(
      str(token["accessToken"]),
      str(token["refreshToken"]),
      str(token["tokenType"]),
      str(token["scope"]),
      str(token["sessionState"]),
      str(token["domain"]),
    );
    if (!c.domain) c.domain = hostOf(base);
    c.expiresIn = anyToStr(token["expiresIn"]);
    c.refreshExpiresIn = anyToStr(token["refreshExpiresIn"]);
    const now = Date.now();
    c.expiresAt = unixAfter(now, token["expiresIn"]);
    c.refreshExpiresAt = unixAfter(now, token["refreshExpiresIn"]);
    await save(c);
    return c;
  }
  throw new Error(`no login detected after ${MAX_LOGIN_ROUNDS} attempt(s)`);
}

/** 用存储的刷新令牌换取新的访问令牌。失败由调用方回退到交互登录。 */
export async function refresh(c: Credentials): Promise<Credentials> {
  if (!c.refreshToken) throw new Error("no refresh token available");
  const base = c.domain ? `https://${c.domain}` : DEFAULT_BASE_URL;
  const resp = await fetchWithTimeout(`${base}/v2/plugin/auth/refresh?${PLATFORM_QS}`, {
    method: "POST",
    body: JSON.stringify({ refreshToken: c.refreshToken }),
    headers: { ...anonHeaders(), "Content-Type": "application/json" },
  });
  if (resp.status !== 200) throw new Error(`refresh failed: HTTP ${resp.status}`);
  let env: Record<string, unknown>;
  try {
    env = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`refresh: invalid JSON: ${String(err)}`);
  }
  if (env["code"] !== 0 || !env["data"]) {
    throw new Error(`refresh failed: code=${String(env["code"])} msg=${String(env["msg"] ?? "")}`);
  }
  const token = env["data"] as Record<string, unknown>;
  if (!token["accessToken"]) throw new Error("refresh returned an empty access token");

  const or = (value: unknown, fallback: string): string => {
    const s = typeof value === "string" ? value : anyToStr(value);
    return s || fallback;
  };
  const next = fromToken(
    str(token["accessToken"]),
    or(token["refreshToken"], c.refreshToken),
    or(token["tokenType"], c.tokenType),
    or(token["scope"], c.scope),
    or(token["sessionState"], c.sessionState),
    or(token["domain"], c.domain),
  );
  const now = Date.now();
  next.expiresIn = anyToStr(token["expiresIn"]);
  next.refreshExpiresIn = anyToStr(token["refreshExpiresIn"]);
  next.expiresAt = unixAfter(now, token["expiresIn"]);
  next.refreshExpiresAt = unixAfter(now, token["refreshExpiresIn"]);
  if (!next.uid) next.uid = c.uid;
  await save(next);
  return next;
}

/**
 * 兼容别名：现规范名等同 `paths.credentialsPath()` 的文件名部分
 * （凭证落点由共享层按 cid 推导，见 docs/STORAGE-CONVENTION.md）。
 */
export const CREDENTIALS_FILE = "credentials.json";
