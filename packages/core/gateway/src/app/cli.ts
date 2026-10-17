/**
 * 命令行入口：`serve`/`login`（运行）+ `start`/`stop`/`restart`/`status`/`models`/`credits`/`logs`（管理）。
 *
 * 管理类子命令不依赖网关进程，直接操作守护进程与本地文件；
 * 运行类子命令（serve/login）走 headless。
 *
 * 本文件是共享层：调用方（各渠道包的 `src/cli.ts`）必须**先注册渠道**，
 * 再调用 `main()`。故这里不再自带「直接运行本文件」的入口判断。
 */

import { parseArgs } from "node:util";

import { channelCount, getChannel, hasChannel } from "../runtime/channel.js";
import { CHANNEL_VERBS, isChannelVerb } from "./command-groups.js";
import * as groups from "./command-groups.js";
import { defaultAddr, defaultUiPort, version } from "../runtime/cli-consts.js";
import * as daemon from "./daemon.js";
import * as headless from "./headless.js";
import { runWeb } from "./web.js";
import * as supervisor from "./supervisor.js";

/** 生成当前渠道的帮助文本。 */
export function usage(): string {
  const single = channelCount() === 1;
  // 仓库级入口的 bin 有 `modelmux` / `mx` 两个名字，帮助里统一用短名 `mx`。
  const bin = single ? getChannel().config.cid : "mx";
  const display = single ? getChannel().config.display : "多渠道路由（模型池）";
  const verbLines = CHANNEL_VERBS.map(([v, d]) => `  ${v.padEnd(10)} ${d}`);
  const cid = single ? bin : "traecn";
  return `${bin} — ${display} OpenAI Chat Completion 网关（本地多渠道）

用法: ${bin} <动词> [<cid>] [参数]
      <cid> 一律写在动词之后，如 ${bin} login ${cid}

网关（仓库级，不带 <cid>）:
  start                     守护式启动网关（幂等：已在跑直接返回）
  stop                      停止守护式网关（读 PID 文件杀进程树，不碰第三方进程）
  restart                   重启守护式网关（stop + start）
  serve                     前台运行网关（内部命令，供调试）
  web                       打开 Web 控制台（http://127.0.0.1:4412/web/）

模型池（全模型池：动态返回全部渠道能提供的模型，请求落到哪家渠道由网关按账单已用量决定）:
  model list                池视图：2 个模型 → 候选渠道 + 已用量 + 冷却/暂不可用
  model usage [--refresh]   池账本；--refresh 立刻重查各渠道账单额度

按渠道操作（<cid> 是动词后的第一个位置参数，必须是已注册渠道名）:
${verbLines.join("\n")}

其它:
  help                      显示本帮助（等价 -h / --help）
  version                   显示版本（等价 -v / --version）

选项:
  --addr <host:port>        网关监听地址（默认 ${defaultAddr()}）
  --ui-port <port>          控制台 API 端口（默认 ${defaultUiPort()}）
  --wait <seconds>          启动健康等待秒数（默认 12）
  --lines <n>               logs 显示行数（默认 40）
  -f, --follow              logs：持续输出新增日志（等价 tail -f / docker logs -f）
  --realm <名>              login 的登录域（渠道自定义；单域渠道忽略）
  --wechat                  login：微信扫码登录（仅声明该方式的渠道，如 loomy）
  --refresh                 models <cid> / model usage：强制重拉上游目录 / 重查账单
                            （失败即报错退出）
  --all                     paths：统计工作区内全部渠道
  --workspace <dir>         paths：工作区根（默认从当前目录向上查找）
  --json                    输出 JSON（事件行 / 结构化结果）
  --quiet                   不输出过程信息
  --auto                    hook 场景：受 prefs 的 auto_start 开关约束
  --force                   start 时已在跑也重启
  --strict                  启动失败以非零码退出（默认始终返回 0）
  --ensure-login            serve：未登录时引导登录（授权链接打到日志）
  --force-login             serve：忽略已有凭证重新登录
  --verbose                 serve：打印每个上游请求
  --no-console              serve：不启动控制台 API 服务
  -h, --help                显示本帮助
  -v, --version             显示版本

示例:
  ${bin} start                          # 起网关（守护式，幂等）
  ${bin} model list                     # 池视图：2 个模型分别会先落到哪家
  ${bin} model usage --refresh          # 立刻重查各渠道账单额度并写进账本
  ${bin} models ${cid} --refresh        # 强制重拉 ${cid} 的模型目录
  ${bin} login ${cid}                   # 登录 ${cid}（把授权 URL 输出到终端，自行打开）
  ${bin} relogin ${cid}                 # 重新授权 ${cid}（清掉旧凭据后重登）
  ${bin} billing ${cid}                 # 看 ${cid} 的剩余额度 / 账单
  ${bin} status ${cid} --json           # 结构化状态（脚本用）
`;
}

