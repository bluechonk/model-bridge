/**
 * CatPaw 上游客户端：OpenAI 兼容请求 ↔ 妙手 conversation 三段式协议互译。
 *
 * ## 上游协议（WIRE = "custom"，实测见 docs/protocols/catpaw/PROTOCOL.md）
 *
 * 三段式：
 *   1. POST /api/agent/conversation/round  提交本轮全部消息（含历史，type 标角色）
 *   2. POST /api/agent/conversation/event  回报轮次状态（running / completed / failed / canceled）
 *   3. POST /api/agent/conversation/turn   执行轮次，SSE 直出
 *
 * 关键实测事实：
 *   - 直接调 turn（不先 round）一律 500 空响应
 *   - round.messages 用 `type` 标角色，必须带 messageId，最后一条必须是 user
 *   - permissionMode 用 `default`：上游只生成文本（工具调用以 tool_use 分块出现在文本里）
 *   - SSE 帧是累积式（每帧给全文），要按「当前串是否以已发送串为前缀」做 suffix-diff
 *   - 没有结束标志：turn 以 TCP 关闭结束
 *
 * ## 铁律
 *
 * token 原文不进日志/输出，只给指纹与脱敏形态。
 */

import { randomUUID } from "node:crypto";

import { login as sharedLogin, type StreamTranslator } from "@model-bridge/gateway";

const { fetchWithTimeout } = sharedLogin;

import * as catalog from "./catalog.js";
import * as cred from "./cred.js";

// ── 端点常量（实测，见 docs/protocols/catpaw/PROTOCOL.md）─────────────────────────────────────

export const DEFAULT_BASE_URL = "https://ai.catpaw.meituan.com";
const ROUND_PATH = "/api/agent/conversation/round";
const EVENT_PATH = "/api/agent/conversation/event";
const TURN_PATH = "/api/agent/conversation/turn";
const MODEL_LIST_PATH = "/api/agent/maas/model-types";

export const WIRE: "custom" = "custom";
export const DISPLAY_NAME = "CatPaw";

/** 认证头常量。 */
const PASSPORT_COOKIE = "X-Passport-Token";
const M_APPKEY = "fe_com.sankuai.catpaw.external.front";
const GRAY_SET = "new-agent-sdk";
const X_AGENT_VERSION = "1.0.1";
const CATPAW_MODE = "CATX_APP";
const CATPAW_SOURCE = "CatX";
const TOOL_VERSION = "2.0.2";
const PERMISSION_MODE = "default";

/** 超时。 */
const TURN_TIMEOUT_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

/** systemPromptOverride 硬上限（JS JSON.stringify(text).length 口径）。 */
export const SYSTEM_PROMPT_MAX_LEN = 65508;

/** 未登录 / 上游 401。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

/** 上游返回业务错误码。 */
export class CatPawProtocolError extends Error {
  override name = "CatPawProtocolError";
  readonly code: number;
  constructor(message: string, code = 0) {
    super(message);
    this.code = code;
  }
}

// ── 配置 ────────────────────────────────────────────────────────────────────

export interface Config {
  baseUrl: string;
}

export function defaultConfig(): Config {
  return { baseUrl: DEFAULT_BASE_URL };
}

export function loadConfig(): [Config, boolean] {
  // catpaw 不做上游配置落盘（与桌面端协议固定），恒用默认值
  return [defaultConfig(), false];
}

export async function saveConfig(cfg: Config): Promise<void> {
  void cfg; // catpaw 无上游配置文件，保存为 no-op
}

export function chatUrl(cfg?: Config): string {
  const base = resolveBaseUrl(cfg);
  return `${base}${TURN_PATH}`;
}

export function modelsUrl(cfg?: Config): string {
  const base = resolveBaseUrl(cfg);
  return `${base}${MODEL_LIST_PATH}`;
}

export function roundUrl(cfg?: Config): string {
  const base = resolveBaseUrl(cfg);
  return `${base}${ROUND_PATH}`;
}

export function eventUrl(cfg?: Config): string {
  const base = resolveBaseUrl(cfg);
  return `${base}${EVENT_PATH}`;
}

