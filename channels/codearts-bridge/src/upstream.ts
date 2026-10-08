/**
 * CodeArts 上游：SDK-HMAC-SHA256 签名、端点、请求头、请求体改写与错误分类。
 *
 * ## 签名：canonical 里**头行与 SignedHeaders 之间有一个空行**（最容易漏的一处）
 *
 * ```
 * uri          = pathname，若不以 '/' 结尾则补 '/'
 * query        = search 去掉开头的 '?'
 * payloadHash  = sha256_hex(body)                    # GET 传空 body
 * canonical    = '\n'.join([method, uri, query,
 *                 各头按 key 排序的 'k:v' 行,
 *                 '',                            # ← 关键空行
 *                 ';'.join(排序后的 key), payloadHash])
 * stringToSign = 'SDK-HMAC-SHA256\n' + dateStamp + '\n' + sha256_hex(canonical)
 * Authorization = 'SDK-HMAC-SHA256 Access={ak},SignedHeaders={...},Signature={hmac_hex}'
 * ```
 *
 * ## 哪些头参与签名（**反例不能一概而论**）
 *
 * 参与：`host`（由运行时生成，发送前剔除）、`x-sdk-date`、`x-sdk-content-sha256`、
 * `x-security-token`、`content-type`（**仅非 GET**）、`maas_type`（**仅 benefit 模型**）。
 *
 * ⚠️ **`Agent-Type` / `X-Language` 绝不能参与签名**（2026-09-18 真实凭据实测）：
 * 进入 canonical request 与 SignedHeaders 会得
 * `401 {"error_code":"APIG.0301",...verify ak sk signature fail}`；签名后追加则 200。
 * ⚠️ 但 `maas_type: benefit` 是**反例** —— 它必须参与签名（否则 404 未注册）。
 *
 * ## 网关契约带来的一个约束
 *
 * 共享网关的调用序列是 `buildChatBody()` → `buildHeaders()`（中间无 await）——
 * 后者是同步接口、拿不到请求体，而 `x-sdk-content-sha256` 需要 body 哈希。
 * 故 `buildChatBody()` 会把「本次请求的规范化 body + chat/session id」存进
 * 模块内的 pending 槽，`buildHeaders()` 从那里取。JS 单线程且两步之间无 await，
 * 并发请求不会交错 —— 这一点在文件内注释里写明，避免后来者误以为可以改成异步。
 */

import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";

import * as catalog from "./catalog.js";
import { ensureDir, upstreamPath } from "@model-bridge/gateway";

/** 上游基址（snap-access 网关；硬编码 cn-north-4，无多区域）。 */
export const DEFAULT_BASE_URL = "https://snap-access.cn-north-4.myhuaweicloud.com";

/** 对话端点。 */
export const CHAT_PATH = "/api/v2/chat/completions";
/** 常规模型目录端点（签名 GET + 签名后追加 Agent-Type/X-Language）。 */
export const SNAP_BUILTIN_PATH = "/v1/model/builtin";
/** benefit（免费额度）模型目录端点（只有签名头，无任何额外头）。 */
export const OPENGW_CONFIG_URL = "https://opengw.developer.huaweicloud.com/api/v1/gateway/config";

/** benefit 目录端点；`CODEARTS_OPENGW_URL` 可覆盖（自托管 / 离线测试）。 */
export function opengwConfigUrl(): string {
  const override = process.env["CODEARTS_OPENGW_URL"];
  return override && override.trim() ? override.trim() : OPENGW_CONFIG_URL;
}
/** 排队状态端点（桥接层不轮询它，保留常量供诊断用）。 */
export const QUEUE_STATUS_BASE = `${DEFAULT_BASE_URL}/api/v1/queue/status`;

/** 展示名（状态页与日志用）。 */
export const DISPLAY_NAME = "CodeArts";

/** 上游线型：标准 OpenAI SSE delta。 */
export const WIRE: "openai" | "custom" = "openai";

/** 默认最大输出（实测 65536 可用、131072 触发空流被拒）。 */
export const DEFAULT_MAX_TOKENS = 65_536;

