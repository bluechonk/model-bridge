/**
 * Qoder 国内版渠道装配（`qoder.com.cn`，阿里云生态）。
 *
 * ⚠ 与国际版 `qoder`（`qoder.com`）是**两个独立渠道**：账号在哪个域，就必须用哪个
 * 渠道登录。这里**刻意不做「国际/国内」二选一** —— 域是渠道身份的一部分，写死在
 * 配置里，登录链路与凭证落点就不会随 `--realm` 漂移（同 `workbuddy` / `workbuddyai`
 * 的拆法）。
 *
 * 代价是 cred / upstream / catalog / billing 与国际版高度相似（重复代码）。这是有意
 * 的：两区的端点、模型目录、账单口径都可能各自演进，共享抽象会把「一个改了两边都变」
 * 变成默认行为。
 */

import { setChannel, type BridgeConfig, type Channel } from "@model-bridge/gateway";

import * as billing from "./billing.js";
import * as catalog from "./catalog.js";
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

export const config: BridgeConfig = {
  cid: "qodercn",
  display: "Qoder 国内版",
  version: "0.1.0",
  defaultAddr: "127.0.0.1:8817",
  uiPort: 8818,
  // 本渠道是拆分后**新建**的（此前 `qoder` 一个渠道兼做国际/国内），没有自己的历史目录。
  //
  // ⚠ 刻意**不**声明 `legacyDirs` / `legacyEnvVars`：那些历史目录里的凭据血统不明
  // （可能是国际版留下的，`domain=qoder.com`），声明在这里会把国际版的登录数据迁进
  // 国内渠道 —— 等于跨区串号。国际版的旧数据归 `qoder` 渠道。
  debugDumpEnv: "QODERCN_DEBUG_DUMP",
};

export const channel: Channel = { config, cred, upstream, catalog, billing };

setChannel(channel);
