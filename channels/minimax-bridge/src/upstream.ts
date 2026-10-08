/**
 * MiniMax Code 上游：Anthropic Messages 形状的端点、请求头、请求体改写与流翻译。
 *
 * 实现依据：`docs/protocols/minimax/PROTOCOL.md`（§1 端点、§2.2 请求头、§3 对话请求、§4 流式响应、§5 目录）。
 *
 * ## 本模块承载的渠道知识（每条都有规格依据）
 *
 * 1. **线型是 Anthropic Messages**（§3.1）：请求体 `{model, stream, messages, system...
 *    顶层字符串, max_tokens?, temperature?, stop_sequences?, tools?, thinking?,
 *    output_config?}`；响应是 Anthropic SSE（§4），故 `WIRE = "custom"`，网关走
 *    `newTranslator()` 增量翻译。
 * 2. **请求头只有 Authorization + Content-Type + Accept**（§2.2 / §3.4）：
 *    ⚠ **不发** `anthropic-version`（2026-09-29 真机 200，源码明确要求不照抄官方文档）。
 * 3. **思考档位决策表**（§3.2，真机实测）：`none`→disabled、`on`→adaptive、
 *    有档位→adaptive + `output_config.effort`、`MiniMax-M3.1*`→**必须** adaptive、
 *    M2.7 系不发。⚠ M3 不发 thinking 时默认「不思考」。
 * 4. **成对提交规则**（§3.3）：harness 是「一条 assistant（N 个 tool_use）+ N 条独立
 *    tool 消息」，必须把 assistant 与其全部结果**成对提交**（assistant 先进待发区，
 *    遇到结果时一起 push，合成一条 user 的多个 tool_result 块）。
 *    逐条下发 / assistant 先发结果攒到下一轮 / 纯 reasoning 空 assistant 被丢弃
 *    三种形态都会报 2013。
 * 5. **图片走 Anthropic `image` 块，裸 base64**（§3.3）：`{type:'image', source:
 *    {type:'base64', media_type, data: <裸 base64>}}`。OpenAI 的 `image_url` 形状被拒；
 *    消息体里的图片内联失败 → **抛错**（不静默丢图），工具结果里的读不到 → 跳过。
 * 6. **目录响应形状**（§5.1）：`{providers:[{providerId:'minimax', config:{models:{...},
 *    model_order:[...]}}]}`；对象 key 是长名（id），条目 `name` 是短名。
 */

import { readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";

import { ensureDir, login as sharedLogin, upstreamPath } from "@model-bridge/gateway";

/** 业务 API 基址（模型目录 / 对话，§1）。 */
export const DEFAULT_BASE_URL = "https://agent.minimax.cn";

/** 展示名（状态页与错误文案用）。 */
export const DISPLAY_NAME = "MiniMax Code";

/**
 * 上游线型是**自定义（Anthropic Messages）**：网关必须走 `newTranslator()`
 * 增量翻译，不能当 OpenAI SSE 透传。
 */
export const WIRE: "openai" | "custom" = "custom";

/** 对话路径（§1：Anthropic Messages）。 */
export const DEFAULT_CHAT_PATH = "/mavis/api/v1/llm/v1/messages";

/** 模型目录路径（§1）。 */
export const DEFAULT_MODELS_PATH = "/mavis/api/v1/models";

/** 目录查询参数（§1：`region=cn&buildEnv=prod`）。 */
export const MODELS_QUERY = "region=cn&buildEnv=prod";

/**
 * 「必须 adaptive」的模型前缀（§3.2）：传 `disabled` 会被硬拒
 * `400 ... requires adaptive thinking ... not allowed (2013)`。
 */
export const MINIMAX_ADAPTIVE_ONLY_PREFIX = "MiniMax-M3.1";

/** 上游 API 拒绝了访问令牌（HTTP 401/403）。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

export interface Config {
  baseUrl: string;
  chatPath: string;
  modelsPath: string;
}

/**
 * 凭据的最小面。
 *
 * 刻意只声明需要的字段而不是 import `cred.Credentials` —— 那会形成
 * upstream ↔ cred 的循环依赖。
 */
export interface AuthLike {
  accessToken: string;
  uid?: string;
  domain?: string;
}

export function defaultConfig(): Config {
  return { baseUrl: DEFAULT_BASE_URL, chatPath: DEFAULT_CHAT_PATH, modelsPath: DEFAULT_MODELS_PATH };
}

/** 读取已解析的上游描述符（`[配置, 是否来自磁盘]`）。 */
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
  const fallback = defaultConfig();
  return [
    {
      baseUrl: nonEmpty(parsed.baseUrl) ?? fallback.baseUrl,
      // 路径是协议硬编码，不从磁盘覆盖
      chatPath: DEFAULT_CHAT_PATH,
      modelsPath: DEFAULT_MODELS_PATH,
    },
    true,
  ];
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
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

function ensureSlash(value: string): string {
  if (!value) return "/";
  return value.startsWith("/") ? value : `/${value}`;
}

/** 完整限定的 Messages URL。 */
export function chatUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return trimSlash(resolved.baseUrl) + ensureSlash(resolved.chatPath);
}

