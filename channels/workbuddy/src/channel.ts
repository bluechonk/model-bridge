/**
 * WorkBuddy 渠道装配（**国内版**：腾讯 CodeBuddy，`codebuddy.ai`）。
 *
 * 本文件是**共享层与渠道层的唯一边界**：`@modelmux/gateway` 里的
 * gateway / daemon / headless / auth-flow 都通过这里注册的 `Channel` 拿到
 * cred / upstream / catalog / billing。
 *
 * ⚠ 与国际版 `workbuddyai`（`workbuddy.ai`）是**两个独立渠道**：域是渠道身份的一部分，
 * 写死在配置里，账号在哪个域就用哪个渠道登录，登录链路与凭证落点不随 `--realm` 漂移。
 *
 * cred / upstream / catalog / billing 与国际版高度相似（重复代码）是有意的：两个产品的
 * 端点、模型目录、账单口径都可能各自演进，共享抽象会把「一个改了两边都变」变成默认行为。
 */

import { setChannel, type ChannelConfig, type Channel } from "@modelmux/gateway";

import * as billing from "./billing.js";
import * as catalog from "./catalog.js";
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

export const config: ChannelConfig = {
  cid: "workbuddy",
  display: "WorkBuddy（国内版）",
  version: "0.1.0",
  defaultAddr: "127.0.0.1:8803",
  uiPort: 8804,
  debugDumpEnv: "WORKBUDDY_DEBUG_DUMP",
};

export const channel: Channel = { config, cred, upstream, catalog, billing };

setChannel(channel);
