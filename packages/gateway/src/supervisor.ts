/**
 * 网关监督进程（supervisor）：`mx start` spawn 的常驻看护者，`mx start` 自身随即退出。
 *
 * 进程模型见 docs/DAEMON-SUPERVISOR.md：监督者只管生命周期
 * —— spawn worker → 等健康 → 监听 exit → 按指数退避重生（参数照 CCR 3.1.3 实测行为）。
 *
 * 终止语义：
 * - worker 死前已通过健康探测 → 按退避重生；
 * - worker 启动窗口内死亡/超时未 healthy（如端口被占）→ 记 error 后退出，不无限重生；
 * - 监督者自身被杀 = 作废重生（杀监督者即 cancel，无进程内协议）；
 * - worker 侧 IPC 断开自退（监督者消失时 worker 干净离场）。
 *
 * ⚠ 落点（pid/日志/cwd）全部由 `mx start` 以**显式路径**下发：scope 推导（渠道级 vs
 *   仓库级）是 daemon 的职责，监督者不重复推导 —— 多渠道路由下渠道级路径函数需要
 *   explicit cid，监督者贸然调 paths.* 会启动即崩（实测踩过）。
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";

import { cliEntry, DEFAULT_WAIT_MS, gatewayHealthy } from "./daemon.js";

/** worker 稳定运行该时长后重置退避计数（CCR：稳定 60s 清零，首杀只等 1s）。 */
const STABLE_MS = 60_000;
/** 退避封顶（CCR 同款）。 */
const MAX_BACKOFF_MS = 30_000;
/** 健康探测轮询间隔。 */
const HEALTH_POLL_MS = 250;

/** CCR 退避公式：1s × 2^n，n 封顶 5，总封顶 30s。 */
function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempts, 5));
}

/** 监督者的落点参数（scope 相关路径由 `mx start` 下发，见文件头注释）。 */
export interface SuperviseOptions {
  addr: string;
  uiPort: number;
  /** worker PID 文件路径（监督者维护，重生时更新）。 */
  workerPid: string;
  /** 运行日志路径（监督者与 worker 的事件行都落这里）。 */
  log: string;
  /** worker 的工作目录。 */
  cwd: string;
}

export function superviseLog(event: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...extra }));
}

function waitExit(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal: signal ?? null }));
    child.once("error", (err) => {
      console.error(`[supervisor] worker spawn failed: ${String(err)}`);
      resolve({ code: null, signal: "spawn-error" });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeWorkerPid(pidPath: string, pid: number): void {
  try {
    writeFileSync(pidPath, `${pid}\n`, "utf8");
  } catch (err) {
    console.warn(`[supervisor] failed to write worker pid file: ${String(err)}`);
  }
}

function clearWorkerPid(pidPath: string): void {
  try {
    unlinkSync(pidPath);
  } catch {
    /* 本来就不在 */
  }
}

/**
 * 监督进程主循环（`mx supervise` 的落点；由 `mx start` spawn，不是用户命令）。
 *
 * 事件行打到 stdout/stderr → 被 `mx start` 的 stdio 重定向聚进 gateway.log，
 * 与 worker 的 emit 行同一条时间线。
 */
export async function runSupervise(options: SuperviseOptions): Promise<number> {
  const { addr, uiPort, workerPid: workerPidFile, log: logPath, cwd } = options;
  // worker 参数与 daemon.start 旧格式一致；worker 的渠道身份由其入口自带
  // （渠道级 start 时 cliEntry() 就是该渠道包的 cli.js，单渠道特例自动生效）。
  // ⚠ 首位必须是入口脚本：spawn(process.execPath, [entry, "serve", ...])，
  //   漏了它 worker 起不来（实测踩过：直接 ["serve", ...] 导致 worker 崩）。
  // IPC fd（stdio 第 4 项）给 worker 的自退钩子（headless.runServe）。
  const workerArgs = [
    cliEntry(),
    "serve",
    "--addr",
    addr,
    "--ui-port",
    String(uiPort),
    "--json",
  ];

/** 心跳间隔：监督者持续向 worker 发 ping；worker 侧超时判定见 headless.ts。 */
const PING_INTERVAL_MS = 2_000;

let attempts = 0;
for (;;) {
    const logFd = openSync(logPath, "a");
    const child = spawn(process.execPath, workerArgs, {
      // 不 detached：worker 归监督者的进程树管，taskkill /T 杀监督者可整树清
      stdio: ["ignore", logFd, logFd, "ipc"],
      windowsHide: true,
      cwd,
    });
    closeSync(logFd);
    writeWorkerPid(workerPidFile, child.pid ?? 0);
    superviseLog("worker_spawned", { pid: child.pid, attempt: attempts });

    // 心跳：Windows 下父进程死亡不保证触发子端 disconnect（实测：父 exit 后子端
    // 收不到），故用应用层 ping 做父死感知 —— worker 8s 收不到即判定监督者消失。
    const pinger = setInterval(() => {
      try {
        child.send({ type: "supervisor-ping" });
      } catch {
        /* channel 已断，worker 的超时判定会接管 */
      }
    }, PING_INTERVAL_MS);

    // 启动窗口：worker 退出或超时未 healthy 都算「从未就绪」→ 不重生，退出监督者。
    // 与 daemon.start 的等待窗口同值（12s），两端超时口径一致。
    const healthy = await (async (): Promise<boolean> => {
      const deadline = Date.now() + DEFAULT_WAIT_MS;
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) return false;
        if (await gatewayHealthy(addr)) return true;
        await sleep(HEALTH_POLL_MS);
      }
      return child.exitCode === null && (await gatewayHealthy(addr));
    })();
    if (!healthy) {
      const code = child.exitCode;
      clearInterval(pinger);
      if (code === null && child.pid) {
        // 超时未 healthy 但进程还在：补一刀再走，避免留下无监督 worker
        try {
          child.kill("SIGTERM");
        } catch {
          /* 已退出 */
        }
      }
      console.error(
        `[supervisor] worker did not become healthy within ${DEFAULT_WAIT_MS / 1000}s ` +
          `exit=${code ?? "running"}; giving up (no respawn for a worker that never served)`,
      );
      clearWorkerPid(workerPidFile);
      return 1;
    }

    const healthyAt = Date.now();
    const exited = await waitExit(child);
    clearInterval(pinger);
    // CCR 判定：稳定运行 ≥60s 清零退避计数（长期健康 worker 首次被杀只等 1s）
    if (Date.now() - healthyAt >= STABLE_MS) attempts = 0;
    const delay = backoffMs(attempts++);
    console.warn(
      `[supervisor] gateway worker exited unexpectedly ` +
        `(code=${exited.code ?? "signal:" + String(exited.signal)}); restarting in ${delay}ms`,
    );
    superviseLog("worker_exited", { code: exited.code, signal: exited.signal, delay_ms: delay });
    await sleep(delay);
  }
}