/** benefit 模型缺 `maas_type` 时后端下发的稳定错误码（去掉该头可重试一次）。 */
export const BENEFIT_NOT_FOUND_ERROR_CODE = "InferHub.4004.200";
/** 账号无 benefit 包时的 SSE 错误码（同义）。 */
export const BENEFIT_NOT_FOUND_CODE = "BENEFIT_NOT_FOUND";

const HTTP_TIMEOUT_MS = 30_000;

/** 上游 API 拒绝了访问令牌（HTTP 401/403）。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

/** 描述如何到达 CodeArts chat 端点。 */
export interface Config {
  baseUrl: string;
}

/** 凭据的最小面（避免 upstream ↔ cred 循环依赖）。 */
export interface AuthLike {
  accessToken?: string;
  accessKeyId: string;
  secretAccessKey: string;
  securityToken: string;
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

/** 常规模型目录 URL（不带认证；签名由 `fetchModels` 负责）。 */
export function modelsUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return `${trimSlash(resolved.baseUrl)}${SNAP_BUILTIN_PATH}`;
}

// ── SDK-HMAC-SHA256 签名 ─────────────────────────────────────────────────────

/** SHA-256 hex（`node:crypto` 同步实现，契约要求零依赖）。 */
export function sha256Hex(data: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** HMAC-SHA256 hex。 */
export function hmacSha256Hex(key: string | Buffer, data: string | Buffer): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

/**
 * 构造 canonical request（**注意 `headerLines` 与 `signedHeaders` 之间的空行**）。
 *
 * `headers` 的键必须已统一为小写；函数内部按 key 排序（与 Go / Python 侧的
 * 普通字典序一致，不要用 localeCompare）。
 */
export function buildCanonicalRequest(
  method: string,
  uri: string,
  query: string,
  headers: Record<string, string>,
  payloadHash: string,
): string {
  const signedHeaders = Object.keys(headers).sort();
  const headerLines = signedHeaders.map((key) => `${key}:${headers[key] ?? ""}`);
  return [method, uri, query, headerLines.join("\n"), "", signedHeaders.join(";"), payloadHash].join(
    "\n",
  );
}

/** `SDK-HMAC-SHA256\n{dateStamp}\n{canonicalHash}`。 */
export function buildStringToSign(dateStamp: string, canonicalHash: string): string {
  return `SDK-HMAC-SHA256\n${dateStamp}\n${canonicalHash}`;
}

/** `YYYYMMDDTHHMMSSZ`（毫秒被截掉，结尾保留 Z）。 */
export function formatDateStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export interface SignInput {
  method: string;
  url: string;
  /** 请求体（GET 省略）。 */
  body?: string | Buffer;
  ak: string;
  sk: string;
  securityToken: string;
  /** 参与签名的额外头（`maas_type: benefit`）。 */
  extraSignedHeaders?: Readonly<Record<string, string>>;
  /** 注入固定时刻（测试断言固定签名 hex 用）。 */
  dateStamp?: string;
}

/**
 * 签名一个华为云请求；返回**需合并到请求中的头映射**（含 `Authorization`）。
 *
 * 返回里含 `host` —— 发送前必须剔除（fetch 会按实际连接目标生成），
 * 但它在 canonical 里是必需项。各调用方都遵循这一条。
 */
export function signRequest(input: SignInput): Record<string, string> {
  const url = new URL(input.url);
  let uri = url.pathname;
  if (!uri.endsWith("/")) uri += "/";
  const query = url.search.slice(1);
  const dateStamp = input.dateStamp ?? formatDateStamp();
  const payloadHash = sha256Hex(input.body ?? Buffer.alloc(0));

  const headers: Record<string, string> = {
    host: url.host,
    "x-sdk-date": dateStamp,
    "x-sdk-content-sha256": payloadHash,
    "x-security-token": input.securityToken,
  };
  if (input.extraSignedHeaders) {
    for (const [key, value] of Object.entries(input.extraSignedHeaders)) {
      headers[key.toLowerCase()] = value;
    }
  }
  // GET（模型目录等）不带请求体，因此没有 content-type。
  if (input.method.toUpperCase() !== "GET") headers["content-type"] = "application/json";

  const signedKeys = Object.keys(headers).sort();
  const canonical = buildCanonicalRequest(input.method, uri, query, headers, payloadHash);
  const signature = hmacSha256Hex(
    input.sk,
    buildStringToSign(dateStamp, sha256Hex(canonical)),
  );
  headers["Authorization"] =
    `SDK-HMAC-SHA256 Access=${input.ak},` +
    `SignedHeaders=${signedKeys.join(";")},Signature=${signature}`;
  return headers;
}

/** 剔除 `host`（发送前必须做，见 `signRequest` 说明）。 */
export function withoutHost(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "host") continue;
    out[key] = value;
  }
  return out;
}

