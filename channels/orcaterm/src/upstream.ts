/**
 * OrcaTerm 上游客户端 —— **尚未实现（桩）**。
 *
 * 对话协议（`/messages`、`/messages/single-turn`、`/message/add-symbol`，SSE 流式）
 * 只在 WebView2 缓存里见到路径，**请求体与鉴权方式尚未抓到**，无法据实实现。
 *
 * 按 CONTRACT-TS §7：未实现的渠道必须让每个函数**立即抛错**，消息含
 * 「尚未实现 + 实现依据指引」，而不是返回空值（空值会伪装成「上游就是空」）。
 *
 * 实现依据：抓一次真实对话请求后，回填 channels/orcaterm/docs/PROTOCOL.md §3。
 */

/** 与 `cred.DEFAULT_BASE_URL` 同源；上游实现落地前仅供占位。 */
export const DEFAULT_BASE_URL = "https://orcaterm.com";

/** 对话协议形态未知；先按需要翻译层（`custom`）声明。 */
export const WIRE: "custom" = "custom";
export const DISPLAY_NAME = "OrcaTerm";

/** 上游 401。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

const HINT =
  "尚未实现：OrcaTerm 对话协议（/messages*）的请求体与鉴权方式待抓包确认，" +
  "见 channels/orcaterm/docs/PROTOCOL.md §3";

function stub(method: string): never {
  throw new Error(`OrcaTerm upstream.${method} ${HINT}`);
}

export function defaultConfig(): never {
  return stub("defaultConfig");
}

export function loadConfig(): never {
  return stub("loadConfig");
}

export function saveConfig(_cfg: unknown): never {
  return stub("saveConfig");
}

export function chatUrl(_cfg?: unknown): never {
  return stub("chatUrl");
}

export function modelsUrl(_cfg?: unknown): never {
  return stub("modelsUrl");
}

export function buildHeaders(_credential: unknown, _cfg?: unknown): never {
  return stub("buildHeaders");
}

export function buildChatBody(_req: Record<string, unknown>, _upstreamModel: string): never {
  return stub("buildChatBody");
}

export function fetchModels(_credential: unknown): never {
  return stub("fetchModels");
}

export function resolveConfig(_data: Record<string, unknown>, _fallback?: unknown): never {
  return stub("resolveConfig");
}

export function newTranslator(): never {
  return stub("newTranslator");
}
