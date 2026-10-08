/**
 * ZCode（智谱 z.ai）上游：Anthropic Messages 形状的端点、请求头、请求体改写与流翻译。
 *
 * ## 本模块承载的渠道知识（每一条都有实测依据，见 docs/protocols/zcode/PROTOCOL.md）
 *
 * 1. **3012 风控与官方身份块**（§3.1，本渠道最大的坑）
 *    上游对 `/zcode-plan/anthropic` 通道做请求体内容检查：`system` 缺少官方身份块时
 *    直接返回 `{"code":3012,"msg":"request has been blocked due to unusual activity."}`。
 *    实测矩阵：无 system ✗、仅 cliPrefix（42 字符）✗、
 *    **cliPrefix + stable 全部三段（约 2894 字符）✓** ⇒ 判据是「身份块是否存在」。
 *    ⚠ 3012 有账号冷却惩罚（30 分钟起，5 次停用），故身份块必须完整、宁缺毋滥。
 *    身份块由 `tools/extract-zcode-identity.mjs` 程序化提取到
 *    `tools/zcode-identity.json`，**运行时读取**（不硬编码，避免手抄偏差）。
 *
 * 2. **X-Device-Mid 是硬需求**：缺它 billing 全家桶回 400 `code 3001`。
 *
 * 3. **只发准入必需的身份块**：官方完整身份块还含约 5KB dynamic 段
 *    （行为指令），与准入无关且会压过调用方 prompt，故不含。
 *
 * 4. **请求体是 Anthropic Messages 形状**（§3.2）：`{model, system:[块], messages:[块],
 *    max_tokens, stream}`；工具用 `input_schema` 而非 `parameters`。
 *
 * 5. **流式响应是 Anthropic SSE**（§4）：`content_block_delta` 的三种 delta 分别映射
 *    正文 / 思考 / 工具参数；**`signature_delta` 必须忽略**（当文本会往回答里注入
 *    十六进制）；**`error` 事件必须显式产出 error 帧**（静默当成正常结束会让 UI
 *    「干净地停止、无报错」）。
 */

import { readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDir, login as sharedLogin, upstreamPath } from "@model-bridge/gateway";

export const DEFAULT_BASE_URL = "https://zcode.z.ai";

/** 展示名（状态页与错误文案用）。 */
export const DISPLAY_NAME = "ZCode";

/**
 * 上游线型是**自定义（Anthropic Messages）**：网关必须走 `newTranslator()`
 * 增量翻译，不能当 OpenAI SSE 透传。
 */
export const WIRE: "openai" | "custom" = "custom";

/** 积分制对话路径（docs/protocols/zcode/PROTOCOL.md §1）。 */
export const DEFAULT_CHAT_PATH = "/api/v1/zcode-plan/anthropic/v1/messages";

/** 客户端配置（模型池 + captcha 配置），也是凭据有效性探测端点。 */
export const DEFAULT_MODELS_PATH = "/api/v1/client/configs";

/** 默认客户端版本（3.14.4 起模型请求侧不再索要 captcha，见 §6.3）。 */
export const DEFAULT_APP_VERSION = "3.14.4";

/** Anthropic 协议版本头（固定值）。 */
export const ANTHROPIC_VERSION = "2023-06-01";

/** 默认输出上限：Anthropic 的 `max_tokens` 必填，客户端没给时补一个安全值。 */
const DEFAULT_MAX_TOKENS = 8192;

/** 上游 API 拒绝了访问令牌（HTTP 401/403，或业务码 401/1002）。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

export interface Config {
  baseUrl: string;
  chatPath: string;
  modelsPath: string;
  appVersion: string;
}

/**
 * 凭据的最小面。
 *
 * 刻意只声明需要的字段而不是 import `cred.Credentials` —— 那会形成
 * upstream ↔ cred 的循环依赖。
 */
export interface AuthLike {
  accessToken: string;
  deviceMid: string;
  uid?: string;
  appVersion?: string;
  domain?: string;
}

export function defaultConfig(): Config {
  return {
    baseUrl: DEFAULT_BASE_URL,
    chatPath: DEFAULT_CHAT_PATH,
    modelsPath: DEFAULT_MODELS_PATH,
    appVersion: DEFAULT_APP_VERSION,
  };
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
      appVersion: nonEmpty(parsed.appVersion) ?? fallback.appVersion,
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

/** 客户端配置（模型池）URL。 */
export function modelsUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return trimSlash(resolved.baseUrl) + ensureSlash(resolved.modelsPath);
}

/** 从 baseUrl 提取 host 部分（转发共享层原语）。 */
export function hostOf(baseUrl: string): string {
  return sharedLogin.hostOf(baseUrl);
}

