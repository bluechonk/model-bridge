/**
 * WorkBuddy（国内版）本地 OpenAI 兼容网关（无窗口引擎）—— 对外出口。
 *
 * 共享层模块来自 `@model-bridge/gateway`；本渠道独有的是 cred / upstream /
 * catalog / billing。导入本文件会顺带注册渠道（见 `./channel.js`）。
 */

// 共享层（原样转出，保持旧的 import 站点可用）
export {
  authFlow,
  cli,
  consoleApi,
  daemon,
  gateway,
  headless,
  modelFamily,
  paths,
  portfree,
  sseStream,
  setChannel,
  getChannel,
  hasChannel,
  version,
  defaultAddr,
  defaultUiPort,
  isAllowedFamily,
  filterAllowedFamily,
  allowlistSummary,
} from "@model-bridge/gateway";

// 渠道独有模块
export * as billing from "./billing.js";
export * as catalog from "./catalog.js";
export * as cred from "./cred.js";
export * as upstream from "./upstream.js";
export * as channel from "./channel.js";
