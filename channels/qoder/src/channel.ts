/**
 * Qoder 渠道装配：静态配置 + 四个渠道独有模块，注册进共享 gateway 层。
 *
 * 本文件是**共享层与渠道层的唯一边界**：`@model-bridge/gateway` 里的
 * gateway / daemon / headless / auth-flow 都通过这里注册的 `Channel` 拿到
 * cred / upstream / catalog / billing。
 */

import { setChannel, type BridgeConfig, type Channel } from "@model-bridge/gateway";

import * as billing from "./billing.js";
import * as catalog from "./catalog.js";
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

export const config: BridgeConfig = {
  cid: "qoder",
  display: "Qoder",
  version: "0.1.0",
  defaultAddr: "127.0.0.1:8801",
  uiPort: 8802,
  legacyDirs: [
    ".qoder-bridge",
    ".zcode-connect-qoder",
    ".qoder2api",
    ".qoder-gateway",
  ],
  legacyEnvVars: ["QODER_HOME"],
  debugDumpEnv: "QODER_DEBUG_DUMP",
};

export const channel: Channel = {
  config,
  cred,
  upstream: { ...upstream, isQueueError: (frame: Record<string, unknown>) => upstream.isQueueError(frame) },
  catalog,
  billing,
};

setChannel(channel);
