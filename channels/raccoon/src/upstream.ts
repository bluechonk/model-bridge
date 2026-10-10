/**
 * Raccoon（商汤小浣熊）上游：端点、三种请求头形态、思考通道与请求体安全化。
 *
 * ## 本模块承载的渠道知识（每条都是实测结论，见 docs/protocols/raccoon/PROTOCOL.md）
 *
 * 1. **思考控制的唯一有效通道是 `extra_body.thinking.type`**（`enabled` / `disabled`，
 *    服务端报错原文确认枚举还含 `adaptive`）：
 *    - `reasoning_effort` **被接受但实测无效果**（8 轮配对实验正负各半，纯随机）
 *    - `extra_body.enable_thinking`（单层/双层）、`thinking` 放**顶层**、`thinking.budget_tokens`
 *      **全部无效** ⇒ 必须把下游的意图**翻译**进 `extra_body.thinking`，且**不能**原样透传
 *      `reasoning_effort`
 *    - 本插件只暴露两态：`on` → `{type:'enabled'}`、`off` → `{type:'disabled'}`；
 *      **只有明确的「关闭」才关**，未知档位一律按开启处理；不传档位时**不发该字段**
 * 2. **`max_tokens` 只放行安全正整数**：`0` / 负数 / `NaN` 会让 DSH 在
 *    `defaultMaxTokens` 的硬校验上抛 `INVALID_MODEL_MAX_TOKENS`，**整轮对话起不来**
 *    （不是降级，是崩）。
 * 3. **`tools` 必须真的下发到请求体顶层** —— 漏发会让模型在正文里臆造 XML 工具调用，
 *    harness 认不出 → 任务终止。
 * 4. **三种头形态**（platform 的有无是硬约束）：
 *    - 对话：`Accept: text/event-stream` + `Content-Type` + platform（**不含**
 *      `X-Client-Version` / `X-Client-Device-ID`）
 *    - 模型目录：内联构造，`Accept: application/json`，**不含** platform、**不含** Content-Type
 *    - `desktop/v1/login/points/grant`：**无 body 但 platform 必需**
 */

import { readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";

import { ensureDir, upstreamPath } from "@model-bridge/gateway";

export { DEFAULT_BASE_URL, AUTH_PREFIX, LLM_PREFIX, POINTS_PREFIX, DESKTOP_PREFIX, CLIENT_PLATFORM, CLIENT_VERSION, USER_AGENT, EXCHANGE_PATH, AUTHORIZATION_CODE_NOT_FOUND } from "./cred.js";
import {
  AUTH_PREFIX,
  CLIENT_PLATFORM,
  CLIENT_VERSION,
  DEFAULT_BASE_URL,
  DESKTOP_PREFIX,
  EXCHANGE_PATH,
  LLM_PREFIX,
  POINTS_PREFIX,
  USER_AGENT,
} from "./cred.js";

/** 展示名（状态页与错误文案用）。 */
export const DISPLAY_NAME = "Raccoon";

/** 上游线型：标准 OpenAI 兼容 SSE，网关只需规范化透传。 */
export const WIRE: "openai" | "custom" = "openai";

const HTTP_TIMEOUT_MS = 60_000;

/** 上游 API 拒绝了访问令牌（HTTP 401/403 或 code 200003）。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

/** 描述如何到达 Raccoon 端点。 */
export interface Config {
  baseUrl: string;
}

/** 凭据的最小面（避免 upstream ↔ cred 循环依赖）。 */
export interface AuthLike {
  accessToken: string;
  officeIdentity: string;
  deviceId?: string;
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

function base(cfg?: Config): string {
  return ((cfg ?? loadConfig()[0]).baseUrl).replace(/\/+$/, "");
}

/** 对话端点路径。 */
export const CHAT_PATH = `${LLM_PREFIX}/chat/completions`;
/** 模型目录端点路径。 */
export const MODEL_CATALOG_PATH = `${LLM_PREFIX}/model_catalog`;

/** 对话端点。 */
export function chatUrl(cfg?: Config): string {
  return `${base(cfg)}${CHAT_PATH}`;
}

/** 模型目录端点（**请求头内联，不含 platform**）。 */
export function modelsUrl(cfg?: Config): string {
  return `${base(cfg)}${MODEL_CATALOG_PATH}`;
}

/** 积分余额端点。 */
export function balanceUrl(cfg?: Config): string {
  return `${base(cfg)}${POINTS_PREFIX}/balance`;
}

/** 账单端点（查奖励是否已领）。 */
export function billsUrl(cfg?: Config): string {
  return `${base(cfg)}${POINTS_PREFIX}/bills?paging.limit=50&paging.offset=0`;
}

/** 桌面端登录奖励端点（**platform 必需**；一次性新手奖励，不是每日签到）。 */
export function loginGrantUrl(cfg?: Config): string {
  return `${base(cfg)}${DESKTOP_PREFIX}/login/points/grant`;
}

/** 授权码换凭证端点（网页登录第二步；body `{authorization_code}`）。 */
export function exchangeCodeUrl(cfg?: Config): string {
  return `${base(cfg)}${EXCHANGE_PATH}`;
}

/**
 * 每日积分触发器（`GET`，**platform 必需**）。
 *
 * 官方桌面端每次启动都会打这个接口，服务端据此**按天幂等**发放每日积分
 * —— 它才是「签到」的真正触发点（发放在服务端完成，账单是权威结果）。
 */
export const SETTING_INFO_PATH = "/api/web/office/v3/setting_info";

export function settingInfoUrl(cfg?: Config): string {
  return `${base(cfg)}${SETTING_INFO_PATH}`;
}

/** 用户信息端点。 */
export function userInfoUrl(cfg?: Config): string {
  return `${base(cfg)}${AUTH_PREFIX}/user_info`;
}

// ── 请求头（三种形态）─────────────────────────────────────────────────────────

export interface HeaderOptions {
  /** 带 `Content-Type: application/json`（有 body 时）。 */
  jsonBody?: boolean;
  /** 带 `X-Client-Platform`（grant 必需；对话也有）。 */
  platform?: boolean;
}

/**
 * 构造上游请求头。
 *
 * ⚠ 对话形态**不含** `X-Client-Version` / `X-Client-Device-ID`（协议 §2.1 内联实测）；
 * client 身份头在 `cred` 里另有带这些头的版本（短信端点用）。
 */
export function buildHeaders(credential: AuthLike, opts: HeaderOptions = {}): Record<string, string> {
  const chat = opts.jsonBody ?? true;
  const platform = opts.platform ?? true;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.accessToken}`,
    // 个人账号为空串；客户端**总是**发送该头
    "X-Org-Code": credential.officeIdentity || "",
    "X-Raccoon-Language": "zh",
  };
  if (chat) {
    headers["Content-Type"] = "application/json";
    headers["Accept"] = "text/event-stream";
  } else {
    headers["Accept"] = "application/json";
  }
  if (platform) headers["X-Client-Platform"] = CLIENT_PLATFORM;
  return headers;
}

/** 探活/管理端点用的头（JSON Accept，无 platform）。 */
export function jsonHeaders(credential: AuthLike): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${credential.accessToken}`,
    "X-Org-Code": credential.officeIdentity || "",
    "X-Raccoon-Language": "zh",
    "User-Agent": USER_AGENT,
  };
}

// ── 请求体改写 ────────────────────────────────────────────────────────────────

