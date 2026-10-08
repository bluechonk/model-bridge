/**
 * 登录流程骨架：三类已验证的授权链路的**渠道无关骨架**。
 *
 * | 类型 | 骨架 | 渠道 |
 * |---|---|---|
 * | A. 本地回调服务器 | `startCallbackServer` | trae、codearts、lobsterai |
 * | B. flow 轮询 | `pollFlow` | workbuddyai |
 * | C. 设备码 / 扫码轮询 | `pollDeviceCode` | cline、loomy、raccoon |
 *
 * ## 边界
 *
 * 骨架只负责**流程控制**：起本地端口、按间隔轮询、判终态、超时、退避。
 * **请求怎么发、URL 怎么拼、响应怎么解析、token 怎么换**都是渠道知识，
 * 由调用方通过回调注入。
 *
 * ⚠ 各渠道保留自己的 `login()` 与导出签名（如 codearts 的
 * `startCallbackServer({pkce,keyPair,ticketId})`），薄包装转发到这里的骨架，
 * 以免破坏已有 import 站点与测试引用。
 */

import { createServer, type Server } from "node:http";

// ── A. 本地回调服务器 ─────────────────────────────────────────────────────────

/** 本地回调服务器：等浏览器重定向回本机端口，取出 query 参数。 */
export interface CallbackServer {
  /** 实际监听端口（请求 0 或端口被占时会退到随机端口，**调用方须用此值重算 URL**）。 */
  readonly port: number;
  /** 等首个回调（超时抛错）。同名参数取第一个。 */
  wait(timeoutMs: number): Promise<Record<string, string>>;
  /** 关闭服务器（幂等；未等到回调时会让 wait 拒绝）。 */
  close(): void;
}

/**
 * 启动本地回调服务器。
 *
 * @param options.port      期望端口；被占用（EADDRINUSE/EACCES）时自动退到随机端口
 * @param options.pathPrefix 只处理该路径前缀的请求，其它回 404（缺省全部接受）
 * @param options.html      回给浏览器的页面（缺省一句「可以关闭本页」）
 */
export async function startCallbackServer(
  options: { port?: number; pathPrefix?: string; html?: string } = {},
): Promise<CallbackServer> {
  const { port = 0, pathPrefix, html = DEFAULT_CALLBACK_HTML } = options;

  let settle: (value: Record<string, string>) => void = () => {};
  let fail: (err: Error) => void = () => {};
  const params = new Promise<Record<string, string>>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // close() 可能早于 wait()：先吞掉，避免 unhandled rejection 噪音
  void params.catch(() => {});
  let settled = false;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (pathPrefix && !url.pathname.startsWith(pathPrefix)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const flat: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (!(key in flat)) flat[key] = value; // 同名参数取第一个
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    if (!settled) {
      settled = true;
      settle(flat);
    }
  });

  let actualPort: number;
  try {
    actualPort = await listenOn(server, port);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "EADDRINUSE" && code !== "EACCES") throw err;
    actualPort = await listenOn(server, 0);
  }

  return {
    port: actualPort,
    wait(timeoutMs: number): Promise<Record<string, string>> {
      return new Promise<Record<string, string>>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error(`等待授权回调超时（${Math.round(timeoutMs / 1000)} 秒）`));
          }
        }, timeoutMs);
        params.then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (err: Error) => {
            clearTimeout(timer);
            reject(err);
          },
        );
      });
    },
    close(): void {
      try {
        server.close();
        server.closeAllConnections?.();
      } catch {
        /* 已关闭 */
      }
      if (!settled) {
        settled = true;
        fail(new Error("回调服务器已关闭"));
      }
    },
  };
}

function listenOn(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const address = server.address() as { port: number } | null;
      resolve(address?.port ?? port);
    });
  });
}

const DEFAULT_CALLBACK_HTML =
  "<!doctype html><meta charset=utf-8><title>授权完成</title>" +
  "<p>授权已完成，可以关闭本页返回终端。</p>";

// ── B. flow 轮询 ──────────────────────────────────────────────────────────────

/** 轮询一步的结果。 */
export type PollStep<T> =
  | { kind: "pending" } // 授权中，继续轮询
  | { kind: "retry"; message?: string } // 瞬时问题（5xx / 网络），继续轮询
  | { kind: "done"; value: T } // 拿到结果
  | { kind: "fatal"; error: Error }; // 终态失败，立即抛出

