/**
 * LobsterAI 上游：端点、请求头、请求体改写、客户端版本号与错误分类。
 *
 * ## 本模块承载的渠道知识
 *
 * 1. **`X-LobsterAI-Client-Capabilities` / `X-LobsterAI-Client-Version` 是模型端点的
 *    准入条件**（2026-09-17 实测）：不带 capabilities 时 `/api/models/available`
 *    只返回 25 个模型且**没有 `kimi-k3`**，带上才 26 个；`thinking-level-control-v1`
 *    还是 `reasoning_effort:"off"` 的前提（不带该能力时服务端直接 500）。
 * 2. **`stream: false` 会返回 500** —— 上游只支持 SSE，`buildChatBody()` 恒设 `stream: true`，
 *    客户端要非流式由网关聚合。
 * 3. **图片形态必须是 `{type:'image_url', image_url:{url:'data:...'}}`**：
 *    `{type:'image'}` 与裸 base64 字符串都返回 **500**。
 * 4. **错误分类顺序不可重排**（`classifyError`）：body 关键词必须排在状态码之前
 *    （除 402）—— 实测上游用 **400 + 中文「积分不足」**表达余额耗尽。
 * 5. **不发 `prompt_cache_key`**（腾讯后端的前缀缓存机制，此处未实测支持），
 *    **不发 `tool_choice`**。
 *
 * 客户端版本号是**动态真值**：`{portal}/.../prod/update`（第三方域名，非统一信封，
 * 载荷在 `data.value.version`），缓存 12 小时，失败回退 `2026.9.4`。
 */

import { readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";

import * as catalog from "./catalog.js";
import { ensureDir, upstreamPath } from "@model-bridge/gateway";

/** 上游 API 基址（单一域名，无多区域）。 */
export const DEFAULT_BASE_URL = "https://lobsterai-server.youdao.com";

/** 对话端点（OpenAI 兼容，**仅支持 SSE**）。 */
export const CHAT_PATH = "/api/proxy/v1/chat/completions";
/** 可用模型列表端点。 */
export const MODELS_PATH = "/api/models/available";

/** 展示名（状态页与日志用）。 */
export const DISPLAY_NAME = "LobsterAI";

/**
 * 上游线型：标准 OpenAI SSE delta → 网关规范化透传，不需要翻译层
 * （本模块仍按契约导出 `newTranslator()`，恒等实现）。
 */
export const WIRE: "openai" | "custom" = "openai";

/** User-Agent（原样照抄 Go 的 `clientUA`，刻意不跟着真版本号改）。 */
export const USER_AGENT = "LobsterAI/0.1.0";

/**
 * 客户端能力声明（模型端点的准入条件）。
 *
 * 两个能力都必须声明：`kimi-k3-agentic-v1` 决定模型集合里有没有 `kimi-k3`；
 * `thinking-level-control-v1` 是 `reasoning_effort:"off"` 的前提（否则 500）。
 */
export const CLIENT_CAPABILITIES = "kimi-k3-agentic-v1,thinking-level-control-v1";
export const CAPABILITIES_HEADER = "X-LobsterAI-Client-Capabilities";
export const VERSION_HEADER = "X-LobsterAI-Client-Version";

/** 客户端版本号查询端点（第三方域名，非统一信封）。 */
export const CLIENT_VERSION_URL =
  "https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update";
/** 版本号缓存有效期（12 小时）—— 版本是日期式的，变更频率极低。 */
export const VERSION_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/** 动态拉取失败时的兜底版本号。 */
export const FALLBACK_CLIENT_VERSION = "2026.9.4";

const HTTP_TIMEOUT_MS = 30_000;

/** 上游 API 拒绝了访问令牌（HTTP 401/403）。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

/** 模型声明不支持图片时显式报错（**不静默丢弃**）。 */
export class UnsupportedContentError extends Error {
  override name = "UnsupportedContentError";
}

/** 描述如何到达 LobsterAI chat 端点。 */
export interface Config {
  baseUrl: string;
}

/**
 * 凭据的最小面。
 *
 * 刻意只声明需要的字段而不 import `cred.Credentials` —— 那会形成
 * cred → upstream → cred 的循环依赖。
 */
export interface AuthLike {
  accessToken: string;
  uid?: string;
  domain?: string;
}

export function defaultConfig(): Config {
  return { baseUrl: DEFAULT_BASE_URL };
}

/** 读取上游描述符；文件缺失/损坏时返回默认配置。 */
export function loadConfig(): [Config, boolean] {
  let raw: string;
  try {
    raw = readFileSync(upstreamPath(), "utf8");
  } catch {
    return [defaultConfig(), false];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Config>;
    const baseUrl =
      typeof parsed.baseUrl === "string" && parsed.baseUrl ? parsed.baseUrl : DEFAULT_BASE_URL;
    return [{ baseUrl }, true];
  } catch {
    return [defaultConfig(), false];
  }
}

/** 原子写入上游描述符。 */
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
  return `${trimSlash(resolved.baseUrl)}${CHAT_PATH}`;
}

