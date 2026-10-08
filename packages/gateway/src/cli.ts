/**
 * 命令行入口：`serve`/`login`（运行）+ `start`/`stop`/`restart`/`status`/`models`/`credits`/`logs`（管理）。
 *
 * 管理类子命令不依赖网关进程，直接操作守护进程与本地文件；
 * 运行类子命令（serve/login）走 headless。
 *
 * 本文件是共享层：调用方（各 bridge 的 `src/cli.ts`）必须**先注册渠道**，
 * 再调用 `main()`。故这里不再自带「直接运行本文件」的入口判断。
 */

import { parseArgs } from "node:util";

import { channelCount, channels, getChannel, hasChannel, type Channel } from "./channel.js";
import { CHANNEL_VERBS } from "./command-groups.js";
import * as groups from "./command-groups.js";
import * as signinCli from "./signin-cli.js";
import { runInChannel } from "./channel-context.js";
import { poolIds, qualifiedId } from "./model-pool.js";
import { defaultAddr, defaultUiPort, version } from "./cli-consts.js";
import * as daemon from "./daemon.js";
import * as headless from "./headless.js";
import * as accountCli from "./account-cli.js";
import * as report from "./report.js";

/** 生成当前渠道的帮助文本。 */
export function usage(): string {
  const single = channelCount() === 1;
  const cid = single ? getChannel().config.cid : "model-bridge";
  const display = single ? getChannel().config.display : "多渠道路由（模型池）";
  const verbLines = CHANNEL_VERBS.map(([v, d]) => `  ${("<cid> " + v).padEnd(24)} ${d}`);
  return `${cid} — ${display} OpenAI Chat Completion 网关（无窗口运行，供 ZCode 插件驱动）

用法: ${cid} <命令> [选项]
      ${cid} <cid2> <动词> [参数]     # 对某个渠道操作，如 ${single ? cid : "trae"} login

网关（仓库级，服务全部渠道）:
  start                     守护式启动网关（幂等：已在跑直接返回）
  stop                      停止守护式网关（读 PID 文件杀进程树，不碰第三方进程）
  restart                   重启守护式网关（stop + start）
  status                    聚合状态：网关健康、逐渠道登录状态、守护 PID、凭证
  logs                      查看网关日志尾部
  serve                     前台无窗口运行（不守护；守护进程内部也用它）

模型池:
  model list                列出全部渠道（池子）与各自模型（= channels）
  model show <cid>          只看某个渠道的模型

按渠道操作（<cid> 是已注册的渠道，如 workbuddyai）:
${verbLines.join("\n")}

其它:
  channels                  等价 model list（兼容保留）
  paths [--all]             存储落点与文件（仓库级 = 全部渠道；只读）
  accounts [...]            账号池（不加 <cid> 时跨渠道）
  credits                   额度查询（等价 <cid> billing；可加 --channel <cid>）
  checkin [--status]        签到 / 领奖励（不加 <cid> = 全部渠道；--status 只查不领、--daily-only 跳过一次性）
  login                     登录（可加 --channel <cid>，等价 <cid> login）
  help                      显示本帮助（等价 -h / --help）
  version                   显示版本（等价 -v / --version）

选项:
  --addr <host:port>        网关监听地址（默认 ${defaultAddr()}）
  --ui-port <port>          控制台 API 端口（默认 ${defaultUiPort()}）
  --wait <seconds>          启动健康等待秒数（默认 8）
  --lines <n>               logs 显示行数（默认 40）
  --realm <auto|intl|cn>    login 的登录域（默认 auto）
  --channel <cid>           只操作该渠道（等价把 <cid> 写成第一个参数）
  --status                  checkin：只查状态，不领（只读）
  --daily-only              checkin：只处理"每日"语义的渠道（跳过一次性奖励）
  --fail-if-unclaimed       checkin：今天明确未签 → 退出码非零（"不知道"不算失败）
  --all                     paths：统计工作区内全部渠道
  --workspace <dir>         paths：工作区根（默认从当前目录向上查找）
  --json                    输出 JSON（事件行 / 结构化结果）
  --quiet                   不输出过程信息
  --auto                    hook 场景：受 prefs 的 auto_start 开关约束
  --force                   start 时已在跑也重启；login 时忽略已有凭证强制重登
  --strict                  启动失败以非零码退出（默认始终返回 0）
  --ensure-login            serve：未登录时打开浏览器授权
  --force-login             serve：忽略已有凭证重新登录
  --verbose                 serve：打印每个上游请求
  --no-console              serve：不启动控制台 API 服务
  -h, --help                显示本帮助
  -v, --version             显示版本

示例:
  ${cid} start                          # 起网关（守护式，幂等）
  ${cid} model list                     # 看全部渠道（池子）与各自模型
  ${cid} trae login                     # 登录 trae（浏览器授权）
  ${cid} trae billing                   # 看 trae 的剩余额度 / 账单
  ${cid} checkin --status               # 今天签没签（只读；上方是上游、退化到本地台账）
  ${cid} checkin --fail-if-unclaimed    # 挂定时任务用：今天明确没签就非零退出
  ${cid} checkin                        # 给所有能领的渠道签到
  ${cid} workbuddyai status --json       # 结构化状态（脚本用）
`;
}

