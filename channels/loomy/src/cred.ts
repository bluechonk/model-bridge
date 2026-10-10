/**
 * Loomy（讯飞）认证：HMAC-SHA1 账号签名、短信/微信登录、凭据持久化与「续期=探测」。
 *
 * ## 本模块承载的渠道知识（每条都是实测结论，见 docs/protocols/loomy/PROTOCOL.md）
 *
 * 1. **签名是 9 段 `\n` 连接**，后两段（SignedHeaders / CanonicalizedHeaders）
 *    恒为空串 ⇒ 最终字符串**以两个换行结尾**。这是 `join("\n")` 在 9 个元素上的
 *    自然结果，**不要「顺手」去掉尾随换行** —— 去掉即签名不匹配。
 * 2. **空 body 的 Content-MD5 段是空串**（而不是「空串的 md5」）。
 * 3. **认证头前缀是 `account {ak}:{sig}`**，不是 `Bearer`。
 * 4. **签名与发送必须共用同一个序列化后的 body 字符串**：二次序列化会改变字节
 *    （键序/空格），签名随即失效。故 `accountPost()` 只 `JSON.stringify` 一次。
 * 5. **没有 refresh 端点**（session 是登录时声明 14 天得来的）：`refresh()` 只做
 *    **有效性探测**，失效时抛错 —— **不假装续期成功**（那会让 UI 显示「已续期」而请求仍 401）。
 * 6. **微信长轮询：405 = 已确认（code 在这一帧），404 = 已扫码待确认**。
 *    早期实现恰好读反，后果是用户确认后流程永久卡在「已扫码」。
 * 7. **微信 code 只在第 1 步用一次**，后续三步只用 `rcode`；`bind` 缺失时**归为 0**
 *    （走绑定流程，保守方向）；`rcode` 缺失必须明确报错。
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

import { credentialsPath, ensureDir, login as sharedLogin } from "@model-bridge/gateway";
import * as upstream from "./upstream.js";

/** 账号端点基址（短信登录走这里）。 */
export const DEFAULT_BASE_URL = "https://account.xfinfr.com";

/** 讯飞 AccessKey（随客户端分发 + AES 混淆，只用于账号端点的请求签名）。 */
export const ACCESS_KEY_ID = "2thryby66wxi53sk";
export const ACCESS_KEY_SECRET = "zsak6eadrbawz683wf5r3m2snrwj868r";
export const APP_ID = "GM3LOOMY";

/** session 声明有效期 14 天（响应不带到期时间，故本地推算）。 */
export const SESSION_TTL_SECONDS = 1_209_600;

export const SEND_MSG_PATH = "/login/phone/sendMsgCode";
export const CHECK_CODE_PATH = "/login/phone/checkCode";
export const BIND_AUTH_PATH = "/login/thirdAccount/bind/auth";
export const BIND_SEND_MSG_PATH = "/login/thirdAccount/bind/sendMsg";
export const BIND_CHECK_CODE_PATH = "/login/thirdAccount/bind/checkCode";
export const BIND_SKIP_PATH = "/login/thirdAccount/bind/skip";

/** 微信扫码（**纯 HTTP 路线**，不用官方 Electron 的 will-redirect 截获）。 */
export const WECHAT_APP_ID = "wx18d60be432287cf8";
export const WECHAT_REDIRECT_URI = "https://loomy.xunfei.cn/oauth/wechat/callback";
export const WECHAT_LONG_POLL_TIMEOUT_MS = 40_000;

/** 短信登录的输入来源（无窗口工程没有输入框，用环境变量）。 */
export const PHONE_ENV = "LOOMY_PHONE";
export const SMS_CODE_ENV = "LOOMY_SMS_CODE";

const HTTP_TIMEOUT_MS = 60_000;

const NOT_LOGGED_IN_MSG = "no usable credentials found; run `loomy login` first";

/** 磁盘上没有可用凭据。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message: string = NOT_LOGGED_IN_MSG) {
    super(message);
  }
}

/** 凭据（磁盘字段为 snake_case，见 `load`）。 */
export interface Credentials {
  /** 讯飞 `session`，**32 位小写 hex**。 */
  readonly accessToken: string;
  /** 讯飞用户 id，**18 位数字串**。 */
  readonly userid: string;
  /** 账号标识（= `userid`）。 */
  readonly uid: string;
  /** Loomy 无域概念 → 恒空串。 */
  readonly domain: string;
  readonly phone: string;
  readonly nickname: string;
  /** **毫秒时间戳字符串**，由登录时刻 + 14 天本地推算。 */
  readonly expiresAt: string;
  readonly obtainedAt: string;
  readonly source: string;
}

