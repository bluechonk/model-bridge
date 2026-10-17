/**
 * 进程与端口工具：PID 存活判定、进程树结束、健康探测、入口脚本定位。
 *
 * 从 `daemon.ts` 拆出：这些是**与生命周期语义正交**的纯工具 ——
 * supervisor / status / stop 都要用，单独成文件后依赖方向更直白
 * （supervisor 不再需要为了拿 killTree 而 import 整个 daemon）。
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { channelCount, channels, getChannel, type Channel } from "../runtime/channel.js";
import { defaultAddr } from "../runtime/cli-consts.js";
import * as gateway from "../http/gateway.js";
import * as paths from "../runtime/paths.js";
import { baseUrlOf } from "../http/portfree.js";

/** 探测超时（毫秒）：status 与 probe 共用。 */
export const HEALTH_TIMEOUT_MS = 1500;

/**
 * 运行范围。
 *
 * - **渠道级**（显式 `cid`，或只注册了一个渠道）：PID/日志/偏好都在渠道层内 `<root>/<cid>/`。
 * - **仓库级**（多渠道路由且未指定 cid）：一个网关进程服务多个渠道，它不属于任何单个
 *   渠道，故 PID/日志/偏好落在根上 `<root>/`。
 */
export interface Scope {
  /** 渠道 id；仓库级为 undefined。 */
  cid?: string;
  /** CLI 名与日志前缀。 */
  name: string;
  pidPath: () => string;
  workerPidPath: () => string;
  logPath: () => string;
  prefsPath: () => string;
}

export function scopeOf(cid?: string): Scope {
  if (cid !== undefined) {
    const name = getChannel(cid).config.cid;
    return {
      cid,
      name,
      pidPath: () => paths.pidPath(cid),
      workerPidPath: () => paths.workerPidPath(cid),
      logPath: () => paths.logPath(cid),
      prefsPath: () => paths.prefsPath(cid),
    };
  }
  if (channelCount() === 1) {
    return {
      name: channels()[0]!.config.cid,
      pidPath: () => paths.pidPath(),
      workerPidPath: () => paths.workerPidPath(),
      logPath: () => paths.logPath(),
      prefsPath: () => paths.prefsPath(),
    };
  }
  return {
    name: "modelmux",
    pidPath: () => paths.rootPidPath(),
    workerPidPath: () => paths.rootWorkerPidPath(),
    logPath: () => paths.rootLogPath(),
    prefsPath: () => paths.rootPrefsPath(),
  };
}

/**
 * 探测端口上的健康载荷；不是本服务时返回 null。
 *
 * ⚠ 必须核对 `service` 字段：同一端口上可能跑着**别的**网关（它们同样返回
 * `{"ok":true}`）。只按 `ok` 判定会把别人的进程报成自己的「OK」，
 * 而请求实际发去了另一个程序。缺失 `service` 字段的历史实现也按「他人占用」处理。
 */
export async function probe(addr: string): Promise<Record<string, unknown> | null> {
  try {
    const resp = await fetch(`${baseUrlOf(addr)}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (resp.status !== 200) return null;
    const payload = (await resp.json()) as Record<string, unknown>;
    if (payload["ok"] !== true) return null;
    // 接受本进程认得的**所有**身份：单渠道的 `cid` 与仓库级 `modelmux`。
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

export function pidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // 只有 ESRCH（进程确实不存在）算「已死」。EPERM（权限不足）等
    // 其他错误恰恰说明进程对象还在 —— 保守按「活着」处理，否则
    // stop 会把杀不掉的进程误报成已停（实测踩过：stop 报成功、
    // 进程照常占着端口服务）。
    return (err as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

export function readPid(scope: Scope): number {
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
  } catch (err) {
    // 同 pidAlive：只有「确实不存在」才算已死；权限错误等
    // 说明进程还活着，交给 waitDead 去验证
    if ((err as NodeJS.ErrnoException)?.code === "ESRCH") return true;
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
 * 仓库级 bin 与各渠道包的 bin 都是「先注册渠道，再调 `main()`」，而共享包的
 * `cli.js` 只是一组导出、没有自带入口调用 —— 重跑它会立刻退出（守护进程永远起不来）。
 * 重跑自己才能带上与父进程一致的渠道集合。
 *
 * 回退（argv[1] 不是可执行的 JS，如 `node -e`）：本模块同目录的 `cli.js`，由调用方接受失败。
 * 注意 bundle 形态下该回退同样失效（bundle 里没有独立 cli.js）——但回退只在异常启动方式
 * （非文件入口）下触发，属已知限制。
 */
export function cliEntry(): string {
  const entry = process.argv[1];
  if (entry && /\.(m?js|cjs)$/i.test(entry) && existsSync(entry)) return entry;
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}
