/**
 * CLI 默认值：从当前渠道的 `BridgeConfig` 读取。
 *
 * 旧实现里这里是三个编译期常量（每个项目各存一份、靠字符串替换区分），
 * 现在改为函数，值随注册的渠道而变，避免共享包携带渠道知识。
 *
 * 保持单独的模块（而非从 channel.ts 直接读）是为了让 `cli.ts` 与 `daemon.ts`
 * 都能引用它而不互相 import。
 */

import { channelCount, getChannel } from "./channel.js";

/**
 * 仓库级（多渠道路由）默认值。
 *
 * 一个网关进程服务多个渠道时，它不属于任何单个渠道，故不取渠道的 `defaultAddr`。
 * `8787` 是既有的仓库级端口约定（ZCode 里的 `model-bridge` provider 就指向它）。
 */
export const REPO_DEFAULT_ADDR = "127.0.0.1:8787";
export const REPO_DEFAULT_UI_PORT = 8788;

/** CLI 版本号。 */
export function version(cid?: string): string {
  if (cid !== undefined) return getChannel(cid).config.version;
  if (channelCount() === 1) return getChannel().config.version;
  return "0.0.0";
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