/** 打印版本：`<入口名> <版本>（N 个渠道；node vX）`。 */
function printVersion(): void {
  const label = channelCount() === 1 ? getChannel().config.cid : "mx";
  console.log(`${label} ${version()}（${channelCount()} 个渠道；node ${process.version}）`);
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

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      // 严格模式：未知选项（含已移除的 `--cname` / `--channel` / `-c`）直接报错。
      // 否则 parseArgs 会把未知长选项当布尔吃下、把它的值丢成位置参数 —— 用户以为
      // 指定了渠道，实际拿到的是「全部渠道」，静默做错事。
      strict: true,
      options: {
        addr: { type: "string" },
        "ui-port": { type: "string" },
        wait: { type: "string" },
        lines: { type: "string" },
        realm: { type: "string" },
        workspace: { type: "string" },
        json: { type: "boolean" },
        quiet: { type: "boolean" },
        auto: { type: "boolean" },
        all: { type: "boolean" },
        force: { type: "boolean" },
        refresh: { type: "boolean" },
        wechat: { type: "boolean" },
        strict: { type: "boolean" },
        "ensure-login": { type: "boolean" },
        "force-login": { type: "boolean" },
        verbose: { type: "boolean" },
        "no-console": { type: "boolean" },
        host: { type: "string" },
        port: { type: "string" },
        open: { type: "boolean" },
        "no-open": { type: "boolean" },
        // supervise（内部命令）的落点参数 —— 由 `start` 以显式路径下发
        "worker-pid": { type: "string" },
        log: { type: "string" },
        cwd: { type: "string" },
        follow: { type: "boolean", short: "f" },
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
  if (boolOpt(o, "help")) {
    console.log(usage());
    return 0;
  }
  if (boolOpt(o, "version")) {
    printVersion();
    return 0;
  }

  const positionals = parsed.positionals;
  const command = positionals[0] ?? "serve";
  const addr = strOpt(o, "addr") ?? defaultAddr();
  const uiPort = numOpt(o, "ui-port") ?? defaultUiPort();

  const ctx: groups.CommandContext = {
    json: boolOpt(o, "json"),
    quiet: boolOpt(o, "quiet"),
    addr,
    uiPort,
    realm: strOpt(o, "realm") ?? "auto",
    force: boolOpt(o, "force"),
    refresh: boolOpt(o, "refresh"),
    wechat: boolOpt(o, "wechat"),
    lines: numOpt(o, "lines") ?? 40,
    all: boolOpt(o, "all"),
    follow: boolOpt(o, "follow"),
    ...(strOpt(o, "workspace") !== undefined ? { workspace: strOpt(o, "workspace")! } : {}),
  };

  // 常见惯例：`help` / `version` 作为子命令也认（等价 -h/--help、-v/--version）
  if (command === "help") {
    console.log(usage());
    return 0;
  }
  if (command === "version") {
    printVersion();
    return 0;
  }

  // ① 分组：`model list` / `model usage`
  if (command === "model") {
    return groups.runModelGroup(positionals.slice(1), ctx);
  }
  // ② 渠道动词：`mx <动词> [<cid>] [参数]`（cid 在动词之后）
  if (isChannelVerb(command)) {
    return groups.runVerb(command, positionals.slice(1), ctx);
  }

  // ③ 仓库级动词（不带 <cid>）
  switch (command) {
    case "web":
      return runWeb({
        host: strOpt(o, "host") || undefined,
        port: numOpt(o, "port") ?? undefined,
        open: boolOpt(o, "open") && !boolOpt(o, "no-open"),
      });

    case "serve":
      return headless.runServe({
        addr,
        uiPort,
        verbose: boolOpt(o, "verbose"),
        ensureLogin: boolOpt(o, "ensure-login"),
        forceLogin: boolOpt(o, "force-login"),
        json: boolOpt(o, "json"),
        consoleEnabled: !boolOpt(o, "no-console"),
        realm: strOpt(o, "realm") ?? "auto",
      });

    case "start":
      return daemon.start({
        addr,
        uiPort,
        waitMs: numOpt(o, "wait") !== undefined ? numOpt(o, "wait")! * 1000 : undefined,
        quiet: boolOpt(o, "quiet"),
        auto: boolOpt(o, "auto"),
        force: boolOpt(o, "force"),
        strict: boolOpt(o, "strict"),
      });

    case "supervise":
      // 内部命令（由 `start` spawn；藏而不删，同 `serve` 待遇，不走帮助）
      return supervisor.runSupervise({
        addr,
        uiPort,
        workerPid: strOpt(o, "worker-pid") ?? "",
        log: strOpt(o, "log") ?? "",
        cwd: strOpt(o, "cwd") ?? process.cwd(),
      });

    case "stop":
      return daemon.stop({
        quiet: boolOpt(o, "quiet"),
      });

    case "restart":
      return daemon.restart({
        addr,
        uiPort,
        waitMs: numOpt(o, "wait") !== undefined ? numOpt(o, "wait")! * 1000 : undefined,
        quiet: boolOpt(o, "quiet"),
        strict: boolOpt(o, "strict"),
      });

    default:
      // 旧语法 `mx <cid> <动词>` 的指路：渠道名现在写在动词之后。
      if (hasChannel(command)) {
        console.error(
          `未知命令: ${command}（新语法把渠道写在动词之后：\`mx <动词> ${command}\`，如 \`mx login ${command}\`）`,
        );
      } else {
        console.error(`未知命令: ${command}`);
      }
      console.error(usage());
      return 2;
  }
}
