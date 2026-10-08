/**
 * 登录原语：各渠道登录流程共用的**渠道无关纯工具**。
 *
 * ## 为什么放在共享层
 *
 * 这些函数在各 `<渠道>-bridge` 里本该是同一份，旧实现却各存一份副本
 * （`openBrowser` 6 份、`hostOf` 6 份、JWT 解析 4 份、`fetchWithTimeout` 多份），
 * 改一处要重刷多份、副本之间还会漂移。
 *
 * ## 边界
 *
 * 本模块**只放渠道无关的原语**：打开浏览器、URL 主机名、JWT 解析、时间归一化、
 * 带超时的 fetch、编码工具、令牌前缀。
 * **不含**任何渠道的 URL 构建 / 请求头 / 响应解析 —— 那些是渠道知识，留在各渠道
 * 的 `cred.ts`。
 *
 * ⚠ 各渠道的 `cred.ts` 保持自己的导出签名不变（薄包装转发到这里），
 * 以免破坏已有的 import 站点与测试引用。
 *
 * ## 为什么不把「流程」也放这里
 *
 * 登录流程骨架（本地回调 / flow 轮询 / 设备码轮询）差异较大，单独放
 * `login-flow.ts`；本模块是它们与各渠道共同依赖的地基。
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

// ── 浏览器 ────────────────────────────────────────────────────────────────────

/**
 * 用系统默认浏览器打开 URL。
 *
 * ⚠ Windows 下必须用 `cmd /c start "" "{url}"` —— **空标题 `""` 不可省**：
 * 否则 URL 里的 `&` 会被 cmd 当成命令分隔符，含多个查询参数的授权链接会被截断
 * （实测过的缺陷）。
 *
 * 打不开浏览器不影响登录：调用方继续轮询/等回调，用户可手动复制链接。
 */
export function openBrowser(url: string): void {
  try {
    const [cmd, args] =
      process.platform === "win32"
        ? (["cmd", ["/c", "start", "", url]] as const)
        : process.platform === "darwin"
          ? (["open", [url]] as const)
          : (["xdg-open", [url]] as const);
    const child = spawn(cmd, [...args], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } catch {
    /* 打不开浏览器不影响登录流程 */
  }
}

// ── URL ───────────────────────────────────────────────────────────────────────

/** 从 URL 取主机名（去 scheme、去 path/query）。 */
export function hostOf(url: string): string {
  const withoutScheme = url.includes("://") ? url.split("://", 2)[1]! : url;
  const cut = withoutScheme.search(/[/?]/);
  return cut < 0 ? withoutScheme : withoutScheme.slice(0, cut);
}

// ── 取值 / 时间戳工具 ─────────────────────────────────────────────────────────

/** 只接受字符串，其它一律返回空串（解析上游信封时的统一收窄）。 */
export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 当前时间的 RFC3339 / ISO 字串。 */
export function nowIso(): string {
  return new Date().toISOString();
}

// ── JWT ───────────────────────────────────────────────────────────────────────

/**
 * 解析 JWT 的 payload（**不验签** —— 只读声明，不用于信任判断）。
 *
 * ⚠ `prefix` 用于带令牌前缀的渠道（如 Cline 的 `token-` 前缀），解析前先剥掉。
 * 无法解析时返回 `{}`（调用方按「缺字段」处理，不抛错）。
 */
export function decodeJwtPayload(token: string, prefix = ""): Record<string, unknown> {
  const bare = stripTokenPrefix(token, prefix);
  const parts = bare.split(".");
  if (parts.length < 2) return {};
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return claims && typeof claims === "object" && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** JWT 的 `exp` 声明（**毫秒**）；无 exp 时返回 0。 */
export function jwtExpMs(token: string, prefix = ""): number {
  const exp = decodeJwtPayload(token, prefix)["exp"];
  if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) return Math.trunc(exp * 1000);
  if (typeof exp === "string" && /^\d+$/.test(exp)) return Number(exp) * 1000;
  return 0;
}

/** JWT 的 `sub` 声明（账号标识）；缺失时返回空串。 */
export function jwtSubject(token: string, prefix = ""): string {
  return str(decodeJwtPayload(token, prefix)["sub"]);
}

// ── 时间归一化 ────────────────────────────────────────────────────────────────

/**
 * 把「秒/毫秒时间戳、数字串、日期串」归一成**毫秒**时间戳；无法解析返回 null。
 *
 * - 数值 < 1e11 视为**秒**（乘 1000）—— 1e11 秒 ≈ 公元 5138 年，判定够用
 * - 数字串同理；非纯数字串按 `Date.parse` 解析
 */
export function parseExpireTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value < 1e11 ? value * 1000 : value);
  }
  if (typeof value === "string" && value.trim()) {
    const text = value.trim();
    if (/^\d+$/.test(text)) {
      const n = Number.parseInt(text, 10);
      return n < 1e11 ? n * 1000 : n;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 从「显式过期字段 → JWT exp」推导到期时刻（**毫秒**）；都没有返回 null。
 *
 * ⚠ 覆盖「字段是秒、字段是日期串、字段缺失只有 JWT」三种形态 ——
 * 各渠道凭据的字段名不同，故显式值由调用方先取出再传入。
 */
export function resolveExpiresAtMs(explicit: unknown, token = ""): number | null {
  const parsed = parseExpireTime(explicit);
  if (parsed !== null) return parsed;
  const exp = jwtExpMs(token);
  return exp > 0 ? exp : null;
}

/**
 * 到期判据：`expiresAtMs` 为空（null / 非正数）时视为**未过期** ——
 * 无从判断时不冒充「已失效」（否则会把可用凭据误判成过期）。
 *
 * ⚠ 各渠道 `Credentials` 形态不同，故这里只接受**毫秒数**；
 * 渠道保留自己的 `isExpired(c)` 薄包装做字段提取。
 */
export function isExpiredAt(expiresAtMs: number | null | undefined, leadMs = 0): boolean {
  if (
    expiresAtMs === null ||
    expiresAtMs === undefined ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= 0
  ) {
    return false;
  }
  return expiresAtMs - leadMs <= Date.now();
}

// ── 网络 ──────────────────────────────────────────────────────────────────────

/**
 * 带超时的 `fetch`。
 *
 * ⚠ 超时用 `AbortSignal.timeout`（**不是** fetch 默认的无超时）——
 * 上游 hang 住时登录轮询会一直挂着，用户看不到任何反馈。
 * 调用方若自行传入 `signal` 则以传入的为准。
 */
export function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Response> {
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
}

// ── 编码 ──────────────────────────────────────────────────────────────────────

/** 随机 hex 串（`bytes` 个字节 → `2*bytes` 个 hex 字符）。 */
export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** SHA-256 的 hex 摘要。 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** base64url 编码（字符串按 utf8、Buffer 原样）。 */
export function b64url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64url");
}

// ── 令牌前缀 ──────────────────────────────────────────────────────────────────

/** 剥掉令牌前缀（无前缀时原样返回）。 */
export function stripTokenPrefix(token: string, prefix: string): string {
  return prefix && token.startsWith(prefix) ? token.slice(prefix.length) : token;
}

/** 补上令牌前缀（空串返回空串；已有前缀不重复加）。 */
export function ensureTokenPrefix(token: string, prefix: string): string {
  if (!token) return "";
  return token.startsWith(prefix) ? token : `${prefix}${token}`;
}