/** 模型列表 URL（不带 keyfrom query，供状态展示用）。 */
export function modelsUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return `${trimSlash(resolved.baseUrl)}${MODELS_PATH}`;
}

function requireString(credential: AuthLike): string {
  if (!credential || typeof credential.accessToken !== "string" || !credential.accessToken) {
    throw new Error("凭据缺少 accessToken");
  }
  return credential.accessToken;
}

/**
 * 通用带认证头（`Authorization` + UA，**不带任何 CodeBuddy 归属头**）。
 *
 * 导出给同渠道的 billing / catalog 复用：`X-Domain` / `X-Product` / `X-IDE-*`
 * 那套归属头 LobsterAI **不认**，带上无用且可能让服务端按错误客户端形态归因。
 */
export function authHeaders(credential: AuthLike, accept = "application/json"): Record<string, string> {
  return {
    Authorization: `Bearer ${requireString(credential)}`,
    Accept: accept,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
}

/**
 * 对话请求头。
 *
 * 比通用头多两个 `X-LobsterAI-Client-*` 头、`Accept` 为 SSE。
 * 版本号取进程内缓存（或兜底常量）—— `buildHeaders()` 是同步契约，
 * 真正的动态拉取发生在 `resolveClientVersion()`（登录/续期/拉目录时）。
 */
export function buildHeaders(credential: AuthLike): Record<string, string> {
  return {
    ...authHeaders(credential, "text/event-stream, application/json"),
    [CAPABILITIES_HEADER]: CLIENT_CAPABILITIES,
    [VERSION_HEADER]: clientVersion(),
  };
}

/**
 * 模型列表请求头。
 *
 * **这两个头在本端点是必需的**（不是可选元数据）：服务端按能力声明过滤模型
 * 集合，不带它 `kimi-k3` 不会出现。早先版本用只有 4 个基础头的形态请求本端点，
 * 于是即使解析正确也**永久缺少 `kimi-k3`**。
 */
export function modelsHeaders(credential: AuthLike, version = clientVersion()): Record<string, string> {
  return {
    ...authHeaders(credential, "application/json"),
    [CAPABILITIES_HEADER]: CLIENT_CAPABILITIES,
    [VERSION_HEADER]: version,
  };
}

// ── 客户端版本号 ─────────────────────────────────────────────────────────────

let versionCache: { value: string; at: number } | null = null;

/** 版本号端点；`LOBSTERAI_VERSION_URL` 可覆盖（自托管 / 离线测试）。 */
export function versionEndpoint(): string {
  const override = process.env["LOBSTERAI_VERSION_URL"];
  return override && override.trim() ? override.trim() : CLIENT_VERSION_URL;
}

/**
 * 校验并解析日期式版本号。
 *
 * 正则对齐 Go / Python 侧：`^(\d+(?:\.\d+)*)(?:-[0-9A-Za-z.-]+)?$`。
 * 之所以要**校验**而不是直接采信：版本号是签到接口的必填 query 参数，
 * 把 `null` / HTML 错误页拼进 URL 只会换来更费解的错误。
 */
export function parseClientVersion(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!/^(\d+(?:\.\d+)*)(?:-[0-9A-Za-z.-]+)?$/.test(trimmed)) return undefined;
  return trimmed;
}

/** 从更新接口响应体取 `data.value.version`（`code`/`msg` 在外层）。 */
export function parseClientVersionFromUpdate(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const data = (body as Record<string, unknown>)["data"];
  if (!data || typeof data !== "object") return undefined;
  const value = (data as Record<string, unknown>)["value"];
  if (!value || typeof value !== "object") return undefined;
  return parseClientVersion((value as Record<string, unknown>)["version"]);
}

