/**
 * WorkBuddyAI 渠道装配（**国际版**：`workbuddy.ai`）。
 *
 * 本文件是**共享层与渠道层的唯一边界**：`@model-bridge/gateway` 里的
 * gateway / daemon / headless / auth-flow 都通过这里注册的 `Channel` 拿到
 * cred / upstream / catalog / billing。
 *
 * ⚠ 国内版（腾讯 CodeBuddy，`codebuddy.ai`）是**独立渠道** `workbuddy`：
 * 域是渠道身份的一部分，一个渠道一个域，不再按 `--realm` 分流。
 */

import { setChannel, type BridgeConfig, type Channel } from "@model-bridge/gateway";

import * as billing from "./billing.js";
import * as catalog from "./catalog.js";
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

export const config: BridgeConfig = {
  cid: "workbuddyai",
  display: "WorkBuddyAI",
  version: "0.4.0",
  defaultAddr: "127.0.0.1:8787",
  uiPort: 8788,
  // 迁移来源（新→旧）。**不含** `.workbuddy-bridge` / `WORKBUDDY_HOME` /
  // `WORKBUDDY_DEBUG_DUMP`：这些「裸 workbuddy」名字现在归**独立渠道** `workbuddy`
  // （国内版 codebuddy.ai）所有 —— 一个名字只能属于一个渠道，否则会跨产品串号。
  // 旧数据早已迁到 `<root>/workbuddyai/`，无需再认它们。
  legacyDirs: [
    ".zcode-workbuddy-bridge",
    ".zcode-connect-workbuddyai",
    ".workbuddyai2api",
    ".workbuddyai-gateway",
  ],
  legacyEnvVars: ["ZCB_HOME", "WBAI2API_HOME"],
  debugDumpEnv: "WORKBUDDYAI_DEBUG_DUMP",
  legacyDebugDumpEnv: ["WBAI_DEBUG_DUMP"],
  fileMigrations: [
    // 迁移遗留的空目录残留（非空时只记日志，不删）
    { from: "webview", action: "delete" },
  ],
};

export const channel: Channel = { config, cred, upstream, catalog, billing };

setChannel(channel);
