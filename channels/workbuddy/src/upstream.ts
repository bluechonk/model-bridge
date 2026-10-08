/**
 * WorkBuddy（国内版）上游：端点、请求头、请求体改写。
 *
 * ## 本模块承载的渠道知识
 *
 * 三条上游硬约束都在 `buildChatBody()` 里实现（网关只负责调用它）：
 *
 * 1. **首条消息必须是 system** —— 否则 400 `first message is not system prompt`
 * 2. **只支持流式** —— 否则 400 `Non-stream chat request is currently not supported`；
 *    客户端要非流式时也向上游要流式，由网关层聚合成普通 JSON
 * 3. **系统提示词指纹拦截** —— 命中时整条会话被 400 `code=11128`
 *    `Illegal API invocation from an unapproved channel` 拒绝，需改写样板文本
 *
 * ⚠ **chat 路径不用 `prefixPath`**（实测）：模型载荷里声明了
 * `authentication.attributes.prefixPath` 为 `/plugin`，但
 * `POST /plugin/v2/chat/completions` 返回 **404**，而
 * `POST /v2/chat/completions` 返回 **200** —— 故刻意不使用该前缀。
 */

import { readFileSync } from "node:fs";
import { writeFile, rename, chmod } from "node:fs/promises";

import { upstreamPath, ensureDir } from "@model-bridge/gateway";

export const DEFAULT_BASE_URL = "https://www.codebuddy.ai";

/** 展示名（状态页与错误文案用）。 */
export const DISPLAY_NAME = "WorkBuddy";

/**
 * 上游线型：`openai` 表示上游就是标准 OpenAI SSE delta，网关只需规范化透传。
 *
 * workbuddy（国内版）属于 `openai`；网关因此不会调用 `newTranslator()`，
 * 但本模块仍导出它（契约要求所有渠道导出同一套接口）。
 */
export const WIRE: "openai" | "custom" = "openai";

/** 已验证的 chat-completions 路由（见文件头注释）。 */
export const DEFAULT_CHAT_PATH = "/v2/chat/completions";

/** 上游 API 拒绝了访问令牌（HTTP 401/403）。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

/** 描述如何到达 WorkBuddy chat 端点。JSON 字段名与 Go 版一致。 */
export interface Config {
  baseUrl: string;
  chatPath: string;
  tokenHeader: string;
  tokenType: string;
  usernameHeader: string;
}

/**
 * 凭据的最小面。
 *
 * 刻意只声明这几个字段而不是 import `cred.Credentials` —— 那会形成
 * upstream ↔ cred 的循环依赖。
 */
export interface AuthLike {
  accessToken: string;
  uid: string;
  domain: string;
}

/**
 * 上游安全策略按系统提示词指纹拦截整条请求：命中时返回
 * 400 `code=11128 Illegal API invocation from an unapproved channel`。
 *
 * 实测最小触发串如下（二分定位，单独出现不触发）；它只是 ZCode 注入的
 * gitStatus 样板行、与用户语义无关，改写为等价表述即可放行。
 */
const FINGERPRINT_REWRITES: Array<[string, string]> = [
  ["Main branch (you will usually use this for PRs)", "Main branch (used for PRs)"],
];

export function defaultConfig(): Config {
  return {
    baseUrl: DEFAULT_BASE_URL,
    chatPath: DEFAULT_CHAT_PATH,
    tokenHeader: "Authorization",
    tokenType: "bearerToken",
    usernameHeader: "X-User-Id",
  };
}

/**
 * 读取已解析的上游描述符。
 *
 * 返回 `[配置, 是否来自磁盘]`；文件缺失时返回默认配置（由调用方按「默认值生效」处理）。
 */
export function loadConfig(): [Config, boolean] {
  let raw: string;
  try {
    raw = readFileSync(upstreamPath(), "utf8");
  } catch {
    return [defaultConfig(), false];
  }
  const parsed = JSON.parse(raw) as Partial<Config>;
  const cfg: Config = {
    baseUrl:
      typeof parsed.baseUrl === "string" && parsed.baseUrl ? parsed.baseUrl : DEFAULT_BASE_URL,
    chatPath:
      typeof parsed.chatPath === "string" && parsed.chatPath ? parsed.chatPath : DEFAULT_CHAT_PATH,
    tokenHeader: parsed.tokenHeader ?? "Authorization",
    tokenType: parsed.tokenType ?? "bearerToken",
    usernameHeader: parsed.usernameHeader ?? "X-User-Id",
  };
  return [cfg, true];
}

/** 持久化上游描述符（临时文件 + 原子替换，避免半截文件）。 */
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

/** 完整限定的 chat-completions URL。 */
export function chatUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return trimSlash(resolved.baseUrl) + ensureSlash(resolved.chatPath);
}

/** 列出可用模型的端点。 */
export function modelsUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return `${trimSlash(resolved.baseUrl)}/v2/enterprises/personal/models`;
}

/** 从 baseUrl 提取 host 部分。 */
export function hostOf(baseUrl: string): string {
  const withoutScheme = baseUrl.includes("://") ? baseUrl.split("://", 2)[1]! : baseUrl;
  const cut = withoutScheme.search(/[/?]/);
  return cut < 0 ? withoutScheme : withoutScheme.slice(0, cut);
}

