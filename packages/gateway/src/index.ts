/**
 * `@model-bridge/gateway`：各渠道 bridge 共享的 gateway 层。
 *
 * 对外导出各模块，供 bridge 入口与测试按需引入。渠道差异通过 `setChannel()`
 * 注册的 `Channel` 注入 —— 本包不 import 任何渠道模块。
 */

export * as authFlow from "./auth-flow.js";
export * as cli from "./cli.js";
export * as consoleApi from "./console.js";
export * as daemon from "./daemon.js";
export * as gateway from "./gateway.js";
export * as headless from "./headless.js";
export * as login from "./login.js";
export * as loginFlow from "./login-flow.js";
export * as migrate from "./migrate.js";
export * as modelFamily from "./model-family.js";
export * as paths from "./paths.js";
export * as portfree from "./portfree.js";
export * as report from "./report.js";
export * as sseStream from "./sse-stream.js";

// 渠道注册表
export {
  setChannel,
  getChannel,
  hasChannel,
  channels,
  channelFor,
  channelCount,
  clearChannels,
  type BridgeConfig,
  type Channel,
  type Credential,
  type CredModule,
  type UpstreamModule,
  type CatalogModule,
  type BillingModule,
  type UpstreamConfig,
  type CreditsResult,
  type CreditPackage,
  type LoginUi,
  type StreamTranslator,
  type SigninModule,
  type SigninStatus,
  type SigninOutcome,
} from "./channel.js";
export type { FileMigration } from "./migrate.js";

// 账号池（一个渠道下多个账号）
export * as accounts from "./account-pool.js";
export type { PoolAccount, PoolIndex, AccountHealth } from "./account-pool.js";

// 模型池（对外 id 恒小写 + 大小写不敏感解析）
export { poolIds, qualifiedId, resolvePoolModel } from "./model-pool.js";

// 渠道上下文（调用渠道模块前包一层，让渠道内部的 paths.* 解析到自己的落点）
export { runInChannel, withinChannel, activeCid } from "./channel-context.js";

// 默认值（随注册的渠道而变）
export {
  version,
  defaultAddr,
  defaultUiPort,
  REPO_DEFAULT_ADDR,
  REPO_DEFAULT_UI_PORT,
} from "./cli-consts.js";

// 模型池路由与服务身份
export { serviceName, knownServiceNames, resolveTarget, IMPLEMENTATION } from "./gateway.js";

// 落点与凭据路径（渠道模块常用）
export {
  ROOT_DIR_NAME,
  ROOT_ENV,
  FILES,
  SUBDIRS,
  rootDir,
  channelDir,
  rootDirFor,
  channelDirFor,
  legacySearchParents,
  channelFile,
  rootFile,
  rootPidPath,
  rootLogPath,
  cacheDir,
  stateDir,
  debugDir,
  ensureCacheDir,
  ensureStateDir,
  ensureDir,
  rootPrefsPath,
  logPath,
  pidPath,
  prefsPath,
  credentialsPath,
  upstreamPath,
} from "./paths.js";

// 模型家族白名单
export { FAMILY_ALLOWLIST, isAllowedFamily, filterAllowedFamily, allowlistSummary } from "./model-family.js";

// CLI 入口
export { main, usage } from "./cli.js";