export const EMPTY_CREDENTIALS: Credentials = {
  accessToken: "",
  userid: "",
  uid: "",
  domain: "",
  phone: "",
  nickname: "",
  expiresAt: "",
  obtainedAt: "",
  source: "",
};

/** 取值收窄（转发共享层原语）。 */
const str = sharedLogin.str;

/** 当前时间的 ISO 字串（转发共享层原语）。 */
const nowIso = sharedLogin.nowIso;

/** 从登录时刻推算 `expires_at`（毫秒时间戳字符串）。 */
export function computeExpiresAt(fromMs = Date.now()): string {
  return String(Math.trunc(fromMs + SESSION_TTL_SECONDS * 1000));
}

/** 凭据是否已过期（无法解析时间戳时保守返回 false）。 */
export function isExpired(c: Credentials): boolean {
  return sharedLogin.isExpiredAt(Number.parseInt(c.expiresAt || "0", 10));
}

// ── 签名（loomy-sign.ts 的逐字节复刻）─────────────────────────────────────────

/** RFC3986 转义：`encodeURIComponent` + 补转 `! ' ( ) *`。 */
export function escape(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** 转义路径：补前导 `/`、剥末尾 `/`、**逐段**转义（空段保留）。 */
export function escapedPath(path: string): string {
  let text = path || "/";
  if (!text.startsWith("/")) text = `/${text}`;
  if (text.length > 1) text = text.replace(/\/+$/, "") || "/";
  return text
    .split("/")
    .map((segment) => escape(segment))
    .join("/");
}

/** 转义查询串：key/value **都**转义、**不排序**、null/undefined → 空串。 */
export function escapedQuery(query?: Record<string, unknown> | Array<[string, unknown]> | null): string {
  if (!query) return "";
  const entries: Array<[string, unknown]> = Array.isArray(query) ? query : Object.entries(query);
  return entries
    .map(([key, value]) => `${escape(key)}=${escape(value === null || value === undefined ? "" : String(value))}`)
    .join("&");
}

/** `base64(md5(body_utf8_bytes))`；**空 body 返回空串**（不是空串的 md5）。 */
export function contentMd5(bodyStr: string): string {
  if (!bodyStr) return "";
  return createHash("md5").update(bodyStr, "utf8").digest("base64");
}

export interface SignInput {
  bodyStr?: string;
  contentType?: string;
  date: string;
  nonce: string;
  query?: Record<string, unknown> | Array<[string, unknown]> | null;
}

/**
 * 9 段签名字符串（`\n` 连接）。
 *
 * ⚠ 后两段恒为空串 ⇒ 结果**以两个换行结尾**，这是协议要求，不是笔误。
 */
export function buildStringToSign(method: string, path: string, input: SignInput): string {
  return [
    method.toUpperCase(),
    escapedPath(path),
    escapedQuery(input.query),
    contentMd5(input.bodyStr ?? ""),
    input.contentType ?? "application/json",
    input.date,
    input.nonce,
    "", // SignedHeaders
    "", // CanonicalizedHeaders
  ].join("\n");
}

/** HMAC-SHA1 签名（base64）。 */
export function sign(stringToSign: string): string {
  return createHmac("sha1", ACCESS_KEY_SECRET).update(stringToSign, "utf8").digest("base64");
}

export interface SignHeaderInput {
  bodyStr?: string;
  query?: Record<string, unknown> | Array<[string, unknown]> | null;
  contentType?: string;
  /** 仅供测试：固定 Date/Nonce 以锁定 golden 签名。 */
  date?: string;
  nonce?: string;
}

/** 账号端点的签名请求头（前缀是 `account`，不是 `Bearer`）。 */
export function signHeaders(method: string, path: string, input: SignHeaderInput = {}): Record<string, string> {
  // UTC 字符串（等价 email.utils.formatdate(usegmt=True)）
  const date = input.date ?? new Date().toUTCString();
  const nonce = input.nonce ?? randomUUID();
  const stringToSign = buildStringToSign(method, path, {
    ...(input.bodyStr !== undefined ? { bodyStr: input.bodyStr } : {}),
    ...(input.query !== undefined ? { query: input.query } : {}),
    contentType: input.contentType ?? "application/json",
    date,
    nonce,
  });
  const headers: Record<string, string> = {
    Authorization: `account ${ACCESS_KEY_ID}:${sign(stringToSign)}`,
    Date: date,
    Nonce: nonce,
    "Content-Type": input.contentType ?? "application/json",
  };
  if (input.bodyStr) headers["Content-MD5"] = contentMd5(input.bodyStr);
  return headers;
}

/**
 * 通用请求体信封：`{base: {…客户端身份…}, param: {...}}`。
 *
 * ⚠ `ua` 硬编码 `Loomy|Desktop|Electron|macOS` —— 客户端在 Windows 上发的也是这个值，
 * **照抄不要改**；`traceid` 每次调用重新生成（32 位 hex）。
 */
export function accountBody(param: Record<string, unknown>): Record<string, unknown> {
  return {
    base: {
      appid: APP_ID,
      modelid: "Web",
      version: "1.0.0",
      devid: "web",
      ua: "Loomy|Desktop|Electron|macOS",
      traceid: randomUUID().replace(/-/g, ""),
    },
    param,
  };
}

function accountBase(override?: string): string {
  return override || process.env["LOOMY_ACCOUNT_BASE_URL"] || DEFAULT_BASE_URL;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 业务响应信封（`desc` 优先于 `message`；code 归一成字符串）。 */
export function parseEnvelope(payload: unknown): { code: string; desc: string; data: Record<string, unknown> } {
  if (!isRecord(payload)) return { code: "", desc: "", data: {} };
  const code = payload["code"] === undefined || payload["code"] === null ? "" : String(payload["code"]);
  const desc = str(payload["desc"]) || str(payload["message"]);
  const data = isRecord(payload["data"]) ? payload["data"] : {};
  return { code, desc, data };
}

/**
 * 账号端点 POST：**只序列化一次 body**，签名与发送共用同一字符串。
 *
 * 业务失败恒 HTTP 200 也适用于账号端点（实测账号端点回 `{code:"100001",desc}`），
 * 故成败只读 `code`。
 */
export async function accountPost(
  path: string,
  param: Record<string, unknown>,
  baseOverride?: string,
): Promise<Record<string, unknown>> {
  const body = JSON.stringify(accountBody(param));
  const headers = signHeaders("POST", path, { bodyStr: body });
  let resp: Response;
  try {
    resp = await fetch(`${accountBase(baseOverride)}${path}`, {
      method: "POST",
      headers,
      // ⚠ 发送的就是签名时的字符串：不要让 fetch 重新序列化
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`account endpoint ${path} request failed: ${String(err)}`);
  }
  if (!resp.ok) throw new Error(`account endpoint ${path} returned HTTP ${resp.status}`);
  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (err) {
    throw new Error(`account endpoint ${path} response is not valid JSON: ${String(err)}`);
  }
  const env = parseEnvelope(payload);
  if (env.code !== upstream.OK_CODE) {
    throw new Error(`account endpoint ${path} failed: code=${env.code} ${env.desc}`);
  }
  return env.data;
}

/** 第 1 步：发短信验证码，返回 `msgid`（提交验证码时必须原样带回）。 */
export async function sendSmsCode(phone: string, baseOverride?: string): Promise<string> {
  const data = await accountPost(SEND_MSG_PATH, { ccode: "86", phone, expire: 300 }, baseOverride);
  const msgid = str(data["msgid"]);
  if (!msgid) throw new Error("send-code response has no msgid");
  return msgid;
}

/** 第 2 步：短信验证码登录，返回凭据。 */
export async function verifySmsCode(
  phone: string,
  mcode: string,
  msgid: string,
  baseOverride?: string,
): Promise<Credentials> {
  const data = await accountPost(
    CHECK_CODE_PATH,
    { ccode: "86", phone, mcode, msgid, expire: SESSION_TTL_SECONDS },
    baseOverride,
  );
  const session = str(data["session"]);
  const userid = str(data["userid"]);
  if (!session) throw new Error("login response has no session");
  const c: Credentials = {
    ...EMPTY_CREDENTIALS,
    accessToken: session,
    userid,
    uid: userid,
    phone: str(data["phone"]) || phone,
    expiresAt: computeExpiresAt(),
    obtainedAt: nowIso(),
    source: "loomy-sms",
  };
  await save(c);
  return c;
}

// ── 微信扫码（纯 HTTP 路线）───────────────────────────────────────────────────

/** 微信开放平台基址（可用 `LOOMY_WECHAT_BASE_URL` 覆盖，测试用）。 */
function wechatBase(): string {
  return process.env["LOOMY_WECHAT_BASE_URL"] || "https://open.weixin.qq.com";
}

/** 长轮询端点（可用 `LOOMY_WECHAT_LONG_POLL_URL` 覆盖，测试用）。 */
function wechatLongPollUrl(): string {
  return (
    process.env["LOOMY_WECHAT_LONG_POLL_URL"] ||
    "https://long.open.weixin.qq.com/connect/l/qrconnect"
  );
}

/** 桌面 Chrome UA + Referer（微信要求）。 */
function wechatHeaders(): Record<string, string> {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/124.0.0.0 Safari/537.36",
    Referer: "https://open.weixin.qq.com/",
  };
}

/**
 * 授权页 URL。
 *
 * ⚠ `redirect_uri` **必须用官方地址**（微信校验域名白名单）：换成 127.0.0.1 或任意
 * 域名会得到 872 字节的「redirect_uri 参数错误」页 —— 故**不能**用本地回调服务器收 code。
 */
export function wechatAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    appid: WECHAT_APP_ID,
    redirect_uri: WECHAT_REDIRECT_URI,
    response_type: "code",
    scope: "snsapi_login",
    state,
  });
  return `${wechatBase()}/connect/qrconnect?${params.toString()}#wechat_redirect`;
}

