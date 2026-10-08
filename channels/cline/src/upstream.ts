/**
 * Cline 上游：端点、请求头、请求体改写。
 *
 * ## 本模块承载的渠道知识
 *
 * 1. **`Authorization: Bearer workos:<jwt>`** —— 前缀由 `cred.ensureTokenPrefix()`
 *    幂等补齐，**绝不发送裸令牌**（裸令牌 = 401 + "make sure you're using the
 *    latest version of Cline" 的误导文案）。
 * 2. **请求体四处修正**（`buildChatBody`）：
 *    - `system` 提示词提升为 `messages[0]`（先拼再放，不依赖键覆盖的隐式行为）
 *    - `tools[].function.parameters` 里的 `enum` **清洗空串成员**（含纯空白），
 *      过滤后为空则整个 `enum` 键丢弃，且**递归下钻** `properties` / `items`：
 *      Gemini 系经 `google` / `vertex` provider 会因 `enum[3]: cannot be empty` 400
 *    - `max_tokens` 上界 `943_718`；非有限值 / ≤0 **不发该键**（不编造）
 *    - `reasoning_effort` **原样透传，不做白名单校验**（档位表只是客户端快照，
 *      校验等于把上游新增档位静默丢弃；上游对不认识的档位也只是静默忽略）
 * 3. **403 必须先排除地域限制**（`isRegionRestricted`）：Cline 对「该地区不可用」
 *    的模型也回 403，与凭据问题同码。不区分会触发续期 → 重试 → 仍 403 → 被归成
 *    `AUTH` 渲染成「API 密钥无效」，真实原因被完全掩盖，且每次请求白跑一次续期。
 * 4. **限流等待时长只写在人类可读的英文句子里**（Cline 不给 retry-after 头，
 *    也不给绝对时刻），取值优先级 4 层见 `parseRetryAfterSeconds`。
 */

import { readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";

import { clientHeaders, ensureTokenPrefix } from "./cred.js";
import { ensureDir, upstreamPath } from "@model-bridge/gateway";

/** Cline 接口基址（与 cred 保持同一常量值）。 */
export const DEFAULT_BASE_URL = "https://api.cline.bot";

/** 展示名（状态页与错误文案用）。 */
export const DISPLAY_NAME = "Cline";

/**
 * 上游线型：标准 OpenAI SSE delta，网关只需规范化透传。
 *
 * 网关因此不会调用 `newTranslator()`，但本模块仍导出它（契约要求同一套接口）。
 */
export const WIRE: "openai" | "custom" = "openai";

export const CHAT_PATH = "/api/v1/chat/completions";
export const MODELS_PATH = "/api/v1/models";

/** 单次输出的硬上界（实测值）。 */
export const MAX_TOKENS_CAP = 943_718;

/** 地域限制的特征表述（小写比对，取特征词）。 */
const REGION_MARKERS = [
  "not available in your region",
  "access forbidden",
  "region not supported",
  "not available in your country",
];

/** 上游 API 拒绝了访问令牌（HTTP 401/403）。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

/** 描述如何到达 Cline chat 端点。 */
export interface Config {
  baseUrl: string;
  chatPath: string;
}

/**
 * 凭据的最小面。
 *
 * 刻意只声明用得到的字段而不是 import `cred.Credentials` —— 避免
 * upstream ↔ cred 的循环依赖（前缀工具函数仍复用 cred 的那一份，单一真相源）。
 */
export interface AuthLike {
  accessToken: string;
}

export function defaultConfig(): Config {
  return { baseUrl: DEFAULT_BASE_URL, chatPath: CHAT_PATH };
}

/** 读取已解析的上游描述符；返回 `[配置, 是否来自磁盘]`。 */
export function loadConfig(): [Config, boolean] {
  let raw: string;
  try {
    raw = readFileSync(upstreamPath(), "utf8");
  } catch {
    return [defaultConfig(), false];
  }
  let parsed: Partial<Config>;
  try {
    parsed = JSON.parse(raw) as Partial<Config>;
  } catch {
    return [defaultConfig(), false];
  }
  const cfg: Config = {
    baseUrl:
      typeof parsed.baseUrl === "string" && parsed.baseUrl ? parsed.baseUrl : DEFAULT_BASE_URL,
    chatPath:
      typeof parsed.chatPath === "string" && parsed.chatPath ? parsed.chatPath : CHAT_PATH,
  };
  return [cfg, true];
}

/** 持久化上游描述符（临时文件 + 原子替换）。 */
export async function saveConfig(cfg: Config): Promise<void> {
  ensureDir();
  const path = upstreamPath();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** 完整限定的 chat-completions URL。 */
export function chatUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return `${trimSlash(resolved.baseUrl)}${resolved.chatPath || CHAT_PATH}`;
}

/** 全量模型 id 端点。 */
export function modelsUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return `${trimSlash(resolved.baseUrl)}${MODELS_PATH}`;
}

