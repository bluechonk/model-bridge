/**
 * 渠道动词：`mx <动词> [<cid>]` 的分发与实现（login / status / models / billing / accounts / …）。
 *
 * 从 `command-groups.ts` 拆出。共享的 `CommandContext`、目录工具与登录列表
 * 从 `./model-group.js` 取（单向依赖）。
 */

import { channels, getChannel, hasChannel, type Channel } from "../../runtime/channel.js";
import { runInChannel } from "../../runtime/channel-context.js";
import { catalogCacheFetchedAt } from "../../runtime/catalog-cache.js";

import { ledgerSnapshot, refreshBilling, scoreOf } from "../../pool/pool-usage.js";
import { poolUsagePath } from "../../runtime/paths.js";
import * as accountCli from "../account-cli.js";
import * as daemon from "../daemon.js";
import * as headless from "../headless.js";
import * as report from "../report.js";
import { CommandContext, listLocalModels, listLogins } from "./model-group.js";

export const CHANNEL_VERBS: ReadonlyArray<readonly [string, string]> = [
  ["status", "状态：带 <cid> = 该渠道；不带 = 仓库级聚合（全部渠道）"],
  ["login", "登录渠道：`login <cid>`；`login list` 列出可登录渠道与状态"],
  ["relogin", "重新授权：清掉现有凭据后重走登录流程（`relogin <cid>`）"],
  ["models", "模型：带 <cid> = 该渠道池内模型（读本地缓存）；不带 = 网关注册的模型"],
  ["billing", "额度 / 账单：带 <cid> = 该渠道；不带 = 全部渠道（只读，不经网关）"],
  ["accounts", "账号池：`accounts [<cid>] list|use <key>|add|remove <key>`"],
  ["paths", "存储落点与文件：`paths [<cid>]`（只读）"],
  ["logs", "日志尾部：`logs [<cid>]`（带 -f 持续输出）"],
];

/** 目录的来源，决定 CLI 怎么向用户交代这次列的是哪份数据。 */

export function isChannelVerb(verb: string): boolean {
  return CHANNEL_VERBS.some(([v]) => v === verb);
}

/**
 * `mx <动词> [<cid>] [参数]`。
 *
 * cid 是动词后**第一个位置参数**（且必须是已注册渠道名）：给了就是「对某渠道」，
 * 不给则各动词回落到仓库级语义（status→聚合、billing→全部、paths→全部、
 * logs→网关日志、models→网关注册的模型）。`login` / `relogin` 不给 cid 只对
 * 单渠道入口有意义（多渠道路由下报错指路）。
 */

export async function runVerb(verb: string, args: string[], ctx: CommandContext): Promise<number> {
  const first = args[0];
  const cid = first !== undefined && hasChannel(first) ? first : undefined;
  const rest = cid !== undefined ? args.slice(1) : args;

  switch (verb) {
    case "status":
      return daemon.status({
        json: ctx.json,
        addr: ctx.addr,
        ...(cid !== undefined ? { cid } : {}),
      });
    case "models":
      return cid === undefined
        ? daemon.models({ json: ctx.json, addr: ctx.addr })
        : listLocalModels(getChannel(cid), ctx.json, ctx.refresh);
    case "billing":
      return daemon.credits({ json: ctx.json, ...(cid !== undefined ? { cid } : {}) });
    case "paths":
      return report.runPaths({
        json: ctx.json,
        all: ctx.all,
        ...(cid !== undefined ? { cid } : {}),
        ...(ctx.workspace !== undefined ? { workspace: ctx.workspace } : {}),
      });
    case "logs":
      return ctx.follow
        ? daemon.followLogs(ctx.lines, ctx.json, cid)
        : daemon.logs(ctx.lines, ctx.json, cid);
    case "accounts":
      return accountCli.runAccounts({
        json: ctx.json,
        realm: ctx.realm,
        force: ctx.force,
        verb: rest[0] ?? "list",
        ...(cid !== undefined ? { cid } : {}),
        ...(rest[1] !== undefined ? { target: rest[1] } : {}),
      });
    case "login":
      // `login list`：列出可登录渠道与状态（只读）
      if (cid === undefined && rest[0] === "list") return listLogins(ctx.json);
      return runLoginVerb(cid, ctx, false);
    case "relogin":
      return runLoginVerb(cid, ctx, true);
    default:
      console.error(
        `未知动词: ${verb}\n` +
          `用法: mx <动词> [<cid>]；可用动词: ${CHANNEL_VERBS.map(([v]) => v).join(" / ")}`,
      );
      return 2;
  }
}

/** `login` / `relogin`：多渠道路由下必须给出 cid（单渠道入口可省）。 */

function runLoginVerb(cid: string | undefined, ctx: CommandContext, force: boolean): Promise<number> {
  const verb = force ? "relogin" : "login";
  if (cid === undefined && channelCountSafe() > 1) {
    console.error(
      `多渠道路由需要指定目标：\`mx ${verb} <cid>\`（可登录渠道用 \`mx login list\` 查看）。`,
    );
    return Promise.resolve(2);
  }
  return headless.runLogin({
    force,
    json: ctx.json,
    realm: ctx.realm,
    wechat: ctx.wechat,
    ...(cid !== undefined ? { cid } : {}),
  });
}

/** 已注册渠道数（用于多渠道路由判断）。 */

function channelCountSafe(): number {
  return channels().length;
}

