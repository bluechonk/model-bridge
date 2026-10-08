/**
 * Gemini Code Assist（Google Cloud Code）上游：端点、请求头、Cloud Code 信封、
 * 工具 schema 清洗、会话 id 派生与 **Gemini SSE → OpenAI delta 的增量翻译**。
 *
 * ## 本模块承载的渠道知识（每条都有依据，见 docs/protocols/gemini/PROTOCOL.md）
 *
 * 1. **端点（§1）**：`GEMINI_ENDPOINT_DAILY` / `GEMINI_ENDPOINT_SANDBOX`，
 *    推理走 `{endpoint}/v1internal:streamGenerateContent?alt=sse`；
 *    `loadCodeAssist` 与 `retrieveUserQuotaSummary` **固定走 sandbox**。
 *    源码中**不存在 prod 端点**（已检索确认）。
 * 2. **请求头（§2.7）**：`Authorization: Bearer` + `Content-Type` + **身份五头逐字写死**；
 *    **不加** `x-goog-api-key` / `x-goog-api-client`；流式请求刻意不带 `Accept`。
 *    ⚠ 共享网关会按契约给缺 `Accept` 的请求补 `Accept: text/event-stream` —— 这是
 *    共享层的统一行为（所有 custom 渠道一致），渠道层无从拦截；上游接受有/无 `Accept`，
 *    故不构成兼容问题。
 * 3. **信封（§3.1）**：`{model, project, request:{contents, systemInstruction, tools,
 *    toolConfig, generationConfig, sessionId}, requestId, userAgent}`。
 * 4. **三条上游对齐细节（§3.2）**：身份五头逐字、流式不带 `Accept`、
 *    **信封逐层字母序序列化**（`sortedStringify`）。后者通过 `deepSorted()` 让
 *    `buildChatBody()` 返回的对象**键序即字母序**实现 —— 共享网关用
 *    `JSON.stringify` 序列化，键序即插入序，故等价于递归排序（数组保序）。
 * 5. **模型名是准入钥匙（§3.4）**：上游模型名 = `gemini-3.8-flash-<tier>`，
 *    发裸 `gemini-3.8-flash` 上游 404。档位 budget：low=1000 / medium=4000 /
 *    high=10000 / tiered=只发 includeThoughts；`includeThoughts` 恒 true。
 * 6. **sessionId 是派生值（§3.3）**：`f(project, contents[0].text, lane)`。
 *    ⚠ 原版哈希本体**尚未反推出来**（已否证 50+ 种）—— 本实现对齐的是**依赖维度**
 *    与「同输入同输出」，取值为 FNV-1a 64 位（有符号十进制串），**不与原版逐字相同**。
 * 7. **流式响应是 Gemini 自有格式（§4）**：每帧 `{"response":{...}}` 或裸 `Response`；
 *    **只有 `candidates` 非空才算内容帧**；结束 `data: [DONE]`；思考 part 的签名
 *    **刻意不存**；工具调用**独占一个块**。
 */

import { randomBytes } from "node:crypto";

import { ensureDir, login as sharedLogin, upstreamPath } from "@model-bridge/gateway";
import { readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";

/** 轮换端点（§1.1：`prod` 不存在，只有 daily 与 sandbox）。 */
export const GEMINI_ENDPOINT_DAILY = "https://daily-cloudcode-pa.googleapis.com";
export const GEMINI_ENDPOINT_SANDBOX = "https://daily-cloudcode-pa.sandbox.googleapis.com";

/** 默认推理端点（`GEMINI_ENDPOINT` 可覆盖，便携/测试用）。 */
export const DEFAULT_BASE_URL = GEMINI_ENDPOINT_DAILY;

/** 展示名（状态页与错误文案用）。 */
export const DISPLAY_NAME = "Gemini Code Assist";

/**
 * 上游线型是**自定义（Gemini 自有 SSE）**：网关必须走 `newTranslator()` 增量翻译。
 */
export const WIRE: "openai" | "custom" = "custom";

/** 推理路径（流式；非流式常量在源码中**全仓无引用**，故不实现）。 */
export const INFER_PATH = "/v1internal:streamGenerateContent?alt=sse";
/** 账号档位 / project 探测路径（固定 sandbox）。 */
export const LOAD_CODE_ASSIST_PATH = "/v1internal:loadCodeAssist";
/** 配额路径（固定 sandbox）。 */
export const QUOTA_PATH = "/v1internal:retrieveUserQuotaSummary";

/** 免费档账号 LCA 返回空 project 时的兜底串（§8.1）。 */
export const GEMINI_DEFAULT_PROJECT = "aicode-consumers";

/** 上游裸模型 id（不带档位后缀；带档位才是准入钥匙，§3.4）。 */
export const GEMINI_UPSTREAM_FLASH = "gemini-3.8-flash";

/** maxOutputTokens 缺省（§3.4）。 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

/** 默认温度（信封样例值）。 */
export const DEFAULT_TEMPERATURE = 0.7;

/** 推理超时（§1.2：推理 120s）。 */
export const INFER_TIMEOUT_MS = 120_000;
/** 探测 / 配额超时（§1.2：配额 30s）。 */
export const PROBE_TIMEOUT_MS = 30_000;

/** 请求体上限 64 MiB（§3.7，发送前真实检查）。 */
export const MAX_REQUEST_BYTES = 64 << 20;
/** 单张图片上限 10 MiB（§3.7）。 */
export const MAX_IMAGE_BYTES = 10 << 20;

/** 身份五头（逐字常量，**不许随机**，§2.7）。 */
export const IDENTITY_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": "antigravity/4.3.0 (cmdc-pak)",
  "x-client-name": "antigravity",
  "x-client-version": "4.3.0",
  "x-machine-id": "cmdc-pak",
  "x-vscode-sessionid": "proxy",
};

