/**
 * Qoder 渠道的 cred.ts（**待实现**）。
 *
 * 实现依据：`docs/protocols/qoder/PROTOCOL.md`（协议规格）与 `../docs/CONTRACT-TS.md`（接口契约）。
 *
 * ⚠ 占位刻意让调用**立即失败并说明原因**，而不是返回空值 ——
 * 返回空值会让网关看起来在工作（模型列表恒为空、请求静默失败），
 * 比直接报错更难排查。
 */

const TODO = "qoder-bridge 的 cred.ts 尚未实现；请按 docs/protocols/qoder/PROTOCOL.md 实现本模块。";

function todo(what: string): never {
  throw new Error(`${TODO}（${what}）`);
}

export const DEFAULT_BASE_URL = "https://example.invalid";

export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
}

export interface Credentials {
  readonly accessToken: string;
  readonly uid: string;
  readonly domain: string;
}

export function load(): Credentials {
  todo("cred.load");
}

export async function save(_c: Credentials): Promise<void> {
  todo("cred.save");
}

export async function login(
  _baseUrl?: string,
  _options?: { onUrl?: (url: string) => void; onStatus?: (msg: string) => void },
): Promise<Credentials> {
  todo("cred.login");
}

export async function refresh(_c: Credentials): Promise<Credentials> {
  todo("cred.refresh");
}

export function resolveBaseUrl(_realm = "auto"): string {
  todo("cred.resolveBaseUrl");
}