function credentialParts(credential: AuthLike): { ak: string; sk: string; st: string } {
  const ak = credential?.accessKeyId ?? "";
  const sk = credential?.secretAccessKey ?? "";
  if (!ak || !sk) throw new Error("凭据缺少 AK/SK");
  return { ak, sk, st: credential.securityToken ?? "" };
}

// ── 请求体改写 ───────────────────────────────────────────────────────────────

/** DSML 工具模式的触发模型（**无日期后缀**的 deepseek-v4 flash/pro）。 */
export const DSML_MODEL_PATTERN = /^deepseek-v4-(flash|pro)$/;
/** 只有这些「大参数」工具才值得切 DSML（小参数工具保持标准 tool_calls）。 */
export const DSML_LARGE_PARAM_TOOLS = ["write", "file_write", "apply_patch"];

/** DSML magic string（`｜` 是 U+FF5C 全角竖线，逐字不可改）。 */
export const DSML_TOOL_CALLS_OPEN = "<｜DSML｜tool_calls>";
export const DSML_TOOL_CALLS_CLOSE = "</｜DSML｜tool_calls>";
export const DSML_INVOKE_OPEN = "<｜DSML｜invoke name=\"...\">";
export const DSML_INVOKE_CLOSE = "</｜DSML｜invoke>";
export const DSML_PARAM_OPEN = "<｜DSML｜parameter name=\"...\" string=\"true\">";
export const DSML_PARAM_CLOSE = "</｜DSML｜parameter>";
export const THOUGHT_OPEN = "<thought>";
export const THOUGHT_CLOSE = "</thought>";

/** 是否切 DSML 模式（仅 deepseek-v4 且工具列表含大参数写文件类工具）。 */
export function needsDsmlToolMode(model: string, toolNames: readonly string[]): boolean {
  return DSML_MODEL_PATTERN.test(model) && toolNames.some((n) => DSML_LARGE_PARAM_TOOLS.includes(n));
}

/**
 * 构造 DSML 工具说明（注入一条**额外的 system 消息**，插在首个 system 之后）。
 *
 * 为什么不用标准 `tools`：deepseek-v4 的 `tool_calls.arguments` 是一次性打包生成的，
 * 生成超大参数（如 2000 行 write）期间 SSE 静默 > 60s 会被 APIG 网关掐断
 * （`terminated`）；DSML 走 `delta.content` 流式通道，实测 1000 行 write 全程
 * 最大静默仅 204ms。这也是本渠道**唯一**的「工具形态」分叉。
 */
export function buildDsmlSystemPrompt(
  tools: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }>,
): string {
  const schemas = tools
    .map((tool) => JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }))
    .join("\n");
  return [
    "你可以调用工具。工具调用的输出格式（必须严格遵守）：",
    `${DSML_TOOL_CALLS_OPEN}`,
    `<｜DSML｜invoke name="工具名">`,
    '<｜DSML｜parameter name="参数名" string="true">参数值</｜DSML｜parameter>',
    "</｜DSML｜invoke>",
    `${DSML_TOOL_CALLS_CLOSE}`,
    "思考过程请放在 <thought> 与 </thought> 之间，不要写进正文。",
    "可用工具：",
    schemas,
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 取纯文本内容：字符串原样，数组只保留 `text` 块（图片块**丢弃** —— 端点不接受）。 */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: unknown } => isRecord(block) && block["type"] === "text")
    .map((block) => String(block["text"] ?? ""))
    .join("");
}