/** 信封里的 `userAgent` 字段值（§2.7）。 */
export const ENVELOPE_USER_AGENT = "antigravity";

/** 工具 schema 白名单键（§3.5，白名单外**整键删除**）。 */
export const GEMINI_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
  "items",
  "minItems",
  "maxItems",
  "properties",
  "required",
  "minProperties",
  "maxProperties",
  "minLength",
  "maxLength",
  "pattern",
  "anyOf",
  "propertyOrdering",
  "minimum",
  "maximum",
]);

/** 档位预算（§3.4：tiered 只发 includeThoughts，不发 thinkingBudget）。 */
export const EFFORT_BUDGETS: Readonly<Record<string, number | null>> = {
  low: 1000,
  medium: 4000,
  high: 10000,
  tiered: null,
};

/** 已知档位后缀（§5：模型 id 归一时剥掉）。 */
export const TIER_SUFFIXES: readonly string[] = ["low", "medium", "high", "tiered"];

/** 上游 API 拒绝了访问令牌（HTTP 401/403）。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

/**
 * 请求体把单次上下文撑过窗口（§4.5）。
 *
 * ⚠ 归错码代价不对称：归成 `INVALID_REQUEST` 就**连一次压缩的机会都没有**。
 */
export class ContextWindowExceeded extends Error {
  override name = "ContextWindowExceeded";
}

export interface Config {
  baseUrl: string;
  /** 探测到的 Google Cloud 项目（缺失时上游回落 `aicode-consumers`）。 */
  project: string;
}

/** 凭据的最小面（避免 upstream ↔ cred 循环依赖）。 */
export interface AuthLike {
  accessToken: string;
  uid?: string;
  email?: string;
  domain?: string;
  cloudaicompanionProject?: string;
}

/** 推理端点基址（`GEMINI_ENDPOINT` 可覆盖）。 */
export function defaultEndpoint(): string {
  const override = process.env["GEMINI_ENDPOINT"];
  return override && override.trim() ? override.trim().replace(/\/+$/, "") : GEMINI_ENDPOINT_DAILY;
}

/** sandbox 端点基址（`GEMINI_SANDBOX_ENDPOINT` 可覆盖）。 */
export function sandboxEndpoint(): string {
  const override = process.env["GEMINI_SANDBOX_ENDPOINT"];
  return override && override.trim()
    ? override.trim().replace(/\/+$/, "")
    : GEMINI_ENDPOINT_SANDBOX;
}

export function defaultConfig(): Config {
  return { baseUrl: defaultEndpoint(), project: GEMINI_DEFAULT_PROJECT };
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** 读取已解析的上游描述符（`[配置, 是否来自磁盘]`）。 */
export function loadConfig(): [Config, boolean] {
  let raw: string;
  try {
    raw = readFileSync(upstreamPath(), "utf8");
  } catch {
    return [defaultConfig(), false];
  }
  let parsed: Record<string, unknown> = {};
  try {
    const data: unknown = JSON.parse(raw);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      parsed = data as Record<string, unknown>;
    }
  } catch {
    return [defaultConfig(), false];
  }
  const fallback = defaultConfig();
  return [
    {
      baseUrl: nonEmpty(parsed["baseUrl"]) ?? fallback.baseUrl,
      project: nonEmpty(parsed["project"]) ?? fallback.project,
    },
    true,
  ];
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

/** 完整限定的流式推理 URL。 */
export function chatUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return trimSlash(resolved.baseUrl) + INFER_PATH;
}

/** 账号档位 / project 探测 URL（**固定 sandbox**，§1.1 路由特例）。 */
export function loadCodeAssistUrl(): string {
  return sandboxEndpoint() + LOAD_CODE_ASSIST_PATH;
}

/** 配额查询 URL（**固定 sandbox**，§1.1 路由特例）。 */
export function quotaUrl(): string {
  return sandboxEndpoint() + QUOTA_PATH;
}

/** 「模型列表」URL：Cloud Code 无模型列表端点，用 loadCodeAssist 做凭据有效性探测。 */
export function modelsUrl(_cfg?: Config): string {
  return loadCodeAssistUrl();
}

