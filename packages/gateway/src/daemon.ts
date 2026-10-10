/**
 * 守护式网关管理：`start / stop / restart / logs / status / models / credits` 的实现。
 *
 * 进程模型：网关是**共享本地服务**，守护式常驻、不随宿主会话生灭。
 * `start` 负责拉起（幂等：先探测 `/health`，已在跑直接返回）并落 PID 文件；
 * `stop` 读 PID 文件杀进程树；会话期不做自动回收。
 *
 * 渠道差异由注册的 `Channel` 提供；本文件里的 CLI 名/日志前缀取自其 config。
 */

import { spawn, execFile } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  channelCount,
  channels,
  getChannel,
  type Channel,
  type CreditPackage,
  type CreditsResult,
} from "./channel.js";
import { defaultAddr, defaultUiPort } from "./cli-consts.js";
import { syncPool } from "./account-pool.js";
import { claimedTodayPerLedger, ledgerExists } from "./signin-ledger.js";
import { runInChannel } from "./channel-context.js";
import * as gateway from "./gateway.js";
import * as paths from "./paths.js";
import { baseUrlOf, displayBase } from "./portfree.js";
import { detectStaleBuild, staleBuildHint } from "./stale-build.js";

/**
 * start 等待网关就绪的默认时长（毫秒）。
 *
 * ⚠ 冷启动实测 ~5s（11 个渠道初始化 + 启动探测），紧接构建/安装后机器忙时会超过 8s
 * （实测踩过：8s 窗口超时误报「未就绪」，网关其实几百毫秒后就 ready 了）。
 * 留出余量到 12s；hook 场景仍走 `--wait` 自己调小。
 */
export const DEFAULT_WAIT_MS = 12_000;
const HEALTH_TIMEOUT_MS = 1500;

/**
 * 运行范围。
 *
 * - **渠道级**（显式 `cid`，或只注册了一个渠道）：PID/日志/偏好都在渠道层内 `<root>/<cid>/`。
 * - **仓库级**（多渠道路由且未指定 cid）：一个网关进程服务多个渠道，它不属于任何单个
 *   渠道，故 PID/日志/偏好落在根上 `<root>/`。
 */
interface Scope {
  /** 渠道 id；仓库级为 undefined。 */
  cid?: string;
  /** CLI 名与日志前缀。 */
  name: string;
  pidPath: () => string;
  logPath: () => string;
  prefsPath: () => string;
}

function scopeOf(cid?: string): Scope {
  if (cid !== undefined) {
    const name = getChannel(cid).config.cid;
    return {
      cid,
      name,
      pidPath: () => paths.pidPath(cid),
      logPath: () => paths.logPath(cid),
      prefsPath: () => paths.prefsPath(cid),
    };
  }
  if (channelCount() === 1) {
    return {
      name: channels()[0]!.config.cid,
      pidPath: () => paths.pidPath(),
      logPath: () => paths.logPath(),
      prefsPath: () => paths.prefsPath(),
    };
  }
  return {
    name: "model-bridge",
    pidPath: () => paths.rootPidPath(),
    logPath: () => paths.rootLogPath(),
    prefsPath: () => paths.rootPrefsPath(),
  };
}

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

/**
 * 探测端口上的健康载荷；不是本服务时返回 null。
 *
 * ⚠ 必须核对 `service` 字段：同一端口上可能跑着**别的**网关（它们同样返回
 * `{"ok":true}`）。只按 `ok` 判定会把别人的进程报成自己的「OK」，
 * 而请求实际发去了另一个程序。缺失 `service` 字段的历史实现也按「他人占用」处理。
 */