/** 模型目录 URL（§5.1：必须带 `region=cn&buildEnv=prod`）。 */
export function modelsUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return `${trimSlash(resolved.baseUrl)}${ensureSlash(resolved.modelsPath)}?${MODELS_QUERY}`;
}

/** 从 baseUrl 提取 host 部分（转发共享层原语）。 */
export function hostOf(baseUrl: string): string {
  return sharedLogin.hostOf(baseUrl);
}

/**
 * 构造上游请求头（§2.2）。
 *
 * ⚠ **不发** `anthropic-version`：2026-09-29 真机请求未带头即 200，源码明确要求
 * 「不照抄 Anthropic 官方文档加那个头」。
 * ⚠ 本函数是网关**对话**路径用的（gateway 只在头里没有 Accept 时补
 * `text/event-stream`，故这里显式给出对话需要的 Accept）。
 * 业务端点（models/credit）由 `businessHeaders()` 覆盖 Accept 为 `application/json`。
 */
export function buildHeaders(credential: AuthLike, _cfg?: Config): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
}

/** 业务 GET 端点请求头（§2.2：仅 Authorization + Accept: application/json）。 */
export function businessHeaders(credential: AuthLike, cfg?: Config): Record<string, string> {
  return { ...buildHeaders(credential, cfg), Accept: "application/json" };
}

// ── 请求体改写：OpenAI → Anthropic Messages ─────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * OpenAI 的 `image_url`（data: URL）→ Anthropic base64 image 块（**裸 base64**，§3.3）。
 *
 * 无法内联（非 data: URL / 非 base64）返回 null，由调用方决定抛错还是跳过。
 */
function imageFromOpenAi(part: Record<string, unknown>): Record<string, unknown> | null {
  const imageUrl = part["image_url"];
  const url = isRecord(imageUrl)
    ? nonEmpty(imageUrl["url"])
    : typeof imageUrl === "string"
      ? imageUrl
      : null;
  if (!url || !url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const header = url.slice(5, comma); // 去掉 "data:"
  const [mediaType, encoding] = header.split(";");
  if (encoding !== "base64" || !mediaType) return null;
  // ⚠ 裸 base64，无 `data:` 前缀；带前缀会被 400 拒绝（§3.3）。
  return { type: "image", source: { type: "base64", media_type: mediaType, data: url.slice(comma + 1) } };
}

/**
 * 把一条消息的 content 转成 Anthropic 块数组。
 *
 * @param strict 消息体场景：图片内联失败即抛错（不静默丢图，§3.3）；
 *               工具结果场景：内联失败跳过该块。
 */
function toAnthropicContent(
  content: unknown,
  strict: boolean,
): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (Array.isArray(content)) {
    const blocks: Array<Record<string, unknown>> = [];
    for (const part of content) {
      if (!isRecord(part)) continue;
      const type = part["type"];
      if (type === "text" && typeof part["text"] === "string") {
        blocks.push({ type: "text", text: part["text"] });
        continue;
      }
      if (type === "image_url") {
        const image = imageFromOpenAi(part);
        if (image) {
          blocks.push(image);
        } else if (strict) {
          throw new Error("消息体里的图片无法内联（期望 data: URL 的裸 base64），拒绝静默丢图");
        }
        continue;
      }
      if (type === "input_text" || type === "output_text") {
        if (typeof part["text"] === "string") blocks.push({ type: "text", text: part["text"] });
        continue;
      }
      blocks.push(part); // 已是 Anthropic 形状（tool_use / image / tool_result）
    }
    return blocks;
  }
  if (content === null || content === undefined) return [];
  return [{ type: "text", text: String(content) }];
}