/** 从 URL 取主机名（转发共享层原语）。 */
export function hostOf(url: string): string {
  return sharedLogin.hostOf(url);
}

/**
 * 构造上游请求头（鉴权 + 身份五头逐字写死）。
 *
 * ⚠ **不加** `x-goog-api-key` / `x-goog-api-client`（原版不带）；
 * ⚠ 本函数不设 `Accept`（流式刻意不带；共享网关会按契约补上，见文件头说明）。
 */
export function buildHeaders(credential: AuthLike): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.accessToken}`,
    "Content-Type": "application/json",
    ...IDENTITY_HEADERS,
  };
}

// ── 会话 id 派生（§3.3）──────────────────────────────────────────────────────

/**
 * 会话代数（升代自愈，§3.3）。
 *
 * 上游按 sessionId 在服务端累计对话输入，长工具循环把累计推过 1M 后该 sessionId
 * 的每个请求都 400；升一代 = 换全新 sessionId = 上游开新会话。
 * ⚠ `generation === 0` 时不把代数拼进输入。
 */
let sessionGeneration = 0;

/** 当前会话代数。 */
export function currentGeneration(): number {
  return sessionGeneration;
}

/** 升一代（会话溢出自愈时调用）。 */
export function bumpGeneration(): number {
  sessionGeneration += 1;
  return sessionGeneration;
}

/** 设定代数（测试用）。 */
export function setGeneration(value: number): void {
  sessionGeneration = Math.max(0, Math.trunc(value));
}

/**
 * FNV-1a 64 位哈希，按**有符号** 64 位解释后转十进制串。
 *
 * ⚠ 原版哈希本体尚未反推出来；本实现对齐的是依赖维度与「同输入同输出」，
 * 取值**不与原版逐字相同**（§3.3 已明确）。
 */
export function fnv1a64Signed(input: string): string {
  const MASK64 = 0xffffffffffffffffn;
  const PRIME = 0x100000001b3n;
  let hash = 0xcbf29ce484222325n;
  const bytes = Buffer.from(input, "utf8");
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * PRIME) & MASK64;
  }
  // 有符号 64 位解释
  const signed = hash >= 0x8000000000000000n ? hash - 0x10000000000000000n : hash;
  return signed.toString(10);
}

/**
 * 派生 sessionId：`f(project, firstUserText, lane)`（+ 升代时追加 generation）。
 *
 * ⚠ **不吃** model / maxOutputTokens / systemInstruction / 对话轮数 / 后续文本。
 */
export function deriveGeminiSessionId(
  project: string,
  firstUserText: string,
  lane = "infer",
  generation = sessionGeneration,
): string {
  let input = `${project}\u0000${lane}\u0000${firstUserText}`;
  if (generation > 0) input += `\u0000${generation}`; // 0 代不拼接（否则升级功能本身换一次 sessionId）
  return fnv1a64Signed(input);
}

/** `requestId`：`agent/<毫秒时间戳>/<8 hex>`（§3.1）。 */
export function makeRequestId(nowMs = Date.now()): string {
  return `agent/${nowMs}/${randomBytes(4).toString("hex")}`;
}

// ── 信封序列化（逐层字母序，§3.2）────────────────────────────────────────────

/**
 * 递归把对象的键按字母序重排（数组保序）—— 等价于 Go 的 `marshalAlphabetical`。
 *
 * `JSON.stringify` 按 own property 插入序输出，故重排后的对象经共享网关序列化即
 * 得到**字母序字节**（无需改共享层）。
 */
export function deepSorted<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => deepSorted(v)) as unknown as T;
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = deepSorted(src[key]);
    return out as unknown as T;
  }
  return value;
}

/** 字母序 JSON 字符串（供调试/测试对照；`buildChatBody` 返回的即等价对象）。 */
export function sortedStringify(value: unknown): string {
  return JSON.stringify(deepSorted(value));
}

// ── 工具 schema 清洗（§3.5）──────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 清洗 Gemini 工具的 JSON schema（§3.5）。
 *
 * 三条规则：白名单外删除；`properties`/`items`/`anyOf` 递归；
 * `type` 为数组形态 → 收敛成单个 type 并补 `nullable:true`；`enum` 含非字符串值 → 整删。
 */
export function sanitizeGeminiSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) return {};
  const out: Record<string, unknown> = {};
  let nullableFromUnion = false;

  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue; // 白名单外整键删除（上游对未知键硬 400）

    if (key === "type") {
      if (Array.isArray(value)) {
        // 数组形态收敛成单个 type 并补 nullable:true
        const first = value.find((t) => typeof t === "string" && t !== "null");
        const chosen = typeof first === "string" ? first : "string";
        out["type"] = chosen;
        if (value.some((t) => t === "null")) nullableFromUnion = true;
        continue;
      }
      if (typeof value === "string") out["type"] = value;
      continue;
    }

    if (key === "enum") {
      // enum 含任何非字符串值就整删
      if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
        out["enum"] = value;
      }
      continue;
    }

    if (key === "properties") {
      if (isRecord(value)) {
        const props: Record<string, unknown> = {};
        for (const [name, sub] of Object.entries(value)) {
          props[name] = sanitizeGeminiSchema(sub);
        }
        out["properties"] = props;
      }
      continue;
    }

    if (key === "items") {
      // items 可能是对象或数组
      if (Array.isArray(value)) out["items"] = value.map((v) => sanitizeGeminiSchema(v));
      else if (isRecord(value)) out["items"] = sanitizeGeminiSchema(value);
      continue;
    }

    if (key === "anyOf") {
      if (Array.isArray(value)) out["anyOf"] = value.map((v) => sanitizeGeminiSchema(v));
      continue;
    }

    out[key] = value;
  }

  if (nullableFromUnion && out["nullable"] === undefined) out["nullable"] = true;
  return out;
}

// ── 请求体改写：OpenAI → Cloud Code 信封（§3）────────────────────────────────

function isImagePart(part: Record<string, unknown>): { mimeType: string; data: string } | null {
  const imageUrl = part["image_url"];
  const url = isRecord(imageUrl) ? nonEmpty(imageUrl["url"]) : null;
  if (!url || !url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const header = url.slice(5, comma);
  const [mediaType, encoding] = header.split(";");
  if (encoding !== "base64" || !mediaType) return null;
  const data = url.slice(comma + 1);
  return { mimeType: mediaType, data };
}

/** 从 `data:` URL 提 base64（估计字节数用于 10 MiB 上限检查）。 */
function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/** 把一段 content 转成 Gemini parts（text / inlineData）。 */
function toParts(content: unknown): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (typeof content === "string") {
    if (content) parts.push({ text: content });
    return parts;
  }
  if (!Array.isArray(content)) {
    if (content !== null && content !== undefined) parts.push({ text: String(content) });
    return parts;
  }
  for (const raw of content) {
    if (!isRecord(raw)) continue;
    const type = raw["type"];
    if (type === "text" || type === "input_text" || type === "output_text") {
      const text = raw["text"];
      if (typeof text === "string" && text) parts.push({ text });
      continue;
    }
    if (type === "image_url") {
      const image = isImagePart(raw);
      if (!image) throw new Error("图片内联失败（image_url 不是 base64 的 data: URL）");
      if (base64Bytes(image.data) > MAX_IMAGE_BYTES) {
        throw new ContextWindowExceeded("单张图片超过 10 MiB 上限");
      }
      parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
      continue;
    }
  }
  return parts;
}

/** 扫描全消息建 `tool_use.id → name` 映射（上游按 name 而非 id 配对，§3.6）。 */
function toolNameMap(messages: unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (!isRecord(msg)) continue;
    const calls = msg["tool_calls"];
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (!isRecord(call)) continue;
      const id = nonEmpty(call["id"]);
      const fn = isRecord(call["function"]) ? call["function"] : null;
      const name = nonEmpty(fn?.["name"]);
      if (id && name) map.set(id, name);
    }
  }
  return map;
}

/** 一条 tool 消息 → 一个 `functionResponse` user part；name 为空返回 null（整块丢弃）。 */
function toolResultPart(
  rec: Record<string, unknown>,
  names: Map<string, string>,
): Record<string, unknown> | null {
  const id = typeof rec["tool_call_id"] === "string" ? rec["tool_call_id"] : "";
  const name = names.get(id) ?? "";
  if (!name) return null; // name 为空时整块丢弃
  const content = rec["content"];
  let text = "";
  if (typeof content === "string") text = content;
  else if (content !== null && content !== undefined) text = JSON.stringify(content);
  const response: Record<string, unknown> = { content: text };
  if (rec["error"] === true || rec["is_error"] === true) response["error"] = true;
  return { functionResponse: { name, response } };
}

interface ContentsBuild {
  contents: Array<Record<string, unknown>>;
  systemInstruction: Record<string, unknown> | null;
}

/** 把 OpenAI messages 转成 Gemini contents + systemInstruction（role 只有 user/model）。 */
function toGeminiContents(messages: unknown[]): ContentsBuild {
  const contents: Array<Record<string, unknown>> = [];
  const systemParts: Array<Record<string, unknown>> = [];
  const names = toolNameMap(messages);

  const pushTurn = (role: string, parts: Array<Record<string, unknown>>): void => {
    if (parts.length === 0) return;
    const last = contents[contents.length - 1];
    // 连续的 functionResponse 合并进前一条 user turn（与上游一致的填充形态）
    if (last && last["role"] === "user" && role === "user" && isFunctionResponseOnly(parts)) {
      (last["parts"] as Array<Record<string, unknown>>).push(...parts);
      return;
    }
    contents.push({ role, parts });
  };

  for (const msg of messages) {
    if (!isRecord(msg)) continue;
    const role = msg["role"];
    if (role === "system" || role === "developer") {
      systemParts.push(...toParts(msg["content"]));
      continue;
    }
    if (role === "tool" || role === "function") {
      const part = toolResultPart(msg, names);
      if (part) pushTurn("user", [part]);
      continue;
    }
    if (role === "assistant") {
      const parts = toParts(msg["content"]);
      const calls = msg["tool_calls"];
      if (Array.isArray(calls)) {
        for (const call of calls) {
          if (!isRecord(call)) continue;
          const fn = isRecord(call["function"]) ? call["function"] : null;
          const name = nonEmpty(fn?.["name"]);
          if (!name) continue; // 无 name 的调用无法表达为 functionCall，剔除
          let args: unknown = {};
          const rawArgs = fn?.["arguments"];
          if (typeof rawArgs === "string" && rawArgs.trim()) {
            try {
              args = JSON.parse(rawArgs);
            } catch {
              args = {}; // 参数不是合法 JSON（流式半截）时给空对象
            }
          } else if (isRecord(rawArgs)) {
            args = rawArgs;
          }
          parts.push({ functionCall: { name, args } });
        }
      }
      pushTurn("model", parts);
      continue;
    }
    pushTurn("user", toParts(msg["content"]));
  }

  return {
    contents,
    systemInstruction: systemParts.length > 0 ? { role: "system", parts: systemParts } : null,
  };
}

function isFunctionResponseOnly(parts: Array<Record<string, unknown>>): boolean {
  return parts.length > 0 && parts.every((p) => isRecord(p["functionResponse"]));
}

/** `contents[0]` 里首个非空文本 part（§3.3）。 */
export function geminiFirstUserText(contents: Array<Record<string, unknown>>): string {
  const first = contents[0];
  if (!first) return "";
  const role = first["role"];
  if (role !== "" && role !== "user" && role !== undefined) return "";
  const parts = first["parts"];
  if (!Array.isArray(parts)) return "";
  for (const part of parts) {
    if (isRecord(part) && typeof part["text"] === "string" && part["text"]) return part["text"];
  }
  return "";
}

/** 剥掉已知档位后缀（§5 模型 id 归一）。 */
export function stripTierSuffix(model: string): string {
  for (const tier of TIER_SUFFIXES) {
    if (model.endsWith(`-${tier}`)) return model.slice(0, -(tier.length + 1));
  }
  return model;
}

/** 档位归一：未知 / 缺省一律 `medium`（§3.4）。 */
export function normalizeEffort(value: unknown): string {
  if (typeof value === "string" && value in EFFORT_BUDGETS) return value;
  return "medium";
}

/** 上游模型名 = 裸名 + `-<tier>`（模型名是准入钥匙，§3.4）。 */
export function applyTier(model: string, tier: string): string {
  return `${stripTierSuffix(model)}-${tier}`;
}

/** OpenAI tools → Gemini functionDeclarations；tool_choice → functionCallingConfig。 */
function toGeminiTools(
  req: Record<string, unknown>,
): { tools: Array<Record<string, unknown>> | null; toolConfig: Record<string, unknown> | null } {
  const raw = Array.isArray(req["tools"]) ? req["tools"] : Array.isArray(req["functions"]) ? req["functions"] : null;
  const declarations: Array<Record<string, unknown>> = [];
  if (raw) {
    for (const item of raw) {
      if (!isRecord(item)) continue;
      const fn = isRecord(item["function"]) ? item["function"] : item;
      const name = nonEmpty(fn["name"]);
      if (!name) continue;
      const decl: Record<string, unknown> = { name };
      const description = nonEmpty(fn["description"]);
      if (description) decl["description"] = description;
      const schema = fn["parameters"] ?? fn["input_schema"];
      decl["parameters"] = sanitizeGeminiSchema(isRecord(schema) ? schema : { type: "object", properties: {} });
      declarations.push(decl);
    }
  }
  const tools = declarations.length > 0 ? [{ functionDeclarations: declarations }] : null;

  let toolConfig: Record<string, unknown> | null = null;
  const choice = req["tool_choice"];
  if (tools) {
    if (typeof choice === "string") {
      const modes: Record<string, string> = { auto: "AUTO", required: "ANY", none: "NONE" };
      const mode = modes[choice];
      if (mode) toolConfig = { functionCallingConfig: { mode } };
    } else if (isRecord(choice)) {
      const fn = isRecord(choice["function"]) ? choice["function"] : null;
      const name = nonEmpty(fn?.["name"]);
      if (name) {
        toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] } };
      }
    }
  }
  return { tools, toolConfig };
}

/**
 * 把下游 OpenAI 请求改写成 Cloud Code 信封（§3.1）。
 *
 * - `upstreamModel` 通常来自 `catalog.resolveModel()`（短名透传）；档位由
 *   `req.reasoning_effort` 决定，最终模型名 = 裸名 + `-<tier>`。
 * - `project` 取上游配置（由 `resolveConfig` 落盘），缺失回落 `aicode-consumers`。
 * - 返回对象**键序即字母序**（`deepSorted`）—— 共享网关序列化后得到字母序字节（§3.2）。
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const messages = Array.isArray(req["messages"]) ? req["messages"] : [];
  const { contents, systemInstruction } = toGeminiContents(messages);

  const cfg = loadConfig()[0];
  const project = cfg.project || GEMINI_DEFAULT_PROJECT;
  const tier = normalizeEffort(req["reasoning_effort"]);
  const model = applyTier(upstreamModel || GEMINI_UPSTREAM_FLASH, tier);

  const maxOutputTokens =
    typeof req["max_tokens"] === "number" && Number.isFinite(req["max_tokens"]) && req["max_tokens"] > 0
      ? Math.trunc(req["max_tokens"])
      : typeof req["max_completion_tokens"] === "number" && req["max_completion_tokens"] > 0
        ? Math.trunc(req["max_completion_tokens"])
        : DEFAULT_MAX_OUTPUT_TOKENS;

  // includeThoughts 恒 true（「关闭思考」是假关，§3.4）；tiered 只发 includeThoughts
  const thinkingConfig: Record<string, unknown> = { includeThoughts: true };
  const budget = EFFORT_BUDGETS[tier];
  if (typeof budget === "number") thinkingConfig["thinkingBudget"] = budget;

  const generationConfig: Record<string, unknown> = {
    maxOutputTokens,
    thinkingConfig,
  };
  if (typeof req["temperature"] === "number") generationConfig["temperature"] = req["temperature"];
  else generationConfig["temperature"] = DEFAULT_TEMPERATURE;
  if (typeof req["top_p"] === "number") generationConfig["topP"] = req["top_p"];

  const { tools, toolConfig } = toGeminiTools(req);

  const request: Record<string, unknown> = {
    contents,
    generationConfig,
    sessionId: deriveGeminiSessionId(project, geminiFirstUserText(contents), "infer"),
  };
  if (systemInstruction) request["systemInstruction"] = systemInstruction;
  if (tools) request["tools"] = tools;
  if (toolConfig) request["toolConfig"] = toolConfig;

  const envelope: Record<string, unknown> = {
    model,
    project,
    request,
    requestId: makeRequestId(),
    userAgent: ENVELOPE_USER_AGENT,
  };

  const serialized = sortedStringify(envelope);
  if (Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) {
    throw new ContextWindowExceeded(
      "请求体超过 64 MiB 上限（发送前真实检查）：归 CONTEXT_WINDOW_EXCEEDED 以触发 harness 压缩重试",
    );
  }
  return deepSorted(envelope);
}

// ── 模型载荷（凭据有效性探测 / project 探测）───────────────────────────────

/** 从 loadCodeAssist 载荷提取 project（顶层优先，再 currentTier，§8.1）。 */
export function extractProject(data: unknown): string {
  if (!isRecord(data)) return "";
  const top = nonEmpty(data["cloudaicompanionProject"]);
  if (top) return top;
  const currentTier = isRecord(data["currentTier"]) ? data["currentTier"] : null;
  return nonEmpty(currentTier?.["cloudaicompanionProject"]) ?? "";
}

/**
 * 账号档位短标签（§6.3）：含 ultra → Ultra；含 pro → Pro；含 free → Free。
 *
 * ⚠ 判据是 `paidTier`（不是 `currentTier`）；顺序有意义。
 */
export function tierLabel(paidTier: unknown): string {
  const id = isRecord(paidTier) ? `${nonEmpty(paidTier["id"]) ?? ""} ${nonEmpty(paidTier["name"]) ?? ""}` : nonEmpty(paidTier) ?? "";
  const lower = id.toLowerCase();
  if (lower.includes("ultra")) return "Ultra";
  if (lower.includes("pro")) return "Pro";
  if (lower.includes("free")) return "Free";
  return "";
}

/**
 * 凭据有效性探测：`POST loadCodeAssist`（固定 sandbox）。
 *
 * 401/403 → `UpstreamUnauthorized`；非 2xx → 普通错误。
 * 返回 `{ project, tier, raw }` 供 `resolveConfig` / 状态页使用。
 */
export async function fetchModels(
  credential: AuthLike,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  let resp: Response;
  try {
    resp = await fetch(loadCodeAssistUrl(), {
      method: "POST",
      headers: buildHeaders(credential),
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`loadCodeAssist 请求失败: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized("上游拒绝了访问令牌（HTTP 401/403）");
  }
  if (resp.status !== 200) throw new Error(`loadCodeAssist 请求失败: HTTP ${resp.status}`);
  let data: unknown;
  try {
    data = await resp.json();
  } catch (err) {
    throw new Error(`loadCodeAssist 响应不是合法 JSON: ${String(err)}`);
  }
  return {
    project: extractProject(data),
    tier: tierLabel(isRecord(data) ? data["paidTier"] : undefined),
    raw: data,
  };
}