/** 账号信息端点（`/users/me`，由网关按令牌判定账号）。 */
export function meUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return `${trimSlash(resolved.baseUrl)}/api/v1/users/me`;
}

/** 推荐模型端点（**唯一权威的 free 集合**，不需要认证）。 */
export function recommendedModelsUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return `${trimSlash(resolved.baseUrl)}/api/v1/ai/cline/recommended-models`;
}

/**
 * 构造上游请求头（鉴权 + 客户端伪装）。
 *
 * `chat: true`（默认）时带对话用的 `Content-Type` 与 SSE `Accept`；
 * 其余端点只带 `Accept: application/json`（实测非对话端点不带 Content-Type）。
 */
export function buildHeaders(credential: AuthLike, opts: { chat?: boolean } = {}): Record<string, string> {
  const chat = opts.chat ?? true;
  const headers: Record<string, string> = {
    ...clientHeaders(),
    Authorization: `Bearer ${ensureTokenPrefix(credential.accessToken)}`,
  };
  if (chat) {
    headers["Content-Type"] = "application/json";
    headers["Accept"] = "text/event-stream";
  } else {
    headers["Accept"] = "application/json";
  }
  return headers;
}

/**
 * 403 是否属于「地域限制」。
 *
 * 命中时必须**跳过续期**并直接抛权限错误：续期对地域限制毫无作用，
 * 还会把真实原因掩盖成「凭据无效」。
 */
export function isRegionRestricted(bodyText: string): boolean {
  const text = bodyText.toLowerCase();
  return REGION_MARKERS.some((marker) => text.includes(marker));
}

/** 时长 token：`(?![a-z])` 不可去掉 —— 没有它 `2 minutes` 的 `m` 会再命中一次，时长翻倍。 */
const DURATION_TOKEN = /(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi;

function durationSeconds(text: string): number | null {
  let total = 0;
  let hit = false;
  for (const match of text.matchAll(DURATION_TOKEN)) {
    const value = Number.parseInt(match[1]!, 10);
    const unit = match[2]!.toLowerCase();
    const factor = unit.startsWith("h") ? 3600 : unit.startsWith("m") ? 60 : 1;
    total += value * factor;
    hit = true;
  }
  return hit ? total : null;
}

/**
 * 从 429 响应里取「等待多少秒」。
 *
 * 取值优先级（PROTOCOL §7.1）：
 *  1. `retry-after` 响应头
 *  2. 报文里的 `Try again in 19h 39m`（正则 `try again in\s+([^.;\n]*)`）
 *  3. 通用句式（`try again at <绝对时刻>`，尝试解析成时刻）
 *  4. 全文时长 token 扫描（快照式兜底；**扫不到就返回 null，不编造数字**）
 *
 * ⚠ **只有 429 才有「多久后重置」**：402（额度耗尽）的动作是充值而不是等，
 * 故非 429 一律返回 null。
 */
export function parseRetryAfterSeconds(
  status: number,
  headers: Record<string, string | undefined>,
  bodyText: string,
): number | null {
  if (status !== 429) return null;

  const header = headers["retry-after"] ?? headers["Retry-After"];
  if (header && /^\d+$/.test(header.trim())) return Number.parseInt(header.trim(), 10);

  const inMatch = /try again in\s+([^.;\n]*)/i.exec(bodyText);
  if (inMatch) {
    const seconds = durationSeconds(inMatch[1]!);
    if (seconds !== null) return seconds;
  }

  const atMatch = /try again (?:at|after)\s+([^.;\n]*)/i.exec(bodyText);
  if (atMatch) {
    const parsed = Date.parse(atMatch[1]!.trim());
    if (Number.isFinite(parsed)) return Math.max(0, Math.round((parsed - Date.now()) / 1000));
  }

  return durationSeconds(bodyText);
}

// ── 请求体改写 ────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSystemMessage(msg: unknown): boolean {
  return isRecord(msg) && msg["role"] === "system";
}

/**
 * `system` 提示词提升为 `messages[0]`。
 *
 * 多条字符串型 system 内容用 `\n\n` 合并（**先拼再放进对象**，不依赖
 * 「后面的键覆盖前面」的隐式行为）。若某条 system 的 content 是分段数组，
 * 无法安全合并 → 整组按原顺序保留（宁可不动，也不丢内容）。
 */
