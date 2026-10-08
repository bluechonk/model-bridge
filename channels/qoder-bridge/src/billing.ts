/**
 * Qoder 渠道的 billing.ts（**待实现**）。
 *
 * 实现依据：`docs/protocols/qoder/PROTOCOL.md`（协议规格）与 `../docs/CONTRACT-TS.md`（接口契约）。
 *
 * ⚠ 占位刻意让调用**立即失败并说明原因**，而不是返回空值 ——
 * 返回空值会让网关看起来在工作（模型列表恒为空、请求静默失败），
 * 比直接报错更难排查。
 */

const TODO = "qoder-bridge 的 billing.ts 尚未实现；请按 docs/protocols/qoder/PROTOCOL.md 实现本模块。";

function todo(what: string): never {
  throw new Error(`${TODO}（${what}）`);
}

export class CreditsError extends Error {
  override name = "CreditsError";
}

export interface CreditPackage {
  name: string;
  remain: number;
  size: number;
  used?: number;
  unit?: string;
  days_left?: number | null;
  [key: string]: unknown;
}

export interface CreditsResult {
  ok: true;
  total: {
    remain: number;
    size: number;
    used: number;
    unit: string;
    remain_percent: number;
  };
  packages: CreditPackage[];
  claimable?: Array<Record<string, unknown>>;
}

export async function fetchCredits(
  _options?: { refreshOn401?: boolean },
): Promise<CreditsResult> {
  todo("billing.fetchCredits");
}