/** 解析上游基址：优先环境变量 CATPAW_BASE_URL（测试注入），否则用配置/默认值。 */
function resolveBaseUrl(cfg?: Config): string {
  const env = process.env["CATPAW_BASE_URL"];
  if (env) return env.replace(/\/+$/, "");
  return (cfg?.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function resolveConfig(data: Record<string, unknown>, fallback?: Config): Config {
  const base = data["baseUrl"];
  return {
    baseUrl: typeof base === "string" && base ? base : fallback?.baseUrl || DEFAULT_BASE_URL,
  };
}

// ── 凭据形状 ─────────────────────────────────────────────────────────────────

export interface CredentialShape {
  accessToken: string;
  uid: string;
}

// ── 工具函数 ─────────────────────────────────────────────────────────────────

/** 32 位无横线 hex（M-TRACEID 形状）。 */
function traceId(): string {
  return randomUUID().replace(/-/g, "");
}

/** `buildHeaders` 的端点形态选项。 */
export interface HeaderOptions {
  /**
   * 是否用于**流式对话**端点（`turn`）。
   *
   * 默认 `true`（契约里 `buildHeaders` 的主要用途就是对话）。
   * `round` / `event` / 模型目录等普通 JSON 端点必须传 `false`：
   * 实测给它们 `Accept: text/event-stream` 会被 **406/500** 拒绝。
   */
  stream?: boolean;
}

/**
 * 从凭据构建上游请求头。
 *
 * ⚠ **`Accept` 按端点区分，不能一刀切**：`turn`（流式对话）必须 `text/event-stream`
 * （缺了被 406 拒绝）；`round` / `event` / 模型目录必须 `application/json`
 * （发 SSE 会被 500 拒绝）。早期一刀切发 SSE 导致 `round` 直接 500，故参数化
 * 由调用方声明形态。
 */
export function buildHeaders(
  credential: CredentialShape,
  opts: HeaderOptions = {},
): Record<string, string> {
  const stream = opts.stream ?? true;
  const token = credential.accessToken;
  const headers: Record<string, string> = {
    "M-TRACEID": traceId(),
    "M-APPKEY": M_APPKEY,
    "gray-set": GRAY_SET,
    "X-Agent-Version": X_AGENT_VERSION,
    "X-Passport-Token": token,
    "Cookie": `${PASSPORT_COOKIE}=${token}`,
    "enableHeartBeat": "true",
    "Content-Type": "application/json",
    "Accept": stream ? "text/event-stream" : "application/json",
  };
  if (credential.uid) headers["user-uid"] = credential.uid;
  return headers;
}

// ── 请求体构造 ───────────────────────────────────────────────────────────────

/** 上游消息（round.messages 与 turn.message 共用）。 */
interface UpstreamMessage {
  type: string; // "user" | "assistant"
  role: string;
  messageId: string;
  content: Array<{ type: string; text?: string; tool_call_id?: string; name?: string; arguments?: string }>;
}

/** 从 OpenAI messages 构造上游 round.messages。 */
function toUpstreamMessages(messages: Array<Record<string, unknown>>): UpstreamMessage[] {
  const out: UpstreamMessage[] = [];
  for (const msg of messages) {
    const role = typeof msg["role"] === "string" ? msg["role"] : "";
    if (role === "system") continue; // system 走 systemPromptContext
    const content = msg["content"];
    if (typeof content === "string") {
      out.push({
        type: role,
        role,
        messageId: randomUUID(),
        content: [{ type: "text", text: content }],
      });
    } else if (Array.isArray(content)) {
      const parts: UpstreamMessage["content"] = [];
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p["type"] === "text" && typeof p["text"] === "string") {
          parts.push({ type: "text", text: p["text"] });
        } else if (p["type"] === "tool_result" || p["type"] === "tool_call") {
          // 工具结果/调用折叠成文本，保持角色语义
          parts.push({ type: "text", text: JSON.stringify(p, null, 2) });
        }
      }
      if (parts.length > 0) {
        out.push({ type: role, role, messageId: randomUUID(), content: parts });
      }
    }
  }
  // 确保最后一条是 user（上游硬要求）
  if (out.length === 0 || out[out.length - 1]!.type !== "user") {
    throw new Error('upstream requires the last message to have role "user"');
  }
  return out;
}

/** 取 system 消息（可能不存在）。 */
function extractSystem(messages: Array<Record<string, unknown>>): string {
  for (const msg of messages) {
    if (msg["role"] === "system" && typeof msg["content"] === "string") {
      return msg["content"];
    }
  }
  return "";
}

