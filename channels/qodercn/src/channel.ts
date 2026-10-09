/**
 * Qoder 国内版渠道装配（`qoder.com.cn`，阿里云生态）。
 *
 * ⚠ 与国际版 `qoder`（`qoder.com`）是**两个独立渠道**：域是渠道身份的一部分，写死在
 * 配置里，账号在哪个域就用哪个渠道登录，登录链路与凭证落点不随 `--realm` 漂移。
 *
 * cred / upstream / catalog / billing 与国际版高度相似（重复代码）是有意的：两区的端点、
 * 模型目录、账单口径都可能各自演进，共享抽象会把「一个改了两边都变」变成默认行为。
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
  // 本渠道没有需要迁移的历史目录，刻意**不**声明 `legacyDirs` / `legacyEnvVars`：
  // 那些旧目录里的凭据血统不明（可能是国际版留下的 `domain=qoder.com`），声明在这里
  // 会把国际版数据迁进国内渠道 —— 等于跨区串号。
  debugDumpEnv: "QODERCN_DEBUG_DUMP",
};

export const channel: Channel = {
  config,
  cred,
  upstream: { ...upstream, isQueueError: (frame: Record<string, unknown>) => upstream.isQueueError(frame) },
  catalog,
  billing,
};

setChannel(channel);
