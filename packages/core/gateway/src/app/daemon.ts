/**
 * 守护式网关管理：`start / stop / restart / logs / status / models / credits` 的实现。
 *
 * 进程模型（见 docs/DAEMON-SUPERVISOR.md）：`start` 拉起的是**监督进程**
 * （`supervise`，detached 常驻），worker（`serve`）由监督进程 spawn 与重生 ——
 * worker 意外死亡会被按指数退避自动拉回；`stop` 杀监督者即作废重生，再兜底清 worker。
 * `start` 幂等：先探测 `/health`，已在跑直接返回。
 *
 * 渠道差异由注册的 `Channel` 提供；本文件里的 CLI 名/日志前缀取自其 config。
 * 进程与端口工具（PID/进程树/健康探测）在 `process-utils.ts`。
 */

import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";

import {
  channelCount,
  channels,
  getChannel,
  type Channel,
  type CreditPackage,
  type CreditsResult,
} from "../runtime/channel.js";
import { defaultAddr, defaultUiPort } from "../runtime/cli-consts.js";
import { syncPool } from "../runtime/account-pool.js";
import { claimedTodayPerLedger, ledgerExists } from "../auth/signin-ledger.js";
import { runInChannel } from "../runtime/channel-context.js";
import * as gateway from "../http/gateway.js";
import * as paths from "../runtime/paths.js";
import { baseUrlOf, displayBase } from "../http/portfree.js";
import { detectStaleBuild, staleBuildHint } from "./stale-build.js";
import {
  HEALTH_TIMEOUT_MS,
  Scope,
  scopeOf,
  probe,
  gatewayHealthy,
  foreignServiceOnPort,
  pidAlive,
  readPid,
  killTree,
  cliEntry,
} from "./process-utils.js";

// 公开面兼容：这些工具原先定义在本文件，外部按 `@modelmux/gateway` 的 daemon 命名空间取用
export { gatewayHealthy, foreignServiceOnPort, pidAlive, killTree, cliEntry } from "./process-utils.js";

/**
 * start 等待网关就绪的默认时长（毫秒）。
 *
 * ⚠ 冷启动实测 ~5s（11 个渠道初始化 + 启动探测），紧接构建/安装后机器忙时会超过 8s
 * （实测踩过：8s 窗口超时误报「未就绪」，网关其实几百毫秒后就 ready 了）。
 * 留出余量到 12s；hook 场景仍走 `--wait` 自己调小。
 */
export const DEFAULT_WAIT_MS = 12_000;

/** 范围内的渠道清单（仓库级 = 全部已注册渠道）。 */
function scopeChannels(scope: Scope): Channel[] {
  return scope.cid !== undefined ? [getChannel(scope.cid)] : channels();
}

/** 确保范围内的目录存在（渠道级 = 渠道层；仓库级 = 根）。 */
function ensureScopeDir(scope: Scope): string {
  if (scope.cid !== undefined) return paths.ensureDir(scope.cid);
  if (channelCount() === 1) return paths.ensureDir();
  const root = paths.rootDir();
  mkdirSync(root, { recursive: true });
  return root;
}

