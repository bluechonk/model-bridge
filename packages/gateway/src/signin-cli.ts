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

interface ChannelReport {
  cid: string;
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

  return runInChannel(cid, async () => {
    let status: SigninStatus;
    try {
      status = await signin.status();
    } catch (err) {
      return { cid, failed: true, summary: `查签到状态失败: ${String(err)}` };
    }

    if (statusOnly || status.claimable === false) {
      return {
        cid,
        status,
        claimed: false,
        // 「没有端点 / 没有可领」时 summary 就是渠道自己给的那句话，原样透出（不加任何修饰）
        summary: status.summary,
      };
    }

    try {
      const outcome = await signin.claim();
      return { cid, status, claimed: outcome.ok, summary: outcome.summary, detail: outcome.detail };
    } catch (err) {
      return { cid, failed: true, status, claimed: false, summary: `领取失败: ${String(err)}` };
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
    // 仓库级：**所有**渠道都过一遍 —— 没有端点的渠道会返回它自己的一句说明，
    // 那不是失败（共享层不区分"支持/不支持"，一视同仁）
    targets = channels();
  }

  const reports: ChannelReport[] = [];
  for (const channel of targets) reports.push(await checkinOne(channel, statusOnly));

  const bad = reports.some((r) => r.failed);

  if (json) {
    console.log(JSON.stringify({ status_only: statusOnly, channels: reports }, null, 2));
    return bad ? 1 : 0;
  }

  for (const report of reports) {
    const mark = statusOnly ? "·" : report.claimed ? "✓" : "·";
    console.log(`${mark} [${report.cid}] ${report.summary}`);
  }
  return bad ? 1 : 0;
}
