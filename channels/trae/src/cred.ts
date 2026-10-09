/**
 * TRAE（字节跳动）认证：浏览器授权登录、设备指纹、ExchangeToken 续期。
 *
 * ## 登录（实测，docs/protocols/trae/PROTOCOL.md §2）
 *
 * - 登录页参数名必须是 **`auth_callback_url`**（没有 `callback_url`/`redirect_uri`），
 *   写错登录页**永远停在授权中**（真实缺陷）。
 * - **回调直接回传 token**（不是 OAuth `?code=`）；若上游改走 PKCE
 *   （回调里只有 `code`/`authCode`），本模块明确报错而不是静默失败。
 * - 本地回调端口 **18080**，被占用（EADDRINUSE/EACCES）时回退随机端口，
 *   登录 URL 用**实际**端口重算。
 * - 昵称有 latin-1 双重编码乱码（实测 `Óû§8847309959`），用
 *   `Buffer.from(raw,"latin1").toString("utf8")` 修复；修不好且无 CJK 时回退
 *   `用户+uid末4位`。
 *
 * ## 设备指纹
 *
 * - `machine_id` / `device_id` 都是 **32 位 hex**（早期误做成 16 位纯数字，与协议不符）。
 * - `device_id` **每账号互不相同**：同日两账号共用会被「该设备已签到」拦截。
 * - 签到用的设备标识是**确定性派生**（`sha256(salt:uid + 代数)`），因此同一账号
 *   稳定唯一，从而规避「每设备每天一次」配额；9074（设备级限流）时轮换代次。
 *
 * ## 续期
 *
 * `POST {oauthHost}/cloudide/api/v3/trae/oauth/ExchangeToken`
 * —— **access 与 refresh 都轮换**，续期后必须回写。
 * 终态（需重新登录）三条任一：HTTP 401/403、错误分类 session-dead、
 * **2xx 且响应是 JSON 却没有 accessToken**（含 HTML 错误页）。
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";

import { credentialsPath, ensureDir, login as sharedLogin, prefsPath } from "@model-bridge/gateway";

/** agentHost（对话 + 模型列表）。 */
export const DEFAULT_BASE_URL = "https://trae-api-cn.mchost.guru";

/** OAuth host（ExchangeToken / GetUserInfo）。 */
export const OAUTH_HOST = "https://api.trae.com.cn";

/** 签到 / 积分 host（规格里是硬编码，未用 product.ugHost）。 */
export const UG_HOST = "https://api.trae.cn";

/** 登录门户（consoleHost）。 */
export const CONSOLE_HOST = "https://www.trae.cn";

export const CLIENT_ID = "en1oxy7wnw8j9n";
export const APP_ID = "6eefa01a-1036-4c7e-9ca5-d891f63bfcd8";
/** ideVersion 是模型准入条件：版本过低时 glm-5.3 等新模型报 4001。 */
export const IDE_VERSION = "0.1.52";
export const IDE_VERSION_CODE = "20260811";
/** 登录 URL 用的 pluginVersion（≠ ideVersion）。 */
export const PLUGIN_VERSION = "2.3.62834";
export const USER_AGENT = "Trae/0.1.52";

export const CALLBACK_PORT = 18080;
export const CALLBACK_PATH = "/authorize";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const HTTP_TIMEOUT_MS = 30_000;

const NOT_LOGGED_IN_MSG = "no credentials found; run `trae login` first";

/** 磁盘上不存在可用凭据。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message: string = NOT_LOGGED_IN_MSG) {
    super(message);
  }
}

/** 登录/续期要求重新登录（终态）。 */
export class ReloginRequiredError extends Error {
  override name = "ReloginRequiredError";
}

/**
 * 凭据（磁盘字段与渠道包一致：snake_case）。
 *
 * 同时保留契约要求的 `accessToken` / `uid` / `domain` 形态。
 */
