/**
 * `checkin`（签到 / 领取）子命令。
 *
 * ## 「今日是否签到过」怎么判
 *
 * 三层，按权威性取第一个能用的：
 *
 * | 层 | 来源 | 何时可用 | 权威性 |
 * |---|---|---|---|
 * | ① 上游 | `signin.status().claimedToday` | 已登录且上游可达 | 权威 |
 * | ② 本地台账 | `state/signin.json` | 永远（含离线） | 只证明**我们**领过 |
 * | ③ unknown | 都没有 | — | 明确说"不知道"，不猜 |
 *
 * - 上游说"已签"而台账没记 → **回填台账**（自愈：覆盖「在客户端/别处签的」这种情况）
 * - 上游查询失败 → 退回台账，输出里注明上游查询失败
 * - 渠道没有「今天」这个概念（`daily === false`，如 raccoon 的一次性奖励）→ 不套"今天"话术，
 *   原样输出**渠道自己**的说明
 * - 上游答不了、台账也没有 → 也原样输出渠道自己的说明（它最清楚自己是没端点还是查不到）
 *
 * ## 各渠道叫法不同
 *
 * `check-in` / `signin` / 活动「领取」/ 上游自动发 —— 统一收敛成 `status()` + `claim()`
 * （契约必需，共享层不做能力探测）。没有端点的渠道由**渠道自己**返回一句说明。
 */

import { channels, getChannel, type Channel, type SigninStatus } from "./channel.js";
import { runInChannel } from "./channel-context.js";
import { claimedTodayPerLedger, ledgerExists, recordClaim } from "./signin-ledger.js";

export interface CheckinOptions {
  /** 只处理该渠道；省略 = 全部已注册渠道。 */
  cid?: string;
  json?: boolean;
  /** 只查状态，不领（只读）。 */
  statusOnly?: boolean;
  /** 只处理「每日」语义的渠道（跳过 raccoon 那种一次性奖励）。 */
  dailyOnly?: boolean;
  /** 今天**明确未签**的渠道 → 退出码非零（"不知道"不算失败）。 */
  failIfUnclaimed?: boolean;
}

/** 今日签到结论的依据。 */
export type CheckinBasis = "upstream" | "local" | "none";

interface ChannelReport {
  cid: string;
  /** 今日是否已签：`true` / `false` / `null`（不知道）。 */
  today: boolean | null;
  basis: CheckinBasis;
  /** 是否「每日」语义（`false` = 一次性奖励，不套"今天"话术）。 */
  daily: boolean;
  /** 上游是否明说有可领的。 */
  claimable: boolean | null;
  /** 本次是否真的领了。 */
  claimed: boolean;
  /** 查询/领取**抛错**了（未登录、上游拒绝、桩未实现）—— 影响退出码。 */
  failed?: boolean;
  summary: string;
  detail?: unknown;
}

function basisText(basis: CheckinBasis): string {
  if (basis === "upstream") return "上游";
  if (basis === "local") return "本地记录";
  return "无依据";
}