/** 从消息里取推理内容（`reasoning_content` 字段或数组里的 `reasoning` 块）。 */
function reasoningToText(message: Record<string, unknown>): string {
  const direct = message["reasoning_content"];
  if (typeof direct === "string") return direct;
  const content = message["content"];
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: unknown } => isRecord(block) && block["type"] === "reasoning")
    .map((block) => String(block["text"] ?? ""))
    .join("");
}

/** 剔除无法配对的工具调用 / 结果（孤儿会让后端对之后每条消息都 400）。 */
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
 * 把下游 OpenAI 消息改写为 CodeArts 的传输格式。
 *
 * ⚠️ **assistant 的 `reasoning_content` 恒带**（无推理时空串）：deepseek-v4 系
 * 对缺失该字段的历史直接 400 `Missing reasoning_content field`。
 * 图片块被丢弃（端点只接受文本——与 buddy / lobsterai 不同，那两个渠道必须
 * 显式报错或转 image_url）。
 */
export function serializeMessages(messages: readonly unknown[]): Array<Record<string, unknown>> {
  const records = messages.filter(isRecord);
  const { keepCallIds, keepResultIds } = resolveToolPairing(records);
  const wire: Array<Record<string, unknown>> = [];
  for (const message of records) {
    const role = message["role"];
    if (role === "assistant") {
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
                typeof fn["arguments"] === "string"
                  ? fn["arguments"]
                  : JSON.stringify(fn["arguments"] ?? {}),
            },
          });
        }
      }
      const out: Record<string, unknown> = {
        role: "assistant",
        content: contentToText(message["content"]),
        // 恒带（可为空串）：缺失会让后端对之后每条消息报
        // "Missing `reasoning_content` field"。
        reasoning_content: reasoningToText(message),
      };
      if (toolCalls.length > 0) out["tool_calls"] = toolCalls;
      wire.push(out);
      continue;
    }
    if (role === "system") {
      wire.push({ role: "system", content: contentToText(message["content"]) });
      continue;
    }
    if (role === "tool") {
      const id = typeof message["tool_call_id"] === "string" ? message["tool_call_id"] : "";
      if (!id || !keepResultIds.has(id)) continue;
      wire.push({
        role: "tool",
        tool_call_id: id,
        content: contentToText(message["content"]) || "(no output)",
      });
      continue;
    }
    // user（及其它角色）：纯文本。
    if (role === "user" || role === undefined) {
      wire.push({ role: "user", content: contentToText(message["content"]) });
      continue;
    }
    wire.push({ role: String(role), content: contentToText(message["content"]) });
  }
  return wire;
}

/**
 * 本请求的 chat/session id 派生。
 *
 * 官方 IDE 用「每次会话生成一个 32 hex 的 Session-Id」并把同一个值同时用于
 * `prompt_cache_key`（前缀缓存命中依据）、`Chat-Id`、`Session-Id` 头。
 * 共享网关没有「会话」概念（每个请求都是独立 HTTP 调用），故这里**按
 * 对话首条 user 文本 + 模型名派生**：同一条对话的后续请求得到同一个值
 * （前缀缓存能命中），不同对话得到不同的值。
 */
export function deriveSessionKey(model: string, messages: readonly unknown[]): string {
  let firstUser = "";
  for (const message of messages) {
    if (!isRecord(message) || message["role"] !== "user") continue;
    firstUser = contentToText(message["content"]);
    if (firstUser) break;
  }
  const seed = firstUser ? `${model}\u0000${firstUser}` : `${model}\u0000${Math.random()}`;
  return sha256Hex(seed).slice(0, 32);
}

/** 本次 chat 请求的待签名载荷（`buildChatBody` → `buildHeaders` 之间的传递槽）。 */
interface PendingChat {
  payloadJson: string;
  sessionKey: string;
  model: string;
  benefit: boolean;
}

let pendingChat: PendingChat | null = null;

/** 仅供测试：读取/清空 pending 槽。 */
export function peekPendingChat(): PendingChat | null {
  return pendingChat;
}

