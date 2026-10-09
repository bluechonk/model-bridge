/**
 * CatPaw（美团妙手）渠道装配：静态配置 + 四个渠道独有模块，注册进共享 gateway 层。
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
  cid: "catpaw",
  display: "CatPaw",
  version: "0.4.0",
  defaultAddr: "127.0.0.1:8790",
  uiPort: 8791,
  // 迁移来源（新→旧）：首项是刚被取代的旧顶层目录名
  legacyDirs: [".catpaw-bridge", ".zcode-catpaw-bridge", ".zcode-connect-catpaw"],
  legacyEnvVars: ["CATPAW_HOME", "ZCC_HOME"],
  debugDumpEnv: "CATPAW_DEBUG_DUMP",
  fileMigrations: [
    // 旧版守护进程写的是 daemon.pid（现规范名 gateway.pid）
    { from: "daemon.pid", to: "gateway.pid" },
  ],
};

export const channel: Channel = { config, cred, upstream, catalog, billing };

setChannel(channel);