export interface Credentials {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** 毫秒字符串（兼容秒/ISO/JWT exp 兜底）。 */
  readonly expiresAt: string;
  readonly uid: string;
  readonly nickname: string;
  readonly phone: string;
  readonly email: string;
  /** 登录后绝不变，32 位 hex。 */
  readonly machineId: string;
  /** 每账号互不相同，32 位 hex。 */
  readonly deviceId: string;
  readonly enterpriseId: string;
  /** 绑定的域（agentHost）。 */
  readonly domain: string;
  /** 续期用的 OAuth host 覆盖（部分账号下发）。 */
  readonly apiHost?: string;
  /** 签到设备派生的代数（9074 时 +1）。 */
  readonly checkinGeneration?: number;
  readonly obtainedAt?: string;
}

export const EMPTY_CREDENTIALS: Credentials = {
  accessToken: "",
  refreshToken: "",
  expiresAt: "",
  uid: "",
  nickname: "",
  phone: "",
  email: "",
  machineId: "",
  deviceId: "",
  enterpriseId: "",
  domain: "",
  checkinGeneration: 0,
};

/** 上游 OAuth host（可用 TRAE_OAUTH_HOST 覆盖，便于离线自检）。 */
export function oauthHost(): string {
  return (process.env["TRAE_OAUTH_HOST"] || OAUTH_HOST).replace(/\/+$/, "");
}

/** 签到 host（可用 TRAE_UG_HOST 覆盖，便于离线自检）。 */
export function ugHost(): string {
  return (process.env["TRAE_UG_HOST"] || UG_HOST).replace(/\/+$/, "");
}

/** 取值收窄（转发共享层原语）。 */
const str = sharedLogin.str;