const UUID_PATTERN = /^[A-Za-z0-9_\-=+/]{6,64}$/;

/** 从授权页 HTML 提取 uuid（两条路径互为兜底，无需执行 JS）。 */
export function extractWechatUuid(html: string): string {
  const primary = /\/connect\/qrcode\/([A-Za-z0-9_\-=+/]+)/.exec(html);
  if (primary?.[1] && UUID_PATTERN.test(primary[1])) return primary[1];
  const fallback = /l\/qrconnect\?uuid=([A-Za-z0-9_\-=+/]+)/.exec(html);
  if (fallback?.[1] && UUID_PATTERN.test(fallback[1])) return fallback[1];
  return "";
}

/** PNG / JPEG / GIF 三种魔数都认（实测二维码是 **JPEG**，早期只判 PNG 会误报）。 */
export function looksLikeImage(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const gif = bytes.subarray(0, 4).toString("latin1") === "GIF8";
  return png || jpeg || gif;
}

/** 拉二维码图片。⚠ **字节数 < 200 视为错误页**（实测正常图约 47KB）。 */
export async function fetchWechatQr(uuid: string): Promise<Buffer> {
  let resp: Response;
  try {
    resp = await fetch(`${wechatBase()}/connect/qrcode/${uuid}`, {
      headers: wechatHeaders(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`fetching QR code failed: ${String(err)}`);
  }
  if (!resp.ok) throw new Error(`fetching QR code failed: HTTP ${resp.status}`);
  const bytes = Buffer.from(await resp.arrayBuffer());
  if (bytes.length < 200) throw new Error(`QR response too small (${bytes.length} bytes), treating as an error page`);
  if (!looksLikeImage(bytes)) throw new Error("QR response is not an image (no PNG/JPEG/GIF magic)");
  return bytes;
}

export type WechatPollStatus = "waiting" | "scanned" | "confirmed" | "cancelled" | "expired" | "error";

export interface WechatFrame {
  status: WechatPollStatus;
  /** `status === "confirmed"` 时的 `wx_code`。 */
  code: string;
}

/**
 * 长轮询一次。
 *
 * ⚠⚠ 语义以微信授权页内嵌 JS 为准（**不能读反**）：
 * - `408` 待扫码 → `waiting`
 * - `404` **已扫码待确认** → `scanned`
 * - `405` **已确认**，`wx_code` 就在这一帧 → `confirmed`（但 code 为空时保守判 `scanned`）
 * - `403` 取消 / `402` 失效
 * - 其它/未知 → 保守 `waiting`（绝不误判成功）
 * - 网络异常 → `error` 状态而**不抛错**
 */
export async function wechatPollOnce(uuid: string, last = ""): Promise<WechatFrame> {
  const url = new URL(wechatLongPollUrl());
  url.searchParams.set("uuid", uuid);
  if (last) url.searchParams.set("last", last);
  url.searchParams.set("_", String(Date.now()));
  let text: string;
  try {
    const resp = await fetch(url, {
      headers: wechatHeaders(),
      signal: AbortSignal.timeout(WECHAT_LONG_POLL_TIMEOUT_MS),
    });
    text = await resp.text();
  } catch {
    return { status: "error", code: "" };
  }
  const errcodeMatch = /wx_errcode\s*=\s*(\d+)/.exec(text);
  if (!errcodeMatch) return { status: "waiting", code: "" };
  const errcode = Number.parseInt(errcodeMatch[1]!, 10);
  const code = /wx_code\s*=\s*'([^']*)'/.exec(text)?.[1] ?? "";
  switch (errcode) {
    case 408:
      return { status: "waiting", code: "" };
    case 404:
      return { status: "scanned", code: "" };
    case 405:
      // 已确认：但没带 code 时不能判成功（保守继续轮询）
      return code ? { status: "confirmed", code } : { status: "scanned", code: "" };
    case 403:
      return { status: "cancelled", code: "" };
    case 402:
      return { status: "expired", code: "" };
    default:
      return { status: "waiting", code: "" };
  }
}

