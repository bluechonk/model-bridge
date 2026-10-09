/**
 * TRAE（字节跳动）上游：SOLO 形状的端点、请求头、请求体改写、Error 分类与流翻译。
 *
 * ## 本模块承载的渠道知识（每一条都有实测依据，见 docs/protocols/trae/PROTOCOL.md）
 *
 * 1. **请求头同一 token 设三处**：`Authorization: Cloud-IDE-JWT <token>` /
 *    `X-Cloudide-Token` / `X-Ide-Token` —— 缺任一个都可能被拒。
 * 2. **版本头是模型准入条件**：`X-Ide-Version` / `X-App-Version-Code` 过低时
 *    glm-5.3 等新模型报 4001 `param is invalid`。
 * 3. **请求体**（§3.2）：`function`（通道）、`model` 与 `config_name` **双字段同值**、
 *    `messages[].content` 一律转 `[{type:"text",text}]` 数组、
 *    `tools[].function.parameters` 转 **JSON 字符串**、
 *    `max_tokens` 收敛到上限 **64000**（索要 131072 会被上游打成 4xx）。
 * 4. **Max 模式（1M 上下文）必须成套下发**：只调大 `max_tokens` 无效。
 * 5. **响应是自定义 event 流**（§4.1）：`event:output` 的 `response` 是正文**增量**、
 *    `reasoning_content` 是思考增量、`tool_calls` 里的 `function_call` 要改名为
 *    `function` 并清理 SOLO 专属字段；结束是 `event:done`（不是 `[DONE]`）；
 *    `event:error` 必须显式产出 error 帧。
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";

import * as catalog from "./catalog.js";
import { APP_ID, IDE_VERSION, IDE_VERSION_CODE, USER_AGENT } from "./cred.js";
import { ensureDir, login as sharedLogin, upstreamPath } from "@model-bridge/gateway";

/** agentHost：对话 + 模型列表。 */
export const DEFAULT_BASE_URL = "https://trae-api-cn.mchost.guru";

/** 展示名（状态页与错误文案用）。 */
export const DISPLAY_NAME = "TRAE";

/**
 * 上游线型是**自定义 event 流**（`event:output` / `token_usage` / `done` / `error`）：
 * 网关必须走 `newTranslator()` 增量翻译。
 */
export const WIRE: "openai" | "custom" = "custom";

export const CHAT_PATH = "/api/agent/v3/llm_utils_chat";

/** 多通道模型列表（单通道的 get_detail_param 无调用方）。 */
export const MODELS_PATH = "/api/ide/v1/batch_get_detail_param";

/** 缺省通道（`function` 字段）。 */
export const DEFAULT_FUNCTION = "solo_work_lite";

/** `max_tokens` 安全上限：实测客户端索要 131072 会被打成 4xx。 */
export const MAX_TOKENS_LIMIT = 64_000;

/** Max 模式的 prompt 预算（成套字段之一）。 */
export const MAX_MODE_PROMPT_TOKENS = 936_000;

/** 模型列表请求的 22 个通道，逐字（§5.1）。 */
export const MODEL_FUNCTIONS: readonly string[] = [
  "ui_builder_v2",
  "solo_coder",
  "chat_v3",
  "solo_builder",
  "builder_v3",
  "builder",
  "chat",
  "inline_chat",
  "git_ai",
  "custom_agent_generation",
  "utils",
  "code_reviewer",
  "code_review_summary",
  "solo_agent",
  "solo_agent_remote",
  "solo_work_remote",
  "solo_agent_lite",
  "solo_work_lite",
  "solo_design_lite",
  "solo_design_remote",
  "multimodal",
  "system_diagnosis",
] as const;

/** 上游 API 拒绝了访问令牌（HTTP 401/403，或错误分类 session-dead）。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

export interface Config {
  baseUrl: string;
  chatPath: string;
  modelsPath: string;
}

/** 凭据的最小面（避免 upstream ↔ cred 循环依赖）。 */
export interface AuthLike {
  accessToken: string;
  uid: string;
  machineId: string;
  deviceId: string;
  domain?: string;
}

