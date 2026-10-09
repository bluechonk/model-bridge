/**
 * Loomy（讯飞）上游：端点、**两套认证头**、业务码判据与请求体改写。
 *
 * ## 本模块承载的渠道知识（每条都是实测结论，见 docs/protocols/loomy/PROTOCOL.md）
 *
 * 1. **两套认证头**：`/models` 与 `/points/*`、`/onboarding/*` **只认 `token` 头**；
 *    `/chat/completions` **只认 `Authorization: Bearer`**（chat 端点**两个都发**，
 *    因为官方客户端在 session 模式下也是两个都发）。
 *    实测交叉验证：带错的那个 → HTTP 200 + `{"code":"100002","desc":"缺少 token"}`。
 * 2. **业务失败恒返回 HTTP 200**：成败只能读 body 的 `code`
 *    （`000000` 成功 / `100002` 登录失效 / `100001` 参数错误）。
 *    只看状态码会把「登录已失效」误判成成功。
 * 3. **`reasoning_effort` 必须校验档位在该模型的 efforts 内**（不能被 HTTP 状态码骗：
 *    实测传 `reasoning_effort` / `reasoningEffort` / `thinking` 三种名字**都返回 200**，
 *    服务端对未知字段静默忽略）。校验不过时**静默不下发**（退回服务端默认档）。
 * 4. 档位表来自远端 `GET /models`；为**避免 upstream ↔ catalog 循环依赖**，由
 *    `catalog` 在构建目录时把档位注册进本模块的注册表（`setModelEfforts`）。
 */

import { readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";

import { ensureDir, upstreamPath } from "@model-bridge/gateway";

/** 业务基址（推理与积分端点）。 */
export const DEFAULT_BASE_URL = "https://loomyad.xunfei.cn";

/** 展示名（状态页与错误文案用）。 */
export const DISPLAY_NAME = "Loomy";

/** 上游线型：标准 OpenAI 兼容 SSE，网关只需规范化透传。 */
export const WIRE: "openai" | "custom" = "openai";

export const API_PREFIX = "/api/v1";
export const OK_CODE = "000000";
export const AUTH_ERROR_CODE = "100002";
export const BAD_REQUEST_CODE = "100001";

const HTTP_TIMEOUT_MS = 60_000;
/** 目录端点超时（PROTOCOL §5.1）。 */
const MODELS_TIMEOUT_MS = 30_000;

/** 上游认为凭据失效（业务码 100002）或 HTTP 401/403。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

/** 描述如何到达 Loomy 端点。 */
export interface Config {
  baseUrl: string;
}

/**
 * 凭据的最小面（避免 upstream ↔ cred 循环依赖）。
 */
export interface AuthLike {
  accessToken: string;
}

export function defaultConfig(): Config {
  return { baseUrl: DEFAULT_BASE_URL };
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
    baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl ? parsed.baseUrl : DEFAULT_BASE_URL,
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

function base(cfg?: Config): string {
  return trimSlash((cfg ?? loadConfig()[0]).baseUrl);
}

/** 对话端点。 */
export function chatUrl(cfg?: Config): string {
  return `${base(cfg)}${API_PREFIX}/chat/completions`;
}

/** 模型列表端点。 */
export function modelsUrl(cfg?: Config): string {
  return `${base(cfg)}${API_PREFIX}/models`;
}

/** 积分明细（**只读**，最便宜的探测端点）。 */
export function pointsRecordsUrl(cfg?: Config): string {
  return `${base(cfg)}${API_PREFIX}/points/records?pageNo=1&pageSize=1&recordType=all`;
}

/** 每日额度初始化（**写**端点，幂等）。 */
export function firstLoginUrl(cfg?: Config): string {
  return `${base(cfg)}${API_PREFIX}/points/first-login`;
}

/** 新手任务列表。 */
export function tasksUrl(cfg?: Config): string {
  return `${base(cfg)}${API_PREFIX}/onboarding/tasks`;
}

/** 完成单个新手任务。 */
export function taskCompleteUrl(cfg?: Config): string {
  return `${base(cfg)}${API_PREFIX}/onboarding/tasks/complete`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// ── 认证头（两套）─────────────────────────────────────────────────────────────

/**
 * 业务端点头：**只发 `token`**（`/models`、`/points/*`、`/onboarding/*`）。
 * 多发 `Authorization` 不会被采纳 —— 只认 `token`。
 */
export function businessHeaders(credential: AuthLike): Record<string, string> {
  return { Accept: "application/json", token: credential.accessToken };
}

/**
 * chat 端点头：**两个都发**（只认 `Authorization: Bearer`；`Bearer ` 前缀必需，
 * 实测无前缀同样回 `100002 缺少 token`）。
 */
export function chatHeaders(credential: AuthLike): Record<string, string> {
  return {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    Authorization: `Bearer ${credential.accessToken}`,
    token: credential.accessToken,
  };
}

/** 网关按 `buildHeaders(credential)` 取对话头（默认 chat 形态）。 */
export function buildHeaders(
  credential: AuthLike,
  opts: { chat?: boolean } = {},
): Record<string, string> {
  return (opts.chat ?? true) ? chatHeaders(credential) : businessHeaders(credential);
}

// ── 业务信封 ──────────────────────────────────────────────────────────────────

/** 解析业务信封：`{code, desc | message, data}`（`desc` 优先于 `message`）。 */
export function parseEnvelope(payload: unknown): {
  code: string;
  desc: string;
  data: Record<string, unknown>;
} {
  if (!isRecord(payload)) return { code: "", desc: "", data: {} };
  const code = payload["code"] === undefined || payload["code"] === null ? "" : String(payload["code"]);
  return {
    code,
    desc: str(payload["desc"]) || str(payload["message"]),
    data: isRecord(payload["data"]) ? payload["data"] : {},
  };
}

/** `100002` = 登录失效（收到它**不得重试**，必须重新登录）。 */
export function isAuthError(code: string): boolean {
  return code === AUTH_ERROR_CODE;
}

/** 发一个业务 GET/POST 并判业务码（**不信 HTTP 状态码**）。 */
async function businessCall(
  url: string,
  credential: AuthLike,
  init: { method: string; body?: string; timeoutMs?: number },
): Promise<Record<string, unknown>> {
  const headers = businessHeaders(credential);
  const requestHeaders: Record<string, string> =
    init.body === undefined ? headers : { ...headers, "Content-Type": "application/json" };

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: init.method,
      headers: requestHeaders,
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(init.timeoutMs ?? HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`business request failed: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized(`Loomy rejected the access token (HTTP ${resp.status})`);
  }
  if (resp.status !== 200) throw new Error(`business request returned HTTP ${resp.status}`);
  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (err) {
    throw new Error(`business response is not valid JSON: ${String(err)}`);
  }
  const env = parseEnvelope(payload);
  // ⚠ 业务失败**恒 HTTP 200**：只能说 code
  if (env.code !== OK_CODE) {
    if (isAuthError(env.code)) {
      throw new UpstreamUnauthorized(`Loomy session is invalid (code=${env.code} ${env.desc})`);
    }
    throw new Error(`Loomy business failure: code=${env.code} ${env.desc}`);
  }
  return isRecord(payload) ? (payload as Record<string, unknown>) : {};
}

/** 拉模型目录（**必须用 `token` 头**，带错会得到 100002）。 */
export async function fetchModels(
  credential: AuthLike,
  cfgOverride?: Config,
): Promise<Record<string, unknown>> {
  return businessCall(modelsUrl(cfgOverride), credential, {
    method: "GET",
    timeoutMs: MODELS_TIMEOUT_MS,
  });
}

/** 积分明细（**只读**）：既是最便宜的探测端点，也是额度查询的数据源。 */
export async function fetchPointsRecords(
  credential: AuthLike,
  cfgOverride?: Config,
): Promise<Record<string, unknown>> {
  return businessCall(pointsRecordsUrl(cfgOverride), credential, { method: "GET" });
}

/**
 * 触发每日额度初始化（**写**，幂等）。
 *
 * ⚠ 语义是「触发每日额度重置」，**不是「+5000 积分」**：`dailyBalance = dailyQuota - dailyConsumed`，
 * 消耗后不回补。故**不能**在「打开面板」这类高频路径上调用它。
 */
export async function triggerFirstLogin(
  credential: AuthLike,
  cfgOverride?: Config,
): Promise<Record<string, unknown>> {
  const payload = await businessCall(firstLoginUrl(cfgOverride), credential, {
    method: "POST",
    body: "{}",
  });
  return parseEnvelope(payload).data;
}

/** 新手任务列表（返回信封里的 `data`）。 */
export async function fetchTasks(
  credential: AuthLike,
  cfgOverride?: Config,
): Promise<Record<string, unknown>> {
  const payload = await businessCall(tasksUrl(cfgOverride), credential, { method: "GET" });
  return parseEnvelope(payload).data;
}
/**
 * 完成单个新手任务。
 *
 * ⚠ 上报 body **只有 `key`** —— 无设备指纹、无版本号、无渠道号；
 * ⚠ **服务端不校验前置行为**（实测 8 个任务逐个直领全部成功，余额 0 → 10000，
 * 没有真的发对话/生成 PPT/装技能）：完成条件全在客户端本地判定，服务端只做
 * 「幂等置位 + 加分」。故本实现是**纯 API 直领**。
 */
export async function completeTask(
  credential: AuthLike,
  key: string,
  cfgOverride?: Config,
): Promise<Record<string, unknown>> {
  const payload = await businessCall(taskCompleteUrl(cfgOverride), credential, {
    method: "POST",
    body: JSON.stringify({ key }),
  });
  return parseEnvelope(payload).data;
}

/**
 * 从模型载荷推导连接配置。Loomy 端点固定，载荷不下发连接信息
 * （保留本函数是为了契约一致）。
 */
export function resolveConfig(_data: Record<string, unknown>, fallback?: Config): Config {
  return { ...(fallback ?? defaultConfig()) };
}

// ── 档位注册表（避免 upstream ↔ catalog 循环依赖）──────────────────────────────

export interface ModelEfforts {
  efforts: string[];
  defaultEffort: string;
}

const effortsRegistry = new Map<string, ModelEfforts>();

/** 由 `catalog` 在构建目录时调用：登记某模型支持的思考档位。 */
export function setModelEfforts(model: string, efforts: string[], defaultEffort: string): void {
  effortsRegistry.set(model, { efforts: [...efforts], defaultEffort });
}

/** 查询已登记的档位；未知模型返回 null（→ 不下发 reasoning_effort）。 */
export function modelEfforts(model: string): ModelEfforts | null {
  return effortsRegistry.get(model) ?? null;
}

/** 仅供测试：清空档位注册表。 */
export function clearModelEfforts(): void {
  effortsRegistry.clear();
}

// ── 请求体改写 ────────────────────────────────────────────────────────────────

function isSystemMessage(msg: unknown): boolean {
  return isRecord(msg) && msg["role"] === "system";
}

/**
 * `system` 提示词提升为 `messages[0]`（**先拼再放进对象**，不依赖
 * 「后面的键覆盖前面」的隐式行为）；多条字符串内容用 `\n\n` 合并。
 */
export function hoistSystemMessages(messages: unknown[]): unknown[] {
  const systems = messages.filter(isSystemMessage);
  if (systems.length === 0) return [...messages];
  const contents = systems.map((m) => (m as Record<string, unknown>)["content"]);
  if (contents.some((c) => typeof c !== "string")) return [...messages];
  const merged: Record<string, unknown> = { ...(systems[0] as Record<string, unknown>) };
  merged["role"] = "system";
  merged["content"] = (contents as string[]).join("\n\n");
  return [merged, ...messages.filter((m) => !isSystemMessage(m))];
}

/**
 * 把下游 OpenAI 请求改写成 Loomy 能接受的形状。
 *
 * - `system` 提升为 `messages[0]`
 * - `reasoning_effort` **校验档位在该模型的 efforts 内**，不过就静默删掉
 *   （给一个远端不认的值比不给更糟）
 * - 恒设 `stream: true`（客户端要非流式由网关聚合）
 * - 其余可选字段条件展开（`undefined` 时不发该键）
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...req, model: upstreamModel };

  if (Array.isArray(body["messages"])) {
    body["messages"] = hoistSystemMessages(body["messages"] as unknown[]);
  }

  const effort = body["reasoning_effort"];
  if (effort !== undefined) {
    const known = modelEfforts(upstreamModel);
    const value = typeof effort === "string" ? effort : "";
    if (!known || !value || !known.efforts.includes(value)) {
      delete body["reasoning_effort"]; // 静默不下发（退回服务端默认档）
    }
  }

  body["stream"] = true;
  return body;
}

/** 翻译器接口（`WIRE === "openai"` 时网关不会调用，导出仅为契约一致）。 */
export interface StreamTranslator {
  feed(chunk: Buffer): Array<Buffer | string>;
  finish(): Array<Buffer | string>;
}

/** 恒等翻译器。 */
export function newTranslator(): StreamTranslator {
  return {
    feed: (chunk: Buffer) => [chunk],
    finish: () => [],
  };
}
