/**
 * 命令分组：`model-bridge <cid> <动词>` 与 `model-bridge model <子命令>`。
 *
 * 设计取向（对应「像 playwright-cli 那样有子命令」的诉求）：
 * - **网关生命周期是仓库级的**：`start/stop/restart/status/logs/serve` 不带渠道，
 *   因为它们操作的是那个服务全部渠道的网关。
 * - **以渠道为第一参数**：`<cid> login` / `<cid> billing` / `<cid> checkin` …
 *   这是「对某个渠道做点什么」的自然读法。
 * - **分组**：`model list`（全部池子）、`model show <cid>`（单个池子）。
 * - 原来的扁平形式（`status --channel <cid>`、`credits`、`channels`…）**全部保留**，
 *   所以既有脚本与插件命令不用改。
 */

import { channelCount, channels, getChannel, type Channel } from "./channel.js";
import { runInChannel } from "./channel-context.js";
import { poolIds, qualifiedId } from "./model-pool.js";
import * as accountCli from "./account-cli.js";
import * as daemon from "./daemon.js";
import * as headless from "./headless.js";
import * as report from "./report.js";
import * as signinCli from "./signin-cli.js";

export interface CommandContext {
  json: boolean;
  quiet: boolean;
  addr: string;
  uiPort: number;
  realm: string;
  force: boolean;
  /** `checkin --status`：只查不领。 */
  statusOnly: boolean;
  /** `checkin --daily-only`：只处理"每日"语义的渠道（跳过一次性奖励）。 */
  dailyOnly: boolean;
  /** `checkin --fail-if-unclaimed`：今天明确未签 → 退出码非零。 */
  failIfUnclaimed: boolean;
  lines: number;
  workspace?: string;
}

/** 渠道级动词（供帮助文本与未知动词提示；别名在括号里）。 */
export const CHANNEL_VERBS: ReadonlyArray<readonly [string, string]> = [
  ["status", "该渠道的登录 / 凭证状态（默认动词）"],
  ["login", "浏览器授权登录该渠道（`--realm intl|cn`）"],
  ["models", "该渠道池内的模型 id（读本地目录，不需要网关）"],
  ["billing", "剩余额度 / 账单（别名 credits；只读，不经网关）"],
  ["checkin", "签到 / 领奖励（`--status` 只查不领、`--daily-only` 跳过一次性；别名 signin）"],
  ["accounts", "账号池：`list` / `use <key>` / `add` / `remove <key>`"],
  ["paths", "该渠道的存储落点与文件（只读）"],
  ["logs", "该渠道的网关日志尾部"],
];

function listLocalModels(channel: Channel, json: boolean): number {
  const cid = channel.config.cid;
  const ids = runInChannel(cid, () => {
    try {
      return poolIds(channel);
    } catch {
      return [] as string[];
    }
  });
  if (json) {
    console.log(
      JSON.stringify(
        { cid, display: channel.upstream.DISPLAY_NAME, models: ids.map((id) => `${cid}/${id}`) },
        null,
        2,
      ),
    );
    return 0;
  }
  if (ids.length === 0) {
    console.log(`${cid}: 池内没有可用模型（未登录，或上游目录拉取失败）`);
    return 0;
  }
  for (const id of ids) console.log(`${cid}/${id}`);
  return 0;
}

/** 全部渠道的模型池一览（`model list` 与兼容的 `channels` 共用）。 */
export function listAllModels(json: boolean): number {
  const list = channels();
  if (list.length === 0) {
    console.error("没有渠道被注册（入口忘了 import 渠道包？）");
    return 2;
  }
  const multi = channelCount() > 1;
  const rows = list.map((channel) => {
    const ids = runInChannel(channel.config.cid, () => {
      try {
        return poolIds(channel);
      } catch {
        return [] as string[];
      }
    });
    return {
      cid: channel.config.cid,
      display: channel.upstream.DISPLAY_NAME,
      version: channel.config.version,
      models: ids.map((id) => qualifiedId(channel.config.cid, id, multi)),
      raw: ids,
    };
  });

  if (json) {
    console.log(JSON.stringify(rows.map(({ raw, ...rest }) => ({ ...rest, raw_models: raw })), null, 2));
    return 0;
  }
  console.log(`${list.length} 个渠道（模型池）${multi ? "；对外模型 id 形如 <cid>/<模型>" : ""}：`);
  for (const row of rows) {
    console.log(`  ${row.cid.padEnd(12)} ${row.display.padEnd(18)} ${row.models.join(", ") || "（无可用模型）"}`);
  }
  return 0;
}

/** `model <list|show <cid>>`。 */
export function runModelGroup(args: string[], ctx: CommandContext): number {
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list":
    case "ls":
      return listAllModels(ctx.json);
    case "show":
    case "get": {
      const cid = args[1];
      if (!cid) {
        console.error("用法: model show <cid>");
        return 2;
      }
      return listLocalModels(getChannel(cid), ctx.json);
    }
    default:
      console.error(`未知的 model 子命令: ${sub}（可用: list / show <cid>）`);
      return 2;
  }
}

/** `model-bridge <cid> <动词> [参数]`。 */
export async function runChannelCommand(
  cid: string,
  args: string[],
  ctx: CommandContext,
): Promise<number> {
  const verb = args[0] ?? "status";
  const rest = args.slice(1);
  const channel = getChannel(cid); // 未注册会抛错，调用方已确认

  switch (verb) {
    case "status":
      return daemon.status({ cid, json: ctx.json, addr: ctx.addr, uiPort: ctx.uiPort });
    case "login":
      return headless.runLogin({ cid, json: ctx.json, realm: ctx.realm, force: ctx.force });
    case "models":
      return listLocalModels(channel, ctx.json);
    case "billing":
    case "credits":
      return daemon.credits({ cid, json: ctx.json });
    case "checkin":
    case "check-in":
    case "signin":
      return signinCli.runCheckin({
        cid,
        json: ctx.json,
        statusOnly: ctx.statusOnly,
        dailyOnly: ctx.dailyOnly,
        failIfUnclaimed: ctx.failIfUnclaimed,
      });
    case "accounts":
      return accountCli.runAccounts({
        cid,
        json: ctx.json,
        verb: rest[0] ?? "list",
        ...(rest[1] !== undefined ? { target: rest[1] } : {}),
      });
    case "paths":
      return report.runPaths({ cid, json: ctx.json });
    case "logs":
      return daemon.logs(ctx.lines, ctx.json, cid);
    case "start":
    case "stop":
    case "restart":
      console.error(
        `网关是**仓库级**的：\`model-bridge ${verb}\` 管的是服务全部渠道的那个网关。\n` +
          `只想跑 ${cid} 一个渠道调试，用 \`node channels/${cid}/dist/cli.js ${verb}\`（独立端口）。`,
      );
      return 2;
    default:
      console.error(
        `未知动词: ${verb}\n` +
          `用法: model-bridge <cid> <动词>；可用动词: ${CHANNEL_VERBS.map(([v]) => v).join(" / ")}`,
      );
      return 2;
  }
}