function readPrefs(scope: Scope): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(scope.prefsPath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** hook 自动挂载开关；缺省开启，显式写入 false 才关闭。 */
export function autoStartEnabled(cid?: string): boolean {
  return readPrefs(scopeOf(cid))["auto_start"] !== false;
}

export interface StartOptions {
  addr?: string;
  uiPort?: number;
  waitMs?: number;
  quiet?: boolean;
  auto?: boolean;
  force?: boolean;
  strict?: boolean;
  /** 渠道级操作指定渠道；省略 = 单渠道模式或仓库级（多渠道路由）。 */
  cid?: string;
}

/**
 * 守护式启动网关：幂等；返回 0 表示「在跑或已交由后台处理」。
 *
 * `auto`（hook 场景）时受 prefs 的 auto_start 开关约束；
 * `strict` 时失败以非零码退出（默认只报告，不阻塞调用方 —— hook 不能卡会话）。
 */
export async function start(options: StartOptions = {}): Promise<number> {
  const scope = scopeOf(options.cid);
  const addr = options.addr ?? defaultAddr(options.cid);
  const uiPort = options.uiPort ?? defaultUiPort(options.cid);
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const { quiet = false, auto = false, force = false, strict = false } = options;
  const name = scope.name;
  const log = (m: string): void => {
    if (!quiet) console.log(`[${name}] ${m}`);
  };

  if (auto && !autoStartEnabled(options.cid)) {
    log("auto_start 已关闭，跳过自动挂载");
    return 0;
  }

  if ((await gatewayHealthy(addr)) && !force) {
    log(`网关已在运行: ${baseUrlOf(addr)}`);
    // 「已在运行」是**旧代码**最容易被漏掉的时刻：改完 build 再来 start 会被这里拦下，
    // 用户以为「已经启动好了」，实际跑的还是旧进程。主动报出来。
    const stale = detectStaleBuild(scope.pidPath());
    if (stale.stale) log(staleBuildHint(stale));
    return 0;
  }

  // PID 文件指向活进程但不健康（僵尸实例）：先清掉再拉起，否则端口自愈会撞上它
  const pid = readPid(scope);
  if (pid && pidAlive(pid)) {
    log(`结束不健康的守护实例 (PID ${pid})...`);
    const dead = await killTree(pid);
    if (dead) recordStop(scope, pid);
    else log(`警告：旧实例 (PID ${pid}) 未能结束，新实例可能无法绑定端口`);
  }
  try {
    unlinkSync(scope.pidPath());
  } catch {
    /* 本来就没有 */
  }

  ensureScopeDir(scope);
  // 渠道刷新过的 token 回灌池子；池子还没 active 就先把现有凭证收进来
  for (const channel of scopeChannels(scope)) {
    runInChannel(channel.config.cid, () => syncPool(channel.config.cid));
  }
  // 拉起的是**监督进程**（supervise，detached 常驻）：worker（serve）由它 spawn 与重生。
  // PID 文件记监督者 pid；worker pid 由监督者维护到 gateway-worker.pid。
  // 落点（worker pid/日志/cwd）以显式路径下发 —— scope 推导是 daemon 的职责，
  // 监督者不重复推导（多渠道路由下 paths 渠道级函数需要 explicit cid）。
  const workerDir = ensureScopeDir(scope);
  const superviseArgs = [
    cliEntry(),
    "supervise",
    "--addr",
    addr,
    "--ui-port",
    String(uiPort),
    "--json",
    "--worker-pid",
    scope.workerPidPath(),
    "--log",
    scope.logPath(),
    "--cwd",
    workerDir,
  ];
  // ⚠ stdio 全部重定向到日志文件：监督进程没有控制台可继承，
  //   继承父进程的 stdout 会在父进程退出后写入失败（EPIPE 刷屏）
  const logFd = openSync(scope.logPath(), "a");
  const child = spawn(process.execPath, superviseArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    cwd: ensureScopeDir(scope),
  });
  closeSync(logFd);
  child.unref();
  if (child.pid) writeFileSync(scope.pidPath(), `${child.pid}\n`, "utf8");

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break; // 守护进程启动即退（如端口被占）
    if (await gatewayHealthy(addr)) {
      log(`网关已启动: ${baseUrlOf(addr)} (PID ${child.pid})`);
      return 0;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  // 边界保险：窗口内最后一次探测与截止时刻之间可能刚好错过 → 报告前再探一次
  if (child.exitCode === null && (await gatewayHealthy(addr))) {
    log(`网关已启动: ${baseUrlOf(addr)} (PID ${child.pid})`);
    return 0;
  }
  log(
    `启动等待 ${waitMs / 1000}s 超时（PID ${child.pid}，日志 ${scope.logPath()}）；` +
      `可能仍在启动中 —— 用 ${name} status 确认`,
  );
  return strict ? 1 : 0;
}

/**
 * 追加一行终止记录到该 scope 的日志。
 *
 * 日志平时只有**网关子进程自己**写的 start/ready（stdout 重定向），进程被 kill 后
 * 没有机会留遗言——stop 侧不补这一行，时间线上就永远没有"下线"痕迹，
 * 手动停与崩溃在同一条日志里分不出来。必须等进程死透再写（避免与临终输出交错）。
 */
function recordStop(scope: Scope, pid: number): void {
  try {
    appendFileSync(scope.logPath(), `${JSON.stringify({ event: "stop", pid })}\n`, "utf8");
  } catch {
    /* 日志不可写不影响停止本身 */
  }
}

/**
 * 停止守护式网关（只管理有 PID 文件的实例，不碰第三方进程）。
 *
 * 三步流（杀监督者 = 天然作废重生，见 docs/DAEMON-SUPERVISOR.md §4）：
 * ① killTree 监督者 —— 重生代次随进程消失，worker 后续退出不会再被拉回；
 * ② 等 worker IPC 自退（≤3s，reason=supervisor-gone），未退则 killTree worker 兜底；
 * ③ 终验：监督者/worker 进程对象与端口上的网关健康全部确认消失才声称「已停止」。
 */
export async function stop(options: { quiet?: boolean; addr?: string; cid?: string } = {}): Promise<number> {
  const { quiet = false } = options;
  const scope = scopeOf(options.cid);
  const addr = options.addr ?? defaultAddr(options.cid);
  const pid = readPid(scope);
  const name = scope.name;
  const log = (m: string): void => {
    if (!quiet) console.log(`[${name}] ${m}`);
  };

  if (!pid) {
    if (await gatewayHealthy(addr)) {
      log("网关在运行但没有 PID 文件（非本机守护拉起），未做处理");
      return 1;
    }
    log("网关未在运行");
    return 0;
  }
  const dead = await killTree(pid);
  // 二次验证：taskkill 异步竞态下 waitDead 可能误报「已死」——
  // 进程对象还在，都不能声称停止（实测踩过：stop 报成功、删了 PID 文件，
  // 进程照常服务）。端口的最终核验放到 worker 清理完之后做。
  if (!dead || pidAlive(pid)) {
    // 进程还活着就不能声称「已停止」：留着 PID 文件，下一次 stop 还能再试
    log(`未能停止网关 (PID ${pid})：进程仍在运行，请手动结束`);
    return 1;
  }
  recordStop(scope, pid);

  // ② worker 兜底：监督者死了，worker 应因 IPC 断开自退；留出优雅停机窗口再补刀
  const workerPid = readPidAt(scope.workerPidPath());
  if (workerPid && pidAlive(workerPid)) {
    let selfGone = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (!pidAlive(workerPid)) {
        selfGone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!selfGone) await killTree(workerPid);
  }

  // ③ 端口终验：worker 进程对象也消失、端口上无本网关健康，才算停干净
  if ((workerPid !== 0 && pidAlive(workerPid)) || (await gatewayHealthy(addr))) {
    log(`未能停止网关 (PID ${pid})：端口仍在被本网关监听，请手动结束`);
    return 1;
  }
  try {
    unlinkSync(scope.pidPath());
  } catch {
    /* 已被清掉 */
  }
  try {
    unlinkSync(scope.workerPidPath());
  } catch {
    /* 已被清掉 */
  }
  log(`已停止网关 (PID ${pid})`);
  return 0;
}

/** 从指定 PID 文件读数字（不存在/损坏 → 0）。 */
function readPidAt(path: string): number {
  try {
    const value = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/** 重启守护式网关（stop + start；换配置/升级后用）。 */
export async function restart(options: StartOptions = {}): Promise<number> {
  const stopped = await stop({ quiet: true, ...(options.cid !== undefined ? { cid: options.cid } : {}) });
  if (stopped !== 0) return stopped; // 停掉失败就别起：省得空等后报端口占用
  // 等端口完全释放再拉起
  await new Promise((r) => setTimeout(r, 800));
  return start(options);
}

function readPidValue(scope: Scope): number | null {
  const pid = readPid(scope);
  return pid || null;
}

/** worker pid（监督进程维护，重生会变；无监督拉起的裸 serve 恒空）。 */
function readWorkerPidValue(scope: Scope): number | null {
  const pid = readPidAt(scope.workerPidPath());
  return pid || null;
}

/** 聚合状态：网关健康、控制台快照、守护 PID、凭证、auto_start。 */
export async function status(
  options: { json?: boolean; addr?: string; uiPort?: number; cid?: string } = {},
): Promise<number> {
  const scope = scopeOf(options.cid);
  const addr = options.addr ?? defaultAddr(options.cid);
  const uiPort = options.uiPort ?? defaultUiPort(options.cid);
  const health = await probe(addr);
  const gatewayUp = health !== null;
  // 端口上若有别的服务（同名的旧实现 / 别的项目的网关），明确报出来
  const foreign = gatewayUp ? "" : await foreignServiceOnPort(addr);

  let consoleState: Record<string, unknown> | null = null;
  if (gatewayUp) {
    try {
      const resp = await fetch(`http://127.0.0.1:${uiPort}/api/state`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (resp.status === 200) consoleState = (await resp.json()) as Record<string, unknown>;
    } catch {
      consoleState = null;
    }
  }

  // 凭证：渠道级只报该渠道；仓库级逐渠道（顶层 present = 任一有凭证）
  const list = scopeChannels(scope);
  const perChannel = list.map((channel) => {
    let present = false;
    try {
      runInChannel(channel.config.cid, () => channel.cred.load());
      present = true;
    } catch {
      present = false;
    }
    return { cid: channel.config.cid, display: channel.upstream.DISPLAY_NAME, present };
  });
  const credentialsPresent = perChannel.some((c) => c.present);

  // 守护进程是否在跑旧代码（改完 build 没 restart）—— 见 stale-build.ts 的事故说明
  const stale = gatewayUp ? detectStaleBuild(scope.pidPath()) : { stale: false, buildMs: null, pidMs: null };

  // 签到（**只看本地台账，不发网络请求**）：status 也能一眼看到"今天签了几个"。
  // 为什么不查上游：status 是高频诊断命令，让它去打所有渠道的上游端点不合适。
  const withLedger = list
    .map((channel) => ({
      cid: channel.config.cid,
      claimed_today: claimedTodayPerLedger(channel.config.cid),
    }))
    .filter((row) => ledgerExists(row.cid));

  const info = {
    signin: {
      note: "仅本地台账（我们发起过的领取）；自动签到以此为判定，上游的权威答案见渠道 billing",
      claimed_today: withLedger.filter((r) => r.claimed_today).length,
      tracked: withLedger.length,
      channels: withLedger,
    },
    gateway: {
      addr: baseUrlOf(addr),
      reachable: gatewayUp,
      occupied_by: foreign,
      implementation: health?.["implementation"] ?? null,
      channels: list.map((c) => c.config.cid),
    },
    console: consoleState,
    daemon_pid: readPidValue(scope),
    worker_pid: readWorkerPidValue(scope),
    credentials:
      list.length === 1
        ? { present: credentialsPresent }
        : { present: credentialsPresent, channels: perChannel },
    auto_start: autoStartEnabled(options.cid),
    log: scope.logPath(),
    stale_build: stale.stale,
  };

  if (options.json) {
    console.log(JSON.stringify(info, null, 2));
    return 0;
  }
  const state =
    (consoleState?.["ui_state"] as string | undefined) ?? (gatewayUp ? "running" : "down");
  const head = gatewayUp
    ? `网关: ${baseUrlOf(addr)} [OK]`
    : foreign
      ? `网关: ${baseUrlOf(addr)} [端口被 ${foreign} 占用]`
      : `网关: ${baseUrlOf(addr)} [不可达]`;
  // 一行一个字段：挤成一行在窄终端里会被折断成难读的形状
  console.log(head);
  console.log(`状态: ${state}`);
  console.log(`守护PID: ${info.daemon_pid ?? "无"}`);
  console.log(`凭证: ${credentialsPresent ? "有" : "无"}`);
  console.log(`auto_start: ${info.auto_start ? "开" : "关"}`);
  // 仓库级时逐渠道报登录态（渠道级只有一行，且行首已有渠道名，不重复）
  if (list.length > 1) {
    console.log(
      `渠道: ${perChannel.map((c) => `${c.cid}${c.present ? "✓" : "✗"}`).join(" ")}`,
    );
  }
  if (info.signin.tracked > 0) {
    console.log(
      `签到（本地记录）: 今天已签 ${info.signin.claimed_today}/${info.signin.tracked} 个渠道` +
        `（${info.signin.channels.map((c) => `${c.cid}${c.claimed_today ? "✓" : ""}`).join(", ")}）`,
    );
  }
  // 下一步建议：有异常才说话，正常不打扰（status 是高频诊断命令的收尾）
  const notLoggedIn = perChannel.filter((c) => !c.present);
  if (notLoggedIn.length > 0) {
    const first = notLoggedIn[0]!;
    console.log(
      list.length === 1
        ? `建议: mx login ${first.cid}（未登录）`
        : `建议: ${notLoggedIn.length} 个渠道未登录，逐个 mx login <cid>（如 mx login ${first.cid}）`,
    );
  }
  if (stale.stale) console.log(staleBuildHint(stale));
  const message = consoleState?.["message"];
  if (typeof message === "string" && message) console.log(`提示: ${message}`);
  return 0;
}

/** 列出网关暴露的模型短名。 */
export async function models(
  options: { json?: boolean; addr?: string; cid?: string } = {},
): Promise<number> {
  const scope = scopeOf(options.cid);
  const addr = options.addr ?? defaultAddr(options.cid);
  let ids: string[];
  try {
    const resp = await fetch(`${baseUrlOf(addr)}/v1/models`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const payload = (await resp.json()) as { data?: Array<{ id?: string }> };
    ids = (payload.data ?? []).map((m) => m.id ?? "").filter(Boolean);
  } catch (err) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: String(err) }));
    } else {
      console.log(`[${scope.name}] 获取模型失败: ${String(err)}`);
    }
    return 1;
  }
  if (options.json) console.log(JSON.stringify({ ok: true, models: ids }));
  else console.log(ids.length > 0 ? ids.join("\n") : "（无模型）");
  return 0;
}