const THINKING_TYPES = new Set(["adaptive", "enabled", "disabled"]);
const OFF_VALUES = new Set(["off", "none", "disabled", "false", "no", "0"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSystemMessage(msg: unknown): boolean {
  return isRecord(msg) && msg["role"] === "system";
}

/** `system` 提示词提升为 `messages[0]`（多条字符串内容用 `\n\n` 合并）。 */
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

/** 从 `{type: '...'}` 形态里取合法枚举；非法/缺失返回 ""。 */
function thinkingType(value: unknown): string {
  if (!isRecord(value)) return "";
  const type = value["type"];
  return typeof type === "string" && THINKING_TYPES.has(type) ? type : "";
}

/**
 * 把下游的思考意图翻译成 `extra_body.thinking.type`（**唯一有效通道**）。
 *
 * 优先级：合法 `extra_body.thinking` > 合法顶层 `thinking` > `reasoning_effort`
 * （`off`/`none`/`disabled`/`false` → `disabled`，其余任何值 → `enabled`）。
 * 三处都没有 → **不发该字段**（服务端默认 = 开启，实测与显式 enabled 等价）。
 */
export function resolveThinkingType(req: Record<string, unknown>): string {
  const explicit = thinkingType(isRecord(req["extra_body"]) ? req["extra_body"]["thinking"] : undefined);
  if (explicit) return explicit;
  const topLevel = thinkingType(req["thinking"]);
  if (topLevel) return topLevel;
  const effort = req["reasoning_effort"];
  if (effort === undefined) return "";
  if (typeof effort === "string") {
    return OFF_VALUES.has(effort.toLowerCase()) ? "disabled" : "enabled";
  }
  if (effort === false) return "disabled";
  // ⚠ 未知档位一律按开启处理（只有明确的「关闭」才关）
  return "enabled";
}

/** `max_tokens` 只放行安全正整数；其余**删掉该键**（远端输入不能崩掉整轮对话）。 */
export function sanitizeMaxTokens(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.trunc(value);
  return n > 0 ? n : undefined;
}

/**
 * 把下游 OpenAI 请求改写成 Raccoon 能接受的形状。
 *
 * - `system` 提升为 `messages[0]`
 * - 思考：翻译进 `extra_body.thinking`（**`reasoning_effort` 绝不通透**）
 * - `max_tokens` 安全化
 * - `tools` 留在顶层
 * - 恒设 `stream: true`（客户端要非流式由网关聚合）
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...req, model: upstreamModel };

  if (Array.isArray(body["messages"])) {
    body["messages"] = hoistSystemMessages(body["messages"] as unknown[]);
  }

  delete body["reasoning_effort"]; // 被服务端接受但实测无效果 ⇒ 不原样透传
  delete body["thinking"]; // 顶层 thinking 会被上游忽略

  const thinking = resolveThinkingType(req);
  if (thinking) {
    body["extra_body"] = { thinking: { type: thinking } };
  } else {
    delete body["extra_body"];
  }

  const maxTokens = sanitizeMaxTokens(body["max_tokens"]);
  if (maxTokens === undefined) delete body["max_tokens"];
  else body["max_tokens"] = maxTokens;

  body["stream"] = true;
  return body;
}

// ── 端点调用 ──────────────────────────────────────────────────────────────────

function isAuthFailure(status: number, code: number): boolean {
  return status === 401 || status === 403 || code === 200003;
}

/**
 * 拉模型目录（**内联头**：Accept json、无 platform、无 Content-Type）。
 * 401/403/200003 → `UpstreamUnauthorized`。
 */
export async function fetchModels(
  credential: AuthLike,
  cfgOverride?: Config,
): Promise<Record<string, unknown>> {
  let resp: Response;
  try {
    resp = await fetch(modelsUrl(cfgOverride), {
      headers: jsonHeaders(credential),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new Error(`Model catalog request failed: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized(`Raccoon rejected the access token (HTTP ${resp.status})`);
  }
  if (resp.status !== 200) throw new Error(`Model catalog returned HTTP ${resp.status}`);
  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (err) {
    throw new Error(`Model catalog response is not valid JSON: ${String(err)}`);
  }
  const record = isRecord(payload) ? payload : {};
  const code = typeof record["code"] === "number" ? record["code"] : 0;
  if (isAuthFailure(resp.status, code)) {
    throw new UpstreamUnauthorized(`Raccoon session expired (code=${code})`);
  }
  return record;
}

/** 探活：拉一次用户信息（`syncProfile` 之外的管理路径也用得上）。 */
export async function fetchMe(
  credential: AuthLike,
  cfgOverride?: Config,
): Promise<Record<string, unknown>> {
  let resp: Response;
  try {
    resp = await fetch(userInfoUrl(cfgOverride), {
      headers: jsonHeaders(credential),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`User info request failed: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized(`Raccoon rejected the access token (HTTP ${resp.status})`);
  }
  if (resp.status !== 200) throw new Error(`User info returned HTTP ${resp.status}`);
  const payload = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  const code = typeof payload["code"] === "number" ? payload["code"] : 0;
  if (isAuthFailure(resp.status, code)) {
    throw new UpstreamUnauthorized(`Raccoon session expired (code=${code})`);
  }
  return isRecord(payload["data"]) ? (payload["data"] as Record<string, unknown>) : {};
}

/**
 * 从模型载荷推导连接配置。Raccoon 端点固定（保留本函数是为了契约一致）。
 */
export function resolveConfig(_data: Record<string, unknown>, fallback?: Config): Config {
  return { ...(fallback ?? defaultConfig()) };
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