/**
 * 构造上游请求头（鉴权 + 客户端伪装）。
 *
 * ⚠ `X-Device-Mid` 是硬需求：缺它 billing 全家桶回 400 `code 3001`。
 * 这里**明确抛错**而不是静默漏发 —— 漏发的表现是上游 400，排查成本更高。
 *
 * `authorization: false` 用于不需要用户凭据的端点（preview / event report）。
 */
export function buildHeaders(
  credential: AuthLike,
  cfg?: Config,
  options: { authorization?: boolean } = {},
): Record<string, string> {
  const resolved = cfg ?? loadConfig()[0];
  const deviceMid = credential.deviceMid;
  if (!deviceMid) {
    throw new Error("凭据缺少 device_mid：它是上游硬需求（缺则 400 code 3001），请重新登录");
  }
  const version = credential.appVersion || resolved.appVersion || DEFAULT_APP_VERSION;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": `ZCode/${version}`,
    "HTTP-Referer": "https://zcode.z.ai",
    "X-ZCode-App-Version": version,
    "X-Release-Channel": "stable",
    "X-Client-Language": "zh-CN",
    "X-Client-Timezone": "Asia/Shanghai",
    "X-Device-Mid": deviceMid,
    "X-Platform": "win32",
    "X-Os-Category": "windows",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (options.authorization !== false && credential.accessToken) {
    headers["Authorization"] = `Bearer ${credential.accessToken}`;
  }
  return headers;
}

// ── 官方身份块（3012 准入的唯一开关） ────────────────────────────────────────

export interface Identity {
  cliPrefix: string;
  stable: string[];
}

let identityCache: Identity | null = null;

/** 仅供测试：清空身份块缓存（换文件/删文件后重新读取）。 */
export function clearIdentityCache(): void {
  identityCache = null;
}

/** 身份块 JSON 的候选路径（环境变量 → 工作目录 → 项目根）。 */
function identityPaths(): string[] {
  const env = process.env["ZCODE_IDENTITY_FILE"];
  // 显式指定即权威：指向不存在的文件时直接报错，而不是悄悄回退到仓库内的副本
  // （否则用户以为自己换了身份块，实际仍用旧的 —— 3012 的代价极高）。
  if (env) return [env];
  return [
    join(process.cwd(), "tools", "zcode-identity.json"),
    // dist/upstream.js 与 src/upstream.ts 都在项目内一层，`../..` 归一化后即项目根
    join(fileURLToPath(import.meta.url), "..", "..", "tools", "zcode-identity.json"),
  ];
}

const IDENTITY_HINT =
  "缺少官方身份块（tools/zcode-identity.json）。请先运行 " +
  "`node tools/extract-zcode-identity.mjs <渠道包 zcode-identity.ts> tools/zcode-identity.json`。\n" +
  "⚠ 不要在缺失时发请求：system 缺身份块会被以 3012 拦截，且 3012 有账号冷却惩罚" +
  "（30 分钟起，5 次停用）。";