function intOrZero(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

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

/** 支持的域（源码中不存在国际版配置，只有这一份 CN 配置）。 */
export const REALMS: Record<string, string> = {
  cn: DEFAULT_BASE_URL,
};

/** 把 realm 参数解析为 agentHost。 */
export function resolveBaseUrl(realm = "auto"): string {
  if (realm in REALMS) return REALMS[realm]!;
  if (realm === "intl") {
    // TRAE 源码中不存在国际版配置，明确报错比把用户导向一个不存在的域更好。
    throw new Error("TRAE only has a CN config (trae-api-cn.mchost.guru); intl is unsupported, use auto or cn");
  }
  if (realm !== "" && realm !== "auto") throw new Error(`Unknown realm: ${realm}`);
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

/** 从 URL 提取主机名（转发共享层原语）。 */
export function hostOf(url: string): string {
  return sharedLogin.hostOf(url);
}

// ── 设备指纹 ─────────────────────────────────────────────────────────────────

/** SHA-256 的 hex 摘要（转发共享层原语）。 */
const sha256Hex = sharedLogin.sha256Hex;

export function generateMachineId(): string {
  return randomBytes(16).toString("hex"); // 32 位 hex
}

/** device_id 必须每账号互不相同（同日共用会被「该设备已签到」拦截）。 */
export function generateDeviceId(): string {
  return randomBytes(16).toString("hex"); // 32 位 hex
}

/**
 * 签到设备标识：`sha256("devid:" + uid + ⋯counterBE32) ` 的确定性派生。
 *
 * 取前 32 hex 十进制化后的前 15 位 ⇒ 15 位数字、每账号稳定唯一，
 * 从而规避「每设备每天一次」配额；9074（设备级限流）时换 `generation` 轮换。
 */
export function deriveCheckinDeviceId(uid: string, generation = 0): string {
  const hash = createHash("sha256");
  hash.update(`devid:${uid}`, "utf8");
  const counter = Buffer.alloc(4);
  for (let i = 0; i <= Math.max(0, generation); i += 1) {
    counter.writeUInt32BE(i, 0);
    hash.update(counter);
  }
  const hex = hash.digest("hex").slice(0, 32);
  const digits = BigInt(`0x${hex}`).toString(10);
  return digits.slice(0, 15).padEnd(15, "0");
}

/** 签到头里的市场用户标识：确定性派生 UUID v4。 */
export function deriveMarketUserId(uid: string): string {
  const hex = sha256Hex(`market:${uid}`).slice(0, 32).split("");
  hex[12] = "4"; // version 4
  const variant = (Number.parseInt(hex[16]!, 16) & 0x3) | 0x8; // RFC4122 variant
  hex[16] = variant.toString(16);
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 签到头里的 VSCode 会话 id：确定性派生 64 hex。 */
export function deriveSessionId(uid: string): string {
  return sha256Hex(`sess:${uid}`);
}

const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const ASCII_RE = /^[\x20-\x7E]+$/;

/**
 * 修复昵称的 latin-1 双重编码乱码。
 *
 * 规则（实测）：先尝试 latin-1 → utf8；修得出来且更像正常文本就用修复值；
 * 否则保留原文（含 CJK 时）；再否则回退 `用户+uid末4位`。
 */
export function fixNickname(raw: string, uid = ""): string {
  const fallback = uid.length >= 4 ? `用户${uid.slice(-4)}` : "用户";
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return fallback;
  if (ASCII_RE.test(trimmed)) return trimmed; // 纯 ASCII 本来就是正常昵称
  const repaired = Buffer.from(trimmed, "latin1").toString("utf8");
  const broken = repaired.includes("\uFFFD");
  if (!broken && repaired !== trimmed && (CJK_RE.test(repaired) || !CJK_RE.test(trimmed))) {
    return repaired;
  }
  if (CJK_RE.test(trimmed)) return trimmed;
  return fallback;
}

// ── 登录 URL 与回调 ──────────────────────────────────────────────────────────

/**
 * 构造登录 URL（逐字 18 个参数）。
 *
 * ⚠ 参数名必须是 `auth_callback_url`；没有 `callback_url`/`redirect_uri` ——
 * 写错登录页永远停在授权中。
 */
export function buildAuthorizeUrl(
  callbackUrl: string,
  machineId: string,
  deviceId: string,
  consoleHost?: string,
): string {
  const params = new URLSearchParams({
    login_version: "1",
    auth_from: "solo",
    login_channel: "native_ide",
    plugin_version: PLUGIN_VERSION, // ≠ ideVersion
    auth_type: "local",
    client_id: CLIENT_ID,
    redirect: "0",
    login_trace_id: `${machineId}${deviceId}`.slice(-16),
    auth_callback_url: callbackUrl,
    machine_id: machineId,
    device_id: deviceId,
    x_device_id: deviceId,
    x_machine_id: machineId,
    x_device_brand: "PC",
    x_device_type: "PC",
    x_os_version: "1.0",
    x_app_version: IDE_VERSION,
    x_app_type: "stable",
  });
  return `${(consoleHost || CONSOLE_HOST).replace(/\/+$/, "")}/authorization?${params.toString()}`;
}

export interface CallbackFields {
  access_token: string;
  refresh_token: string;
  uid: string;
  nickname: string;
  phone: string;
  email: string;
  enterprise_id: string;
  api_host: string;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function pick(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

/**
 * 解析登录回调参数。
 *
 * ⚠ 回调**直接回传 token**（query 里的 `refreshToken`、`userJwt.Token`），
 * 不是 OAuth `?code=`；PKCE 变体（`code`/`authCode`/`authCodeInfo`）明确报错。
 * ⚠ TenantID 才是租户标识（不是 EnterpriseID）。
 */
export function parseCallback(flat: Record<string, unknown>): CallbackFields {
  const userInfo = parseJsonObject(flat["userInfo"] ?? flat["user_info"]);
  const userJwt = parseJsonObject(flat["userJwt"] ?? flat["user_jwt"]);

  const accessToken =
    pick(userJwt["Token"]) ||
    pick(userJwt["token"]) ||
    pick(flat["token"]) ||
    pick(flat["accessToken"]) ||
    pick(flat["access_token"]);
  const refreshToken =
    pick(flat["refreshToken"]) ||
    pick(flat["refresh_token"]) ||
    pick(userJwt["RefreshToken"]) ||
    pick(userJwt["refresh_token"]);

  if (!accessToken && !refreshToken) {
    const pkce = pick(flat["code"]) || pick(flat["authCode"]) || pick(flat["authCodeInfo"]);
    if (pkce) {
      throw new Error(
        "Upstream used the PKCE flow (callback only carries code/authCode), which this implementation does not support; update the gateway or use another login method",
      );
    }
    throw new Error("Callback has no token: upstream may have changed the callback format");
  }

  const uid = pick(userInfo["UserID"]) || pick(userInfo["userId"]) || pick(flat["uid"]);
  const rawNickname = pick(userInfo["ScreenName"]);
  const phone =
    pick(userInfo["NonPlainTextMobile"]) ||
    pick(userInfo["Mobile"]) ||
    pick(flat["phone"]);
  const email =
    pick(userInfo["NonPlainTextEmail"]) || pick(userInfo["Email"]) || pick(flat["email"]);
  const apiHost = pick(flat["api_host"]) || pick(flat["apiHost"]) || pick(userInfo["ApiHost"]);

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    uid,
    nickname: fixNickname(rawNickname, uid),
    phone,
    email,
    enterprise_id: pick(userInfo["TenantID"]) || pick(userInfo["tenantId"]),
    api_host: apiHost,
  };
}

/** 本地回调服务器：收到一次回调后即可 `wait()` 出参数。 */
export interface CallbackServer {
  port: number;
  wait(timeoutMs: number): Promise<Record<string, string>>;
  close(): void;
}

/** 回调页（用户授权后浏览器看到的静态页）。 */
const CALLBACK_HTML =
  "<!doctype html><meta charset=utf-8><title>TRAE 授权</title>" +
  "<p>授权已完成，请回到网关窗口（此页面可以关闭）。</p>";

function listenOn(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const address = server.address() as { port: number } | null;
      resolve(address?.port ?? port);
    });
  });
}