export interface PollFlowOptions<T> {
  /** 每次轮询间隔（毫秒）。 */
  intervalMs: number;
  /** 总等待上限（毫秒）。 */
  windowMs: number;
  /** 执行一次轮询。抛错视为 `retry`（除非回调自行返回 fatal）。 */
  attempt: () => Promise<PollStep<T>>;
  /** 可注入的 sleep（测试用）。 */
  sleep?: (ms: number) => Promise<void>;
  onStatus?: (message: string) => void;
}

/**
 * 通用轮询循环：按 `intervalMs` 反复调用 `attempt`，直到 `done` / `fatal` / 超时。
 *
 * ⚠ 终态判据由 `attempt` 决定（各渠道不同：ZCode 把非 408/429 的 4xx 当 fatal，
 * WorkBuddy 把「200 但还没 token」当 pending），骨架只负责循环与超时。
 * `attempt` 抛出的异常按 `retry` 处理（网络抖动不该终止登录）。
 */
export async function pollFlow<T>(options: PollFlowOptions<T>): Promise<T> {
  const { intervalMs, windowMs, attempt, onStatus } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + windowMs;

  while (Date.now() < deadline) {
    let step: PollStep<T>;
    try {
      step = await attempt();
    } catch (err) {
      onStatus?.(`轮询失败（${String(err)}），继续重试…`);
      step = { kind: "retry" };
    }
    if (step.kind === "done") return step.value;
    if (step.kind === "fatal") throw step.error;
    if (step.kind === "retry" && step.message) onStatus?.(step.message);
    await sleep(intervalMs);
  }
  throw new Error(`等待授权超时（${Math.round(windowMs / 60000)} 分钟）`);
}

// ── C. 设备码 / 扫码轮询 ──────────────────────────────────────────────────────

/** 设备码轮询一步的结果。 */
export type DevicePollStep<T> =
  | { kind: "pending" }
  | { kind: "slow_down" } // 服务端要求放慢 → 永久抬高本轮的轮询间隔
  | { kind: "done"; value: T }
  | { kind: "fatal"; error: Error };

export interface PollDeviceOptions<T> {
  /** 初始轮询间隔（毫秒）。 */
  intervalMs: number;
  /** 设备码有效期（秒），来自上游。 */
  expiresInSec: number;
  /** 连续网络失败上限（超过即放弃）。 */
  maxConsecutiveFailures?: number;
  attempt: () => Promise<DevicePollStep<T>>;
  sleep?: (ms: number) => Promise<void>;
  onStatus?: (message: string) => void;
  /** slow_down 每次抬高的毫秒数（缺省 1000）。 */
  slowDownStepMs?: number;
}

/**
 * 设备码 / 扫码轮询：在 `pollFlow` 基础上加两条设备码特有的规则。
 *
 * - `slow_down`：**累积**抬高间隔（每次都加，不重置）—— 这是 RFC 8628 的要求，
 *   重置成固定值会在服务端持续限流时陷入死循环。
 * - 连续网络失败计数：超过上限即抛错，避免上游挂掉后一直空转到超时。
 */
export async function pollDeviceCode<T>(options: PollDeviceOptions<T>): Promise<T> {
  const { expiresInSec, maxConsecutiveFailures = 5, onStatus, slowDownStepMs = 1000 } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + Math.max(1, expiresInSec) * 1000;
  let intervalMs = options.intervalMs;
  let failures = 0;

  for (;;) {
    if (Date.now() >= deadline) throw new Error("设备码授权超时，请重新运行 login");

    let step: DevicePollStep<T>;
    try {
      step = await options.attempt();
      failures = 0;
    } catch (err) {
      failures += 1;
      if (failures >= maxConsecutiveFailures) {
        throw new Error(`轮询设备码连续 ${failures} 次网络失败: ${String(err)}`);
      }
      await sleep(intervalMs);
      continue;
    }

    if (step.kind === "done") return step.value;
    if (step.kind === "fatal") throw step.error;
    if (step.kind === "slow_down") {
      intervalMs += slowDownStepMs; // 必须真的累积
      onStatus?.(`服务端要求放慢轮询，间隔调整为 ${intervalMs / 1000}s`);
    }
    await sleep(intervalMs);
  }
}
