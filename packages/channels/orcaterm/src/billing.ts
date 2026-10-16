/**
 * OrcaTerm 额度 / 签到 —— **尚未实现（桩）**。
 *
 * OrcaTerm 确实有一套自有 CAPI（`/cgi/v2/buy/index`、`/cgi/v2/user/getInfo`），
 * 但**额度与签到端点的响应形态未验证**，不臆造数字也不谎报「没有端点」。
 *
 * 与 catpaw 的「上游确实没有端点」不同：这里是**未实现**，所以按 CONTRACT-TS §7
 * 如实说明，而不是返回 0 或假装查成功。
 */

import type { SigninModule } from "@modelmux/gateway";

const HINT =
  "尚未实现：OrcaTerm 额度/签到端点未验证（/cgi/v2/*，见 channels/orcaterm/docs/PROTOCOL.md §2）";

/** 额度查询失败。 */
export class CreditsError extends Error {
  override name = "CreditsError";
  constructor(message = HINT) {
    super(message);
  }
}

/** 查询额度：当前明确报「未实现」，不返回 0 误导。 */
export function fetchCredits(): Promise<never> {
  return Promise.reject(new CreditsError());
}

/**
 * 签到 / 领取能力（契约要求每个渠道都提供）。
 *
 * 不假装有端点、也不当成错误：`claimable: null` 表示「查不到」，
 * `claim()` 回 `ok: false` + 同一说明。
 */
export const signin: SigninModule = {
  async status() {
    return { claimable: null, summary: HINT };
  },
  async claim() {
    return { ok: false, summary: HINT };
  },
};