export function defaultConfig(): Config {
  return { baseUrl: DEFAULT_BASE_URL, chatPath: CHAT_PATH, modelsPath: MODELS_PATH };
}

/** 读取已解析的上游描述符（`[配置, 是否来自磁盘]`）。 */
export function loadConfig(): [Config, boolean] {
  let raw: string;
  try {
    raw = readFileSync(upstreamPath(), "utf8");
  } catch {
    return [defaultConfig(), false];
  }
  let parsed: Partial<Config> = {};
  try {
    parsed = JSON.parse(raw) as Partial<Config>;
  } catch {
    return [defaultConfig(), false];
  }
  const fallback = defaultConfig();
  return [
    {
      baseUrl: nonEmpty(parsed.baseUrl) ?? fallback.baseUrl,
      chatPath: nonEmpty(parsed.chatPath) ?? fallback.chatPath,
      modelsPath: nonEmpty(parsed.modelsPath) ?? fallback.modelsPath,
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

export function chatUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return trimSlash(resolved.baseUrl) + ensureSlash(resolved.chatPath);
}

export function modelsUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return trimSlash(resolved.baseUrl) + ensureSlash(resolved.modelsPath);
}

export function hostOf(baseUrl: string): string {
  return sharedLogin.hostOf(baseUrl);
}

/** 构造上游请求头（鉴权 + 客户端伪装）。 */
export function buildHeaders(
  credential: AuthLike,
  options: { accept?: string } = {},
): Record<string, string> {
  const token = credential.accessToken;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: options.accept ?? "text/event-stream",
    "User-Agent": USER_AGENT,
    // ⚠ 同一 token 设三处：缺任一个都可能被拒
    Authorization: `Cloud-IDE-JWT ${token}`,
    "X-Cloudide-Token": token,
    "X-Ide-Token": token,
    "X-App-Id": APP_ID,
    "X-App-Version": "default",
    // ⚠ 版本头是模型准入条件（版本过低 → glm-5.3 报 4001）
    "X-Ide-Version": IDE_VERSION,
    "X-Ide-Version-Code": IDE_VERSION_CODE,
    "X-App-Version-Code": IDE_VERSION_CODE,
    "X-Ide-Version-Type": "stable",
    "X-Device-Type": "macos",
    "X-OS-Version": "macOS 15.7.4",
    "X-Device-Brand": "Apple",
    "Request-Traffic-Type": "prod",
    "X-Machine-Id": credential.machineId,
    "X-Device-Id": credential.deviceId,
  };
  if (credential.uid) headers["X-Uid"] = credential.uid;
  return headers;
}

// ── 错误分类（§4.2） ─────────────────────────────────────────────────────────

export type TraeErrorKind =
  | "hard-plan"
  | "quota-exceeded"
  | "soft-rate"
  | "session-dead"
  | "not-found"
  | "server"
  | "client"
  | "none";

/**
 * 按报文 + 状态码分类错误。
 *
 * ⚠ 判定顺序有讲究：**`4008` 必须先于 `4011`**（报文里两个码都有时按配额耗尽
 * 处理 → 换号，而不是按频率超限等 60s）。
 */
export function classifyError(status: number, body: string): TraeErrorKind {
  const text = (body ?? "").toLowerCase();
  if (text.includes("1005")) return "hard-plan"; // Plan 权益不足
  if (text.includes("4008")) return "quota-exceeded"; // 配额耗尽
  if (text.includes("4011")) return "soft-rate"; // 频率超限
  if (status === 401 || status === 403) return "session-dead";
  if (/token invalid|token 失效|session|unauthorized|login/.test(text)) return "session-dead";
  if (status === 429) return "soft-rate";
  if (status === 404) return "not-found";
  if (status >= 500) return "server";
  if (status >= 400) return "client";
  return "none";
}