/** 取工具声明（OpenAI 形状 → 上游 toolConfigs）。 */
function extractTools(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const tools = payload["tools"];
  if (!Array.isArray(tools)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const t = tool as Record<string, unknown>;
    const fn = t["function"] && typeof t["function"] === "object"
      ? (t["function"] as Record<string, unknown>)
      : t;
    const name = typeof fn["name"] === "string" ? fn["name"] : "";
    if (!name) continue;
    out.push({
      name,
      description: typeof fn["description"] === "string" ? fn["description"] : "",
      inputSchema: fn["parameters"] ?? {},
    });
  }
  return out;
}

/** 取 reasoning effort。 */
function extractEffort(payload: Record<string, unknown>): string {
  const extra = payload["extra"];
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    const effort = (extra as Record<string, unknown>)["effort"];
    if (typeof effort === "string") return effort;
  }
  return "";
}

/**
 * 把 OpenAI ChatCompletion 请求改写成 catpaw conversation turn body。
 *
 * ⚠ 上游是**三段式协议**（round → event → turn），而共享 gateway 层只 POST 一次
 * 到 `chatUrl()`（turn URL）。所以这里**同步 fire-and-forget** 先发 round + event，
 * 返回 turn body 供 `openStream` POST 到 turn URL。
 *
 * ⚠ round/event 失败不阻塞 turn 请求（失败时上游会回 HTTP 500，由 `openStream` 归为上游错误）。
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const messages = req["messages"] as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages is required and must not be empty");
  }

  const modelType = catalog.modelTypeOf(upstreamModel);
  const system = extractSystem(messages);
  const systemLen = JSON.stringify(system).length - 2; // JSON.stringify(text).length
  if (systemLen > SYSTEM_PROMPT_MAX_LEN) {
    throw new Error(
      `system prompt is ${systemLen} chars after escaping, exceeding the upstream limit ${SYSTEM_PROMPT_MAX_LEN}`,
    );
  }

  const upstreamMessages = toUpstreamMessages(messages);
  const last = upstreamMessages[upstreamMessages.length - 1]!;

  const tools = extractTools(req);
  const effort = extractEffort(req);
  const context = 1024000;

  const conversationId = randomUUID();
  const requestContext = {
    modelParams: { declarativeParams: { context: String(context), ...(effort ? { effort } : {}) } },
  };

  const roundBody: Record<string, unknown> = {
    conversationId,
    source: CATPAW_SOURCE,
    messages: upstreamMessages,
    modelType,
    mode: CATPAW_MODE,
    toolVersion: TOOL_VERSION,
    requestContext,
  };
  if (system) roundBody["systemPromptContext"] = { systemPromptOverride: system };

  const turnBody: Record<string, unknown> = {
    conversationId,
    turnRequestId: randomUUID(),
    source: CATPAW_SOURCE,
    action: "turn",
    message: last,
    modelType,
    mode: CATPAW_MODE,
    permissionMode: PERMISSION_MODE,
    toolVersion: TOOL_VERSION,
    requestContext,
  };
  if (system) turnBody["systemPromptContext"] = { systemPromptOverride: system };
  if (tools.length > 0) {
    turnBody["toolConfigs"] = tools;
    turnBody["availableTools"] = tools.map((t) => t["name"]);
  }

  // 前置 round + event 由网关通过 `prepareChat` 钩子 await（见下方该函数）。
  // 这里只把 roundBody 挂上，不发起请求 —— `buildChatBody` 是同步契约，
  // 且 fire-and-forget 会与 turn 竞争（实测导致「会话未在执行中」）。
  turnBody["__conversationId"] = conversationId;
  turnBody["__roundBody"] = JSON.stringify(roundBody);
  return turnBody;
}

/**
 * 前置 round + event：**顺序执行且必须都成功**，`turn` 才被上游接受。
 *
 * 实测矩阵（真实账号）：只 round（缺 event）→ turn 报「会话未在执行中」；
 * 只 turn → 500；两个都发、都用 JSON Accept、且在 turn 之前完成 → 200 出正文。
 *
 * 由网关经 `UpstreamModule.prepareChat` 钩子 `await`（`buildChatBody` 是同步契约，
 * 放不下这段异步顺序；fire-and-forget 又会与 turn 竞争）。
 *
 * ⚠ 参数必须是**网关建好的同一个 body**（同一 conversationId）。绝不能在这里再调一次
 * `buildChatBody` —— 那会生成新 id，前置指向会话 A、对话指向 B，上游照样报
 * 「会话未在执行中」（实测踩过）。
 */
