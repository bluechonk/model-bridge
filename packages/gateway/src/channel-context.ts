/**
 * 渠道上下文：**当前正在为哪个 cid 干活**。
 *
 * ## 为什么需要它
 *
 * 渠道模块（`cred.ts` / `upstream.ts` / `catalog.ts`）内部会调共享层的 `paths.*`
 * （`credentialsPath()` / `upstreamPath()` / `ensureDir()` / `cacheDir()` …），
 * 但这些函数不知道该渠道是谁 —— 单渠道模式下「唯一注册的渠道」就够，多渠道路由下
 * 必须由**调用方**告诉它们。
 *
 * 用 `AsyncLocalStorage` 而不是模块级变量：`cred.refresh()` / `login()` 这类异步链路
 * 中间有 await，模块级变量会被并发请求互相踩（A 请求刷新 token 时切到 B 的渠道，
 * A 就可能把凭据写进 B 的目录）。ALS 把上下文绑在异步执行链上，天然隔离。
 *
 * ## 用法
 *
 * 共享层在**每一次调用渠道模块之前**包一层：
 *
 * ```ts
 * await runInChannel(channel.config.cid, () => channel.cred.load());
 * ```
 *
 * 单渠道模式下也建议照包 —— 行为等价，但语义显式。
 */

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<string>();

/** 在「当前渠道 = cid」的上下文里运行 `fn`（含其内部的异步链）。 */
export function runInChannel<T>(cid: string, fn: () => T): T {
  return storage.run(cid, fn);
}

/** 当前渠道上下文；不在上下文里时为 undefined。 */
export function activeCid(): string | undefined {
  return storage.getStore();
}

/**
 * 若不在任何渠道上下文里，则在 `cid` 上下文里运行 `fn`；已在上下文里则直接运行。
 *
 * 用于 `/v1/models` 这类「逐个渠道遍历」的循环：外层可能已经有上下文（某个请求），
 * 内层不必重复进入。
 */
export function withinChannel<T>(cid: string, fn: () => T): T {
  return storage.getStore() === undefined ? storage.run(cid, fn) : fn();
}