/** 从探测载荷推导连接配置（project 可能由服务端下发）。 */
export function resolveConfig(data: Record<string, unknown>, fallback?: Config): Config {
  const cfg: Config = { ...(fallback ?? loadConfig()[0] ?? defaultConfig()) };
  const project = nonEmpty(data["project"]);
  if (project) cfg.project = project;
  // 端点由协议固定（daily 轮换 + sandbox 特例），不从载荷覆盖
  cfg.baseUrl = defaultEndpoint();
  return cfg;
}

// ── 错误分类（§4.5）─────────────────────────────────────────────────────────

/**
 * 「服务端按 sessionId 累计超 1M」判据。
 *
 * ⚠ 报文里**一个 `context` 都没有**，harness 认不出 ⇒ 需补专属判据；
 * ⚠ `isGeminiSessionOverflow` 必须**先于** `isGeminiQuotaText` 判定。
 */
export function isGeminiSessionOverflow(text: string): boolean {
  return /\btoken\s+count\b[\s\S]{0,60}?\bexceeds?\s+the\s+maximum\b/i.test(text);
}

/** 配额类文案（与 session 溢出共用同一句话，故必须后判，§4.5）。 */
export function isGeminiQuotaText(text: string): boolean {
  return /quota|rate\s*limit|resource_exhausted|RESOURCE_EXHAUSTED/i.test(text);
}