/** 同步取当前版本号：缓存有效则用缓存，否则用兜底常量。 */
export function clientVersion(): string {
  if (versionCache && Date.now() - versionCache.at < VERSION_CACHE_TTL_MS) {
    return versionCache.value;
  }
  return FALLBACK_CLIENT_VERSION;
}

/**
 * 拉取（或复用缓存的）动态版本号。
 *
 * 失败**不抛错**：返回兜底常量。理由与 Go 的「取不到就放弃签到」不同 ——
 * 后端对 `version` 并不强校验（Go 侧长期发假值 `0.1.0` 也能用），
 * 让用户完全无法登录/签到比用一个稍旧的版本号更糟。
 * 兜底值**不进缓存**（一次瞬时故障不该在 12 小时内持续生效）。
 */
export async function resolveClientVersion(
  options: { force?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  const { force = false, timeoutMs = HTTP_TIMEOUT_MS } = options;
  if (!force && versionCache && Date.now() - versionCache.at < VERSION_CACHE_TTL_MS) {
    return versionCache.value;
  }
  try {
    const resp = await fetch(versionEndpoint(), {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.ok) {
      const version = parseClientVersionFromUpdate(await resp.json());
      if (version) {
        versionCache = { value: version, at: Date.now() };
        return version;
      }
    }
  } catch {
    /* 网络/解析失败：走兜底，不缓存兜底值 */
  }
  return FALLBACK_CLIENT_VERSION;
}

/** 清空版本缓存（测试与「强制刷新版本号」用）。 */
export function clearVersionCache(): void {
  versionCache = null;
}

/** keyfrom 身份载荷（exchange / refresh / models 共用）。 */
export interface KeyfromLike {
  firstKeyfrom?: string;
  latestKeyfrom?: string;
  uuid?: string;
  userId?: string;
}

/**
 * 构造模型列表的 query（keyfrom 身份载荷）。
 *
 * ⚠️ **不含 `refreshToken`** —— 放 query 既是信息泄露（会进服务端访问日志），
 * 也不是该端点的预期输入。空值字段**删键**而不是写空串（Go 的 `if != ""` 语义）。
 */
export function modelsQuery(
  credential: AuthLike & KeyfromLike,
  version: string,
): Record<string, string> {
  const params: Record<string, string> = {
    firstKeyfrom: credential.firstKeyfrom ?? "",
    latestKeyfrom: credential.latestKeyfrom ?? "",
    version,
  };
  if (credential.uuid) params["uuid"] = credential.uuid;
  if (credential.userId) params["userId"] = credential.userId;
  return params;
}

/** 模型列表 URL（带 keyfrom query）。 */
export function modelsUrlFor(
  cfg: Config,
  credential: AuthLike & KeyfromLike,
  version: string,
): string {
  const params = new URLSearchParams(modelsQuery(credential, version));
  return `${modelsUrl(cfg)}?${params.toString()}`;
}

// ── 请求体改写 ───────────────────────────────────────────────────────────────

/** 工具结果内嵌图片的载体文本（与官方 deepseek 适配器同名同义）。 */
export const TOOL_RESULT_IMAGE_TEXT = "Attached image(s) from tool result:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text: unknown } =>
        isRecord(block) && block["type"] === "text",
    )
    .map((block) => String(block["text"] ?? ""))
    .join("");
}

/**
 * 把一个内容块统一成图片 part（`{type:'image_url', image_url:{url}}`）。
 *
 * 认两种输入：
 * - `{type:'image_url', image_url:{url}}`（已是目标形态，原样保留）
 * - `{type:'image', source:{media_type, data}}` / `{type:'image', source:{...}}`
 *   （Anthropic 风格）→ 拼成 `data:{mediaType};base64,{data}`
 *
 * `{type:'image'}` / 裸 base64 字符串**都会让上游回 500** —— 这是唯一的接受形态。
 */
