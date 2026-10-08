/**
 * WorkBuddy 渠道装配（**国内版**：腾讯 CodeBuddy，`codebuddy.ai`）。
 *
 * 本文件是**共享层与渠道层的唯一边界**：`@model-bridge/gateway` 里的
 * gateway / daemon / headless / auth-flow 都通过这里注册的 `Channel` 拿到
 * cred / upstream / catalog / billing。
 *
 * ⚠ 与国际版 `workbuddyai`（`workbuddy.ai`）是**两个独立渠道**：账号在哪个域，
 * 就必须用哪个渠道登录。这里**刻意不再做「国际/国内」二选一** —— 域是渠道身份
 * 的一部分，写死在配置里，登录链路与凭证落点就不会随 `--realm` 漂移。
 *
 * 代价是 cred / upstream / catalog / billing 与国际版高度相似（重复代码）。
 * 这是有意的：两个产品的端点、模型目录、账单口径都可能各自演进，共享抽象会把
 * 「一个改了两边都变」变成默认行为。
 */

import { setChannel, type BridgeConfig, type Channel } from "@model-bridge/gateway";

import * as billing from "./billing.js";
import * as catalog from "./catalog.js";
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

export const config: BridgeConfig = {
  cid: "workbuddy",
  display: "WorkBuddy（国内版）",
  version: "0.1.0",
  defaultAddr: "127.0.0.1:8803",
  uiPort: 8804,
  // 本渠道是拆分后**新建**的（此前 workbuddyai 一个渠道兼做国际/国内），没有历史目录。
  //
  // ⚠ 刻意**不**声明 `.workbuddy-bridge`：那个目录里是**国际版**的旧凭证
  // （实测 `domain=www.workbuddy.ai`），血统属于 workbuddyai；声明在这里会把
  // 国际数据迁进国内渠道，等于跨产品串号。同理不认 `WORKBUDDY_HOME` /
  // `WORKBUDDY_DEBUG_DUMP` 的历史值。见 docs/STORAGE-CONVENTION.md「拆分歧义名」。
  legacyDirs: [],
  legacyEnvVars: [],
  debugDumpEnv: "WORKBUDDY_DEBUG_DUMP",
  legacyDebugDumpEnv: [],
};

export const channel: Channel = { config, cred, upstream, catalog, billing };

setChannel(channel);