export interface WechatWaitOptions {
  onUrl?: (url: string) => void;
  onStatus?: (message: string) => void;
  timeoutSec?: number;
  pollIntervalSec?: number;
}

/** 完整扫码：生成 state → 打开授权页 → 提取 uuid → 轮询到拿到 `wx_code`。 */
export async function wechatWaitForCode(options: WechatWaitOptions = {}): Promise<string> {
  const { onUrl, onStatus } = options;
  const timeoutSec = options.timeoutSec ?? 300;
  const intervalMs = Math.max(0, (options.pollIntervalSec ?? 1.2) * 1000);

  const state = randomUUID().replace(/-/g, "");
  const url = wechatAuthorizeUrl(state);
  onUrl?.(url); // ⚠ 立刻回调（界面据此弹窗）
  onStatus?.("Scan the QR code with WeChat and confirm login");

  let html: string;
  try {
    const resp = await fetch(url, { headers: wechatHeaders(), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    html = await resp.text();
  } catch (err) {
    throw new Error(`opening the WeChat authorize page failed: ${String(err)}`);
  }
  const uuid = extractWechatUuid(html);
  if (!uuid) throw new Error("could not extract the QR uuid from the authorize page (risk control or redesign?)");
  onStatus?.(`QR code generated (uuid=${uuid.slice(0, 8)}...), waiting for scan`);

  const deadline = Date.now() + timeoutSec * 1000;
  let last = "";
  let scannedReported = false;
  while (Date.now() < deadline) {
    const frame = await wechatPollOnce(uuid, last);
    if (frame.status === "error") {
      onStatus?.("long-poll network error, retrying");
    } else if (frame.status === "waiting") {
      /* 待扫码是常态 */
    } else if (frame.status === "scanned") {
      if (!scannedReported) {
        onStatus?.("scanned, please confirm on your phone");
        scannedReported = true;
      }
    } else if (frame.status === "confirmed") {
      onStatus?.("confirmed, finishing login...");
      return frame.code;
    } else if (frame.status === "cancelled") {
      throw new Error("user cancelled the WeChat login");
    } else if (frame.status === "expired") {
      throw new Error("QR code expired; please scan again");
    }
    if (intervalMs > 0) await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("WeChat scan timed out; re-run loomy login");
}

/** 第 1 步：微信 code 换 `rcode`（code 只在这里用一次）。 */
export async function bindAuthThirdAccount(
  code: string,
  baseOverride?: string,
): Promise<{ bind: number; rcode: string; nickname: string }> {
  const data = await accountPost(BIND_AUTH_PATH, { tcode: { code }, type: "wx" }, baseOverride);
  return {
    // ⚠ bind 缺失时归为 0（走绑定流程）—— 保守方向
    bind: Number.parseInt(String(data["bind"] ?? "0"), 10) === 1 ? 1 : 0,
    rcode: str(data["rcode"]),
    nickname: str(data["nickname"]),
  };
}

/** 第 2 步（未绑手机号）：给手机号发验证码。 */
export async function bindSendMsg(
  rcode: string,
  phone: string,
  baseOverride?: string,
): Promise<string> {
  if (!rcode) throw new Error("rcode is missing; cannot continue the WeChat binding flow");
  const data = await accountPost(
    BIND_SEND_MSG_PATH,
    { rcode, phone, ccode: "86", expire: 300 },
    baseOverride,
  );
  const msgid = str(data["msgid"]);
  if (!msgid) throw new Error("WeChat binding send-sms response has no msgid");
  return msgid;
}

/** 第 3 步（未绑手机号）：校验验证码完成绑定登录。 */
export async function bindCheckCode(
  rcode: string,
  mcode: string,
  msgid: string,
  baseOverride?: string,
): Promise<Credentials> {
  if (!rcode) throw new Error("rcode is missing; cannot continue the WeChat binding flow");
  const data = await accountPost(
    BIND_CHECK_CODE_PATH,
    { rcode, mcode, msgid, expire: SESSION_TTL_SECONDS },
    baseOverride,
  );
  return credentialsFromSession(data, "loomy-wechat-bind");
}

/** 第 4 步（已绑手机号）：直接拿 session。 */
export async function bindSkip(rcode: string, baseOverride?: string): Promise<Credentials> {
  if (!rcode) throw new Error("rcode is missing; cannot log in directly (bind=1 requires rcode)");
  const data = await accountPost(BIND_SKIP_PATH, { rcode, expire: SESSION_TTL_SECONDS }, baseOverride);
  return credentialsFromSession(data, "loomy-wechat");
}

async function credentialsFromSession(
  data: Record<string, unknown>,
  source: string,
): Promise<Credentials> {
  const session = str(data["session"]);
  const userid = str(data["userid"]);
  if (!session) throw new Error("login response has no session");
  const c: Credentials = {
    ...EMPTY_CREDENTIALS,
    accessToken: session,
    userid,
    uid: userid,
    phone: str(data["phone"]),
    expiresAt: computeExpiresAt(),
    obtainedAt: nowIso(),
    source,
  };
  await save(c);
  return c;
}

/** 微信扫码完整登录（bind=1 走 skip；bind=0 走发短信 + 校验）。 */
export async function loginWechat(
  baseUrl?: string,
  options: WechatWaitOptions = {},
): Promise<Credentials> {
  const { onStatus } = options;
  const code = await wechatWaitForCode(options);
  const binding = await bindAuthThirdAccount(code, baseUrl);

  let c: Credentials;
  if (binding.bind === 1) {
    if (!binding.rcode) throw new Error("bind=1 but the response has no rcode");
    c = await bindSkip(binding.rcode, baseUrl);
  } else {
    const phone = process.env[PHONE_ENV] ?? "";
    const smsCode = process.env[SMS_CODE_ENV] ?? "";
    if (!phone || !smsCode) {
      throw new Error(
        `phone not bound: provide phone and SMS code via env vars ${PHONE_ENV} / ${SMS_CODE_ENV} and retry`,
      );
    }
    onStatus?.(`sending binding SMS to ${phone}...`);
    const msgid = await bindSendMsg(binding.rcode, phone, baseUrl);
    c = await bindCheckCode(binding.rcode, smsCode, msgid, baseUrl);
    // 绑定流程拿回的 phone 写在 param 里，服务端可能不回传
    if (!c.phone) c = { ...c, phone };
  }
  await upstream.triggerFirstLogin(c).catch((err: unknown) => {
    onStatus?.(`daily quota init failed (does not affect login): ${String(err)}`);
  });
  return c;
}

// ── 凭据落盘 ──────────────────────────────────────────────────────────────────

/** 从磁盘读凭据；缺 `expires_at` 时按 `obtained_at + 14 天` 补算（不拒绝整条凭据）。 */
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
  if (!isRecord(data)) throw new NotLoggedInError("credentials file has an unexpected structure; please log in again");
  const accessToken = str(data["access_token"] ?? data["accessToken"]);
  if (!accessToken) throw new NotLoggedInError();
  const userid = str(data["userid"] ?? data["userId"] ?? data["uid"]);
  const obtainedAt = str(data["obtained_at"] ?? data["obtainedAt"]);
  let expiresAt = str(data["expires_at"] ?? data["expiresAt"]);
  if (!expiresAt && obtainedAt) {
    // 老凭据/手工导入的凭据可能没有 expires_at：只读它会让过期判定恒为 false
    const parsed = Date.parse(obtainedAt);
    if (Number.isFinite(parsed)) expiresAt = computeExpiresAt(parsed);
  }
  return {
    accessToken,
    userid,
    uid: userid,
    domain: "",
    phone: str(data["phone"]),
    nickname: str(data["nickname"]),
    expiresAt,
    obtainedAt,
    source: str(data["source"]),
  };
}

/** 原子写凭据（0600）。 */
export async function save(c: Credentials): Promise<void> {
  ensureDir();
  const path = credentialsPath();
  const tmp = `${path}.tmp`;
  const payload = {
    access_token: c.accessToken,
    userid: c.userid,
    phone: c.phone,
    nickname: c.nickname,
    expires_at: c.expiresAt,
    obtained_at: c.obtainedAt || nowIso(),
    source: c.source,
  };
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

// ── 登录（短信）/ 续期（探测）──────────────────────────────────────────────────

/** 登录方式。 */
export type LoginMethod = "sms" | "wechat";

/** 登录选项：两端（短信 / 微信扫码）的等待参数共用；`method` 可显式指定。 */
export interface LoginOptions extends WechatWaitOptions {
  /**
   * 登录方式。不给时：交互终端里**弹菜单让用户选**；非交互（`serve` 重试、
   * 管道）按 `defaultLoginMethod()` 自动选（短信环境变量齐 → sms，否则 wechat）。
   */
  method?: LoginMethod;
}

/** 非交互时的默认方式：短信环境变量齐 → `sms`（自动化）；否则 `wechat`（唯一可交互完成的路径）。 */
export function defaultLoginMethod(env: NodeJS.ProcessEnv = process.env): LoginMethod {
  return env[PHONE_ENV] && env[SMS_CODE_ENV] ? "sms" : "wechat";
}

/** 菜单输入的解析结果：`"default"` = 空输入用默认；`"invalid"` = 认不出的输入。 */
export type MethodChoice = LoginMethod | "default" | "invalid";

/** 解析菜单输入（英文别名也认，便于自动化）。 */
export function parseLoginMethodChoice(raw: string): MethodChoice {
  const text = raw.trim().toLowerCase();
  if (text === "") return "default";
  if (text === "1" || text === "sms") return "sms";
  if (text === "2" || text === "wechat" || text === "wx") return "wechat";
  return "invalid";
}

/** 规范化手机号输入（容忍空格与连字符）。 */
export function normalizePhone(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

/** 中国大陆手机号：11 位、`1[3-9]` 开头。 */
export function isValidPhone(raw: string): boolean {
  return /^1[3-9]\d{9}$/.test(raw);
}

/** 短信验证码：6 位数字。 */
export function isValidSmsCode(raw: string): boolean {
  return /^\d{6}$/.test(raw);
}

/**
 * 一行输入的抽象（提示写 stderr —— `--json` 时 stdout 要保持干净的 JSON 流）。
 * EOF 返回 `null`（stdin 关闭 = 用户放弃）。
 */
export interface LinePrompt {
  ask(prompt: string): Promise<string | null>;
}

/** stdin 实现（readline）。 */
class StdinPrompt implements LinePrompt {
  private readonly rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: Boolean(process.stdin.isTTY),
  });
  private readonly lines = this.rl[Symbol.asyncIterator]();

  async ask(prompt: string): Promise<string | null> {
    process.stderr.write(prompt);
    const { value, done } = await this.lines.next();
    return done ? null : String(value);
  }

  close(): void {
    this.rl.close();
  }
}

/** 反复追问直到输入合法；EOF（`null`）直接放弃。 */
export async function askUntilValid(
  prompt: LinePrompt,
  question: string,
  validate: (value: string) => boolean,
  invalidHint: string,
): Promise<string | null> {
  for (;;) {
    const raw = await prompt.ask(question);
    if (raw === null) return null;
    const value = raw.trim();
    if (value && validate(value)) return value;
    process.stderr.write(`${invalidHint}\n`);
  }
}

/** 交互式选择登录方式。 */
async function chooseLoginMethodInteractively(
  defaultMethod: LoginMethod,
  prompt: LinePrompt,
  envComplete: boolean,
): Promise<LoginMethod> {
  process.stderr.write(
    [
      "Select login method:",
      `  1) SMS code (${envComplete ? `using ${PHONE_ENV} / ${SMS_CODE_ENV} from env` : "type your phone number, then the code"})`,
      "  2) WeChat QR code (scan with WeChat)",
      `Choice [1/2] (default: ${defaultMethod === "sms" ? 1 : 2}): `,
    ].join("\n") + "\n",
  );
  for (;;) {
    const line = await prompt.ask("");
    if (line === null) return defaultMethod; // EOF：用默认
    const choice = parseLoginMethodChoice(line);
    if (choice === "invalid") {
      process.stderr.write("Invalid choice: enter 1 (SMS) or 2 (WeChat).\n");
      continue;
    }
    return choice === "default" ? defaultMethod : choice;
  }
}

/**
 * 短信登录的公共尾段：**先发码 → 再取验证码 → 校验 → 每日额度初始化**。
 *
 * ⚠ 顺序不能颠倒：验证码必须是**发出后**才问（把「取码」做成回调而不是调用前
 * 求值的参数 —— 参数求值会让提示出现在发送之前，真机踩过）。
 */
async function smsLoginWith(
  baseUrl: string | undefined,
  phone: string,
  codeProvider: () => Promise<string | null>,
  onStatus?: (message: string) => void,
): Promise<Credentials> {
  onStatus?.(`sending SMS code to ${phone}...`);
  const msgid = await sendSmsCode(phone, baseUrl);
  const smsCode = await codeProvider();
  if (!smsCode) throw new Error("login aborted: no SMS code provided (stdin closed)");
  onStatus?.("verifying SMS code...");
  const c = await verifySmsCode(phone, smsCode, msgid, baseUrl);
  await upstream.triggerFirstLogin(c).catch((err: unknown) => {
    onStatus?.(`daily quota init failed (does not affect login): ${String(err)}`);
  });
  return c;
}

/**
 * 交互式短信登录：手机号与验证码都**当场输入**（无窗口工程不再要求环境变量）。
 *
 * 顺序：问手机号 → 发码 → 问验证码 → 换凭证。环境变量给了的值作为**预填**
 * （不再追问那一项）；两处都 EOF（用户放弃）→ 抛错中止。
 */
export async function loginSmsInteractive(
  baseUrl: string | undefined,
  prompt: LinePrompt,
  options: LoginOptions = {},
): Promise<Credentials> {
  const { onStatus } = options;
  const envPhone = normalizePhone(process.env[PHONE_ENV] ?? "");
  const envCode = (process.env[SMS_CODE_ENV] ?? "").trim();

  const phone =
    (isValidPhone(envPhone) ? envPhone : null) ??
    (await askUntilValid(
      prompt,
      "Phone number (11 digits): ",
      isValidPhone,
      "Invalid phone number: expected 11 digits starting with 1.",
    ));
  if (!phone) throw new Error("login aborted: no phone number provided (stdin closed)");

  return smsLoginWith(
    baseUrl,
    phone,
    async () =>
      isValidSmsCode(envCode)
        ? envCode
        : askUntilValid(prompt, "SMS code (6 digits): ", isValidSmsCode, "Invalid code: expected 6 digits."),
    onStatus,
  );
}

/**
 * 默认登录：交互式弹菜单选短信 / 微信；非交互按环境变量自动选。
 *
 * - 选 1（短信）：手机号与验证码**当场输入**（环境变量可选预填）
 * - 选 2（微信）：扫码授权（未绑手机号时绑定环节仍需手机号 + 验证码）
 *
 * ⚠ 别在非交互路径上直接报「缺环境变量」：`serve` 的重试登录也调到这里，
 *   报错会让重试完全无路可走（真机踩过）——非交互时按环境变量自动选，选不成就明确报错。
 *
 * 登录成功后立即调 `POST /points/first-login`（每日额度初始化），**失败仅 warn**。
 */
export async function login(baseUrl?: string, options: LoginOptions = {}): Promise<Credentials> {
  const { onStatus } = options;
  const envPhone = (process.env[PHONE_ENV] ?? "").trim();
  const envCode = (process.env[SMS_CODE_ENV] ?? "").trim();
  const envComplete = Boolean(envPhone && envCode);

  // 非交互（脚本 / 网关重试）：不弹菜单、不问输入，按环境变量定方式
  if (!process.stdin.isTTY) {
    const method = options.method ?? defaultLoginMethod();
    if (method === "wechat") {
      onStatus?.("using WeChat QR login");
      return loginWechat(baseUrl, options);
    }
    if (!isValidPhone(normalizePhone(envPhone)) || !isValidSmsCode(envCode)) {
      throw new Error(
        `SMS login needs a phone number and code: run in a terminal to type them, or set ${PHONE_ENV} (11-digit phone) and ${SMS_CODE_ENV} (6-digit code); ` +
          "or choose 2 for WeChat QR login (--wechat)",
      );
    }
    return smsLoginWith(baseUrl, normalizePhone(envPhone), async () => envCode, onStatus);
  }

  const prompt = new StdinPrompt();
  try {
    const method =
      options.method ?? (await chooseLoginMethodInteractively(defaultLoginMethod(), prompt, envComplete));
    if (method === "wechat") {
      onStatus?.("using WeChat QR login");
      return await loginWechat(baseUrl, options);
    }
    return await loginSmsInteractive(baseUrl, prompt, options);
  } finally {
    prompt.close();
  }
}

/**
 * `refresh()`：Loomy **没有 refresh 端点**，故这里只做**有效性探测**
 * （调最便宜的只读端点 `GET /points/records`，不消耗积分、无副作用）。
 *
 * 失效时抛错让 UI 显示「凭证过期，请重新登录」—— **绝不假装续期成功**。
 * 探测通过时做**有效期对账**（账号池的 expiresAt 是 UI 唯一的显示依据）。
 */
export async function refresh(c: Credentials): Promise<Credentials> {
  try {
    await upstream.fetchPointsRecords(c);
  } catch (err) {
    if (err instanceof upstream.UpstreamUnauthorized) {
      throw new Error(`Loomy has no refresh endpoint; session is invalid, please log in again (${String(err)})`);
    }
    throw new Error(`refresh probe failed: ${String(err)}`);
  }
  if (!isExpired(c)) return c; // 仍有效 → 不改动时间戳
  const next: Credentials = { ...c, expiresAt: computeExpiresAt(), obtainedAt: nowIso() };
  await save(next);
  return next;
}

/** 登录基址：Loomy 是单账号域，无 realm 概念（参数仅为满足契约）。 */
export function resolveBaseUrl(_realm = "auto"): string {
  return accountBase();
}
