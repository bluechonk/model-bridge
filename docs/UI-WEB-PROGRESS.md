# UI Web 进度

> `mx web` 的 React 管理看板实施进度。当前构建、静态托管、命令分发与 e2e 均已绿，剩余手验与契约文档由后续工作收尾。

## 已完成

- `packages/ui`：React 19 SPA 基础（4 路由：仪表盘 / 渠道 / 账号 / 登录），TanStack Query 拉取与轮询，Vite 8 构建。
- `packages/core/gateway`：`console.ts` 扩展静态托管 + `/api/commands` 分发；`web.ts`（命令入口）+ `web-command-handler.ts`（状态/模型/账单/账号池动作）；`/api/commands` 同源校验。
- CLI：`mx web` 已注册（`mx web --help` 可见），支持 `--host` / `--port` / `--open` / `--no-open`，默认不开浏览器。
- 构建：全仓 `npm run build` 已通过（tsconfig 引用修复 + `scripts/copy-ui.mjs` 拷贝静态页到 `packages/core/gateway/dist/ui`）。
- e2e 测试：`packages/ui/tests/web.test.ts` 覆盖首页 200、`/api/commands` 分发、跨源 403、路径穿越 403，当前 4/4 通过。完整 `npm test` 全绿。
- 文档：`docs/UI-WEB-PROGRESS.md`（本文件）+ `docs/README.md` 索引。

## 构建链路

`npm run build` 当前顺序：`tsc -b`（gateway/cli/channels/ui） → `vite build packages/ui` → `npm run build --workspace=packages/cli` → `scripts/copy-ui.mjs` 把 UI 产物拷到 `packages/core/gateway/dist/ui`。

## 当前问题

- 无阻塞性问题。静态托管根由 `dist/console.js` 平级的 `ui/` 推导，并已在服务端解码后再拒绝路径穿越。

## 下一步

1. 端到端手验 `mx web`（浏览器 + `/api/commands` 真渠道）。
2. 更新 `docs/CONTRACT-TS.md` 的 ui-web 契约。
