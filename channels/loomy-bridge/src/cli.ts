/**
 * Loomy 渠道 CLI 入口（bin 指向 dist/cli.js）。
 *
 * 只做两件事：注册本渠道（`./channel.js` 的副作用）→ 交给共享 CLI。
 * 命令实现全在 `@model-bridge/gateway`。
 */

import "./channel.js"; // 副作用：setChannel(本渠道)
import { main } from "@model-bridge/gateway";

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`[loomy] 未捕获异常: ${String(err)}`);
    process.exitCode = 1;
  });
