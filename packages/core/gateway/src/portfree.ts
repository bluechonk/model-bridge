/**
 * 端口占用处理：监听失败时识别占用进程；仅自动结束自身的残留实例，
 * 其他进程需用户确认后才结束，等待端口释放后重试。
 *
 * 渠道无关：不读任何渠道配置。
 */

import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { basename, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

/** 端口被占用且无法自动释放。 */
export class PortBusyError extends Error {
  override name = "PortBusyError";
}

function dedupe(pids: number[]): number[] {
  return [...new Set(pids)];
}

/** 返回正在监听指定端口的所有进程 PID。 */
export function findPortPids(port: number): number[] {
  try {
    if (process.platform === "win32") {
      // 解析 `netstat -ano -p tcp`，行形如：
      //   TCP    127.0.0.1:8803    0.0.0.0:0    LISTENING    12345
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        windowsHide: true,
      });
      const suffix = `:${port}`;
      const pids: number[] = [];
      for (const line of out.split("\n")) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 5 || fields[0] !== "TCP" || fields[3] !== "LISTENING") continue;
        if (!fields[1]!.endsWith(suffix)) continue;
        const pid = Number.parseInt(fields[fields.length - 1]!, 10);
        if (Number.isFinite(pid) && pid > 0) pids.push(pid);
      }
      return dedupe(pids);
    }
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    });
    return dedupe(
      out
        .split("\n")
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isFinite(pid) && pid > 0),
    );
  } catch {
    return [];
  }
}

/** 过滤掉自身与系统进程 PID（0/4），避免误杀。 */
export function excludeSelf(pids: number[]): number[] {
  const self = process.pid;
  return pids.filter((p) => p !== self && p !== 0 && p !== 4);
}

/** 返回进程名（用于区分自身残留实例与第三方进程），失败返回空串。 */
export function procName(pid: number): string {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        windowsHide: true,
      });
      const line = out.trim();
      const comma = line.indexOf(",");
      if (comma <= 0) return "";
      let name = line.slice(0, comma).trim().replace(/^"|"$/g, "");
      if (name.toLowerCase().endsWith(".exe")) name = name.slice(0, -4);
      return name.toLowerCase();
    }
    const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
    return basename(out.trim());
  } catch {
    return "";
  }
}

/** 返回当前可执行文件的基础名，统一去掉 .exe 后缀以便与进程名比较。 */
export function exeName(): string {
  const argv1 = process.argv[1] ?? "";
  let base = basename(argv1);
  if (base.toLowerCase().endsWith(".exe")) base = base.slice(0, -4);
  return base.toLowerCase();
}

/** 结束指定进程；非 Windows 先尝试 SIGTERM，超时再 SIGKILL。 */
export function killPid(pid: number): void {
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/F", "/PID", String(pid)], { windowsHide: true });
    return;
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // 进程已退出
    }
    sleepSync(100);
  }
  process.kill(pid, "SIGKILL");
}

function sleepSync(ms: number): void {
  // Atomics.wait 在 Windows 上对主线程也可用（不像 sleep() 那样被 SIGINT 打断）
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

async function confirmKill(port: number): Promise<boolean> {
  // 非交互环境下不自动杀第三方进程（否则识别失败会变成"静默杀掉任意进程"）
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`Kill this process to free port ${port}? [y/N] `, resolve);
    });
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

/**
 * 在 (host, port) 上建立 HTTP 监听；若端口被其他进程占用：
 * - 占用进程是自身可执行文件的残留实例 → 自动结束并重试；
 * - 其他进程 → 打印进程名并请求确认，拒绝或非交互环境下报错。
 */
export async function bindFreeServer(
  host: string,
  port: number,
  printf: (msg: string) => void,
): Promise<Server> {
  const tryListen = (): Promise<Server | null> =>
    new Promise((resolve) => {
      const server = createServer();
      server.once("error", () => {
        server.close();
        resolve(null);
      });
      server.listen(port, host, () => resolve(server));
    });

  const first = await tryListen();
  if (first) return first;

  const pids = excludeSelf(findPortPids(port));
  if (pids.length === 0) {
    throw new PortBusyError(`port ${port} is in use; could not identify the owning process; free it manually and retry`);
  }
  const selfName = exeName();
  for (const pid of pids) {
    const name = procName(pid);
    // 只有确认为自身同名进程才自动结束；进程名未知时按第三方处理（需确认）
    if (name && name === selfName) {
      printf(`port ${port} is held by our own leftover instance (${name}, PID ${pid}); killing it...`);
    } else {
      printf(`port ${port} is held by another process: ${name || "unknown"} (PID ${pid})`);
      if (!(await confirmKill(port))) {
        throw new PortBusyError(
          `port ${port} is held by ${name || "unknown process"} (PID ${pid}); cancelled; ` +
            `change --addr or free the port manually`,
        );
      }
    }
    try {
      killPid(pid);
    } catch (err) {
      throw new PortBusyError(`failed to kill the process holding port ${port} (PID ${pid}): ${String(err)}`);
    }
  }

  const deadline = Date.now() + 5000;
  let lastErr = "";
  while (Date.now() < deadline) {
    sleepSync(300);
    const server = await tryListen();
    if (server) return server;
    lastErr = "listen failed";
  }
  throw new PortBusyError(`port ${port} was still not free after killing the holder; retry later (${lastErr})`);
}

/** 把监听地址转成可展示的 host:port（空/通配 host 回显为 127.0.0.1）。 */
export function displayBase(addr: string): string {
  if (addr.split(":").length > 2) {
    if (!addr.startsWith("[")) return addr; // 裸 IPv6
    const close = addr.indexOf("]");
    if (close < 0) return addr;
    const host = addr.slice(1, close);
    const rest = addr.slice(close + 1);
    const port = rest.startsWith(":") ? rest.slice(1) : "";
    return `${host === "" || host === "::" ? "127.0.0.1" : host}:${port}`;
  }
  const idx = addr.lastIndexOf(":");
  if (idx < 0) return addr;
  let host = addr.slice(0, idx);
  const port = addr.slice(idx + 1);
  if (!port) return addr;
  if (host === "" || host === "0.0.0.0" || host === "::") host = "127.0.0.1";
  return `${host}:${port}`;
}

/** 把监听地址规范成可请求的 base URL。 */
export function baseUrlOf(addr: string): string {
  const normalized = displayBase(addr);
  return `http://${normalized}`;
}

/** 该路径是否是绝对路径（供 selftest 用）。 */
export function isAbs(p: string): boolean {
  return isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);
}

/** 拼接路径（供 selftest 用）。 */
export function joinPath(...parts: string[]): string {
  return join(...parts);
}
