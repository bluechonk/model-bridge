/**
 * OrcaTerm（腾讯云 AI 运维终端）渠道装配：静态配置 + 四个渠道独有模块，注册进共享 gateway 层。
 *
 * 本文件是**共享层与渠道层的唯一边界**。
 */

import { setChannel, type ChannelConfig, type Channel } from "@modelmux/gateway";

import * as billing from "./billing.js";
import * as catalog from "./catalog.js";
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

export const config: ChannelConfig = {
  cid: "orcaterm",
  display: "OrcaTerm",
  version: "0.1.0",
  defaultAddr: "127.0.0.1:8819",
  uiPort: 8820,
  debugDumpEnv: "ORCATERM_DEBUG_DUMP",
};

export const channel: Channel = { config, cred, upstream, catalog, billing };

setChannel(channel);