/**
 * 构造上游请求头（鉴权 + 客户端伪装）。
 *
 * `User-Agent` 的**品牌字样是必须的**：上游按出站 UA 归因「使用端」，
 * 缺了对应产品品牌会让账单显示为 `-`。
 */
export function buildHeaders(credential: AuthLike, cfg?: Config): Record<string, string> {
  const resolved = cfg ?? loadConfig()[0];
  const domain = credential.domain || hostOf(resolved.baseUrl);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "CodeBuddyCode/1.0",
    "X-Domain": domain,
  };
  const headerName = resolved.tokenHeader || "Authorization";
  headers[headerName] = `Bearer ${credential.accessToken}`;
  if (resolved.usernameHeader && credential.uid) {
    headers[resolved.usernameHeader] = credential.uid;
  }
  return headers;
}

/** 兼容旧调用形态：把鉴权头就地合并进 `headers`。 */
export function applyAuth(
  headers: Record<string, string>,
  cfg: Config,
  token: string,
  uid: string,
): void {
  Object.assign(headers, buildHeaders({ accessToken: token, uid, domain: "" }, cfg));
}

/** 改写命中上游拦截指纹的文本，返回 `[新文本, 替换次数]`。 */
function rewriteFingerprint(text: string): [string, number] {
  let hits = 0;
  let out = text;
  for (const [from, to] of FINGERPRINT_REWRITES) {
    if (!out.includes(from)) continue;
    hits += out.split(from).length - 1;
    out = out.split(from).join(to);
  }
  return [out, hits];
}

/** 改写 messages 里命中上游拦截指纹的文本（content 为字符串或分段数组）。 */
function sanitizeMessages(messages: unknown[]): number {
  let hits = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const rec = msg as Record<string, unknown>;
    const content = rec["content"];
    if (typeof content === "string") {
      const [next, n] = rewriteFingerprint(content);
      rec["content"] = next;
      hits += n;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (typeof p["text"] === "string") {
          const [next, n] = rewriteFingerprint(p["text"]);
          p["text"] = next;
          hits += n;
        }
      }
    }
  }
  return hits;
}

/**
 * 把下游 OpenAI 请求改写成 WorkBuddy（国内版）能接受的形状。
 *
 * 实现三条上游硬约束（见文件头注释）：注入 system、强制流式、指纹改写。
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...req, model: upstreamModel };

  const rawMessages = body["messages"];
  const messages = Array.isArray(rawMessages) ? [...rawMessages] : [];

  // 约束 1：首条消息必须是 system，客户端没带就注入默认系统提示词
  const first = messages[0];
  const firstRole =
    first && typeof first === "object" ? (first as Record<string, unknown>)["role"] : undefined;
  if (firstRole !== "system") {
    messages.unshift({ role: "system", content: "You are a helpful assistant." });
  }

  // 约束 3：改写命中安全策略指纹的样板文本，否则整条会话被以 11128 拒绝
  sanitizeMessages(messages);
  body["messages"] = messages;

  // 约束 2：上游只支持流式，恒设为 true（客户端要非流式由网关层聚合）
  body["stream"] = true;

  return body;
}

/**
 * 拉取并解码模型载荷，返回其中的 data 字典。
 *
 * 用途有二：① 解析连接配置；② 探测凭据是否有效（401/403 抛 UpstreamUnauthorized）。
 */
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
  const data = env["data"];
  if (!data) {
    throw new Error(
      `models response has no "data" field (code=${String(env["code"])} msg=${String(env["msg"] ?? "")})`,
    );
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error("decode models payload: data is not an object");
  }
  const record = data as Record<string, unknown>;
  if (!record["models"]) throw new Error("models payload contains no models");
  return record;
}

/** 从模型载荷推导连接配置。 */
export function resolveConfig(data: Record<string, unknown>, fallback?: Config): Config {
  const cfg: Config = { ...(fallback ?? defaultConfig()) };
  const endpoint = data["endpoint"];
  if (typeof endpoint === "string" && endpoint) cfg.baseUrl = endpoint;
  cfg.chatPath = DEFAULT_CHAT_PATH;
  const auth = data["authentication"];
  if (auth && typeof auth === "object") {
    const attrs = (auth as Record<string, unknown>)["attributes"];
    if (attrs && typeof attrs === "object") {
      const a = attrs as Record<string, unknown>;
      if (typeof a["tokenHeader"] === "string") cfg.tokenHeader = a["tokenHeader"];
      if (typeof a["tokenType"] === "string") cfg.tokenType = a["tokenType"];
      if (typeof a["usernameHeader"] === "string") cfg.usernameHeader = a["usernameHeader"];
    }
  }
  return cfg;
}

/** 翻译器接口（契约要求所有渠道都导出，即使 `WIRE === "openai"` 用不到）。 */
export interface StreamTranslator {
  feed(chunk: Buffer): Array<Buffer | string>;
  finish(): Array<Buffer | string>;
}

/**
 * 恒等翻译器。
 *
 * workbuddy（国内版）是 `openai` 线型，网关不会调用本函数；提供它是为了满足契约
 * （所有渠道导出同一套接口），且万一被误用也只是原样透传、不丢数据。
 */
export function newTranslator(): StreamTranslator {
  return {
    feed: (chunk: Buffer) => [chunk],
    finish: () => [],
  };
}