async function checkinOne(channel: Channel, options: CheckinOptions): Promise<ChannelReport> {
  const cid = channel.config.cid;
  const { signin } = channel.billing;
  const localClaimed = claimedTodayPerLedger(cid);
  const hasLedger = ledgerExists(cid);

  return runInChannel(cid, async () => {
    let status: SigninStatus | null = null;
    let upstreamError = "";
    try {
      status = await signin.status();
    } catch (err) {
      upstreamError = String(err);
    }

    const daily = status?.daily !== false;
    const upstreamToday = typeof status?.claimedToday === "boolean" ? status.claimedToday : null;

    // ① 上游权威
    let verdict: boolean | null = upstreamToday;
    let basis: CheckinBasis = upstreamToday === null ? "none" : "upstream";

    // 上游说已签 → 回填台账（自愈：覆盖"在客户端签的"）
    if (upstreamToday === true && !localClaimed) {
      try {
        recordClaim(cid, { via: "upstream-backfill" });
      } catch {
        /* 回填失败不影响判定 */
      }
    }

    // ② 台账兜底（只在「今天」这个概念成立时才用）
    if (verdict === null && daily && hasLedger) {
      verdict = localClaimed;
      basis = "local";
    }

    const base: ChannelReport = {
      cid,
      today: daily ? verdict : null,
      basis: daily ? basis : "none",
      daily,
      claimable: status?.claimable ?? null,
      claimed: false,
      summary: "",
    };

    // 上游答不了、台账也没有 → 交给**渠道自己**的说法（它最清楚是"没端点"还是"查不到"）
    const unknownSummary = status
      ? status.summary
      : `今天是否签到未知（上游查询失败: ${upstreamError}）`;

    // ── 只读：只报"今天"，不领 ──
    if (options.statusOnly) {
      if (base.today === null && base.basis === "none") {
        return { ...base, ...(status ? {} : { failed: true }), summary: unknownSummary };
      }
      return {
        ...base,
        summary:
          base.today === true
            ? `今天已签到（依据：${basisText(basis)}）`
            : `今天未签到${base.claimable ? "，有可领的" : ""}（依据：${basisText(basis)}）`,
      };
    }

    // ── 写路径 ──
    // 连"有没有可领的"都问不到（查询失败）→ 不发领取请求（盲领是鲁莽的）
    if (!status) {
      return { ...base, failed: true, summary: unknownSummary };
    }

    // 上游明说"没有可领的" → 也不发请求；能判"今天"就给今天的话术，否则用渠道的说法
    if (status.claimable === false) {
      if (base.today === null && base.basis === "none") return { ...base, summary: unknownSummary };
      return {
        ...base,
        summary:
          base.today === true
            ? `今天已签到（依据：${basisText(basis)}）`
            : `今天未签到，但没有可领的（依据：${basisText(basis)}）`,
      };
    }

    try {
      const outcome = await signin.claim();
      if (outcome.ok) {
        // 真领成功 → 记台账（下次离线也答得上）
        try {
          recordClaim(cid, { via: "cli" });
        } catch {
          /* 台账写不进去不影响本次结果 */
        }
      }
      return {
        ...base,
        today: outcome.ok ? true : base.today,
        basis: outcome.ok ? "local" : base.basis,
        claimed: outcome.ok,
        summary: outcome.summary,
        detail: outcome.detail,
      };
    } catch (err) {
      return { ...base, failed: true, summary: `领取失败: ${String(err)}` };
    }
  });
}

/** `checkin` 子命令实现。返回进程退出码。 */
export async function runCheckin(options: CheckinOptions = {}): Promise<number> {
  const { cid, json = false, statusOnly = false, dailyOnly = false, failIfUnclaimed = false } = options;
  let targets: Channel[];
  if (cid !== undefined) {
    targets = [getChannel(cid)];
  } else if (channels().length === 0) {
    console.error("没有渠道被注册（入口忘了 import 渠道包？）");
    return 2;
  } else {
    targets = channels();
  }

  const reports: ChannelReport[] = [];
  for (const channel of targets) {
    const report = await checkinOne(channel, options);
    if (dailyOnly && !report.daily) continue; // --daily-only：跳过一次性奖励
    reports.push(report);
  }

  const failed = reports.some((r) => r.failed);
  const claimedNow = reports.filter((r) => r.claimed).length;
  const signedToday = reports.filter((r) => r.today === true).length;
  const unknown = reports.filter((r) => r.today === null).length;
  const unclaimed = reports.filter((r) => r.today === false).length;
  // §9 的一行摘要：一屏看全"今天签了几个"
  const summaryLine = `今日已签 ${signedToday}/${reports.length}${unknown > 0 ? `（${unknown} 个未知）` : ""}`;

  if (json) {
    console.log(
      JSON.stringify(
        {
          status_only: statusOnly,
          summary: {
            total: reports.length,
            signed_today: signedToday,
            unclaimed,
            unknown,
            claimed_now: claimedNow,
          },
          channels: reports,
        },
        null,
        2,
      ),
    );
    return failed || (failIfUnclaimed && unclaimed > 0) ? 1 : 0;
  }

  for (const report of reports) {
    const mark = report.today === true ? "✓" : report.today === false ? "·" : "?";
    console.log(`${mark} [${report.cid}] ${report.summary}`);
  }
  console.log(summaryLine);
  if (failIfUnclaimed && unclaimed > 0) {
    console.error(`有 ${unclaimed} 个渠道今天明确未签（--fail-if-unclaimed）`);
    return 1;
  }
  return failed ? 1 : 0;
}