/**
 * 把下游 OpenAI 请求改写成 CodeArts 能接受的形状。
 *
 * 顶层键（PROTOCOL §3.1）：`model` / `messages` / `stream: true` /
 * `prompt_cache_key` / `include` / `reasoning_summary` / `thinking`（仅关闭时） /
 * `tool_stream: true` / `max_tokens`（默认 65536）/ `tools`（仅非空且非 DSML）。
 *
 * ⚠️ 这里还会把「本次请求的规范化 body + session key」存进 pending 槽，
 * 供同步的 `buildHeaders()` 计算 `x-sdk-content-sha256` 用（见文件头说明）。
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...req, model: upstreamModel };
  body["stream"] = true;

  const messages = Array.isArray(body["messages"]) ? [...(body["messages"] as unknown[])] : [];
  const system = body["system"];
  delete body["system"];
  if (typeof system === "string" && system.length > 0) {
    messages.unshift({ role: "system", content: system });
  }
  const wireMessages = serializeMessages(messages);

  const sessionKey = deriveSessionKey(upstreamModel, messages);

  // tools：DSML 模式下**不发**（工具说明改注入 system）。
  const rawTools = Array.isArray(body["tools"]) ? (body["tools"] as unknown[]) : [];
  const tools = rawTools
    .filter(isRecord)
    .map((tool) => {
      const fn = isRecord(tool["function"]) ? tool["function"] : {};
      return {
        type: "function" as const,
        function: {
          name: String(fn["name"] ?? ""),
          description: String(fn["description"] ?? ""),
          parameters: isRecord(fn["parameters"]) ? fn["parameters"] : {},
        },
      };
    })
    .filter((tool) => tool.function.name.length > 0);

  let wireTools = tools;
  if (needsDsmlToolMode(upstreamModel, tools.map((t) => t.function.name))) {
    const insertAt = wireMessages.findIndex((m) => m["role"] === "system") + 1;
    wireMessages.splice(insertAt, 0, {
      role: "system",
      content: buildDsmlSystemPrompt(tools.map((t) => t.function)),
    });
    wireTools = [];
  }

  const effort = body["reasoning_effort"];
  const out: Record<string, unknown> = {
    model: upstreamModel,
    messages: wireMessages,
    stream: true,
    // prompt_cache_key 让服务端启用前缀缓存并在 usage 里返回 cached_tokens，
    // 缺失时缓存命中恒为 0（实测 2026-08-24）。
    prompt_cache_key: sessionKey,
    // include / reasoning_summary 对齐真实 IDE 的额外字段。
    include: ["reasoning.encrypted_content"],
    reasoning_summary: "auto",
    // 思考开关：唯一生效的是**顶层** thinking（`reasoning_effort` 与嵌套
    // `reasoning.effort` 都被接受但完全无效）；`enabled` 与不传等价，故只在
    // 关闭时发。
    ...(effort === "off" ? { thinking: { type: "disabled" } } : {}),
    // 让后端把超大工具参数分段流式传输，避免单个 SSE 事件过大被掐断。
    tool_stream: true,
    // 实测 65536 可用、131072 触发空流被拒；显式传入优先。
    max_tokens: typeof req["max_tokens"] === "number" ? req["max_tokens"] : DEFAULT_MAX_TOKENS,
  };
  if (wireTools.length > 0) out["tools"] = wireTools;

  const payloadJson = JSON.stringify(out);
  pendingChat = {
    payloadJson,
    sessionKey,
    model: upstreamModel,
    benefit: catalog.isBenefitModel(upstreamModel),
  };
  return out;
}

/**
 * 构造 chat 请求头（**签名头 + Chat-Id/Session-Id/lang**）。
 *
 * 注意 `Agent-Type` / `X-Language` **不在** chat 头里（chat 端点本来就不需要），
 * 而签名的 `maas_type`（benefit 模型）必须随请求发出。
 *
 * `dropBenefit` 供调用方在收到 `InferHub.4004.200` 时去掉该头重试一次
 * ——共享网关没有这个重试钩子，故默认保留；该选项留给外部/未来接线。
 */
