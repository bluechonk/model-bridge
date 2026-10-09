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
  constructor(message = "this channel has no public credits endpoint") {
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
      "CatPaw (Meituan MiaoShou) gateway has no public credits endpoint; cannot query balance",
    ),
  );
}

// ── 签到 / 领取能力（共享层 CLI 的 `<cid> checkin` 用；契约要求**每个渠道都提供**）──────

import type { SigninModule } from "@model-bridge/gateway";
/**
 * 签到 / 领取能力（`<cid> checkin`）。
 *
 * **CatPaw 没有签到端点** —— 额度随账号订阅提供，上游没有签到 / 领取接口（见 docs/protocols/catpaw/）
 *
 * 按契约仍要提供这个能力（共享层对**所有**渠道一视同仁，不做能力探测），
 * 所以这里不假装有端点、也不当成错误：`status()` 只说"没有可领的"，
 * `claim()` 原样回同一句说明。用户看到的就是这句。
 */
const NO_ENDPOINT = "CatPaw 没有签到端点 —— 额度随账号订阅提供，上游没有签到 / 领取接口（见 docs/protocols/catpaw/）";

export const signin: SigninModule = {
  async status() {
    return { claimable: false, summary: NO_ENDPOINT };
  },
  async claim() {
    return { ok: true, summary: NO_ENDPOINT };
  },
};