/**
 * 查询账号剩余额度（直接走上游 billing，不经本地网关）。
 *
 * 仓库级（多渠道）时逐渠道查询：某个渠道没有额度端点或未登录只影响它自己。
 */
export async function credits(options: { json?: boolean; cid?: string } = {}): Promise<number> {
  const scope = scopeOf(options.cid);
  const list = scopeChannels(scope);
  const name = scope.name;

  const results: Array<Record<string, unknown>> = [];
  let failures = 0;

  for (const channel of list) {
    const label = list.length === 1 ? name : channel.config.cid;
    const { billing, cred } = channel;
    try {
      const info: CreditsResult = await runInChannel(channel.config.cid, () => billing.fetchCredits());
      results.push({ cid: channel.config.cid, ...info });
      if (list.length > 1 && !options.json) {
        const t = info.total;
        console.log(
          `[${label}] 剩余 ${t.remain} / ${t.size} ${t.unit}（${t.remain_percent}%）`,
        );
      }
    } catch (err) {
      failures += 1;
      const hint = err instanceof cred.NotLoggedInError ? `，运行 ${label} login` : "";
      const error = `${String(err)}${hint}`;
      results.push({ cid: channel.config.cid, ok: false, error });
      if (list.length === 1) {
        const payload = { ok: false, error };
        if (options.json) console.log(JSON.stringify(payload));
        else console.log(`[${label}] ${error}`);
        return 1;
      }
      if (!options.json) console.log(`[${label}] ${error}`);
    }
  }

  // 单一渠道：保持既有输出形状（直接打印额度明细）
  if (list.length === 1) {
    const only = results[0]!;
    if (only["ok"] !== true) return 1;
    if (options.json) {
      console.log(JSON.stringify(only, null, 2));
      return 0;
    }
    const t = only["total"] as CreditsResult["total"];
    console.log(
      `额度: 剩余 ${t.remain} / ${t.size} ${t.unit}` +
        `（已用 ${t.used}，剩余 ${t.remain_percent}%）`,
    );
    for (const pkg of only["packages"] as CreditPackage[]) {
      if (pkg.remain <= 0) continue;
      const tail =
        typeof pkg.days_left === "number" && pkg.days_left >= 0
          ? `，${pkg.days_left} 天后到期`
          : "";
      console.log(`  · ${pkg.name}: ${pkg.remain}/${pkg.size}${tail}`);
    }
    return 0;
  }

  if (options.json) {
    console.log(JSON.stringify({ ok: failures === 0, channels: results }, null, 2));
    return failures === 0 ? 0 : 1;
  }
  return failures === 0 ? 0 : 1;
}