export async function prepareChat(body: Record<string, unknown>): Promise<void> {
  const conversationId = sharedLogin.str(body["__conversationId"]);
  const rawRound = sharedLogin.str(body["__roundBody"]);
  if (!conversationId || !rawRound) return;

  // 内部字段不能发给上游：在这里就地摘掉（网关随后发的就是同一个对象）。
  // 用 `__` 前缀 + 显式删除，而不是另开一张旁路表 —— 让「body 就是最终请求体」
  // 这条不变量在 prepareChat 返回后立即成立，不依赖调用顺序。
  delete body["__conversationId"];
  delete body["__roundBody"];

  const headers = buildHeaders(loadCredential(), { stream: false });
  // 顺序执行：round 建会话 → event 置 running。任一失败都会让 turn 无法工作，
  // 所以**不吞错**（由网关归为上游错误，日志能看到是哪一步失败）。
  await postJson(
    roundUrl(),
    headers,
    JSON.parse(rawRound) as Record<string, unknown>,
    FETCH_TIMEOUT_MS,
  );
  await postJson(
    eventUrl(),
    headers,
    { conversationId, eventType: "conversation", data: { status: "running" } },
    FETCH_TIMEOUT_MS,
  );
}

/** 静默加载凭据（失败时返回空凭据，让 preflight 走 401 路径）。 */
function loadCredential(): CredentialShape {
  try {
    const c = cred.load() as unknown as CredentialShape;
    return c;
  } catch {
    return { accessToken: "", uid: "" };
  }
}

// ── SSE 翻译器 ───────────────────────────────────────────────────────────────

/** 累积 → 增量差分状态机。 */
class SuffixDiff {
  private prevText = "";
  private prevReasoning = "";
  private prevToolArgs = new Map<string, string>();

  textDelta(current: string): string {
    if (current.startsWith(this.prevText)) {
      const delta = current.slice(this.prevText.length);
      this.prevText = current;
      return delta;
    }
    this.prevText = current;
    return current;
  }

  reasoningDelta(current: string): string {
    if (current.startsWith(this.prevReasoning)) {
      const delta = current.slice(this.prevReasoning.length);
      this.prevReasoning = current;
      return delta;
    }
    this.prevReasoning = current;
    return current;
  }

  toolArgsDelta(toolId: string, current: string): string {
    const prev = this.prevToolArgs.get(toolId);
    this.prevToolArgs.set(toolId, current);
    if (prev === undefined) return current;
    return current.startsWith(prev) ? current.slice(prev.length) : current;
  }
}

/** SSE 逐行读取器（TCP 可能把一行切成两半）。 */
class SseLineReader {
  private tail = "";
  private decoder = new TextDecoder("utf-8");

  push(chunk: Uint8Array): Array<Record<string, unknown> | { __error: CatPawProtocolError }> {
    this.tail += this.decoder.decode(chunk, { stream: true });
    const out: Array<Record<string, unknown> | { __error: CatPawProtocolError }> = [];
    let idx = this.tail.indexOf("\n");
    while (idx >= 0) {
      const line = this.tail.slice(0, idx);
      this.tail = this.tail.slice(idx + 1);
      const frame = parseSseLine(line);
      if (frame !== null) out.push(frame);
      idx = this.tail.indexOf("\n");
    }
    return out;
  }

  finish(): Record<string, unknown> | { __error: CatPawProtocolError } | null {
    if (!this.tail) return null;
    const line = this.tail;
    this.tail = "";
    return parseSseLine(line);
  }
}

/** 解析一行 `data:`；`[DONE]` 与空行返回 null。 */
function parseSseLine(
  line: string,
): Record<string, unknown> | { __error: CatPawProtocolError } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const raw = trimmed.slice("data:".length).trim();
  if (raw === "" || raw === "[DONE]") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  // 信封解包：{code, msg, data}
  const code = rec["code"];
  if (typeof code === "number" && code !== 0 && code !== 200) {
    const msg = typeof rec["msg"] === "string"
      ? rec["msg"]
      : typeof rec["message"] === "string"
        ? rec["message"]
        : `upstream error code=${code}`;
    return { __error: new CatPawProtocolError(msg, code) };
  }
  if ("data" in rec) {
    const data = rec["data"];
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
  }
  return rec;
}