/**
 * 启动本地回调服务器（默认 18080）。
 *
 * 端口被占用（EADDRINUSE/EACCES）时回退随机端口 —— 调用方必须用返回的
 * 实际端口重算登录 URL。
 */
export async function startCallbackServer(port = CALLBACK_PORT): Promise<CallbackServer> {
  let resolveParams: (value: Record<string, string>) => void = () => {};
  let rejectParams: (err: Error) => void = () => {};
  const params = new Promise<Record<string, string>>((resolve, reject) => {
    resolveParams = resolve;
    rejectParams = reject;
  });
  // close() 可能早于 wait()：先挂一个吞掉的 catch，避免 unhandled rejection 噪音
  void params.catch(() => {});
  let settled = false;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const flat: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (!(key in flat)) flat[key] = value; // 同名参数取第一个
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(CALLBACK_HTML);
    if (!settled) {
      settled = true;
      resolveParams(flat);
    }
  });

  let actualPort: number;
  try {
    actualPort = await listenOn(server, port);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "EADDRINUSE" && code !== "EACCES") throw err;
    actualPort = await listenOn(server, 0);
  }

  return {
    port: actualPort,
    wait(timeoutMs: number): Promise<Record<string, string>> {
      return new Promise<Record<string, string>>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error(`Timed out waiting for the authorization callback (${Math.round(timeoutMs / 1000)}s)`));
          }
        }, timeoutMs);
        params.then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (err: Error) => {
            clearTimeout(timer);
            reject(err);
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
        rejectParams(new Error("callback server closed"));
      }
    },
  };
}

export interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (msg: string) => void;
}

/** 运行一次浏览器授权登录并持久化结果。 */
export async function login(baseUrl?: string, options: LoginOptions = {}): Promise<Credentials> {
  const { onUrl, onStatus } = options;
  const machineId = generateMachineId();
  const deviceId = generateDeviceId();
  const callback = await startCallbackServer();
  try {
    const callbackUrl = `http://127.0.0.1:${callback.port}${CALLBACK_PATH}`;
    const authorizeUrl = buildAuthorizeUrl(callbackUrl, machineId, deviceId, baseUrl);
    onUrl?.(authorizeUrl); // 拿到 URL 立刻回调（界面据此弹窗）
    onStatus?.(`Opened the browser authorization page, waiting for callback (local port ${callback.port})…`);
    openBrowser(authorizeUrl);

    const flat = await callback.wait(LOGIN_TIMEOUT_MS);
    const fields = parseCallback(flat);
    const c: Credentials = {
      accessToken: fields.access_token,
      refreshToken: fields.refresh_token,
      expiresAt: normalizeExpiresAt(undefined, fields.access_token),
      uid: fields.uid,
      nickname: fields.nickname,
      phone: fields.phone,
      email: fields.email,
      machineId,
      deviceId,
      enterpriseId: fields.enterprise_id,
      domain: hostOf(DEFAULT_BASE_URL),
      apiHost: fields.api_host || undefined,
      checkinGeneration: 0,
      obtainedAt: new Date().toISOString(),
    };
    await save(c);
    onStatus?.("Authorization succeeded, credential saved.");
    return c;
  } finally {
    callback.close();
  }
}