/** 读取并校验官方身份块（运行时读 JSON，不硬编码）。 */
export function loadIdentity(): Identity {
  if (identityCache) return identityCache;
  let raw = "";
  let found = "";
  for (const path of identityPaths()) {
    try {
      raw = readFileSync(path, "utf8");
      found = path;
      break;
    } catch {
      continue;
    }
  }
  if (!found) throw new Error(IDENTITY_HINT);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${found} 不是合法 JSON：${String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${found} 形状不对：期望 {cliPrefix, stable: [...]}`);
  }
  const rec = parsed as Record<string, unknown>;
  const cliPrefix = nonEmpty(rec["cliPrefix"]) ?? "";
  const stableRaw = rec["stable"];
  const stable = Array.isArray(stableRaw)
    ? stableRaw.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
  if (!cliPrefix || stable.length === 0) {
    throw new Error(`${found} 缺少 cliPrefix 或 stable 段。${IDENTITY_HINT}`);
  }
  // 实测：仅 cliPrefix 仍被拒（3012）；cliPrefix + stable 全部三段才 200。
  // 少于三段属于未经验证的配置，宁可在本地失败也不去触发 3012 惩罚。
  if (stable.length < 3) {
    throw new Error(
      `身份块不完整（stable 段数 ${stable.length}，需要 3 段）：${found}\n${IDENTITY_HINT}`,
    );
  }
  identityCache = { cliPrefix, stable };
  return identityCache;
}

/** 身份块（Anthropic text 块数组），顺序即准入要求：cliPrefix 在前，stable 紧随。 */
export function identityBlocks(): Array<Record<string, string>> {
  const identity = loadIdentity();
  return [
    { type: "text", text: identity.cliPrefix },
    ...identity.stable.map((text) => ({ type: "text", text })),
  ];
}

// ── 请求体改写：OpenAI → Anthropic Messages ─────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** OpenAI 的 `image_url`（data: URL）→ Anthropic base64 image 块。 */
function imageFromOpenAi(part: Record<string, unknown>): Record<string, unknown> | null {
  const imageUrl = part["image_url"];
  const url = isRecord(imageUrl) ? nonEmpty(imageUrl["url"]) : null;
  if (!url || !url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  const header = url.slice(5, comma); // 去掉 "data:"
  const [mediaType, encoding] = header.split(";");
  if (encoding !== "base64" || !mediaType) return null;
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data: url.slice(comma + 1) },
  };
}

/**
 * 把一条消息的 content 转成 Anthropic 块数组。
 *
 * - 字符串 → `[{type:"text",text}]`（协议要求 content 是块数组）
 * - 数组 → 逐块转换：text 直通；OpenAI 的 image_url(data:) 转 Anthropic image；
 *   其余（tool_use / tool_result / image）按已是 Anthropic 形状原样透传
 */
function toAnthropicContent(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
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
        if (image) blocks.push(image);
        continue;
      }
      // input_text / output_text 是 OpenAI 的等价文本块
      if ((type === "input_text" || type === "output_text") && typeof part["text"] === "string") {
        blocks.push({ type: "text", text: part["text"] });
        continue;
      }
      blocks.push(part); // 已是 Anthropic 形状
    }
    if (blocks.length > 0) return blocks;
    return [{ type: "text", text: "" }];
  }
  if (content === null || content === undefined) return [{ type: "text", text: "" }];
  return [{ type: "text", text: String(content) }];
}

/** OpenAI assistant 的 tool_calls → Anthropic tool_use 块。 */
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
        // 参数不是合法 JSON（流式半截）时给空对象：Anthropic 要求 input 是对象
        input = {};
      }
    } else if (isRecord(args)) {
      input = args;
    }
    blocks.push({ type: "tool_use", id: nonEmpty(call["id"]) ?? "toolu_0", name, input });
  }
  return blocks;
}

/** OpenAI role:"tool" → Anthropic user 消息里的 tool_result 块。 */
function toolResultBlocks(rec: Record<string, unknown>): Array<Record<string, unknown>> {
  const id = nonEmpty(rec["tool_call_id"]) ?? "";
  const content = rec["content"];
  let body: unknown = content;
  if (typeof content === "string") body = content;
  else if (Array.isArray(content)) body = toAnthropicContent(content);
  else if (content === null || content === undefined) body = "";
  return [{ type: "tool_result", tool_use_id: id, content: body }];
}

/** 把消息列表转成 Anthropic 形状（system 抽出，user/assistant 交替）。 */
function toAnthropicMessages(
  messages: unknown[],
): { system: Array<Record<string, unknown>>; messages: Array<Record<string, unknown>> } {
  const system: Array<Record<string, unknown>> = [];
  const out: Array<Record<string, unknown>> = [];

  const pushUser = (blocks: Array<Record<string, unknown>>): void => {
    const last = out[out.length - 1];
    // Anthropic 要求 user/assistant 交替；连续 user（如多条 tool 结果）
    // 合并进同一条消息，避免上游 400。
    if (last && last["role"] === "user") {
      (last["content"] as Array<Record<string, unknown>>).push(...blocks);
      return;
    }
    out.push({ role: "user", content: blocks });
  };

  for (const msg of messages) {
    if (!isRecord(msg)) continue;
    const role = msg["role"];
    if (role === "system" || role === "developer") {
      system.push(...toAnthropicContent(msg["content"]));
      continue;
    }
    if (role === "tool" || role === "function") {
      pushUser(toolResultBlocks(msg));
      continue;
    }
    if (role === "assistant") {
      const blocks = toAnthropicContent(msg["content"]);
      blocks.push(...toolCallsToToolUse(msg));
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    pushUser(toAnthropicContent(msg["content"]));
  }
  return { system, messages: out };
}

/** OpenAI tools / functions → Anthropic tools（`input_schema` 而非 `parameters`）。 */
function toAnthropicTools(req: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = Array.isArray(req["tools"]) ? req["tools"] : Array.isArray(req["functions"]) ? req["functions"] : null;
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

/** OpenAI tool_choice → Anthropic tool_choice。 */
function toAnthropicToolChoice(req: Record<string, unknown>): Record<string, unknown> | null {
  const choice = req["tool_choice"];
  if (typeof choice === "string") {
    if (choice === "auto") return { type: "auto" };
    if (choice === "required") return { type: "any" };
    if (choice === "none") return { type: "none" };
    return null;
  }
  if (isRecord(choice)) {
    const fn = isRecord(choice["function"]) ? choice["function"] : null;
    const name = nonEmpty(fn?.["name"]);
    if (name) return { type: "tool", name };
    const type = nonEmpty(choice["type"]);
    if (type === "auto" || type === "none" || type === "any") return { type };
  }
  return null;
}

/**
 * 把下游 OpenAI 请求改写成 Anthropic Messages 形状。
 *
 * 步骤：
 *  1. `system` = 身份块 + 调用方 system（身份块必须在最前，判据要求）
 *  2. `messages` 转块数组；tool 消息转 tool_result、assistant tool_calls 转 tool_use
 *  3. 恒 `stream: true`（网关要非流式时自己聚合）
 *  4. `max_tokens` 必填（Anthropic 协议要求）；`stop` → `stop_sequences`
 *  5. `reasoning_effort` → `output_config.effort`
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const identity = identityBlocks();
  const rawMessages = Array.isArray(req["messages"]) ? req["messages"] : [];
  const { system: callerSystem, messages } = toAnthropicMessages(rawMessages);
  if (messages.length === 0) {
    throw new Error("messages 为空：Anthropic Messages 至少需要一条 user 消息");
  }

  const maxTokens =
    typeof req["max_tokens"] === "number"
      ? req["max_tokens"]
      : typeof req["max_completion_tokens"] === "number"
        ? req["max_completion_tokens"]
        : DEFAULT_MAX_TOKENS;

  const body: Record<string, unknown> = {
    model: upstreamModel,
    system: [...identity, ...callerSystem],
    messages,
    max_tokens: maxTokens,
    stream: true, // 上游只支持流式；客户端要非流式由网关聚合
  };

  if (typeof req["temperature"] === "number") body["temperature"] = req["temperature"];
  if (typeof req["top_p"] === "number") body["top_p"] = req["top_p"];
  const stop = req["stop"];
  if (Array.isArray(stop) && stop.length > 0) {
    body["stop_sequences"] = stop.filter((s) => typeof s === "string");
  } else if (typeof stop === "string" && stop) {
    body["stop_sequences"] = [stop];
  }
  const tools = toAnthropicTools(req);
  if (tools.length > 0) body["tools"] = tools;
  const toolChoice = toAnthropicToolChoice(req);
  if (toolChoice && tools.length > 0) body["tool_choice"] = toolChoice;
  if (typeof req["reasoning_effort"] === "string" && req["reasoning_effort"]) {
    body["output_config"] = { effort: req["reasoning_effort"] };
  }
  return body;
}

// ── 模型载荷（凭据有效性探测 / 目录） ────────────────────────────────────────

/** 业务码 401/1002 = 凭据失效（docs/protocols/zcode/PROTOCOL.md §4）。 */
function isAuthCode(code: unknown): boolean {
  return code === 401 || code === 1002 || code === "401" || code === "1002";
}

/** 拉取并解码客户端配置载荷；401/403 或业务码 401/1002 抛 UpstreamUnauthorized。 */
export async function fetchModels(
  credential: AuthLike,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  const cfg = loadConfig()[0];
  if (credential.domain && credential.domain !== hostOf(cfg.baseUrl)) {
    cfg.baseUrl = `https://${credential.domain}`;
  }

  let resp: Response;
  try {
    resp = await fetch(modelsUrl(cfg), {
      headers: buildHeaders(credential, cfg),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`configs 请求失败: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized("上游拒绝了访问令牌（HTTP 401/403）");
  }
  if (resp.status !== 200) throw new Error(`configs 请求失败: HTTP ${resp.status}`);

  let env: Record<string, unknown>;
  try {
    env = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`configs 响应不是合法 JSON: ${String(err)}`);
  }
  if (isAuthCode(env["code"])) {
    throw new UpstreamUnauthorized(`上游凭据失效（code=${String(env["code"])}）`);
  }
  if (env["code"] !== undefined && env["code"] !== 0) {
    throw new Error(`configs 返回 code=${String(env["code"])} msg=${String(env["msg"] ?? "")}`);
  }
  const data = env["data"];
  if (isRecord(data)) return data;
  return env;
}

/** 从模型/配置载荷推导连接配置（baseUrl / 版本可能由服务端下发）。 */
export function resolveConfig(data: Record<string, unknown>, fallback?: Config): Config {
  const cfg: Config = { ...(fallback ?? loadConfig()[0] ?? defaultConfig()) };
  const baseUrl = nonEmpty(data["baseUrl"]) ?? nonEmpty(data["base_url"]);
  if (baseUrl) cfg.baseUrl = baseUrl;
  const version = nonEmpty(data["app_version"]) ?? nonEmpty(data["appVersion"]);
  if (version) cfg.appVersion = version;
  // 路径是协议硬编码，不从载荷覆盖
  cfg.chatPath = DEFAULT_CHAT_PATH;
  cfg.modelsPath = DEFAULT_MODELS_PATH;
  return cfg;
}

// ── 流翻译：Anthropic SSE → OpenAI SSE（必须是增量） ──────────────────────────

export interface StreamTranslator {
  /** 喂入一块字节，返回本次可产出的 OpenAI SSE 帧。 */
  feed(chunk: Buffer): Array<Buffer | string>;
  /** 流结束：处理残余、补 `finish_reason` 帧与 `data: [DONE]`。 */
  finish(): Array<Buffer | string>;
}

/** `end_turn` → stop、`max_tokens` → length、`tool_use` → tool_calls（§4）。 */
export function mapStopReason(reason: unknown): string {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
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
 * Anthropic SSE → OpenAI delta 的**增量**翻译器。
 *
 * ⚠ 不能「读完再翻」：流式会失去意义（用户要等整轮生成完才看到第一个字）。
 * ⚠ 必须跨 chunk 保留半帧：SSE 事件会被 TCP 切在任意位置（中文多字节字符与
 * `\n\n` 分隔符都会被切开）⇒ 用 `TextDecoder("utf-8")` 流式解码 + 字符串缓冲，
 * **不要**对每个 chunk 单独 `toString()`。
 * ⚠ 帧自带 `type` 字段，优先用它（`event:` 行可能被中间层吞掉）。
 */
export function newTranslator(): StreamTranslator {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let doneSent = false;

  let messageId = "";
  let model = "zcode";
  const created = Math.floor(Date.now() / 1000);

  let roleSent = false;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
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
      id: messageId || "chatcmpl-zcode",
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
    const completion = outputTokens ?? 0;
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    };
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
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
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
        inputTokens = numOrNull(usage?.["input_tokens"]) ?? inputTokens;
        if (!roleSent) {
          roleSent = true;
          out.push(chunkFrame({ role: "assistant" }, null));
        }
        break;
      }
      case "content_block_start": {
        const blockObj = isRecord(payload["content_block"]) ? payload["content_block"] : null;
        if (blockObj?.["type"] === "tool_use") {
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
                    id: nonEmpty(blockObj["id"]) ?? `call_${toolIndex}`,
                    type: "function",
                    function: {
                      name: nonEmpty(blockObj["name"]) ?? "",
                      arguments: "",
                    },
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
        if (deltaType === "text_delta") {
          const text = delta["text"];
          if (typeof text === "string" && text) out.push(chunkFrame({ content: text }, null));
        } else if (deltaType === "thinking_delta") {
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
                    {
                      index: toolIndexByBlock.get(blockIndex),
                      function: { arguments: partial },
                    },
                  ],
                },
                null,
              ),
            );
          }
        }
        // ⚠ signature_delta 必须忽略：当成文本会把一串十六进制注入回答。
        break;
      }
      case "message_delta": {
        const delta = isRecord(payload["delta"]) ? payload["delta"] : null;
        const usage = isRecord(payload["usage"]) ? payload["usage"] : null;
        outputTokens = numOrNull(usage?.["output_tokens"]) ?? outputTokens;
        if (!finishSent) {
          finishSent = true;
          const reason = mapStopReason(delta?.["stop_reason"]);
          out.push(chunkFrame({}, reason, usageFrame() ?? undefined));
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
        // ⚠ 必须显式产出 error 帧：静默当成正常结束会让 UI「干净地停止、无报错」。
        if (!errorSent) {
          errorSent = true;
          const error = isRecord(payload["error"]) ? payload["error"] : payload;
          const message = nonEmpty(error["message"]) ?? "上游返回了 error 事件";
          const code = error["code"] ?? payload["code"];
          out.push(
            sseFrame({
              error: {
                type: "upstream_error",
                message,
                ...(code === undefined ? {} : { code }),
              },
            }),
          );
        }
        break;
      }
      default:
        // ping / content_block_stop / message_stop 之外的未知事件：无输出
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
      // 兼容 \r\n 分隔符（URL 里的 \r 已随上一块拼接完成）
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

      // 断流（没有 message_stop / message_delta）也要补 finish_reason，
      // 否则客户端拿不到结束标志，UI 卡在「生成中」。
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