async function probe(addr: string): Promise<Record<string, unknown> | null> {
  try {
    const resp = await fetch(`${baseUrlOf(addr)}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (resp.status !== 200) return null;
    const payload = (await resp.json()) as Record<string, unknown>;
    if (payload["ok"] !== true) return null;
    // 接受本进程认得的**所有**身份：单渠道 `<cid>-bridge` 与仓库级 `model-bridge`。
    // 仓库级网关同时服务各渠道，故单渠道的 status 也应把它认作「自己的网关」。
    const service = payload["service"];
    if (typeof service !== "string" || !gateway.knownServiceNames().includes(service)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** 网关是否为本服务且健康（不抛异常）。 */
export async function gatewayHealthy(addr: string = defaultAddr()): Promise<boolean> {
  return (await probe(addr)) !== null;
}

/**
 * 端口上若有一个**不是本服务**的 HTTP 服务，返回它的服务名（缺失时返回「未知服务」）；
 * 否则空串。供 status 明确报告「端口被 X 占用」而不是含糊说「不可达」。
 */
export async function foreignServiceOnPort(addr: string = defaultAddr()): Promise<string> {
  try {
    const resp = await fetch(`${baseUrlOf(addr)}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (resp.status !== 200) return "";
    const payload = (await resp.json()) as Record<string, unknown>;
    if (payload["ok"] !== true) return "";
    if (
      typeof payload["service"] === "string" &&
      gateway.knownServiceNames().includes(payload["service"])
    ) {
      return "";
    }
    const name = payload["service"];
    return typeof name === "string" && name ? name : "未知服务";
  } catch {
    return "";
  }
}

function pidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(scope: Scope): number {
  try {
    const value = Number.parseInt(readFileSync(scope.pidPath(), "utf8").trim(), 10);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * 结束进程及其子进程（node 的孙进程一并处理）。
 *
 * ⚠ win32 的 taskkill 是**异步**的：发出去就返回会让紧随其后的 `start()` 探到
 *   「还活着的旧进程」→ 报「已在运行」却不换代码（实测踩过：`restart` 声称成功，
 *   端口上跑的还是旧进程）。所以这里必须**等进程真的死掉**再返回。
 *
 * @returns 进程已死（含本来就不存在）→ true；仍在存活 → false。
 */
export async function killTree(pid: number): Promise<boolean> {
  const waitDead = async (): Promise<boolean> => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (!pidAlive(pid)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return !pidAlive(pid);
  };

  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    return waitDead();
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return true; // 本来就不存在
  }
  if (await waitDead()) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已退出 */
  }
  return waitDead();
}

/**
 * 守护进程要重新执行的入口脚本。
 *
 * ⚠ 必须是**当前进程的入口**（`process.argv[1]`），不能是共享包内的 `cli.js`：
 * 仓库级 bin 与各 bridge 的 bin 都是「先注册渠道，再调 `main()`」，而共享包的
 * `cli.js` 只是一组导出、没有自带入口调用 —— 重跑它会立刻退出（守护进程永远起不来）。
 * 重跑自己才能带上与父进程一致的渠道集合。
 *
 * 回退（argv[1] 不是可执行的 JS，如 `node -e`）：本模块同目录的 `cli.js`，由调用方接受失败。
 * 注意 bundle 形态下该回退同样失效（bundle 里没有独立 cli.js）——但回退只在异常启动方式
 * （非文件入口）下触发，属已知限制。
 */
function cliEntry(): string {
  const entry = process.argv[1];
  if (entry && /\.(m?js|cjs)$/i.test(entry) && existsSync(entry)) return entry;
  return fileURLToPath(new URL("./cli.js", import.meta.url));
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
  const args = [
    cliEntry(),
    "serve",
    "--addr",
    addr,
    "--ui-port",
    String(uiPort),
    "--json",
  ];
  // ⚠ stdio 全部重定向到日志文件：守护进程没有控制台可继承，
  //   继承父进程的 stdout 会在父进程退出后写入失败（EPIPE 刷屏）
  const logFd = openSync(scope.logPath(), "a");
  const child = spawn(process.execPath, args, {
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

/** 停止守护式网关（只管理有 PID 文件的实例，不碰第三方进程）。 */
export async function stop(options: { quiet?: boolean; addr?: string; cid?: string } = {}): Promise<number> {
  const { quiet = false } = options;
  const scope = scopeOf(options.cid);
  const pid = readPid(scope);
  const name = scope.name;
  const log = (m: string): void => {
    if (!quiet) console.log(`[${name}] ${m}`);
  };

  if (!pid) {
    if (await gatewayHealthy(options.addr ?? defaultAddr(options.cid))) {
      log("网关在运行但没有 PID 文件（非本机守护拉起），未做处理");
      return 1;
    }
    log("网关未在运行");
    return 0;
  }
  const dead = await killTree(pid);
  if (!dead) {
    // 进程还活着就不能声称「已停止」：留着 PID 文件，下一次 stop 还能再试
    log(`未能停止网关 (PID ${pid})：进程仍存活（可能权限不足），请手动结束`);
    return 1;
  }
  recordStop(scope, pid);
  try {
    unlinkSync(scope.pidPath());
  } catch {
    /* 已被清掉 */
  }
  log(`已停止网关 (PID ${pid})`);
  return 0;
}

/** 重启守护式网关（stop + start；换配置/升级后用）。 */
export async function restart(options: StartOptions = {}): Promise<number> {
  await stop({ quiet: true, ...(options.cid !== undefined ? { cid: options.cid } : {}) });
  // 等端口完全释放再拉起
  await new Promise((r) => setTimeout(r, 800));
  return start(options);
}

function readPidValue(scope: Scope): number | null {
  const pid = readPid(scope);
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
      note: "仅本地台账（我们发起过的领取）；上游的权威答案用 `<cid> checkin --status`",
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
  console.log(
    `${head}  ` +
      `状态: ${state}  守护PID: ${info.daemon_pid ?? "无"}  ` +
      `凭证: ${credentialsPresent ? "有" : "无"}  ` +
      `auto_start: ${info.auto_start ? "开" : "关"}`,
  );
  if (info.signin.tracked > 0) {
    console.log(
      `签到（本地记录）: 今天已签 ${info.signin.claimed_today}/${info.signin.tracked} 个渠道` +
        `（${info.signin.channels.map((c) => `${c.cid}${c.claimed_today ? "✓" : ""}`).join(", ")}）`,
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
