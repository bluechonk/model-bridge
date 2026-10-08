/**
 * WorkBuddyAI 渠道装配：静态配置 + 四个渠道独有模块，注册进共享 gateway 层。
 *
 * 本文件是**共享层与渠道层的唯一边界**：`@model-bridge/gateway` 里的
 * gateway / daemon / headless / auth-flow 都通过这里注册的 `Channel` 拿到
 * cred / upstream / catalog / billing。
 *
 * 旧实现里这些配置（目录名/端口/日志前缀…）靠 scaffold 的字符串替换注入到
 * 11 份共享模块副本里；现在集中在这里一处。
 */

import { setChannel, type BridgeConfig, type Channel } from "@model-bridge/gateway";

import * as billing from "./billing.js";
import * as catalog from "./catalog.js";
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

export const config: BridgeConfig = {
  cid: "workbuddy",
  display: "WorkBuddyAI",
  version: "0.4.0",
  defaultAddr: "127.0.0.1:8787",
  uiPort: 8788,
  // 迁移来源（新→旧）：首项是刚被取代的旧顶层目录名
  legacyDirs: [
    ".workbuddy-bridge",
    ".zcode-workbuddy-bridge",
    ".zcode-connect-workbuddyai",
    ".workbuddyai2api",
    ".workbuddyai-gateway",
  ],
  legacyEnvVars: ["WORKBUDDY_HOME", "ZCB_HOME", "WBAI2API_HOME"],
  debugDumpEnv: "WORKBUDDY_DEBUG_DUMP",
  legacyDebugDumpEnv: ["WBAI_DEBUG_DUMP"],
  fileMigrations: [
    // Python 版 GUI 层的空目录残留（非空时只记日志，不删）
    { from: "webview", action: "delete" },
  ],
};

export const channel: Channel = { config, cred, upstream, catalog, billing };

setChannel(channel);