/** 事件类型。 */
type RawEvent =
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_use"; toolId: string; toolName: string; toolArguments: string }
  | { type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number }
  | { type: "done"; finishReason: string }
  | { type: "error"; message: string; code: number };

/** 把一帧（已解信封）翻成零或多个事件。 */
function decodeFrame(diff: SuffixDiff, frame: Record<string, unknown>): RawEvent[] {
  const events: RawEvent[] = [];

  // 错误帧：{conversationId, error:{code, unifyCode, message}}
  const errorDoc = frame["error"];
  if (errorDoc && typeof errorDoc === "object" && !Array.isArray(errorDoc)) {
    const err = errorDoc as Record<string, unknown>;
    const message = typeof err["message"] === "string"
      ? err["message"]
      : JSON.stringify(err);
    const code = typeof err["code"] === "number" ? err["code"] : 0;
    events.push({ type: "error", message, code });
    return events;
  }

  const message = frame["message"];
  if (!message || typeof message !== "object" || Array.isArray(message)) return events;
  const msg = message as Record<string, unknown>;

  // 文本与推理（累积帧）
  let accumulated = "";
  const content = msg["content"];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p["type"] === "text" && typeof p["text"] === "string") {
        accumulated += p["text"];
        const partReasoning = p["reasoningContent"];
        if (typeof partReasoning === "string" && partReasoning) {
          const delta = diff.reasoningDelta(partReasoning);
          if (delta) events.push({ type: "reasoning", text: delta });
        }
      } else if (p["type"] === "tool_use") {
        const toolId = typeof p["toolCallId"] === "string" && p["toolCallId"]
          ? p["toolCallId"]
          : randomUUID();
        const name = typeof p["toolName"] === "string" ? p["toolName"] : "";
        const params = typeof p["toolParams"] === "string"
          ? p["toolParams"]
          : JSON.stringify(p["toolParams"] ?? {});
        events.push({
          type: "tool_use",
          toolId,
          toolName: name,
          toolArguments: diff.toolArgsDelta(toolId, params),
        });
      }
    }
  } else if (typeof msg["text"] === "string") {
    accumulated = msg["text"];
  }
  if (accumulated) {
    const delta = diff.textDelta(accumulated);
    if (delta) events.push({ type: "delta", text: delta });
  }

  // message 层 reasoningContent
  const msgReasoning = msg["reasoningContent"];
  if (typeof msgReasoning === "string" && msgReasoning) {
    const delta = diff.reasoningDelta(msgReasoning);
    if (delta) events.push({ type: "reasoning", text: delta });
  }

  // usage 修正：prompt = max(upstream_prompt, total − completion)
  const contextInfo = frame["contextInfo"];
  const usageDoc =
    contextInfo && typeof contextInfo === "object" && !Array.isArray(contextInfo)
      ? (contextInfo as Record<string, unknown>)["usage"]
      : frame["usage"];
  if (usageDoc && typeof usageDoc === "object" && !Array.isArray(usageDoc)) {
    const u = usageDoc as Record<string, unknown>;
    const num = (k: string): number => (typeof u[k] === "number" && Number.isFinite(u[k]) ? (u[k] as number) : 0);
    const completion = num("completion_tokens");
    const prompt = Math.max(num("prompt_tokens"), num("total_tokens") - completion);
    events.push({
      type: "usage",
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: prompt + completion,
    });
  }

  return events;
}

/** 事件 → OpenAI SSE 帧。 */
function eventToSseFrame(event: RawEvent): Buffer | string {
  switch (event.type) {
    case "delta":
      return frame({
        choices: [{
          index: 0,
          delta: { content: event.text },
          finish_reason: null,
        }],
      });
    case "reasoning":
      return frame({
        choices: [{
          index: 0,
          delta: { reasoning_content: event.text },
          finish_reason: null,
        }],
      });
    case "tool_use":
      return frame({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: event.toolId,
              type: "function",
              function: { name: event.toolName, arguments: event.toolArguments },
            }],
          },
          finish_reason: null,
        }],
      });
    case "usage":
      return frame({
        usage: {
          prompt_tokens: event.promptTokens,
          completion_tokens: event.completionTokens,
          total_tokens: event.totalTokens,
        },
      });
    case "done":
      return frame({
        choices: [{ index: 0, delta: {}, finish_reason: event.finishReason }],
      });
    case "error":
      return frame({
        error: { message: event.message, code: event.code },
      });
  }
}

