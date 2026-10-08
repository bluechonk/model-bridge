/**
 * CatPaw 额度查询。
 *
 * 美团妙手（CatPaw）网关**不暴露额度查询端点**（`/model-types` 与
 * `/conversation/*` 都不返回余额信息）。
 *
 * 按 CONTRACT-TS.md §5.4：「没有额度端点的渠道，抛 `CreditsError(...)` 并说明
 * 原因 —— 不要伪造数字。」
 */

/** 额度查询失败。 */
export class CreditsError extends Error {
  override name = "CreditsError";
  constructor(message = "该渠道没有公开的额度查询端点") {
    super(message);
  }
}

/**
 * 查询额度（未实现）。
 *
 * catpaw 网关不暴露任何余额/积分/额度端点，无法查询。
 * 抛 CreditsError 让 UI 明确显示「不可用」，而不是显示 0 误导用户。
 */
export function fetchCredits(): Promise<never> {
  return Promise.reject(
    new CreditsError(
      "CatPaw（美团妙手）网关没有公开的额度查询端点，无法查询余额",
    ),
  );
}