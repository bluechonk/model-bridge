/**
 * Cline 渠道装配：静态配置 + 四个渠道独有模块，注册进共享 gateway 层。
 *
 * 本文件是**共享层与渠道层的唯一边界**：`@model-bridge/gateway` 里的
 * gateway / daemon / headless / auth-flow 都通过这里注册的 `Channel` 拿到
 * cred / upstream / catalog / billing。
 *
 * 旧实现里这些配置（目录名/端口/日志前缀…）靠 scaffold 的字符串替换注入到
 * 12 份共享模块副本里；现在集中在这里一处。
 */

import { setChannel, type BridgeConfig, type Channel } from "@model-bridge/gateway";

import * as billing from "./billing.js";
import * as catalog from "./catalog.js";
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

export const config: BridgeConfig = {
  cid: "cline",
  display: "Cline",
  version: "0.1.0",
  defaultAddr: "127.0.0.1:8811",
  uiPort: 8812,
  legacyDirs: [
    ".cline-bridge",
    ".zcode-connect-cline",
    ".cline2api",
    ".cline-gateway",
  ],
  legacyEnvVars: ["CLINE_HOME"],
  debugDumpEnv: "CLINE_DEBUG_DUMP",
};

export const channel: Channel = { config, cred, upstream, catalog, billing };

setChannel(channel);