/** OpenAI assistant 的 tool_calls → Anthropic tool_use 块（§3.3）。 */
function toolCallsToToolUse(rec: Record<string, unknown>): Array<Record<string, unknown>> {
  const calls = rec["tool_calls"];
  if (!Array.isArray(calls)) return [];
  const blocks: Array<Record<string, unknown>> = [];
  for (const call of calls) {
    if (!isRecord(call)) continue;
    const fn = isRecord(call["function"]) ? call["function"] : null;
    const name = nonEmpty(fn?.["name"]);
    if (!name) continue; // 无 name 的调用无法表达为 tool_use，剔除
    let input: unknown = {};
    const args = fn?.["arguments"];
    if (typeof args === "string" && args.trim()) {
      try {
        input = JSON.parse(args);
      } catch {
        input = {}; // 参数解析失败退化 {}（§3.3）
      }
    } else if (isRecord(args)) {
      input = args;
    }
    blocks.push({ type: "tool_use", id: nonEmpty(call["id"]) ?? `toolu_${blocks.length}`, name, input });
  }
  return blocks;
}

/** OpenAI role:"tool" → Anthropic user 消息里的 tool_result 块（§3.3）。 */
function toolResultBlock(rec: Record<string, unknown>): Record<string, unknown> {
  const id = nonEmpty(rec["tool_call_id"]) ?? nonEmpty(rec["tool_use_id"]) ?? "";
  const content = rec["content"];
  let body: unknown = "";
  if (typeof content === "string") body = content;
  else if (Array.isArray(content)) body = toAnthropicContent(content, false); // 工具结果图片读不到 → 跳过
  const block: Record<string, unknown> = { type: "tool_result", tool_use_id: id, content: body };
  if (rec["is_error"] === true) block["is_error"] = true;
  return block;
}

/**
 * 消息序列化（§3.3）：抽 `system`（顶层字符串），messages 转 Anthropic 块数组，
 * 并按**成对提交规则**把 assistant 与其全部 tool_result 成对 push。
 */
export function serializeMessages(messages: unknown[]): {
  system: string;
  messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
} {
  const systemParts: string[] = [];
  const out: Array<{ role: string; content: Array<Record<string, unknown>> }> = [];

  // assistant 先进待发区，遇到其结果一起 push（§3.3：逐条下发 / 结果攒到下一轮都报 2013）
  let pendingAssistant: { role: string; content: Array<Record<string, unknown>> } | null = null;
  let pendingResults: Array<Record<string, unknown>> = [];

  const flush = (): void => {
    const assistant = pendingAssistant;
    if (assistant) out.push(assistant);
    if (assistant && pendingResults.length > 0) out.push({ role: "user", content: pendingResults });
    // 无论是否有待发 assistant 都清空结果：孤儿 tool_result（无前置 assistant）丢弃
    pendingAssistant = null;
    pendingResults = [];
  };

  for (const msg of messages) {
    if (!isRecord(msg)) continue;
    const role = msg["role"];
    if (role === "system" || role === "developer") {
      const text = toAnthropicContent(msg["content"], true)
        .map((b) => (typeof b["text"] === "string" ? b["text"] : ""))
        .join("");
      if (text) systemParts.push(text);
      continue;
    }
    if (role === "assistant") {
      flush(); // 前一条 assistant 若还挂着（异常序列），先落地
      const blocks = toAnthropicContent(msg["content"], true);
      blocks.push(...toolCallsToToolUse(msg));
      // ⚠ 纯 reasoning 空 assistant（tool_use 仍在）**不得丢弃**（§3.3 错误形态三）
      if (blocks.length === 0) blocks.push({ type: "text", text: "" });
      pendingAssistant = { role: "assistant", content: blocks };
      continue;
    }
    if (role === "tool" || role === "function") {
      // 结果累积在待发区；assistant + 全部结果作为一组提交
      pendingResults.push(toolResultBlock(msg));
      continue;
    }
    // user / 其它 → 先把待发的 assistant(+结果) 落地，再 push 本条 user
    flush();
    const blocks = toAnthropicContent(msg["content"], true);
    out.push({ role: "user", content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }] });
  }
  flush();

  return { system: systemParts.join("\n\n"), messages: out };
}

