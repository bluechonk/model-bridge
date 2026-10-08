/**
 * ZCode（智谱 z.ai）认证：OAuth CLI 登录、凭据持久化、有效性探测。
 *
 * ## 登录协议（实测形态，见 docs/protocols/zcode/PROTOCOL.md §2）
 *
 *   1. `POST {base}/api/v1/oauth/cli/init`
 *      ⚠ Authorization 是**本进程本地生成的会话密钥**，不是用户凭据 ——
 *      它只用来把「这次轮询」与「浏览器里那次授权」绑在一起。
 *   2. 浏览器打开授权页，人工授权（唯一人工步骤）
 *   3. `GET {base}/api/v1/oauth/cli/poll/{flow_id}` 轮询
 *      ⚠ 终态判据是 **HTTP 4xx（除 408/429）才是失败**；5xx 与网络错误继续重试
 *      —— 把 5xx 当失败会在上游抖动时把用户赶回登录页。
 *
 * ## 设备标识（device_mid）
 *
 * `X-Device-Mid` 是硬需求：缺它 `billing` 全家桶回 400 `{"code":3001}`。
 * 它的**值**不被服务端绑定校验（同一 JWT 换任意随机 UUID 都回 200），
 * 只需**稳定** ⇒ 由本模块随机生成并持久化进凭据。
 * ⚠ 它不是账号标识：同一账号每次重新登录都会得到新值，账号去重必须用 user_id。
 *
 * ## 没有续期端点
 *
 * 上游不提供 refresh。`refresh()` 只做**有效性探测**（调 fetchModels），
 * 失效时抛错 —— 不假装续期成功（那会让 UI 显示「已续期」而请求仍 401）。
 */

import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";

import { credentialsPath, ensureDir, login as sharedLogin, prefsPath } from "@model-bridge/gateway";

/** 积分制（Start Plan）上游根地址。订阅制走 api.z.ai，见 REALMS。 */
export const DEFAULT_BASE_URL = "https://zcode.z.ai";

/**
 * 支持的登录/上游域。
 *
 * ⚠ 积分制（start-plan）**无论账号是 bigmodel 还是 zai 都走 zcode.z.ai**
 * （官方分派表规则 2/5），不要因为账号是国际版就改域名；订阅制（coding-plan）
 * 才走 api.z.ai。
 *
 * `intl` / `cn` 是共享 CLI 的 `--realm` 取值（脚手架沿用了这套名字）：
 * 两个值都指向 zcode.z.ai —— 通道 host 由分派规则固定，与账号所在域无关。
 */
export const REALMS: Record<string, string> = {
  start: "https://zcode.z.ai",
  coding: "https://api.z.ai",
  intl: "https://zcode.z.ai",
  cn: "https://zcode.z.ai",
};

/** 登录页（授权链接兜底形态，redirect 指向 zcode 主域）。 */
const LOGIN_PAGE = "https://bigmodel.cn/login?appId=zcode";

const HTTP_TIMEOUT_MS = 30_000;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;

const NOT_LOGGED_IN_MSG = "no credentials found; run `zcode login` first";

/** 磁盘上不存在可用凭据。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message: string = NOT_LOGGED_IN_MSG) {
    super(message);
  }
}

/**
 * 磁盘上的凭据（JSON 字段名与渠道包一致：snake_case）。
 *
 * 同时保留契约要求的 `accessToken` / `uid` / `domain` 形态。
 */
export interface Credentials {
  /** ZCode JWT（磁盘 `zcode_jwt`），免费额度通道的 `Authorization: Bearer`。 */
  readonly accessToken: string;
  /** 设备标识（磁盘 `device_mid`），**硬需求**。 */
  readonly deviceMid: string;
  /** 账号标识（磁盘 `user_id`）—— 唯一能判断「两条记录是否同一账号」的稳定标识。 */
  readonly uid: string;
  /** 大模型 access token，备用身份。 */
  readonly bigmodelAccessToken?: string;
  /** 客户端版本（用于 `X-ZCode-App-Version`）。 */
  readonly appVersion?: string;
  /** 绑定的域；本渠道无此概念时为空串。 */
  readonly domain: string;
  readonly obtainedAt?: string;
}

export const EMPTY_CREDENTIALS: Credentials = {
  accessToken: "",
  deviceMid: "",
  uid: "",
  domain: "",
};

/** 生成 device_mid：值不被校验，只要稳定（生成后持久化在凭据里）。 */
export function generateDeviceMid(): string {
  return randomUUID();
}

/** 取值收窄（转发共享层原语）。 */
const str = sharedLogin.str;