function imagePart(block: Record<string, unknown>): Record<string, unknown> | null {
  if (block["type"] === "image_url") {
    const imageUrl = block["image_url"];
    if (isRecord(imageUrl) && typeof imageUrl["url"] === "string") {
      return { type: "image_url", image_url: { url: imageUrl["url"] } };
    }
    return null;
  }
  if (block["type"] !== "image") return null;
  const source = isRecord(block["source"]) ? block["source"] : {};
  const mediaType = typeof source["media_type"] === "string" ? source["media_type"] : "image/png";
  const data = typeof source["data"] === "string" ? source["data"] : "";
  const url = typeof source["url"] === "string" ? source["url"] : "";
  if (url) return { type: "image_url", image_url: { url } };
  if (!data) return null;
  return { type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } };
}

/** 收集内容块里的图片，返回 `[文本, 图片 parts]`。 */
function splitContent(content: unknown): { text: string; images: Array<Record<string, unknown>> } {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };
  const images: Array<Record<string, unknown>> = [];
  const texts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block["type"] === "text") {
      texts.push(String(block["text"] ?? ""));
      continue;
    }
    const image = imagePart(block);
    if (image) images.push(image);
  }
  return { text: texts.join(""), images };
}

/** 消息里是否含图片（用于「不支持图片的模型」的判定）。 */
function hasImages(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => isRecord(block) && imagePart(block) !== null);
}

/**
 * 剔除无法配对的工具调用 / 结果。
 *
 * OpenAI 兼容协议要求 `tool_call` 与 `role:'tool'` 结果严格配对，缺任一侧后端
 * 都会 400 拒绝整条请求，而这条坏历史会被每次请求原样重放 ——
 * 表现为「会话突然报废，此后所有消息都无回复」。发出前剔除可让会话自愈。
 * 另外剔除**没有 name 的 tool_call**（空 name 会让上游报 `unknown tool ""`）。
 */
function resolveToolPairing(messages: readonly Record<string, unknown>[]): {
  keepCallIds: Set<string>;
  keepResultIds: Set<string>;
} {
  const declared = new Set<string>();
  const answered = new Set<string>();
  for (const message of messages) {
    const role = message["role"];
    if (role === "assistant" && Array.isArray(message["tool_calls"])) {
      for (const call of message["tool_calls"]) {
        if (!isRecord(call)) continue;
        const id = typeof call["id"] === "string" ? call["id"] : "";
        const fn = isRecord(call["function"]) ? call["function"] : {};
        const name = typeof fn["name"] === "string" ? fn["name"] : "";
        if (id && name) declared.add(id);
      }
    }
    if (role === "tool") {
      const id = typeof message["tool_call_id"] === "string" ? message["tool_call_id"] : "";
      if (id) answered.add(id);
    }
  }
  const keepCallIds = new Set<string>();
  const keepResultIds = new Set<string>();
  for (const id of declared) {
    if (answered.has(id)) {
      keepCallIds.add(id);
      keepResultIds.add(id);
    }
  }
  return { keepCallIds, keepResultIds };
}

/**
 * 把下游 OpenAI 消息改写成 LobsterAI 可接受的形状。
 *
 * - assistant：有 `tool_calls` 时正文为空 → `content: null`（OpenAI 规范）；
 *   `reasoning_content` **仅非空时带**（本渠道不强制，与 buddy 不同）
 * - tool：`content` 只能是**字符串**，且必须紧跟其 tool_call；
 *   内嵌图片挂起到其后的**独立 user 消息**（载体文本逐字）
 * - 图片统一为 `{type:'image_url', image_url:{url:'data:...'}}`
 */
