/**
 * CLI 默认值：从当前渠道的 `BridgeConfig` 读取。
 *
 * 旧实现里这里是三个编译期常量（每个项目各存一份、靠字符串替换区分），
 * 现在改为函数，值随注册的渠道而变，避免共享包携带渠道知识。
 *
 * 保持单独的模块（而非从 channel.ts 直接读）是为了让 `cli.ts` 与 `daemon.ts`
 * 都能引用它而不互相 import。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { channelCount, getChannel } from "./channel.js";

/**
 * 入口包（`process.argv[1]` 所在包）的版本。
 *
 * 多渠道路由下没有"渠道版本"可言，`--version` 该报**仓库级 CLI**（bin `model-bridge`）的版本；
 * 而共享层不知道自己在哪个入口下被跑，故从入口脚本的位置反推它的 package.json。
 */
function entryVersion(): string {
  try {
    const entry = process.argv[1];
    if (!entry) return "0.0.0";
    const parsed: unknown = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8"));
    const version = (parsed as { version?: unknown })?.version;
    return typeof version === "string" ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * 仓库级（多渠道路由）默认值。
 *
 * 一个网关进程服务多个渠道时，它不属于任何单个渠道，故不取渠道的 `defaultAddr`。
 * `8787` 是既有的仓库级端口约定（ZCode 里的 `model-bridge` provider 就指向它）。
 */
export const REPO_DEFAULT_ADDR = "127.0.0.1:8787";
export const REPO_DEFAULT_UI_PORT = 8788;

/** CLI 版本号：渠道级 = 该渠道的版本；多渠道路由 = 入口包（仓库级 CLI）的版本。 */
export function version(cid?: string): string {
  if (cid !== undefined) return getChannel(cid).config.version;
  if (channelCount() === 1) return getChannel().config.version;
  return entryVersion();
}

/** 网关默认监听地址（多渠道路由时用仓库级默认值）。 */
export function defaultAddr(cid?: string): string {
  if (cid !== undefined) return getChannel(cid).config.defaultAddr;
  if (channelCount() === 1) return getChannel().config.defaultAddr;
  return REPO_DEFAULT_ADDR;
}

/** 控制台 API 默认端口（多渠道路由时用仓库级默认值）。 */
export function defaultUiPort(cid?: string): number {
  if (cid !== undefined) return getChannel(cid).config.uiPort;
  if (channelCount() === 1) return getChannel().config.uiPort;
  return REPO_DEFAULT_UI_PORT;
}
