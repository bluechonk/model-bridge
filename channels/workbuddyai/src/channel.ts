/**
 * WorkBuddyAI 渠道装配（**国际版**：`workbuddy.ai`）。
 *
 * 本文件是**共享层与渠道层的唯一边界**：`@modelmux/gateway` 里的
 * gateway / daemon / headless / auth-flow 都通过这里注册的 `Channel` 拿到
 * cred / upstream / catalog / billing。
 *
 * ⚠ 国内版（腾讯 CodeBuddy，`codebuddy.ai`）是**独立渠道** `workbuddy`：
 * 域是渠道身份的一部分，一个渠道一个域，不再按 `--realm` 分流。
 */

import { setChannel, type ChannelConfig, type Channel } from "@modelmux/gateway";

import * as billing from "./billing.js";
import * as catalog from "./catalog.js";
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

export const config: ChannelConfig = {
  cid: "workbuddyai",
  display: "WorkBuddyAI",
  version: "0.4.0",
  defaultAddr: "127.0.0.1:8787",
  uiPort: 8788,
  debugDumpEnv: "WORKBUDDYAI_DEBUG_DUMP",
};

export const channel: Channel = { config, cred, upstream, catalog, billing };

setChannel(channel);