/** OpenAI tools / functions → Anthropic tools（`input_schema` 而非 `parameters`，§3.1）。 */
function toAnthropicTools(req: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = Array.isArray(req["tools"])
    ? req["tools"]
    : Array.isArray(req["functions"])
      ? req["functions"]
      : null;
  if (!raw) return [];
  const tools: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const fn = isRecord(item["function"]) ? item["function"] : item;
    const name = nonEmpty(fn["name"]);
    if (!name) continue;
    const tool: Record<string, unknown> = { name };
    const description = nonEmpty(fn["description"]);
    if (description) tool["description"] = description;
    const schema = fn["input_schema"] ?? fn["parameters"];
    tool["input_schema"] = isRecord(schema) ? schema : { type: "object", properties: {} };
    tools.push(tool);
  }
  return tools;
}

/** 该模型是否**必须** adaptive thinking（§3.2：按前缀判定）。 */
export function requiresAdaptiveThinking(model: string): boolean {
  return model.startsWith(MINIMAX_ADAPTIVE_ONLY_PREFIX);
}

/**
 * 思考决策表（§3.2，真机实测）。
 *
 * @returns 该往请求体里合并的 `thinking` / `output_config` 片段（可能为空 = 整个不发）
 */
export function resolveThinking(
  model: string,
  effort: string | undefined,
): Record<string, unknown> {
  if (requiresAdaptiveThinking(model)) {
    // 必须 adaptive，否则 400（2013）；forced_on 下传 disabled 会被硬拒
    const out: Record<string, unknown> = { thinking: { type: "adaptive" } };
    if (effort && effort !== "none" && effort !== "on") out["output_config"] = { effort };
    return out;
  }
  if (!effort) return {}; // M2.7 系 / M3 无档位：整个不发，服务端默认
  if (effort === "none") return { thinking: { type: "disabled" } };
  if (effort === "on") return { thinking: { type: "adaptive" } };
  return { thinking: { type: "adaptive" }, output_config: { effort } };
}

/**
 * 把下游 OpenAI 请求改写成 Anthropic Messages 形状（§3.1 / §3.2 / §3.3）。
 *
 * - `system` = 顶层**字符串**（不是 role:'system' 消息）
 * - `messages` 按成对提交规则序列化
 * - 恒 `stream: true`（网关要非流式时自己聚合）
 * - `stop` → `stop_sequences`；`tools` → `[{name, description, input_schema}]`
 * - `reasoning_effort` → `thinking` / `output_config`（决策表见 `resolveThinking`）
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const rawMessages = Array.isArray(req["messages"]) ? req["messages"] : [];
  const { system, messages } = serializeMessages(rawMessages);
  if (messages.length === 0) {
    throw new Error("messages 为空：Anthropic Messages 至少需要一条消息");
  }

  const body: Record<string, unknown> = { model: upstreamModel, stream: true, messages };
  if (system) body["system"] = system;

  const maxTokens = req["max_tokens"] ?? req["max_completion_tokens"];
  if (typeof maxTokens === "number" && maxTokens > 0) body["max_tokens"] = maxTokens;
  if (typeof req["temperature"] === "number") body["temperature"] = req["temperature"];

  const stop = req["stop"];
  if (Array.isArray(stop) && stop.length > 0) {
    const seq = stop.filter((s): s is string => typeof s === "string");
    if (seq.length > 0) body["stop_sequences"] = seq;
  } else if (typeof stop === "string" && stop) {
    body["stop_sequences"] = [stop];
  }

  const tools = toAnthropicTools(req);
  if (tools.length > 0) body["tools"] = tools;

  const effort = typeof req["reasoning_effort"] === "string" ? req["reasoning_effort"] : undefined;
  Object.assign(body, resolveThinking(upstreamModel, effort));

  return body;
}

// ── 模型目录（§5.1） ────────────────────────────────────────────────────────

/** 归一后的目录条目（§5.1 normalizeMinimaxModel）。 */
export interface NormalizedModel {
  id: string;
  name: string;
  contextWindow: number | null;
  maxTokens: number | null;
  supportsImage: boolean;
  effortOptions: string[];
  defaultEffort: string | null;
  thinkingMode: string;
}

function positiveInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/** 单条目归一（§5.1）：窗口取档位表最大档，回退 `limit.context`。 */
export function normalizeModel(id: string, raw: Record<string, unknown>): NormalizedModel {
  const limit: Record<string, unknown> = isRecord(raw["limit"]) ? raw["limit"] : {};
  const options = raw["context_window_options"];
  let contextWindow: number | null = null;
  if (Array.isArray(options)) {
    for (const opt of options) {
      const n = positiveInt(opt);
      if (n !== null && (contextWindow === null || n > contextWindow)) contextWindow = n;
    }
  }
  if (contextWindow === null) contextWindow = positiveInt(limit["context"]);

  const effortOptionsRaw = raw["effort_options"];
  const effortOptions = Array.isArray(effortOptionsRaw)
    ? effortOptionsRaw.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  const defaultEffortRaw = nonEmpty(raw["default_effort"]);
  // defaultEffort 必须落在 effortOptions 内，否则丢弃（§5.1）
  const defaultEffort =
    defaultEffortRaw && effortOptions.includes(defaultEffortRaw) ? defaultEffortRaw : null;

  const modalities: Record<string, unknown> = isRecord(raw["modalities"]) ? raw["modalities"] : {};
  const input = Array.isArray(modalities["input"]) ? modalities["input"] : [];
  const thinking: Record<string, unknown> = isRecord(raw["thinking_config"]) ? raw["thinking_config"] : {};

  return {
    // ⚠ 对象 key 注入为 id（长名）；条目 name 是短名（§5.1）
    id,
    name: nonEmpty(raw["name"]) ?? id,
    contextWindow,
    maxTokens: positiveInt(limit["output"]),
    supportsImage: input.includes("image"),
    effortOptions,
    defaultEffort,
    thinkingMode: nonEmpty(thinking["mode"]) ?? "",
  };
}

/** 解析目录载荷（§5.1）：必须找到 `providerId === 'minimax'` 且 config.models 非空。 */
export function parseModelsPayload(payload: Record<string, unknown>): {
  models: NormalizedModel[];
  modelOrder: string[];
} {
  const providers = Array.isArray(payload["providers"]) ? payload["providers"] : [];
  const provider = providers.find(
    (p): p is Record<string, unknown> => isRecord(p) && p["providerId"] === "minimax",
  );
  if (!provider) throw new Error("模型目录响应里没有 providerId=minimax 的 provider");
  const config = isRecord(provider["config"]) ? provider["config"] : null;
  const modelsObj = config && isRecord(config["models"]) ? config["models"] : null;
  if (!modelsObj || Object.keys(modelsObj).length === 0) {
    throw new Error("模型目录响应里 minimax provider 的 config.models 为空");
  }
  const orderRaw = config && Array.isArray(config["model_order"]) ? config["model_order"] : [];
  const order = orderRaw.filter((x): x is string => typeof x === "string");

  // 按 model_order 排序（若提供），否则保持插入序
  const keys = order.length > 0 ? order.filter((k) => k in modelsObj) : Object.keys(modelsObj);
  const seen = new Set<string>();
  const models: NormalizedModel[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = modelsObj[key];
    if (isRecord(entry)) models.push(normalizeModel(key, entry));
  }
  // model_order 没覆盖到的条目补在末尾
  for (const key of Object.keys(modelsObj)) {
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = modelsObj[key];
    if (isRecord(entry)) models.push(normalizeModel(key, entry));
  }
  return { models, modelOrder: keys };
}