// ── 凭据读写 ─────────────────────────────────────────────────────────────────

function toDisk(c: Credentials): string {
  const disk: Record<string, unknown> = {
    access_token: c.accessToken,
    refresh_token: c.refreshToken,
    expires_at: c.expiresAt,
    uid: c.uid,
    nickname: c.nickname,
    phone: c.phone,
    email: c.email,
    machine_id: c.machineId,
    device_id: c.deviceId,
    enterprise_id: c.enterpriseId,
    domain: c.domain,
    checkin_generation: c.checkinGeneration ?? 0,
  };
  if (c.apiHost) disk["api_host"] = c.apiHost;
  if (c.obtainedAt) disk["obtained_at"] = c.obtainedAt;
  return `${JSON.stringify(disk, null, 2)}\n`;
}

function persistSync(c: Credentials): void {
  ensureDir();
  const path = credentialsPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, toDisk(c), "utf8");
  renameSync(tmp, path); // 同目录 rename 原子替换
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows 上 chmod 意义有限 */
  }
}

/**
 * 从磁盘读取凭据。
 *
 * 文件缺失 / JSON 损坏 / access_token 为空时抛 NotLoggedInError。
 * 老凭据缺设备指纹时就地补齐并同步回写（设备指纹是请求硬需求），
 * 而不是拒绝整条凭据。
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
    accessToken: str(rec["access_token"]) || str(rec["accessToken"]),
    refreshToken: str(rec["refresh_token"]) || str(rec["refreshToken"]),
    expiresAt: str(rec["expires_at"]) || str(rec["expiresAt"]),
    uid: str(rec["uid"]),
    nickname: str(rec["nickname"]),
    phone: str(rec["phone"]),
    email: str(rec["email"]),
    machineId: str(rec["machine_id"]) || str(rec["machineId"]),
    deviceId: str(rec["device_id"]) || str(rec["deviceId"]),
    enterpriseId: str(rec["enterprise_id"]) || str(rec["enterpriseId"]),
    domain: str(rec["domain"]),
    apiHost: str(rec["api_host"]) || str(rec["apiHost"]),
    checkinGeneration: intOrZero(rec["checkin_generation"] ?? rec["checkinGeneration"]),
    obtainedAt: str(rec["obtained_at"]) || str(rec["obtainedAt"]),
  };
  if (!c.accessToken) throw new NotLoggedInError();

  if (!c.machineId || !c.deviceId) {
    // 设备指纹缺失时补齐并持久化：machine_id 登录后不应再变，device_id 每账号不同
    const filled: Credentials = {
      ...c,
      machineId: c.machineId || generateMachineId(),
      deviceId: c.deviceId || generateDeviceId(),
    };
    try {
      persistSync(filled);
    } catch {
      /* 回写失败不阻塞：本次进程内仍可用 */
    }
    return filled;
  }
  return c;
}

/** 以 0600 权限原子写入凭据。 */
export async function save(c: Credentials): Promise<void> {
  ensureDir();
  const path = credentialsPath();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, toDisk(c), "utf8");
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

/** 仅改签到设备代数并回写（9074 设备级限流时轮换）。 */
export async function rotateCheckinGeneration(c: Credentials): Promise<Credentials> {
  const next: Credentials = { ...c, checkinGeneration: (c.checkinGeneration ?? 0) + 1 };
  await save(next);
  return next;
}

