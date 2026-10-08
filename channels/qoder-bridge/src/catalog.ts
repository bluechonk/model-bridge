/**
 * Qoder 渠道的 catalog.ts（**待实现**）。
 *
 * 实现依据：`docs/protocols/qoder/PROTOCOL.md`（协议规格）与 `../docs/CONTRACT-TS.md`（接口契约）。
 *
 * ⚠ 占位刻意让调用**立即失败并说明原因**，而不是返回空值 ——
 * 返回空值会让网关看起来在工作（模型列表恒为空、请求静默失败），
 * 比直接报错更难排查。
 */

const TODO = "qoder-bridge 的 catalog.ts 尚未实现；请按 docs/protocols/qoder/PROTOCOL.md 实现本模块。";

function todo(what: string): never {
  throw new Error(`${TODO}（${what}）`);
}

/** 对外暴露的模型 id（短名）。 */
export function exposedIds(): string[] {
  todo("catalog.exposedIds");
}

/** 短名 → 上游 slug；未知名称原样返回。 */
export function resolveModel(_name: string): string {
  todo("catalog.resolveModel");
}