export function buildHeaders(
  credential: AuthLike,
  options: { dropBenefit?: boolean } = {},
): Record<string, string> {
  const { ak, sk, st } = credentialParts(credential);
  const pending = pendingChat;
  const body = pending?.payloadJson ?? "";
  const benefit = (pending?.benefit ?? false) && !options.dropBenefit;
  const signed = signRequest({
    method: "POST",
    url: chatUrl(),
    body,
    ak,
    sk,
    securityToken: st,
    ...(benefit ? { extraSignedHeaders: { maas_type: "benefit" } } : {}),
  });
  const headers = withoutHost(signed);
  headers["Content-Type"] = "application/json";
  const sessionKey = pending?.sessionKey ?? deriveSessionKey("", []);
  headers["Chat-Id"] = sessionKey;
  headers["Session-Id"] = sessionKey;
  headers["lang"] = "en";
  return headers;
}

// ── 模型目录拉取 ─────────────────────────────────────────────────────────────

function isRecordArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** 签名 GET（`Agent-Type` / `X-Language` 在**签名之后**追加，绝不参与签名）。 */
async function signedGet(
  url: string,
  credential: AuthLike,
  extraUnsignedHeaders?: Readonly<Record<string, string>>,
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<Record<string, unknown> | null> {
  const { ak, sk, st } = credentialParts(credential);
  const headers = withoutHost(signRequest({ method: "GET", url, ak, sk, securityToken: st }));
  if (extraUnsignedHeaders) Object.assign(headers, extraUnsignedHeaders);
  let resp: Response;
  try {
    resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized(`upstream rejected the credential (HTTP ${resp.status})`);
  }
  if (!resp.ok) return null;
  try {
    const body = (await resp.json()) as unknown;
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * 拉取模型目录：opengw `gateway/config`（benefit 模型）+ snap `/v1/model/builtin`
 * （常规模型），合并去重后灌入缓存并返回。
 *
 * benefit 集合**只记录归一化未改写的 id**：带日期后缀（`-0731`）与无后缀在后端
 * 是**两个不同模型、benefit 属性相反**，记录改写后的 id 会把无后缀模型误标。
 */
export async function fetchModels(
  credential: AuthLike,
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const [cfg] = loadConfig();
  const entries: catalog.ModelEntry[] = [];
  const seen = new Set<string>();
  const benefitIds: string[] = [];

  const gateway = await signedGet(opengwConfigUrl(), credential, undefined, timeoutMs);
  if (gateway) {
    const result = gateway["result"];
    const models = isRecord(result) ? result["models"] : null;
    if (isRecordArray(models)) {
      for (const row of models) {
        if (!isRecord(row)) continue;
        const rawId = typeof row["model_id"] === "string" ? row["model_id"] : "";
        for (const entry of catalog.parseModelRows([row], seen, "remote")) {
          // 仅当归一化未改写时才记为 benefit（见函数注释）。
          if (rawId && catalog.normalizeModelId(rawId) === rawId) benefitIds.push(entry.id);
          entries.push(entry);
        }
      }
    }
  }

  const builtin = await signedGet(
    modelsUrl(cfg),
    credential,
    {
      "Content-Type": "application/json",
      // ⚠️ 这两个头在签名之后追加（进签名会 401 APIG.0301）。
      "Agent-Type": "PromptCenter",
      "X-Language": "zh-cn",
    },
    timeoutMs,
  );
  if (builtin) {
    const rows = builtin["builtinModels"];
    if (isRecordArray(rows)) {
      for (const row of rows) {
        if (!isRecord(row)) continue;
        entries.push(...catalog.parseModelRows([row], seen, "remote"));
      }
    }
  }

  if (entries.length > 0) catalog.setRemoteModels(entries, benefitIds);
  return { models: entries, benefitIds, baseUrl: cfg.baseUrl };
}

/** 从模型载荷推导连接配置（登录成功后由 auth-flow 调用）。 */
export function resolveConfig(data: Record<string, unknown>, fallback?: Config): Config {
  const cfg: Config = { ...(fallback ?? defaultConfig()) };
  const baseUrl = data["baseUrl"];
  if (typeof baseUrl === "string" && baseUrl) cfg.baseUrl = baseUrl;
  return cfg;
}

// ── 错误分类（顺序即优先级）──────────────────────────────────────────────────

/** 流内 / HTTP 错误类别。 */
export type FailureKind =
  | "quota-exhausted"
  | "queue-retry"
  | "benefit-missing"
  | "auth"
  | "rate-limit"
  | "context-window"
  | "invalid-request"
  | "server"
  | "unknown";

/**
 * 额度用尽判据（**不可重试**，标账号受限 + 换号）。
 *
 * `InferHub.4291.200` 这类额度码必须靠 `includes('4291')` 命中，
 * 而**不能**被下面的 429 边界正则误判成排队。
 */
export function isQuotaExhaustedError(errorCode: string, message: string): boolean {
  return errorCode.includes("4291") || /insufficient[\s_-]+quota/i.test(message);
}

/**
 * 可重试的排队 / 限流判据。
 *
 * ⚠️ **`429` 必须锚定为独立数字**：无边界子串会让额度码 `InferHub.4291.200`
 * 命中 `429` 前缀而被误判成「可重试排队」，进入 30 分钟静默重试、界面零输出
 * （真实缺陷，2026-10-02 实测 25 秒内 4 次 chat + 3 次探测、产出 0 chunk）。
 */
export function isQueueRetryableError(status: number, body: string): boolean {
  if (status === 404 && /InferHub\.002002009\.404|not registered/i.test(body)) return false;
  return (
    body.includes("TM.00001041") ||
    /81111|TPM|(^|[^0-9])429([^0-9]|$)|rate.?limit|too many requests|排队|限流/i.test(body)
  );
}

/** 该账号没有 benefit 包（去掉 `maas_type` 头重试一次即可）。 */
export function isBenefitNotFoundError(errorCode: string): boolean {
  return errorCode === BENEFIT_NOT_FOUND_ERROR_CODE;
}

/** 鉴权类错误：401/403，或 body 里的 APIG.0602 / token 失效措辞。 */
export function isAuthError(status: number, body: string): boolean {
  if (status === 401 || status === 403) return true;
  return (
    body.includes("APIG.0602") ||
    /invalid token|token expired|token is invalid/i.test(body)
  );
}

/** 上下文超限措辞（400 的两个分支靠它区分）。 */
export function isContextWindowError(body: string): boolean {
  return /context|token.{0,20}(limit|length|exceed)|max.{0,10}tokens|too long/i.test(body);
}

/**
 * 判定**流内错误帧**（HTTP 200 + `error_code`/`error_msg`）。
 *
 * 优先级不可颠倒（`llm-adapter.ts:1642-1662`）：
 * 额度用尽 → 排队/限流 → benefit 缺失 → 其它（INVALID_REQUEST）。
 */
export function classifyStreamError(errorCode: string, message: string): FailureKind {
  if (isQuotaExhaustedError(errorCode, message)) return "quota-exhausted";
  if (isQueueRetryableError(200, `${errorCode} ${message}`)) return "queue-retry";
  if (isBenefitNotFoundError(errorCode)) return "benefit-missing";
  return "invalid-request";
}

/**
 * 判定 HTTP 非 2xx（PROTOCOL §4.2）。
 *
 * 401/403 → auth（先 refresh 一次再重试）；429 → rate-limit；
 * 400 → context-window（命中上下文超限措辞）否则 invalid-request；
 * ≥500 → server；其它 → unknown。
 */
export function classifyHttpError(status: number, body: string): FailureKind {
  if (isAuthError(status, body)) return "auth";
  if (status === 429) return "rate-limit";
  if (status === 400) return isContextWindowError(body) ? "context-window" : "invalid-request";
  if (status >= 500) return "server";
  return "unknown";
}

// ── 流翻译器（契约要求所有渠道都导出）────────────────────────────────────────

export interface StreamTranslator {
  feed(chunk: Buffer): Array<Buffer | string>;
  finish(): Array<Buffer | string>;
}

/**
 * 恒等翻译器。
 *
 * CodeArts 是 `openai` 线型（`sse-stream.relay()` 直接规范化透传），
 * 网关不会调用本函数；提供它是为了满足契约。
 */
export function newTranslator(): StreamTranslator {
  return { feed: (chunk: Buffer) => [chunk], finish: () => [] };
}
