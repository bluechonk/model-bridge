/**
 * `checkin`（签到 / 领取）子命令的实现。
 *
 * 各渠道对这件事的叫法不一样：`check-in` / `signin` / 活动「领取」(claim) /
 * 上游自动发放（无端点）。统一收敛成本模块 + `SigninModule` 契约：
 *
 * - `<cid> checkin` —— 先查状态，有可领的就领（**写**操作）；没有则明确说明并跳过
 * - `<cid> checkin --status` —— 只查状态（**只读**，不领）
 * - 不带 `<cid>`（仓库级）—— 逐个渠道跑一遍：查得到的都列出来，能领的都领掉
 */

import { channels, getChannel, type Channel, type SigninStatus } from "./channel.js";
import { runInChannel } from "./channel-context.js";

export interface CheckinOptions {
  /** 只处理该渠道；省略 = 全部已注册渠道。 */
  cid?: string;
  json?: boolean;
  /** 只查状态，不领（只读）。 */
  statusOnly?: boolean;
}

function noSignin(channel: Channel): string {
  return (
    `${channel.config.cid}: 该渠道没有签到端点 —— ` +
    `上游不发签到奖励（或奖励由上游自动发放，见 docs/protocols/ 或 docs/journals/）`
  );
}

interface ChannelReport {
  cid: string;
  supported: boolean;
  /** 查询或领取**抛错**了（未登录、上游拒绝…）—— 影响退出码。 */
  failed?: boolean;
  status?: SigninStatus;
  claimed?: boolean;
  summary: string;
  detail?: unknown;
}

/** 处理单个渠道：查状态 → （可选）领取。 */
async function checkinOne(channel: Channel, statusOnly: boolean): Promise<ChannelReport> {
  const cid = channel.config.cid;
  const { signin } = channel.billing;
  if (!signin) return { cid, supported: false, summary: noSignin(channel) };

  return runInChannel(cid, async () => {
    let status: SigninStatus;
    try {
      status = await signin.status();
    } catch (err) {
      return { cid, supported: true, failed: true, summary: `查签到状态失败: ${String(err)}` };
    }

    if (statusOnly || status.claimable === false) {
      return {
        cid,
        supported: true,
        status,
        claimed: false,
        summary: status.claimable === false ? `${status.summary}（无可领，未领）` : status.summary,
      };
    }

    try {
      const outcome = await signin.claim();
      return {
        cid,
        supported: true,
        status,
        claimed: outcome.ok,
        summary: outcome.summary,
        detail: outcome.detail,
      };
    } catch (err) {
      return {
        cid,
        supported: true,
        failed: true,
        status,
        claimed: false,
        summary: `领取失败: ${String(err)}`,
      };
    }
  });
}

/** `checkin` 子命令实现。返回进程退出码。 */
export async function runCheckin(options: CheckinOptions = {}): Promise<number> {
  const { cid, json = false, statusOnly = false } = options;
  let targets: Channel[];
  if (cid !== undefined) {
    targets = [getChannel(cid)];
  } else if (channels().length === 0) {
    console.error("没有渠道被注册（入口忘了 import 渠道包？）");
    return 2;
  } else {
    // 仓库级：只挑**声明了签到能力**的渠道，别把 10 个"没端点"的噪音也打出来
    targets = channels().filter((c) => Boolean(c.billing.signin));
    if (targets.length === 0) {
      console.error("没有任何渠道支持签到（已注册的渠道都没实现 signin 能力）");
      return 2;
    }
  }

  const reports: ChannelReport[] = [];
  for (const channel of targets) reports.push(await checkinOne(channel, statusOnly));

  const bad = reports.some((r) => !r.supported || r.failed);

  if (json) {
    console.log(JSON.stringify({ status_only: statusOnly, channels: reports }, null, 2));
    return bad ? 1 : 0;
  }

  for (const report of reports) {
    if (!report.supported) {
      console.log(`· ${report.summary}`);
      continue;
    }
    const mark = statusOnly ? "·" : report.claimed ? "✓" : "·";
    console.log(`${mark} [${report.cid}] ${report.summary}`);
  }
  return bad ? 1 : 0;
}