export function normalizeMessages(
  messages: readonly unknown[],
  supportsImage: boolean | undefined,
): Array<Record<string, unknown>> {
  const records = messages.filter(isRecord);
  const { keepCallIds, keepResultIds } = resolveToolPairing(records);
  const wire: Array<Record<string, unknown>> = [];

  for (const message of records) {
    const role = message["role"];
    const content = message["content"];

    if (role === "assistant") {
      if (supportsImage === false && hasImages(content)) {
        throw new UnsupportedContentError("该模型不支持图片（上游声明），请换成支持的模型");
      }
      const { text } = splitContent(content);
      const toolCalls: Array<Record<string, unknown>> = [];
      if (Array.isArray(message["tool_calls"])) {
        for (const call of message["tool_calls"]) {
          if (!isRecord(call)) continue;
          const id = typeof call["id"] === "string" ? call["id"] : "";
          const fn = isRecord(call["function"]) ? call["function"] : {};
          const name = typeof fn["name"] === "string" ? fn["name"] : "";
          if (!id || !name || !keepCallIds.has(id)) continue;
          toolCalls.push({
            id,
            type: "function",
            function: {
              name,
              arguments:
                typeof fn["arguments"] === "string" ? fn["arguments"] : JSON.stringify(fn["arguments"] ?? {}),
            },
          });
        }
      }
      const reasoning = String(message["reasoning_content"] ?? "");
      const out: Record<string, unknown> = {
        role: "assistant",
        // 正文为空且有工具调用时必须是 null（OpenAI 规范）。
        content: text.length === 0 && toolCalls.length > 0 ? null : text,
      };
      if (reasoning.length > 0) out["reasoning_content"] = reasoning;
      if (toolCalls.length > 0) out["tool_calls"] = toolCalls;
      wire.push(out);
      continue;
    }

    if (role === "system") {
      wire.push({ role: "system", content: contentToText(content) });
      continue;
    }

    if (role === "tool") {
      const id = typeof message["tool_call_id"] === "string" ? message["tool_call_id"] : "";
      if (!id || !keepResultIds.has(id)) continue;
      if (supportsImage === false && hasImages(content)) {
        throw new UnsupportedContentError("该模型不支持图片（上游声明），请换成支持的模型");
      }
      const { text, images } = splitContent(content);
      wire.push({ role: "tool", tool_call_id: id, content: text || "(no output)" });
      // 工具结果内嵌图片不能并入 `role:'tool'` 消息（该角色 content 只能是字符串，
      // 且必须紧跟其 tool_call），故挂起到其后的独立 user 消息。
      if (images.length > 0) {
        wire.push({
          role: "user",
          content: [{ type: "text", text: TOOL_RESULT_IMAGE_TEXT }, ...images],
        });
      }
      continue;
    }

    // user（及其它未知角色）：图片升级为多模态 parts，纯文本保持字符串。
    if (supportsImage === false && hasImages(content)) {
      throw new UnsupportedContentError("该模型不支持图片（上游声明），请换成支持的模型");
    }
    const { text, images } = splitContent(content);
    if (images.length > 0) {
      const parts: Array<Record<string, unknown>> = [];
      if (text.length > 0) parts.push({ type: "text", text });
      parts.push(...images);
      wire.push({ role: typeof role === "string" ? role : "user", content: parts });
    } else {
      wire.push({ role: typeof role === "string" ? role : "user", content: text });
    }
  }
  return wire;
}

/**
 * 把下游 OpenAI 请求改写成 LobsterAI 能接受的形状。
 *
 * 实现三条硬约束：恒流式、图片形态统一、工具配对自愈；
 * 并去掉上游不认的 `prompt_cache_key` / `tool_choice`。
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...req, model: upstreamModel };
  // 上游不认这两个字段：`prompt_cache_key` 是腾讯后端的前缀缓存机制（未实测支持），
  // `tool_choice` 在 Go 桥接层被统一归一化掉（此处直接不发）。
  delete body["prompt_cache_key"];
  delete body["tool_choice"];

  // 上游只支持 SSE：`stream: false` 返回 500，故恒为 true
  //（客户端要非流式由网关聚合）。
  body["stream"] = true;

  const messages = Array.isArray(body["messages"]) ? [...(body["messages"] as unknown[])] : [];
  const system = body["system"];
  delete body["system"];
  if (typeof system === "string" && system.length > 0) {
    messages.unshift({ role: "system", content: system });
  }

  const entry = catalog.entryFor(upstreamModel);
  const supportsImage = entry?.supports_image;
  body["messages"] = normalizeMessages(messages, supportsImage);

  // tools：仅非空时带（空数组会让上游按「有工具但都不可用」处理）。
  const tools = body["tools"];
  if (!Array.isArray(tools) || tools.length === 0) delete body["tools"];

  // stop：仅非空数组时带。
  const stop = body["stop"];
  if (!Array.isArray(stop) || stop.length === 0) delete body["stop"];

  // reasoning_effort：调用方显式传入才透传，且必须换成 wire 值
  //（产品档位名含 `max`，而服务端只认 openclawLevel）。
  const effort = body["reasoning_effort"];
  if (typeof effort === "string" && effort.length > 0) {
    body["reasoning_effort"] = catalog.reasoningEffortWire(upstreamModel, effort);
  } else {
    delete body["reasoning_effort"];
  }

  return body;
}

// ── 模型目录拉取 ─────────────────────────────────────────────────────────────

/**
 * 拉取模型列表并灌入目录缓存。
 *
 * 响应**两种形状都必须认**（`lobsterai-adapter.ts:241-252`）：
 * 单层 `{code:0, message:'success', data:[...]}`（实测真实形态）
 * 或双层 `{code:0, msg:'OK', data:{data:[...]}}`。
 * ⚠️ 不能复用「`data` 必须是对象」的信封校验 —— 此端点 `data` 恰恰是数组，
 * 复用会让列表恒为空并静默回退兜底表。
 *
 * 401/403 抛 `UpstreamUnauthorized`（用于探测凭据有效性）。
 */