/**
 * 各错误分类的建议冷却秒数；`null` 表示无固定冷却
 * （session-dead 需重新登录；quota-exceeded 由账号池决定换号）。
 */
export function cooldownSeconds(kind: TraeErrorKind): number | null {
  switch (kind) {
    case "hard-plan":
      return 43_200; // 12h
    case "soft-rate":
      return 60;
    case "not-found":
      return 60;
    case "server":
      return 600;
    case "client":
      return 600;
    default:
      return null;
  }
}

// ── 请求体改写：OpenAI → SOLO ───────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** `messages[].content` 一律转块数组（字符串 → `[{type:"text",text}]`）。 */
function toContentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) {
    const parts = content.filter(isRecord);
    return parts.length > 0 ? parts : [{ type: "text", text: "" }];
  }
  if (isRecord(content)) return [content];
  return [{ type: "text", text: "" }];
}

/**
 * assistant 的 `tool_calls` → SOLO 的单个 `function_call`。
 *
 * 无 `function_call.name` 的调用被剔除（协议要求）；
 * 第二个及之后的调用 SOLO 不接受（单函数调用形态）。
 */
function pickFunctionCall(rec: Record<string, unknown>): Record<string, unknown> | null {
  const calls = rec["tool_calls"];
  if (!Array.isArray(calls)) return null;
  for (const call of calls) {
    if (!isRecord(call)) continue;
    const fn = isRecord(call["function"]) ? call["function"] : null;
    const name = nonEmpty(fn?.["name"]);
    if (!name) continue;
    const args = fn?.["arguments"];
    return {
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
    };
  }
  return null;
}

/** tools 的 `parameters` 对象 → JSON 字符串（SOLO 要求）。 */
function toSoloTools(req: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = req["tools"];
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const tools: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const fn = isRecord(item["function"]) ? item["function"] : null;
    if (!fn) {
      tools.push(item);
      continue;
    }
    const next: Record<string, unknown> = { ...fn };
    const params = fn["parameters"];
    if (params !== undefined && typeof params !== "string") {
      next["parameters"] = JSON.stringify(params);
    }
    tools.push({ ...item, function: next });
  }
  return tools;
}

/** tool_choice 归一化（`none` 时连 tools 一起删）。 */
function normalizeToolChoice(choice: unknown): { value: string | null; dropTools: boolean } {
  if (typeof choice === "string") {
    if (choice === "none") return { value: null, dropTools: true };
    return { value: choice, dropTools: false };
  }
  if (isRecord(choice)) {
    const type = nonEmpty(choice["type"]);
    if (type === "none") return { value: null, dropTools: true };
    const fn = isRecord(choice["function"]) ? choice["function"] : null;
    const name = nonEmpty(fn?.["name"]);
    if (name) return { value: name, dropTools: false };
    if (type) return { value: type, dropTools: false };
  }
  return { value: null, dropTools: false };
}

/** 模型名去掉 `__dev` / `__max` 档位后缀（SOLO 的 model 字段不带后缀）。 */
export function stripModelSuffix(model: string): string {
  return model.replace(/__(dev|max)$/, "");
}

/** Max 模式（1M 上下文）的入场信息（由目录条目提供）。 */
export interface EntryHint {
  function?: string;
  max_mode?: boolean;
  max_context?: number;
  max_max_tokens?: number;
}

/** 从目录推导通道 / Max 模式明细（网关只传两个参数时的兜底路径）。 */
export function catalogHint(model: string): EntryHint {
  const entry = catalog.entryFor(model);
  if (!entry) return {};
  return {
    function: entry.function,
    max_mode: entry.max_mode,
    max_context: entry.context_window,
    max_max_tokens: entry.max_max_tokens,
  };
}

