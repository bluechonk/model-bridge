/**
 * 仓库级 CLI 入口（bin 指向 dist/cli.js）。
 *
 * 只做两件事：注册**全部**渠道（`./channels.js` 的副作用）→ 交给共享 CLI。
 * 命令实现全在 `@model-bridge/gateway`。
 *
 * 与各 bridge 自己的 CLI 的区别：注册的渠道数 > 1 → 进入**多渠道路由**，
 * `/v1/models` 只暴露池内模型，请求由网关按账本选渠道；
 * 单渠道的 CLI 仍是裸短名（兼容既有客户端配置）。
 */

import "./channels.js"; // 副作用：注册全部渠道
import { main } from "@model-bridge/gateway";

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`[model-bridge] uncaught exception: ${String(err)}`);
    process.exitCode = 1;
  });