/** 是否应归 `CONTEXT_WINDOW_EXCEEDED`（交给 harness 压缩）。 */
export function isContextWindowExceeded(text: string): boolean {
  return isGeminiSessionOverflow(text);
}

// ── 流翻译：Gemini SSE → OpenAI delta（增量，§4）────────────────────────────

export interface StreamTranslator {
  /** 喂入一块字节，返回本次可产出的 OpenAI SSE 帧。 */
  feed(chunk: Buffer): Array<Buffer | string>;
  /** 流结束：处理残余、补 `finish_reason` 帧与 `data: [DONE]`。 */
  finish(): Array<Buffer | string>;
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function numOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Gemini SSE → OpenAI delta 的**增量**翻译器。
 *
 * ⚠ 不能「读完再翻」；必须跨 chunk 保留半帧（用 `TextDecoder(..., {stream:true})`）。
 * ⚠ 只有 `candidates` 非空才算内容帧；纯 `usageMetadata` 的收尾帧要继续读。
 * ⚠ 思考 part 的签名**刻意不存**（只有 functionCall 上那个被校验）。
 * ⚠ 工具调用**独占一个块**，参数一次性发完再关块。
 */
export function newTranslator(): StreamTranslator {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let doneSent = false;

  let messageId = "";
  let model = GEMINI_UPSTREAM_FLASH;
  const created = Math.floor(Date.now() / 1000);

  let roleSent = false;
  let finishSent = false;
  let errorSent = false;
  let sawToolCall = false;
  let sawContent = false;
  let recordedFinish = "";
  let toolIndex = 0;

  // usage：取「见过的最大 totalTokenCount 的那一份」（§4.2）
  let bestTotal = -1;
  let promptTokens = 0;
  let candidatesTokens = 0;
  let thoughtsTokens = 0;
  let cachedTokens = 0;
  let usageSeen = false;

  /** 一个 Gemini part（或裸 Response）→ OpenAI delta 帧。 */
  function partFrames(part: Record<string, unknown>): Array<Buffer | string> {
    const out: Array<Buffer | string> = [];
    // 思考：part.thought === true → reasoning（签名刻意不存）
    if (part["thought"] === true) {
      const text = part["text"];
      if (typeof text === "string" && text) {
        out.push(chunkFrame({ reasoning_content: text }, null));
      }
      return out;
    }
    const text = part["text"];
    if (typeof text === "string" && text) {
      out.push(chunkFrame({ content: text }, null));
      return out;
    }
    const functionCall = part["functionCall"];
    if (isRecord(functionCall)) {
      const name = nonEmpty(functionCall["name"]) ?? "";
      const args = functionCall["args"];
      const id = `gemini_tool_${Date.now().toString(36)}_${toolIndex}`; // 本地生成
      const index = toolIndex;
      toolIndex += 1;
      sawToolCall = true;
      // 工具调用独占一个块：参数一次性发完
      out.push(
        chunkFrame(
          {
            tool_calls: [
              {
                index,
                id,
                type: "function",
                function: { name, arguments: JSON.stringify(isRecord(args) ? args : {}) },
              },
            ],
          },
          null,
        ),
      );
      return out;
    }
    // functionResponse / inlineData：上游响应里的这些形态不映射为增量
    return out;
  }

  function chunkFrame(
    delta: Record<string, unknown>,
    finishReason: string | null,
    usage?: Record<string, unknown>,
  ): string {
    const payload: Record<string, unknown> = {
      id: messageId || "chatcmpl-gemini",
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage) payload["usage"] = usage;
    return sseFrame(payload);
  }

  function usagePayload(): Record<string, unknown> | null {
    if (!usageSeen) return null;
    const input = Math.max(0, promptTokens - cachedTokens); // 计数互斥，不减会双重计费
    const total = input + candidatesTokens;
    return {
      prompt_tokens: input,
      completion_tokens: candidatesTokens,
      total_tokens: total,
      prompt_tokens_details: { cached_tokens: cachedTokens },
      completion_tokens_details: { reasoning_tokens: thoughtsTokens }, // 是 output 子集，不相加
    };
  }

  function updateUsage(usage: Record<string, unknown>): void {
    const total = numOr(usage["totalTokenCount"], -1);
    // 取「见过的最大 totalTokenCount 的那一份」（上游会重复播报，早期帧偏小）
    if (total < bestTotal) return;
    bestTotal = total;
    usageSeen = true;
    promptTokens = numOr(usage["promptTokenCount"], promptTokens);
    candidatesTokens = numOr(usage["candidatesTokenCount"], candidatesTokens);
    thoughtsTokens = numOr(usage["thoughtsTokenCount"], thoughtsTokens);
    cachedTokens = numOr(usage["cachedContentTokenCount"], cachedTokens);
  }

  function mapFinish(reason: string): string {
    if (sawToolCall) return "tool_calls";
    if (reason === "MAX_TOKENS") return "max_tokens";
    return "stop"; // STOP / STOP_SEQUENCE / FINISH_REASON_UNSPECIFIED / 未知
  }

  function handleFrame(payload: Record<string, unknown>): Array<Buffer | string> {
    const out: Array<Buffer | string> = [];
    // 先试信封 `{response: {...}}` 再试裸 `Response`
    const body = isRecord(payload["response"]) ? (payload["response"] as Record<string, unknown>) : payload;

    const candidates = body["candidates"];
    const isContentFrame = Array.isArray(candidates) && candidates.length > 0;

    if (isContentFrame) {
      const first = candidates[0];
      if (isRecord(first)) {
        const id = nonEmpty(body["responseId"]) ?? nonEmpty(first["modelVersion"]);
        if (id) messageId = id;
        const mv = nonEmpty(first["modelVersion"]);
        if (mv) model = mv;
        if (!roleSent) {
          roleSent = true;
          out.push(chunkFrame({ role: "assistant" }, null));
        }
        const content = isRecord(first["content"]) ? first["content"] : null;
        const parts = content && Array.isArray(content["parts"]) ? content["parts"] : [];
        let emittedContent = false;
        for (const rawPart of parts) {
          if (!isRecord(rawPart)) continue;
          const frames = partFrames(rawPart);
          if (frames.length > 0) emittedContent = true;
          out.push(...frames);
        }
        if (emittedContent) sawContent = true;
        const finish = nonEmpty(first["finishReason"]);
        if (finish && finish !== "FINISH_REASON_UNSPECIFIED") recordedFinish = finish;
      }
    }

    // 纯 usageMetadata 的收尾帧也要读（§4）
    const usage = body["usageMetadata"];
    if (isRecord(usage)) updateUsage(usage);

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
        out.push(...handleBlock(block));
      }
      return out;
    },