/** 组装一条 OpenAI SSE data: 帧。 */
function frame(payload: Record<string, unknown>): Buffer {
  return Buffer.from(`data: ${JSON.stringify(payload)}\n\n`, "utf8");
}

/**
 * CatPaw StreamTranslator：把上游累积帧 → OpenAI delta 流。
 * 必须增量（逐 chunk 喂入），finish() 补 finish_reason 帧与 [DONE]。
 */
export function newTranslator(): StreamTranslator {
  const diff = new SuffixDiff();
  const reader = new SseLineReader();
  const pendingEvents: RawEvent[] = [];
  let doneSent = false;

  return {
    feed(chunk: Buffer): Array<Buffer | string> {
      const out: Array<Buffer | string> = [];
      for (const frame of reader.push(chunk)) {
        if ("__error" in frame) {
          const err = (frame as { __error: CatPawProtocolError }).__error;
          pendingEvents.push({ type: "error", message: err.message, code: err.code });
          continue;
        }
        const events = decodeFrame(diff, frame as Record<string, unknown>);
        for (const ev of events) pendingEvents.push(ev);
      }
      // 消费 pending（error 出现后不再发内容）
      while (pendingEvents.length > 0) {
        const ev = pendingEvents.shift()!;
        if (ev.type === "error") {
          out.push(eventToSseFrame(ev));
        } else {
          out.push(eventToSseFrame(ev));
        }
      }
      return out;
    },
    finish(): Array<Buffer | string> {
      if (doneSent) return [];
      doneSent = true;
      return [
        eventToSseFrame({ type: "done", finishReason: "stop" }),
        Buffer.from("data: [DONE]\n\n", "utf8"),
      ];
    },
  };
}

// ── 上游 HTTP 交互 ───────────────────────────────────────────────────────────

/** 发一次 JSON POST（round / event 用）。 */
async function postJson(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<void> {
  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { ...headers, Accept: "application/json" },
    body: JSON.stringify(body),
  }, timeoutMs);
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized(`upstream HTTP ${resp.status}`);
  }
  if (!resp.ok) throw new Error(`upstream HTTP ${resp.status}`);
  const text = await resp.text().catch(() => "");
  if (!text) return;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const code = parsed["code"];
    if (typeof code === "number" && code !== 0 && code !== 200) {
      const msg = typeof parsed["msg"] === "string" ? parsed["msg"] : `upstream code=${code}`;
      throw new CatPawProtocolError(msg, code);
    }
  } catch (err) {
    if (err instanceof CatPawProtocolError) throw err;
    /* 非 JSON 响应不视为失败 */
  }
}

/** 回报轮次状态（失败不影响结果）。 */
async function reportStatus(
  headers: Record<string, string>,
  conversationId: string,
  status: string,
): Promise<void> {
  try {
    await postJson(
      `${(DEFAULT_BASE_URL).replace(/\/+$/, "")}${EVENT_PATH}`,
      headers,
      {
        conversationId,
        eventType: "conversation",
        data: { status },
      },
      FETCH_TIMEOUT_MS,
    );
  } catch {
    /* 状态回报失败不影响本次结果 */
  }
}

/** 拉模型目录，回填 catalog。 */
export async function fetchModels(credential: CredentialShape): Promise<Record<string, unknown>> {
  // 模型目录是普通 JSON 端点（实测 Accept: application/json）
  const headers = buildHeaders(credential, { stream: false });
  const resp = await fetchWithTimeout(modelsUrl(), {
    method: "POST",
    headers: { ...headers, Accept: "application/json" },
    body: JSON.stringify({ tenant: "CatDesk", scene: CATPAW_MODE, env: "EXTERNAL" }),
  }, FETCH_TIMEOUT_MS);
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized(`upstream HTTP ${resp.status}`);
  }
  if (!resp.ok) throw new Error(`model-types HTTP ${resp.status}`);
  const parsed = (await resp.json()) as Record<string, unknown>;
  const data = "data" in parsed ? parsed["data"] : parsed;
  const rows = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? ((data as Record<string, unknown>)["models"] as unknown[])
      : [];
  const entries = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const info = catalog.toModelInfo(row as Record<string, unknown>);
    if (info) entries.push(info);
  }
  catalog.setCatalog(entries);
  return { models: entries, ok: true };
}