export function hoistSystemMessages(messages: unknown[]): unknown[] {
  const systems = messages.filter(isSystemMessage);
  if (systems.length === 0) return [...messages];
  const contents = systems.map((m) => (m as Record<string, unknown>)["content"]);
  if (contents.some((c) => typeof c !== "string")) return [...messages];
  const rest = messages.filter((m) => !isSystemMessage(m));
  const merged: Record<string, unknown> = { ...(systems[0] as Record<string, unknown>) };
  merged["role"] = "system";
  merged["content"] = (contents as string[]).join("\n\n");
  return [merged, ...rest];
}

/**
 * 递归清洗 JSON Schema 里的 `enum`。
 *
 * 三条边界（PROTOCOL §3.2）：
 * - **只删空字符串**（含纯空白），其余成员原样保留 —— `enum` 可能是数字/布尔
 *   数组，按「只留字符串」过滤会把合法数值枚举整段丢掉
 * - 过滤后为空则**整个 `enum` 键丢弃**（空 `enum` 同样非法），而非留下 `[]`
 * - **递归下钻** `properties` / `items` 等嵌套层
 */
export function sanitizeEnums(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((item) => sanitizeEnums(item));
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "enum" && Array.isArray(value)) {
      const kept = value.filter(
        (member) => !(typeof member === "string" && member.trim() === ""),
      );
      if (kept.length > 0) out[key] = kept.map((member) => sanitizeEnums(member));
      continue; // 全空 → 整个键丢弃
    }
    out[key] = sanitizeEnums(value);
  }
  return out;
}

/**
 * 把下游 OpenAI 请求改写成 Cline 能接受的形状。
 *
 * 见文件头注释 2 的四处修正；并**恒设 `stream: true`**（上游只支持流式，
 * 客户端要非流式由网关聚合）。
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...req, model: upstreamModel };

  if (Array.isArray(body["messages"])) {
    body["messages"] = hoistSystemMessages(body["messages"] as unknown[]);
  }

  if (body["tools"] !== undefined) {
    // 深拷贝后再清洗：不改动调用方的对象（网关会复用请求体做日志/重试）
    body["tools"] = sanitizeEnums(structuredClone(body["tools"]));
  }

  const stop = body["stop"];
  if (typeof stop === "string") body["stop"] = [stop];

  // max_tokens：非有限值 / ≤0 不发该键（不编造）；超过硬上界则夹取
  const maxTokens = body["max_tokens"];
  if (maxTokens !== undefined) {
    if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
      body["max_tokens"] = Math.min(Math.trunc(maxTokens), MAX_TOKENS_CAP);
    } else {
      delete body["max_tokens"];
    }
  }

  // ⚠ reasoning_effort 原样透传（上面已随 req 展开），此处刻意不做任何校验/改写

  body["stream"] = true;
  return body;
}

/**
 * 拉取全量模型 id（`{data:[{id}]}`）。
 *
 * 用途有二：① 探测凭据是否有效；② 供目录模块合并。401/403 抛 `UpstreamUnauthorized`。
 */
export async function fetchModels(
  credential: AuthLike,
  timeoutMs = 20_000,
  cfgOverride?: Config,
): Promise<Record<string, unknown>> {
  const cfg = cfgOverride ?? loadConfig()[0];
  let resp: Response;
  try {
    resp = await fetch(modelsUrl(cfg), {
      headers: buildHeaders(credential, { chat: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`models request failed: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized("Cline 拒绝了访问令牌（HTTP 401/403）");
  }
  if (resp.status !== 200) throw new Error(`models request failed: HTTP ${resp.status}`);

  let env: unknown;
  try {
    env = await resp.json();
  } catch (err) {
    throw new Error(`models response is not valid JSON: ${String(err)}`);
  }
  if (!isRecord(env)) throw new Error("models response is not a JSON object");
  if (!Array.isArray(env["data"])) throw new Error('models response has no "data" array');
  return env;
}

/**
 * 从模型载荷推导连接配置。
 *
 * Cline 的端点固定，载荷不下发任何连接信息 —— 保留本函数是为了契约一致
 * （auth-flow 登录后会调用它并把结果落盘）。
 */
export function resolveConfig(_data: Record<string, unknown>, fallback?: Config): Config {
  return { ...(fallback ?? defaultConfig()) };
}

/** 翻译器接口（契约要求所有渠道都导出，即使 `WIRE === "openai"` 用不到）。 */
export interface StreamTranslator {
  feed(chunk: Buffer): Array<Buffer | string>;
  finish(): Array<Buffer | string>;
}

/** 恒等翻译器（Cline 是标准 OpenAI SSE，网关不会调用它）。 */
export function newTranslator(): StreamTranslator {
  return {
    feed: (chunk: Buffer) => [chunk],
    finish: () => [],
  };
}