/**
 * 拉取模型目录（§5.1），同时用于探测凭据有效性（401/403 → UpstreamUnauthorized）。
 */
export async function fetchModels(
  credential: AuthLike,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const cfg = loadConfig()[0];
  if (credential.domain && credential.domain !== hostOf(cfg.baseUrl)) {
    cfg.baseUrl = `https://${credential.domain}`;
  }

  let resp: Response;
  try {
    resp = await fetch(modelsUrl(cfg), {
      headers: businessHeaders(credential, cfg),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`models 请求失败: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized("上游拒绝了访问令牌（HTTP 401/403）");
  }
  if (resp.status !== 200) throw new Error(`models 请求失败: HTTP ${resp.status}`);

  let env: Record<string, unknown>;
  try {
    env = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`models 响应不是合法 JSON: ${String(err)}`);
  }
  const { models, modelOrder } = parseModelsPayload(env);
  return { models, model_order: modelOrder };
}

/** 从模型载荷推导连接配置（baseUrl 可能由服务端下发；路径是协议硬编码）。 */
export function resolveConfig(data: Record<string, unknown>, fallback?: Config): Config {
  const cfg: Config = { ...(fallback ?? loadConfig()[0] ?? defaultConfig()) };
  const baseUrl = nonEmpty(data["baseUrl"]) ?? nonEmpty(data["base_url"]);
  if (baseUrl) cfg.baseUrl = baseUrl;
  cfg.chatPath = DEFAULT_CHAT_PATH;
  cfg.modelsPath = DEFAULT_MODELS_PATH;
  return cfg;
}

// ── 流翻译：Anthropic SSE → OpenAI SSE（必须是增量，§4） ─────────────────────

export interface StreamTranslator {
  /** 喂入一块字节，返回本次可产出的 OpenAI SSE 帧。 */
  feed(chunk: Buffer): Array<Buffer | string>;
  /** 流结束：处理残余、补 `finish_reason` 帧与 `data: [DONE]`。 */
  finish(): Array<Buffer | string>;
}

/**
 * `stop_reason` 映射（§4）：`tool_use` → tool-calls、`max_tokens` → max-tokens、
 * `refusal` / 未知 / 缺失 → stop。
 *
 * ⚠ 取值照抄 PROTOCOL §4 的字面结论。
 */
export function mapStopReason(reason: unknown): string {
  switch (reason) {
    case "tool_use":
      return "tool-calls";
    case "max_tokens":
      return "max-tokens";
    default:
      return "stop";
  }
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Anthropic SSE → OpenAI delta 的**增量**翻译器（§4）。
 *
 * ⚠ 不能「读完再翻」：流式会失去意义。
 * ⚠ 必须跨 chunk 保留半帧：SSE 事件会被 TCP 切在任意位置（中文多字节字符与
 * `\n\n` 分隔符都会被切开）⇒ 用 `TextDecoder("utf-8")` 流式解码 + 字符串缓冲。
 * ⚠ 帧自带 `type` 字段，优先用它（`event:` 行可能被中间层吞掉）。
 * ⚠ `signature_delta` **必须忽略**（当文本会往回答里注入十六进制）。
 * ⚠ `thinking` 块必须映射成 reasoning 块，否则思考内容污染正文。
 * ⚠ 收尾 flush 后把余量按整行再走一遍 —— 否则被截断的流会丢掉最后一帧。
 * ⚠ 无任何内容块 → **抛错**。
 */
export function newTranslator(): StreamTranslator {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let doneSent = false;

  let messageId = "";
  let model = "minimax";
  const created = Math.floor(Date.now() / 1000);

  let roleSent = false;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let reasoningTokens: number | null = null;
  let sawContentBlock = false;
  let finishSent = false;
  let errorSent = false;

  /** Anthropic content block index → OpenAI tool_calls index（从 0 连续编号）。 */
  const toolIndexByBlock = new Map<number, number>();
  let nextToolIndex = 0;

  function chunkFrame(
    delta: Record<string, unknown>,
    finishReason: string | null,
    usage?: Record<string, unknown>,
  ): string {
    const payload: Record<string, unknown> = {
      id: messageId || "chatcmpl-minimax",
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage) payload["usage"] = usage;
    return sseFrame(payload);
  }

  /** 归一化 usage：Anthropic 的 input/output_tokens → OpenAI 三件套。 */
  function usageFrame(): Record<string, unknown> | null {
    if (inputTokens === null && outputTokens === null) return null;
    const prompt = inputTokens ?? 0;
    const completion = outputTokens ?? 0; // 已含 thinking_tokens（子集，不相加，§4）
    const usage: Record<string, unknown> = {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    };
    if (reasoningTokens !== null) {
      usage["completion_tokens_details"] = { reasoning_tokens: reasoningTokens };
    }
    return usage;
  }

  function handleEvent(block: string): Array<Buffer | string> {
    const out: Array<Buffer | string> = [];
    let eventName = "";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue; // 注释行（: keep-alive）忽略
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) return out;
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(dataLines.join("\n"));
      if (!isRecord(parsed)) return out;
      payload = parsed;
    } catch {
      return out; // 半截/非 JSON 数据帧：忽略，不猜
    }
    // 帧自带 type 优先（event: 行可能被中间层吞掉）
    const type = nonEmpty(payload["type"]) ?? eventName;

    switch (type) {
      case "message_start": {
        const message = isRecord(payload["message"]) ? payload["message"] : null;
        messageId = nonEmpty(message?.["id"]) ?? messageId;
        model = nonEmpty(message?.["model"]) ?? model;
        const usage = isRecord(message?.["usage"]) ? message["usage"] : null;
        const rawIn = numOrNull(usage?.["input_tokens"]);
        const cacheRead = numOrNull(usage?.["cache_read_input_tokens"]) ?? 0;
        if (rawIn !== null) inputTokens = rawIn + cacheRead;
        if (!roleSent) {
          roleSent = true;
          out.push(chunkFrame({ role: "assistant" }, null));
        }
        break;
      }
      case "content_block_start": {
        const blockObj = isRecord(payload["content_block"]) ? payload["content_block"] : null;
        const blockType = nonEmpty(blockObj?.["type"]);
        if (blockType === "thinking" || blockType === "text" || blockType === "tool_use") {
          sawContentBlock = true;
        }
        if (blockType === "tool_use") {
          const index = numOrNull(payload["index"]) ?? nextToolIndex;
          const toolIndex = nextToolIndex;
          nextToolIndex += 1;
          toolIndexByBlock.set(index, toolIndex);
          out.push(
            chunkFrame(
              {
                tool_calls: [
                  {
                    index: toolIndex,
                    id: nonEmpty(blockObj?.["id"]) ?? `call_${toolIndex}`,
                    type: "function",
                    function: { name: nonEmpty(blockObj?.["name"]) ?? "", arguments: "" },
                  },
                ],
              },
              null,
            ),
          );
        }
        break;
      }
      case "content_block_delta": {
        const delta = isRecord(payload["delta"]) ? payload["delta"] : null;
        if (!delta) break;
        const deltaType = nonEmpty(delta["type"]);
        // 内容增量本身就证明存在内容块（上游可能省略 content_block_start，如被截断的流）
        if (
          deltaType === "text_delta" ||
          deltaType === "thinking_delta" ||
          deltaType === "input_json_delta"
        ) {
          sawContentBlock = true;
        }
        if (deltaType === "text_delta") {
          const text = delta["text"];
          if (typeof text === "string" && text) out.push(chunkFrame({ content: text }, null));
        } else if (deltaType === "thinking_delta") {
          // ⚠ thinking → reasoning 块，否则思考内容污染正文（§4）
          const thinking = delta["thinking"];
          if (typeof thinking === "string" && thinking) {
            out.push(chunkFrame({ reasoning_content: thinking }, null));
          }
        } else if (deltaType === "input_json_delta") {
          const partial = delta["partial_json"];
          if (typeof partial === "string" && partial) {
            const blockIndex = numOrNull(payload["index"]) ?? 0;
            if (!toolIndexByBlock.has(blockIndex)) {
              toolIndexByBlock.set(blockIndex, nextToolIndex);
              nextToolIndex += 1;
            }
            out.push(
              chunkFrame(
                {
                  tool_calls: [
                    { index: toolIndexByBlock.get(blockIndex), function: { arguments: partial } },
                  ],
                },
                null,
              ),
            );
          }
        }
        // ⚠ signature_delta 必须忽略：当成文本会把一串十六进制注入回答（§4）。
        break;
      }
      case "message_delta": {
        const delta = isRecord(payload["delta"]) ? payload["delta"] : null;
        const usage = isRecord(payload["usage"]) ? payload["usage"] : null;
        const outTok = numOrNull(usage?.["output_tokens"]);
        if (outTok !== null) outputTokens = outTok;
        const details = isRecord(usage?.["output_tokens_details"]) ? usage["output_tokens_details"] : null;
        const think = numOrNull(details?.["thinking_tokens"]);
        if (think !== null) reasoningTokens = think; // 子集，不相加（§4）
        if (!finishSent) {
          finishSent = true;
          out.push(chunkFrame({}, mapStopReason(delta?.["stop_reason"]), usageFrame() ?? undefined));
        }
        break;
      }
      case "message_stop": {
        if (!finishSent) {
          finishSent = true;
          out.push(chunkFrame({}, "stop", usageFrame() ?? undefined));
        }
        break;
      }
      case "error": {
        // ⚠ 必须显式产出 error 帧（静默当成正常结束会让 UI「干净地停止、无报错」）。
        if (!errorSent) {
          errorSent = true;
          const error = isRecord(payload["error"]) ? payload["error"] : payload;
          const message = nonEmpty(error["message"]) ?? "上游返回了 error 事件";
          const code = error["code"] ?? payload["code"];
          out.push(
            sseFrame({
              error: { type: "upstream_error", message, ...(code === undefined ? {} : { code }) },
            }),
          );
        }
        break;
      }
      default:
        // ping / content_block_stop 之外的未知事件：无输出
        break;
    }
    return out;
  }

  return {
    feed(chunk: Buffer): Array<Buffer | string> {
      const out: Array<Buffer | string> = [];
      if (doneSent) return out;
      // 流式解码：跨 chunk 的半截多字节字符由 TextDecoder 保留
      buffer += decoder.decode(chunk, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      for (;;) {
        const split = buffer.indexOf("\n\n");
        if (split < 0) break;
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        if (block.trim()) out.push(...handleEvent(block));
      }
      return out;
    },

    finish(): Array<Buffer | string> {
      const out: Array<Buffer | string> = [];
      if (doneSent) return out;
      buffer += decoder.decode();
      buffer = buffer.replace(/\r\n/g, "\n");
      // 容错：上游没发尾部分隔空行时，残余内容仍作为一个事件处理
      if (buffer.trim()) out.push(...handleEvent(buffer));
      buffer = "";

      // ⚠ 无任何内容块 → 抛错（§4）。error 事件已显式报告失败时不重复抛。
      if (!sawContentBlock && !errorSent) {
        throw new Error("上游流不含任何内容块（thinking / text / tool_use）");
      }

      // 断流（没有 message_stop / message_delta）也要补 finish_reason
      if (!finishSent && !errorSent) {
        finishSent = true;
        out.push(chunkFrame({}, "stop", usageFrame() ?? undefined));
      }
      out.push("data: [DONE]\n\n");
      doneSent = true;
      return out;
    },
  };
}