/** 打印版本：`<入口名> <版本>（N 个渠道；node vX）`。 */
function printVersion(cid?: string): void {
  const label = cid ?? (channelCount() === 1 ? getChannel().config.cid : "model-bridge");
  console.log(`${label} ${version(cid)}（${channelCount()} 个渠道；node ${process.version}）`);
}

type RawValues = Record<string, string | boolean | undefined>;

interface ParsedArgs {
  values: RawValues;
  positionals: string[];
}

/**
 * 取字符串选项。
 *
 * `parseArgs({strict:false})` 的值类型是 `string | boolean | undefined`，
 * 故这里做一次收窄；布尔形态（用户写 `--addr` 不带值）按缺省处理。
 */
function strOpt(values: RawValues, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

/** 取布尔选项。 */
function boolOpt(values: RawValues, key: string): boolean {
  return values[key] === true;
}

/** 取数值选项（无法解析时返回 undefined，由调用方回落默认值）。 */
function numOpt(values: RawValues, key: string): number | undefined {
  const raw = strOpt(values, key);
  if (raw === undefined) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 读某渠道的模型池（渠道模块内部可能碰磁盘，须在渠道上下文里调用）；对外 id 恒小写。 */
function exposedIdsOf(channel: Channel): string[] {
  try {
    return runInChannel(channel.config.cid, () => poolIds(channel));
  } catch {
    return [];
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: false,
      options: {
        addr: { type: "string" },
        "ui-port": { type: "string" },
        wait: { type: "string" },
        lines: { type: "string" },
        realm: { type: "string" },
        workspace: { type: "string" },
        channel: { type: "string" },
        status: { type: "boolean" },
        "daily-only": { type: "boolean" },
        "fail-if-unclaimed": { type: "boolean" },
        json: { type: "boolean" },
        quiet: { type: "boolean" },
        auto: { type: "boolean" },
        all: { type: "boolean" },
        force: { type: "boolean" },
        strict: { type: "boolean" },
        "ensure-login": { type: "boolean" },
        "force-login": { type: "boolean" },
        verbose: { type: "boolean" },
        "no-console": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    }) as ParsedArgs;
  } catch (err) {
    console.error(`参数错误: ${String(err)}`);
    console.error(usage());
    return 2;
  }

  const o = parsed.values;
  const cid = strOpt(o, "channel");
  if (boolOpt(o, "help")) {
    console.log(usage());
    return 0;
  }
  if (boolOpt(o, "version")) {
    printVersion(cid);
    return 0;
  }

  const positionals = parsed.positionals;
  const command = positionals[0] ?? "serve";
  const addr = strOpt(o, "addr") ?? defaultAddr(cid);
  const uiPort = numOpt(o, "ui-port") ?? defaultUiPort(cid);

  const ctx: groups.CommandContext = {
    json: boolOpt(o, "json"),
    quiet: boolOpt(o, "quiet"),
    addr,
    uiPort,
    realm: strOpt(o, "realm") ?? "auto",
    force: boolOpt(o, "force"),
    statusOnly: boolOpt(o, "status"),
    dailyOnly: boolOpt(o, "daily-only"),
    failIfUnclaimed: boolOpt(o, "fail-if-unclaimed"),
    lines: numOpt(o, "lines") ?? 40,
    ...(strOpt(o, "workspace") !== undefined ? { workspace: strOpt(o, "workspace")! } : {}),
  };

  // 常见惯例：`help` / `version` 作为子命令也认（等价 -h/--help、-v/--version）
  if (command === "help") {
    console.log(usage());
    return 0;
  }
  if (command === "version") {
    printVersion(cid);
    return 0;
  }

  // ① 以渠道为第一参数：`model-bridge <cid> <动词>`
  if (hasChannel(command)) {
    return groups.runChannelCommand(command, positionals.slice(1), ctx);
  }
  // ② 分组：`model list` / `model show <cid>`
  if (command === "model") {
    return groups.runModelGroup(positionals.slice(1), ctx);
  }

  switch (command) {
    case "serve":
      return headless.runServe({
        addr,
        uiPort,
        ...(cid !== undefined ? { cid } : {}),
        verbose: boolOpt(o, "verbose"),
        ensureLogin: boolOpt(o, "ensure-login"),
        forceLogin: boolOpt(o, "force-login"),
        json: boolOpt(o, "json"),
        consoleEnabled: !boolOpt(o, "no-console"),
        realm: strOpt(o, "realm") ?? "auto",
      });

    case "login":
      return headless.runLogin({
        ...(cid !== undefined ? { cid } : {}),
        force: boolOpt(o, "force"),
        json: boolOpt(o, "json"),
        realm: strOpt(o, "realm") ?? "auto",
      });

    case "start":
      return daemon.start({
        addr,
        uiPort,
        ...(cid !== undefined ? { cid } : {}),
        waitMs: numOpt(o, "wait") !== undefined ? numOpt(o, "wait")! * 1000 : undefined,
        quiet: boolOpt(o, "quiet"),
        auto: boolOpt(o, "auto"),
        force: boolOpt(o, "force"),
        strict: boolOpt(o, "strict"),
      });

    case "stop":
      return daemon.stop({
        quiet: boolOpt(o, "quiet"),
        ...(cid !== undefined ? { cid } : {}),
      });

    case "restart":
      return daemon.restart({
        addr,
        uiPort,
        ...(cid !== undefined ? { cid } : {}),
        waitMs: numOpt(o, "wait") !== undefined ? numOpt(o, "wait")! * 1000 : undefined,
        quiet: boolOpt(o, "quiet"),
        strict: boolOpt(o, "strict"),
      });

    case "status":
      return daemon.status({
        json: boolOpt(o, "json"),
        addr,
        uiPort,
        ...(cid !== undefined ? { cid } : {}),
      });

    case "models":
      return daemon.models({
        json: boolOpt(o, "json"),
        addr,
        ...(cid !== undefined ? { cid } : {}),
      });

    case "credits":
      return daemon.credits({ json: boolOpt(o, "json"), ...(cid !== undefined ? { cid } : {}) });

    case "logs":
      return daemon.logs(numOpt(o, "lines") ?? 40, boolOpt(o, "json"), cid);

    case "paths":
      return report.runPaths({
        json: boolOpt(o, "json"),
        all: boolOpt(o, "all"),
        ...(cid !== undefined ? { cid } : {}),
        ...(strOpt(o, "workspace") !== undefined ? { workspace: strOpt(o, "workspace")! } : {}),
      });

    case "accounts":
      return accountCli.runAccounts({
        verb: parsed.positionals[1] ?? "list",
        ...(parsed.positionals[2] !== undefined ? { target: parsed.positionals[2] } : {}),
        ...(cid !== undefined ? { cid } : {}),
        json: boolOpt(o, "json"),
        realm: strOpt(o, "realm") ?? "auto",
        force: boolOpt(o, "force"),
      });

    case "checkin":
    case "signin":
      return signinCli.runCheckin({
        json: ctx.json,
        statusOnly: ctx.statusOnly,
        dailyOnly: ctx.dailyOnly,
        failIfUnclaimed: ctx.failIfUnclaimed,
        ...(cid !== undefined ? { cid } : {}),
      });

    case "channels":
      return groups.listAllModels(ctx.json);

    default:
      console.error(`未知命令: ${command}`);
      console.error(usage());
      return 2;
  }
}
