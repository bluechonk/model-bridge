/**
 * catpaw-bridge 对外入口：重导出共享层与渠道模块。
 *
 * 供测试与外部程序按需引用；渠道差异通过 `./channel.ts` 的注册生效。
 */

export * as gateway from "@model-bridge/gateway";

export * as cred from "./cred.js";
export * as upstream from "./upstream.js";
export * as catalog from "./catalog.js";
export * as billing from "./billing.js";
export { config, channel } from "./channel.js";