    finish(): Array<Buffer | string> {
      const out: Array<Buffer | string> = [];
      if (doneSent) return out;
      buffer += decoder.decode();
      buffer = buffer.replace(/\r\n/g, "\n");
      if (buffer.trim()) out.push(...handleBlock(buffer));
      buffer = "";

      // 无任何内容块 → 抛错（§4.4：调用方会转成 error 帧）
      if (!sawContent && !sawToolCall && !errorSent) {
        throw new Error("上游流没有任何内容块（无 candidates / 无工具调用）");
      }

      if (!finishSent && !errorSent) {
        finishSent = true;
        out.push(chunkFrame({}, mapFinish(recordedFinish), usagePayload() ?? undefined));
      }
      out.push("data: [DONE]\n\n");
      doneSent = true;
      return out;
    },
  };

  /** 处理一个 SSE 事件块（每帧单行 `data:`；注释行跳过；`event:` 行忽略）。 */
  function handleBlock(block: string): Array<Buffer | string> {
    const out: Array<Buffer | string> = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue; // 注释行（心跳）跳过
      if (line.startsWith("event:")) continue; // event: 行忽略
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).replace(/^ /, "");
      if (data === "[DONE]") {
        if (!finishSent && !errorSent) {
          if (!sawContent && !sawToolCall) {
            throw new Error("上游流没有任何内容块（只有 [DONE]）");
          }
          finishSent = true;
          out.push(chunkFrame({}, mapFinish(recordedFinish), usagePayload() ?? undefined));
        }
        continue;
      }
      let payload: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(data);
        if (!isRecord(parsed)) continue;
        payload = parsed;
      } catch {
        continue; // 半截/非 JSON 数据帧：忽略，不猜
      }
      // 上游 error 帧：必须显式产出 error 帧
      if (isRecord(payload["error"])) {
        if (!errorSent) {
          errorSent = true;
          const err = payload["error"] as Record<string, unknown>;
          out.push(
            sseFrame({
              error: {
                type: "upstream_error",
                message: nonEmpty(err["message"]) ?? "上游返回了 error 帧",
                ...(err["code"] === undefined ? {} : { code: err["code"] }),
              },
            }),
          );
        }
        continue;
      }
      out.push(...handleFrame(payload));
    }
    return out;
  }
}