/**
 * 把下游 OpenAI 请求改写成 SOLO 形状。
 *
 * 只发白名单字段：SOLO 不接受 OpenAI 的 `presence_penalty` 等参数，
 * 透传未知字段会把可用请求打成 4xx。
 *
 * @param entry 目录条目提示（通道 / Max 模式明细）。网关只传两个参数，
 *   此时通道与 Max 明细由 `catalog.entryFor()` 推导；
 *   `__max` 后缀（档位明细里的 Max 变体）会触发 Max 模式成套字段。
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
  entry?: EntryHint,
): Record<string, unknown> {
  const model = stripModelSuffix(upstreamModel);
  const hint = entry ?? catalogHint(model);
  const fn = hint.function || catalog.channelFor(model) || DEFAULT_FUNCTION;

  const body: Record<string, unknown> = {
    stream: true, // 强制流式
    function: fn,
    // ⚠ model 与 config_name 双字段同值
    model,
    config_name: model,
  };
  // ⚠ 请求体不存在 query 字段

  const rawMessages = Array.isArray(req["messages"]) ? req["messages"] : [];
  const messages: Array<Record<string, unknown>> = [];
  for (const msg of rawMessages) {
    if (!isRecord(msg)) continue;
    const out: Record<string, unknown> = { ...msg };
    out["content"] = toContentBlocks(msg["content"]);
    if (msg["role"] === "assistant") {
      const functionCall = pickFunctionCall(msg);
      delete out["tool_calls"];
      if (functionCall) out["function_call"] = functionCall;
    }
    messages.push(out);
  }
  body["messages"] = messages;

  // 工具：parameters 转 JSON 字符串
  let tools = toSoloTools(req);
  const choice = normalizeToolChoice(req["tool_choice"]);
  if (choice.dropTools) tools = [];
  if (tools.length > 0) body["tools"] = tools;
  if (choice.value) body["tool_choice"] = choice.value;

  // max_tokens 收敛到安全上限（只收不放）
  if (typeof req["max_tokens"] === "number") {
    body["max_tokens"] = Math.min(req["max_tokens"], MAX_TOKENS_LIMIT);
  }
  if (typeof req["temperature"] === "number") body["temperature"] = req["temperature"];
  if (typeof req["top_p"] === "number") body["top_p"] = req["top_p"];
  if (typeof req["reasoning_effort"] === "string" && req["reasoning_effort"]) {
    body["reasoning_effort"] = req["reasoning_effort"]; // 原样透传
  }

  // Max 模式（1M 上下文）：必须成套下发，只调大 max_tokens 无效。
  // 仅远端 display_config.max_mode === true 的模型的 __max 档位允许。
  if (entry?.max_mode || (/__max$/.test(upstreamModel) && hint.max_mode)) {
    body["model_auto_selection"] = { strategy: "max" };
    body["model_selection_strategy"] = "max";
    body["mode_type"] = 1;
    if (typeof hint.max_context === "number") body["context_window_size"] = hint.max_context;
    body["prompt_max_tokens"] = MAX_MODE_PROMPT_TOKENS;
    body["max_tokens"] =
      typeof hint.max_max_tokens === "number"
        ? hint.max_max_tokens
        : (body["max_tokens"] as number | undefined) ?? MAX_TOKENS_LIMIT;
  }
  return body;
}

// ── 模型列表（远端目录载荷） ─────────────────────────────────────────────────

/** 拉取多通道模型载荷。401/403（或 session-dead 业务码）抛 UpstreamUnauthorized。 */
export async function fetchModels(
  credential: AuthLike,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const cfg = loadConfig()[0];
  if (credential.domain && credential.domain !== hostOf(cfg.baseUrl)) {
    cfg.baseUrl = `https://${credential.domain}`;
  }
  const body = {
    functions: [...MODEL_FUNCTIONS],
    agent_type: "",
    current_config_info: { config_name: "", is_custom_model: false },
    mode_type: 0,
    access_type: 0,
    ab_force_vids: "",
    ab_autotest_advanced_mode: 0,
    show_custom_model: true,
  };

  let resp: Response;
  try {
    resp = await fetch(modelsUrl(cfg), {
      method: "POST",
      body: JSON.stringify(body),
      headers: buildHeaders(credential, { accept: "application/json" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`Model list request failed: ${String(err)}`);
  }
  const text = await resp.text();
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized("Upstream rejected the access token (HTTP 401/403)");
  }
  if (resp.status !== 200) {
    const kind = classifyError(resp.status, text);
    throw new Error(`Model list request failed: HTTP ${resp.status} (${kind})`);
  }
  let env: unknown;
  try {
    env = JSON.parse(text);
  } catch (err) {
    throw new Error(`Model list response is not valid JSON: ${String(err)}`);
  }
  if (!isRecord(env)) throw new Error("Model list response is not a JSON object");
  // 200 但载荷不像目录（无 function_configs）且报错文本指向登录失效 ⇒ 终态
  if (!Array.isArray(env["function_configs"]) && classifyError(200, text) === "session-dead") {
    throw new UpstreamUnauthorized("Upstream credential is invalid (session-dead)");
  }
  return env;
}

/** 从模型载荷推导连接配置（远端不掌握 host 时保持默认）。 */
export function resolveConfig(data: Record<string, unknown>, fallback?: Config): Config {
  const cfg: Config = { ...(fallback ?? loadConfig()[0] ?? defaultConfig()) };
  const baseUrl = nonEmpty(data["baseUrl"]) ?? nonEmpty(data["base_url"]);
  if (baseUrl) cfg.baseUrl = baseUrl;
  cfg.chatPath = CHAT_PATH;
  cfg.modelsPath = MODELS_PATH;
  return cfg;
}

// ── 流翻译：TRAE event 流 → OpenAI SSE（必须是增量） ─────────────────────────

export interface StreamTranslator {
  /** 喂入一块字节，返回本次可产出的 OpenAI SSE 帧。 */
  feed(chunk: Buffer): Array<Buffer | string>;
  /** 流结束：处理残余、补 `finish_reason` 帧与 `data: [DONE]`。 */
  finish(): Array<Buffer | string>;
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** finish_reason 归一化（done 事件给的是上游自己的枚举）。 */
export function mapFinishReason(reason: unknown): string {
  switch (reason) {
    case "length":
    case "max_tokens":
      return "length";
    case "tool_calls":
    case "tool_use":
    case "function_call":
      return "tool_calls";
    case "stop":
    case "end_turn":
    case undefined:
    case null:
    case "":
      return "stop";
    default:
      return "stop";
  }
}

/** `tool_calls[]` 里的 `function_call` → `function`，并清理 SOLO 专属字段。 */
function cleanToolCalls(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  const calls: Array<Record<string, unknown>> = [];
  value.forEach((item, i) => {
    if (!isRecord(item)) return;
    const fn = isRecord(item["function_call"])
      ? item["function_call"]
      : isRecord(item["function"])
        ? item["function"]
        : {};
    const args = fn["arguments"] ?? fn["partial_arguments"] ?? "";
    const call: Record<string, unknown> = {
      index: typeof item["index"] === "number" ? item["index"] : i,
      type: "function",
      function: {
        name: nonEmpty(fn["name"]) ?? "",
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    };
    const id = nonEmpty(item["id"]);
    if (id) call["id"] = id;
    calls.push(call);
  });
  return calls.length > 0 ? calls : null;
}

/**
 * TRAE event 流 → OpenAI delta 的**增量**翻译器。
 *
 * ⚠ 不能「读完再翻」（流式会失去意义）；必须跨 chunk 保留半帧
 * （`TextDecoder("utf-8")` 流式解码 + 字符串缓冲，不能逐 chunk `toString()`）。
 * ⚠ `done` 事件是结束标志（不是 `[DONE]`）；`error` 事件必须显式产出 error 帧。
 */
export function newTranslator(): StreamTranslator {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let doneSent = false;

  const id = `chatcmpl-trae-${randomBytes(4).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  let roleSent = false;
  let finishSent = false;
  let errorSent = false;
  let usage: Record<string, unknown> | null = null;

  function chunkFrame(
    delta: Record<string, unknown>,
    finishReason: string | null = null,
    usagePayload?: Record<string, unknown>,
  ): string {
    const payload: Record<string, unknown> = {
      id,
      object: "chat.completion.chunk",
      created,
      // 上游帧不带模型名，占位为渠道名（客户端一般回填请求里的 model）
      model: "trae",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usagePayload) payload["usage"] = usagePayload;
    return sseFrame(payload);
  }

  function withRole(delta: Record<string, unknown>): Record<string, unknown> {
    if (roleSent) return delta;
    roleSent = true;
    return { role: "assistant", ...delta };
  }

  function handleEvent(block: string): Array<Buffer | string> {
    const out: Array<Buffer | string> = [];
    let eventName = "";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue; // 注释行忽略
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (!dataLines.length) return out;
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(dataLines.join("\n")); // data 可跨行拼接
      if (!isRecord(parsed)) return out;
      payload = parsed;
    } catch {
      return out; // 半截/非 JSON 帧：忽略
    }

    switch (eventName) {
      case "output": {
        const response = payload["response"];
        const reasoning = payload["reasoning_content"];
        const calls = cleanToolCalls(payload["tool_calls"]);
        const delta: Record<string, unknown> = {};
        if (typeof response === "string" && response) delta["content"] = response;
        if (typeof reasoning === "string" && reasoning) delta["reasoning_content"] = reasoning;
        if (calls) delta["tool_calls"] = calls;
        if (Object.keys(delta).length > 0) out.push(chunkFrame(withRole(delta)));
        break;
      }
      case "token_usage": {
        const prompt = typeof payload["prompt_tokens"] === "number" ? payload["prompt_tokens"] : 0;
        const completion =
          typeof payload["completion_tokens"] === "number" ? payload["completion_tokens"] : 0;
        const reasoningTokens =
          typeof payload["reasoning_tokens"] === "number" ? payload["reasoning_tokens"] : 0;
        usage = {
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: prompt + completion,
          ...(reasoningTokens ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } } : {}),
        };
        out.push(chunkFrame({}, null, usage));
        break;
      }
      case "done": {
        if (!finishSent) {
          finishSent = true;
          out.push(chunkFrame({}, mapFinishReason(payload["finish_reason"]), usage ?? undefined));
        }
        break;
      }
      case "error": {
        // ⚠ 必须显式产出 error 帧：静默当成正常结束会让 UI「干净地停止、无报错」。
        if (!errorSent) {
          errorSent = true;
          out.push(
            sseFrame({
              error: {
                type: "upstream_error",
                message: nonEmpty(payload["message"]) ?? "upstream emitted an error event",
                ...(payload["code"] === undefined ? {} : { code: payload["code"] }),
              },
            }),
          );
        }
        break;
      }
      default:
        // metadata / timing_cost / extra_info：出现即算「上游已开工」，无输出
        break;
    }
    return out;
  }

  return {
    feed(chunk: Buffer): Array<Buffer | string> {
      const out: Array<Buffer | string> = [];
      if (doneSent) return out;
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
      if (buffer.trim()) out.push(...handleEvent(buffer));
      buffer = "";

      // 断流（没有 done 事件）也要补 finish_reason，否则客户端卡在「生成中」
      if (!finishSent && !errorSent) {
        finishSent = true;
        out.push(chunkFrame({}, "stop", usage ?? undefined));
      }
      out.push("data: [DONE]\n\n");
      doneSent = true;
      return out;
    },
  };
}
