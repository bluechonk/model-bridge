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

import { channelCount, channels, getChannel, type Channel } from "./channel.js";
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
  return `${cid} — ${display} OpenAI Chat Completion 网关（无窗口运行，供 ZCode 插件驱动）

用法: ${cid} <命令> [选项]

命令:
  serve                     前台无窗口运行：登录探测 + 网关 + 控制台 API（守护进程内部也用它）
  login                     无窗口完成浏览器授权登录并保存凭证
  start                     守护式启动网关（幂等：已在跑直接返回）
  stop                      停止守护式网关（读 PID 文件杀进程树，不碰第三方进程）
  restart                   重启守护式网关（stop + start）
  status                    聚合状态：网关健康、登录状态、守护 PID、凭证
  models                    列出网关暴露的模型短名
  credits                   查询账号剩余额度（只读，不经本地网关）
  logs                      查看网关日志尾部
  paths                     列出本渠道的存储落点与文件（只读；--all 统计全部渠道）
  channels                  列出已注册的渠道（模型池）与各自可用模型（只读）
  accounts [verb]           账号池：list（默认）/ use <key> / add / remove <key>

选项:
  --addr <host:port>        网关监听地址（默认 ${defaultAddr()}）
  --ui-port <port>          控制台 API 端口（默认 ${defaultUiPort()}）
  --wait <seconds>          启动健康等待秒数（默认 8）
  --lines <n>               logs 显示行数（默认 40）
  --realm <auto|intl|cn>    login 的登录域（默认 auto）
  --channel <cid>           只操作该渠道（多渠道路由下省略 = 全部渠道）
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
`;
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
    const label = cid ?? (channelCount() === 1 ? getChannel().config.cid : "model-bridge");
    console.log(`${label} ${version(cid)}`);
    return 0;
  }

  const command = parsed.positionals[0] ?? "serve";
  const addr = strOpt(o, "addr") ?? defaultAddr(cid);
  const uiPort = numOpt(o, "ui-port") ?? defaultUiPort(cid);

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

    case "channels": {
      const list = channels();
      if (list.length === 0) {
        console.error("没有渠道被注册（入口忘了 import 渠道包？）");
        return 2;
      }
      if (boolOpt(o, "json")) {
        console.log(
          JSON.stringify(
            list.map((c) => ({
              cid: c.config.cid,
              display: c.upstream.DISPLAY_NAME,
              version: c.config.version,
              models: exposedIdsOf(c),
            })),
            null,
            2,
          ),
        );
        return 0;
      }
      const multi = list.length > 1;
      console.log(`${list.length} 个渠道（模型池）${multi ? "；对外模型 id 形如 <cid>/<模型>" : ""}：`);
      for (const c of list) {
        const models = exposedIdsOf(c);
        const shown = models.map((m) => qualifiedId(c.config.cid, m, multi)).join(", ");
        console.log(
          `  ${c.config.cid.padEnd(12)} ${c.upstream.DISPLAY_NAME.padEnd(18)} ${shown || "（无可用模型）"}`,
        );
      }
      return 0;
    }

    default:
      console.error(`未知命令: ${command}`);
      console.error(usage());
      return 2;
  }
}
