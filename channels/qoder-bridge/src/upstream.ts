/**
 * Qoder 渠道的 upstream.ts（**待实现**）。
 *
 * 实现依据：`docs/protocols/qoder/PROTOCOL.md`（协议规格）与 `../docs/CONTRACT-TS.md`（接口契约）。
 *
 * ⚠ 占位刻意让调用**立即失败并说明原因**，而不是返回空值 ——
 * 返回空值会让网关看起来在工作（模型列表恒为空、请求静默失败），
 * 比直接报错更难排查。
 */

const TODO = "qoder-bridge 的 upstream.ts 尚未实现；请按 docs/protocols/qoder/PROTOCOL.md 实现本模块。";

function todo(what: string): never {
  throw new Error(`${TODO}（${what}）`);
}

export const DEFAULT_BASE_URL = "https://example.invalid";

/** 上游线型：`openai`（标准 SSE delta）或 `custom`（需翻译层）。 */
export const WIRE: "openai" | "custom" = "openai";

/** 展示名（状态页与日志用）。 */
export const DISPLAY_NAME = "Qoder";

export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

export interface Config {
  baseUrl: string;
}

export function defaultConfig(): Config {
  todo("upstream.defaultConfig");
}

export function loadConfig(): [Config, boolean] {
  todo("upstream.loadConfig");
}

export async function saveConfig(_cfg: Config): Promise<void> {
  todo("upstream.saveConfig");
}

export function chatUrl(_cfg?: Config): string {
  todo("upstream.chatUrl");
}

export function modelsUrl(_cfg?: Config): string {
  todo("upstream.modelsUrl");
}

export function buildHeaders(_credential: unknown): Record<string, string> {
  todo("upstream.buildHeaders");
}

export function buildChatBody(
  _req: Record<string, unknown>,
  _upstreamModel: string,
): Record<string, unknown> {
  todo("upstream.buildChatBody");
}

export async function fetchModels(_credential: unknown): Promise<Record<string, unknown>> {
  todo("upstream.fetchModels");
}

/** 从模型载荷推导连接配置（登录成功后由 auth-flow 调用）。 */
export function resolveConfig(_data: Record<string, unknown>, _fallback?: Config): Config {
  todo("upstream.resolveConfig");
}

/** 仅 `WIRE === "custom"` 时需要实现。 */
export interface StreamTranslator {
  feed(chunk: Buffer): Array<Buffer | string>;
  finish(): Array<Buffer | string>;
}

export function newTranslator(): StreamTranslator {
  todo("upstream.newTranslator");
}