/** 查看网关日志尾部（守护进程的 stdout/stderr 都落在这里）。 */
export function logs(lines = 40, json = false, cid?: string): number {
  const scope = scopeOf(cid);
  const name = scope.name;
  let text: string;
  try {
    text = readFileSync(scope.logPath(), "utf8");
  } catch {
    const payload = { ok: false, error: `日志不存在: ${scope.logPath()}` };
    if (json) console.log(JSON.stringify(payload));
    else console.log(`[${name}] ${payload.error}`);
    return 1;
  }
  // 末尾换行会 split 出一个空元素，先去掉一个再切，行数才是「真正的行」；
  // 且 `slice(-0)` 等于 `slice(0)`（负零退化为 0）会打印**整个文件**——必须显式判零
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const tail = lines > 0 && body !== "" ? body.split("\n").slice(-lines) : [];
  if (json) {
    console.log(JSON.stringify({ ok: true, log: scope.logPath(), lines: tail }));
  } else {
    console.log(`--- ${scope.logPath()} 最后 ${tail.length} 行 ---`);
    console.log(tail.join("\n"));
  }
  return 0;
}

/**
 * 从 `offset` 起读文件新增内容，只取**完整行**（截到最后一个换行符）。
 *
 * 半行不输出：写入方可能正写到一半（含多字节字符的前几字节），提前解码会得到乱码；
 * UTF-8 里 `0x0A` 不会出现在多字节序列内部，按换行切永远切在字符边界上。
 * 文件被截断/轮转（size < offset）时从 0 重读，避免偏移量失效后永久失明。
 */