function readPrefs(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(prefsPath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 把 realm 参数解析为上游 base url。 */
export function resolveBaseUrl(realm = "auto"): string {
  if (realm in REALMS) return REALMS[realm]!;
  if (realm !== "" && realm !== "auto") throw new Error(`未知 realm: ${realm}`);
  try {
    const c = load();
    if (c.domain) return `https://${c.domain}`;
  } catch {
    /* 未登录/损坏都走默认 */
  }
  const saved = readPrefs()["realm"];
  if (typeof saved === "string" && saved in REALMS) return REALMS[saved]!;
  return DEFAULT_BASE_URL;
}

/** 从 base URL 提取主机名（转发共享层原语）。 */
export function hostOf(baseUrl: string): string {
  return sharedLogin.hostOf(baseUrl);
}

/**
 * 从磁盘读取凭据。
 *
 * 兼容三种形态：本渠道规范字段（`zcode_jwt`/`device_mid`/`user_id`）、
 * 契约字段（`accessToken`/`uid`）与驼峰历史字段。
 *
 * ⚠ 老凭据缺 `device_mid` 时**就地补齐并同步回写**，而不是拒绝整条凭据 ——
 * 它是硬需求，且每次重新生成值都会变（不稳定的 mid 会让服务端无法关联设备）。
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
    accessToken: str(rec["zcode_jwt"]) || str(rec["accessToken"]) || str(rec["zcodeJwt"]),
    deviceMid: str(rec["device_mid"]) || str(rec["deviceMid"]),
    uid: str(rec["user_id"]) || str(rec["userId"]) || str(rec["uid"]),
    bigmodelAccessToken: str(rec["bigmodel_access_token"]) || str(rec["bigmodelAccessToken"]),
    appVersion: str(rec["app_version"]) || str(rec["appVersion"]),
    domain: str(rec["domain"]),
    obtainedAt: str(rec["obtained_at"]) || str(rec["obtainedAt"]),
  };
  if (!c.accessToken) throw new NotLoggedInError();

  if (!c.deviceMid) {
    const filled: Credentials = { ...c, deviceMid: generateDeviceMid() };
    try {
      persistSync(filled);
    } catch {
      /* 回写失败不阻塞：本次进程内仍有一份稳定 mid */
    }
    return filled;
  }
  return c;
}

/** 磁盘序列化（snake_case，与渠道包字段名一致）。 */
function toDisk(c: Credentials): string {
  const disk: Record<string, unknown> = {
    zcode_jwt: c.accessToken,
    device_mid: c.deviceMid,
    user_id: c.uid,
  };
  if (c.bigmodelAccessToken) disk["bigmodel_access_token"] = c.bigmodelAccessToken;
  if (c.appVersion) disk["app_version"] = c.appVersion;
  if (c.domain) disk["domain"] = c.domain;
  if (c.obtainedAt) disk["obtained_at"] = c.obtainedAt;
  return `${JSON.stringify(disk, null, 2)}\n`;
}

/** 同步原子写（仅供 load() 补齐缺失字段时使用：它必须是同步的）。 */
function persistSync(c: Credentials): void {
  ensureDir();
  const path = credentialsPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, toDisk(c), "utf8");
  // 同目录 rename 是原子替换：崩溃不会留下半截 JSON
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows 上 chmod 意义有限 */
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

// ── OAuth CLI 登录 ────────────────────────────────────────────────────────────

interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (msg: string) => void;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<Response> {
  return sharedLogin.fetchWithTimeout(url, init, timeoutMs);
}

/** 登录会话的伪装头（Authorization 是本地会话密钥，不是用户凭据）。 */
function sessionHeaders(sessionKey: string, deviceMid: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": "ZCode/3.14.4",
    "HTTP-Referer": "https://zcode.z.ai",
    "X-Release-Channel": "stable",
    "X-Client-Language": "zh-CN",
    "X-Client-Timezone": "Asia/Shanghai",
    "X-Device-Mid": deviceMid,
    "X-Platform": "win32",
    "X-Os-Category": "windows",
    Authorization: `Bearer ${sessionKey}`,
  };
}

function objOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 在信封中找第一个非空字符串字段（顶层与 data 内都找）。 */
function pickString(env: Record<string, unknown>, keys: string[]): string {
  const layers = [env, objOrNull(env["data"])].filter((x): x is Record<string, unknown> => !!x);
  for (const layer of layers) {
    for (const key of keys) {
      const v = layer[key];
      if (typeof v === "string" && v) return v;
    }
  }
  return "";
}

/** 从轮询响应中提取 JWT / 账号标识（兼容多种信封形状）。 */
function extractToken(env: Record<string, unknown>): { token: string; uid: string } {
  const tokenKeys = ["zcode_jwt", "zcodeJwt", "token", "access_token", "accessToken", "jwt"];
  const uidKeys = ["user_id", "userId", "uid", "sub"];
  return { token: pickString(env, tokenKeys), uid: pickString(env, uidKeys) };
}