// ── 续期 ─────────────────────────────────────────────────────────────────────

/** JWT 的 exp（秒）；不可用时返回 null。 */
/** JWT 的 `exp`（秒）；无 exp 时返回 null（转发共享层原语，毫秒→秒）。 */
function jwtExp(token: string): number | null {
  const ms = sharedLogin.jwtExpMs(token);
  return ms > 0 ? Math.trunc(ms / 1000) : null;
}

/**
 * 归一化过期时间为**毫秒字符串**。
 *
 * 兼容：毫秒数字/数字串、秒级数字（<1e12）、ISO 8601、以及 JWT 的 `exp` 兜底。
 */
export function normalizeExpiresAt(value: unknown, token = ""): string {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (Number.isFinite(numeric) && numeric > 0) {
    return String(numeric < 1e12 ? Math.trunc(numeric * 1000) : Math.trunc(numeric));
  }
  if (typeof value === "string" && value.trim() && !/^\d+$/.test(value.trim())) {
    const parsed = Date.parse(value.trim());
    if (Number.isFinite(parsed)) return String(parsed);
  }
  const exp = jwtExp(token);
  if (exp !== null) return String(exp * 1000);
  return "";
}

/** 终态判据之一：HTTP 401/403。 */
function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * 用 refresh token 换新 token。
 *
 * ⚠ **access 与 refresh 都轮换**，续期后必须回写；
 * 设备指纹字段完全不动。设备指纹之外只有 token/过期时间被更新。
 */
export async function refresh(c: Credentials): Promise<Credentials> {
  if (!c.refreshToken) throw new ReloginRequiredError("No refresh token, please log in again");
  const host = (c.apiHost || oauthHost()).replace(/\/+$/, "");
  const url = `${host}/cloudide/api/v3/trae/oauth/ExchangeToken`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      body: JSON.stringify({
        ClientID: CLIENT_ID,
        RefreshToken: c.refreshToken,
        ClientSecret: "-",
        UserID: "",
      }),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`ExchangeToken request failed: ${String(err)}`);
  }
  if (isAuthStatus(resp.status)) {
    throw new ReloginRequiredError(`ExchangeToken returned HTTP ${resp.status}, credential is invalid, please log in again`);
  }
  if (resp.status !== 200) {
    throw new Error(`ExchangeToken returned HTTP ${resp.status}`);
  }

  // ⚠ 凭据失效时上游回 HTML 错误页：必须先 text() 再试 JSON.parse（不能直接 .json()）
  const text = await resp.text();
  let env: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    env = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    env = null;
  }
  if (!env) {
    throw new ReloginRequiredError("ExchangeToken returned non-JSON (possibly an HTML error page), credential is invalid, please log in again");
  }

  const result = env["Result"] ?? env["result"] ?? env["data"] ?? env;
  const payload = parseJsonObject(result);
  const accessToken =
    pick(payload["Token"]) || pick(payload["token"]) || pick(payload["AccessToken"]) ||
    pick(payload["accessToken"]);
  if (!accessToken) {
    // 2xx 且响应是 JSON 却没有 accessToken ⇒ 终态（需重新登录）
    throw new ReloginRequiredError("ExchangeToken response has no accessToken, credential is invalid, please log in again");
  }
  const refreshToken =
    pick(payload["RefreshToken"]) || pick(payload["refresh_token"]) || c.refreshToken;

  const next: Credentials = {
    ...c, // 设备指纹与账号标识完全不动
    accessToken,
    refreshToken,
    expiresAt: normalizeExpiresAt(
      payload["TokenExpireAt"] ?? payload["tokenExpireAt"] ?? payload["ExpireAt"],
      accessToken,
    ),
  };
  await save(next);
  return next;
}

/**
 * Windows 下用 `cmd /c start "" "{url}"` 打开浏览器（转发共享层原语）。
 *
 * ⚠ 空标题 `""` 不可省：否则 URL 里的 `&` 会被 cmd 当命令分隔符截断。
 */
export function openBrowser(url: string): void {
  sharedLogin.openBrowser(url);
}