export async function fetchModels(
  credential: AuthLike & KeyfromLike,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  const [cfg] = loadConfig();
  const version = await resolveClientVersion();
  const url = modelsUrlFor(cfg, credential, version);

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: modelsHeaders(credential, version),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`models request failed: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized("upstream rejected the access token (HTTP 401/403)");
  }
  if (resp.status !== 200) throw new Error(`models request failed: HTTP ${resp.status}`);

  let env: Record<string, unknown>;
  try {
    env = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`models response is not valid JSON: ${String(err)}`);
  }
  if (env["code"] !== 0) {
    throw new Error(
      `models request failed: code=${String(env["code"])} ` +
        `msg=${String(env["msg"] ?? env["message"] ?? "")}`,
    );
  }
  const data = env["data"];
  const rows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data["data"])
      ? (data["data"] as unknown[])
      : null;
  if (!rows) throw new Error("models payload contains no model array");

  const entries = catalog.parseRemoteModels(rows);
  if (entries.length > 0) catalog.setRemoteModels(entries);
  return { models: entries, baseUrl: cfg.baseUrl };
}

/** 从模型载荷推导连接配置（登录成功后由 auth-flow 调用）。 */
export function resolveConfig(data: Record<string, unknown>, fallback?: Config): Config {
  const cfg: Config = { ...(fallback ?? defaultConfig()) };
  const baseUrl = data["baseUrl"];
  if (typeof baseUrl === "string" && baseUrl) cfg.baseUrl = baseUrl;
  return cfg;
}

// ── 错误分类（顺序即优先级，不可重排）────────────────────────────────────────

/** 上游错误类别。 */
export type ErrorKind =
  /** 成功（HTTP < 400 且未命中任何关键词）。 */
  | "none"
  /** 余额/积分不足。 */
  | "hard-credit"
  /** 429 软限流。 */
  | "soft-rate"
  /** 会话终止（refresh_token 被拒）：只能重新登录。 */
  | "session-dead"
  /** 上游偶发 404。 */
  | "not-found"
  /** 5xx 上游故障。 */
  | "server"
  /** 其它 4xx / 业务错误。 */
  | "client";

/**
 * 余额不足关键词（对齐 Go `classify.go` 的 `hardMarkers`）。
 *
 * 中英双通道是必需的：同一后端在不同场景下会返回中文或英文文案。
 * ⚠️ 2026-09 补充的 `额度已用完` / `升级套餐` 等 6 个中文 + 4 个英文来自
 * **真实缺陷**：额度耗尽的**实际文案**是「免费额度已用完，请升级套餐」，
 * 而早期表里只有「额度用尽」「积分用完」——「已用完」与「用尽」字面不同，
 * 于是这个**最主要的失败模式**判成 `none`（不换号、不记徽章）。
 */
export const HARD_CREDIT_MARKERS: readonly string[] = [
  "insufficient credit",
  "no credit",
  "credit exhausted",
  "out of credit",
  "quota exceeded",
  "quota exhaust",
  "payment required",
  "credit not enough",
  "not enough credit",
  "freecreditsused",
  "free credits used",
  "free quota",
  "quota used up",
  "upgrade your plan",
  "upgrade to continue",
  "积分不足",
  "额度不足",
  "余额不足",
  "积分用完",
  "额度用尽",
  "没有积分",
  "积分耗尽",
  "额度已用完",
  "升级套餐",
];

/** 会话终止标记（`40100`/`40101` 是刷新被拒的业务码）。 */
export const SESSION_DEAD_MARKERS: readonly string[] = [
  "40100",
  "40101",
  "token rejected",
  "refresh token was rejected",
];

/** 换号上限（进循环前已用首个凭据发过一次请求，故判据是 `attempt >= MAX - 1`）。 */
export const MAX_ROTATE = 3;
/** 限流重置时间兜底（1 小时）。 */
export const RATE_LIMIT_FALLBACK_MS = 3_600_000;

/**
 * 按 HTTP 状态码 + 响应体判定错误类别。
 *
 * **判定顺序即优先级**（完全对齐 `classify.go:66-93`），不要重排：
 *
 * | # | 判据 | 结果 |
 * |---|---|---|
 * | 1 | `status === 402` | `hard-credit` |
 * | 2 | body 命中 hard 关键词 | `hard-credit` |
 * | 3 | body 命中 session-dead 标记 | `session-dead` |
 * | 4 | `status === 429` | `soft-rate` |
 * | 5 | `status === 404` | `not-found` |
 * | 6 | `status >= 500` | `server` |
 * | 7 | `status >= 400` | `client` |
 * | 8 | 其它 | `none` |
 *
 * ⚠️ **body 关键词排在状态码之前**（除 402）：实测上游用 **400 + 中文「积分不足」**
 * 表达余额耗尽，只按状态码会误判成 `client`（可重试），于是反复重试一个
 * 永远不会成功的账号。
 * ⚠️ **session-dead 排在 429/404 之前**：`40100`/`40101` 可能与 4xx 同时出现，
 * 会话已死时任何换号重试都没意义。
 */
export function classifyError(status: number, body: string): ErrorKind {
  if (status === 402) return "hard-credit";

  const lower = body.toLowerCase();
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker) || body.includes(marker)) return "hard-credit";
  }
  for (const marker of SESSION_DEAD_MARKERS) {
    if (body.includes(marker)) return "session-dead";
  }

  if (status === 429) return "soft-rate";
  if (status === 404) return "not-found";
  if (status >= 500) return "server";
  if (status >= 400) return "client";
  return "none";
}

/**
 * 判定**流内错误帧**（HTTP 200 + SSE `{error:{message}}`）的类别。
 *
 * 不能直接复用 `classifyError`：它的优先级里状态码排最前，而流内错误的 HTTP
 * 状态是 200 —— 那些分支全部失效，未命中关键词时只会得到 `none`
 * （= 不换号），而额度耗尽正是以 HTTP 200 + 流内错误帧表达的。
 * 故默认值取 `client`（可轮转）：该账号此刻没能服务这个请求，应当换号再试。
 */
export function classifyStreamError(message: string): ErrorKind {
  const byKeyword = classifyError(200, message);
  return byKeyword === "none" ? "client" : byKeyword;
}

/** 是否应当「换下一个账号」—— 除成功外每一类都换号。 */
export function shouldRotateAccount(kind: ErrorKind): boolean {
  return kind !== "none";
}

/**
 * 是否记为**该模型**的限流标记（UI 亮「限额重置」徽章）。
 *
 * 只覆盖真正写了冷却时间的三类；`session-dead` 与 server/client 只轮转、
 * 不留徽章 —— 否则一个 400 请求错误会被显示成「该模型限流 1 小时」，是虚假信息。
 */
export function recordsRateLimit(kind: ErrorKind): boolean {
  return kind === "hard-credit" || kind === "soft-rate" || kind === "not-found";
}

/** 是否属于**终态**（重试无意义，只能重新登录）。 */
export function isTerminalError(kind: ErrorKind): boolean {
  return kind === "session-dead";
}

// ── 流翻译器（契约要求所有渠道都导出）────────────────────────────────────────

export interface StreamTranslator {
  feed(chunk: Buffer): Array<Buffer | string>;
  finish(): Array<Buffer | string>;
}

/**
 * 恒等翻译器。
 *
 * LobsterAI 是 `openai` 线型，网关不会调用本函数（`sse-stream.relay()` 直接
 * 规范化透传）；提供它是为了满足契约，万一被误用也只是原样透传、不丢数据。
 */
export function newTranslator(): StreamTranslator {
  return { feed: (chunk: Buffer) => [chunk], finish: () => [] };
}