async function createFlow(
  base: string,
  sessionKey: string,
  deviceMid: string,
): Promise<{ flowId: string; authorizeUrl: string }> {
  const resp = await fetchWithTimeout(`${base}/api/v1/oauth/cli/init`, {
    method: "POST",
    body: "{}",
    headers: sessionHeaders(sessionKey, deviceMid),
  });
  if (resp.status !== 200) throw new Error(`发起登录失败: HTTP ${resp.status}`);
  const env = objOrNull(await resp.json().catch(() => null));
  if (!env) throw new Error("发起登录失败: 响应不是 JSON 对象");
  const flowId = pickString(env, ["flow_id", "flowId", "id"]);
  if (!flowId) throw new Error("发起登录失败: 响应缺少 flow_id");
  let authorizeUrl = pickString(env, [
    "authorize_url",
    "auth_url",
    "login_url",
    "redirect_url",
    "url",
  ]);
  if (!authorizeUrl) {
    // 兜底：官方登录页 + redirect 指向渠道主域
    authorizeUrl = `${LOGIN_PAGE}&redirect=${encodeURIComponent(base)}`;
  }
  return { flowId, authorizeUrl };
}

/**
 * 轮询授权结果。
 *
 * ⚠ 终态判据：**HTTP 4xx（除 408/429）才是失败**；5xx 与网络错误继续重试。
 * 2xx 但响应里还没有 token（授权中）也继续轮询。
 */
async function pollFlow(
  base: string,
  sessionKey: string,
  deviceMid: string,
  flowId: string,
  onStatus?: (msg: string) => void,
  windowMs = LOGIN_WINDOW_MS,
): Promise<{ token: string; uid: string }> {
  const url = `${base}/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`;
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetchWithTimeout(url, { headers: sessionHeaders(sessionKey, deviceMid) });
      if (resp.status >= 400 && resp.status < 500) {
        if (resp.status === 408 || resp.status === 429) {
          onStatus?.(`轮询被限流（HTTP ${resp.status}），稍后重试…`);
        } else {
          throw new Error(`授权失败：上游返回 HTTP ${resp.status}`);
        }
      } else if (resp.status >= 500) {
        onStatus?.(`上游暂时不可用（HTTP ${resp.status}），继续重试…`);
      } else {
        const env = objOrNull(await resp.json().catch(() => null));
        if (env) {
          const { token, uid } = extractToken(env);
          if (token) return { token, uid };
          const status = pickString(env, ["status", "state"]).toLowerCase();
          if (["failed", "denied", "rejected", "expired"].includes(status)) {
            throw new Error(`授权失败：上游状态 ${status}`);
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("授权失败")) throw err;
      onStatus?.(`轮询失败（${String(err)}），继续重试…`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`等待授权超时（${Math.round(windowMs / 60000)} 分钟）`);
}

/**
 * 运行一次浏览器 OAuth CLI 登录并持久化结果。
 *
 * ⚠ `onUrl` 必须在拿到 URL 后**立刻**调用（界面据此弹窗）。
 */
export async function login(baseUrl?: string, options: LoginOptions = {}): Promise<Credentials> {
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const { onUrl, onStatus } = options;
  const sessionKey = randomBytes(32).toString("hex");
  const deviceMid = generateDeviceMid();

  const { flowId, authorizeUrl } = await createFlow(base, sessionKey, deviceMid);
  onUrl?.(authorizeUrl);
  onStatus?.("请在浏览器中完成授权（本进程会自动继续）…");
  openBrowser(authorizeUrl);

  const { token, uid } = await pollFlow(base, sessionKey, deviceMid, flowId, onStatus);
  const c: Credentials = {
    accessToken: token,
    deviceMid,
    uid,
    domain: hostOf(base) === hostOf(DEFAULT_BASE_URL) ? "" : hostOf(base),
    obtainedAt: new Date().toISOString(),
  };
  await save(c);
  onStatus?.("授权成功，凭据已保存。");
  return c;
}

/**
 * 刷新凭据。
 *
 * ⚠ 上游**没有续期端点** ⇒ 这里只做**有效性探测**（调 fetchModels），
 * 失效时抛错。绝不假装续期成功。
 */
export async function refresh(c: Credentials): Promise<Credentials> {
  const upstream = await import("./upstream.js");
  await upstream.fetchModels(c); // 失败即抛（401/403 → UpstreamUnauthorized）
  return c;
}

/**
 * Windows 下用 `cmd /c start "" "{url}"` 打开浏览器。
 *
 * ⚠ 空标题 `""` 是必须的：否则 URL 里的 `&` 会被 cmd 当命令分隔符截断。
 */
export function openBrowser(url: string): void {
  sharedLogin.openBrowser(url);
}