export function readAppended(path: string, offset: number): { text: string; offset: number } {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { text: "", offset }; // 文件暂时不在（刚轮转）：保持偏移等它回来
  }
  if (size < offset) offset = 0;
  if (size === offset) return { text: "", offset };
  const len = size - offset;
  const buf = Buffer.alloc(len);
  try {
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, len, offset);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { text: "", offset };
  }
  const nl = buf.lastIndexOf(0x0a);
  if (nl === -1) return { text: "", offset };
  return { text: buf.subarray(0, nl + 1).toString("utf8"), offset: offset + nl + 1 };
}

/** 跟随轮询间隔（毫秒）。250ms 下肉眼接近实时，开销可忽略。 */
const FOLLOW_INTERVAL_MS = 250;

/**
 * `logs --follow`：先打尾部 N 行，再持续输出新增内容，Ctrl+C 退出。
 * 语义对齐 `tail -f` / `docker logs -f`；只读文件，不碰网关进程。
 */
export async function followLogs(lines = 40, json = false, cid?: string): Promise<number> {
  const path = scopeOf(cid).logPath();
  const code = logs(lines, json, cid);
  if (code !== 0) return code; // 日志不存在：直接给快照的报错语义
  let offset = statSync(path).size;
  return await new Promise<number>((resolve) => {
    const timer = setInterval(() => {
      const r = readAppended(path, offset);
      offset = r.offset;
      if (r.text) process.stdout.write(r.text);
    }, FOLLOW_INTERVAL_MS);
    const stop = (): void => {
      clearInterval(timer);
      resolve(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
