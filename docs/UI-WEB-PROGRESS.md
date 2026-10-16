# UI Web 进度

> `mx web` 的 React 管理看板实施进度。注意：本分支开发尚未结项，构建已全通，静态静态托管链路仍有一个待复现的 404。

## 已完成

- `packages/ui`：React 19 SPA 基础（4 路由：仪表盘 / 渠道 / 账号 / 登录），TanStack Query 拉取与轮询，Vite 8 构建。
- `packages/gateway`：`console.ts` 扩展静态托管 + `/api/commands` 分发；`web.ts`（命令入口）+ `web-command-handler.ts`（状态/模型/账单/账号池动作）；`/api/commands` 同源校验。
- CLI：`mx web` 已注册（`mx web --help` 可见），支持 `--host` / `--port` / `--open` / `--no-open`，默认不开浏览器。
- 构建：全仓 `npm run build` 已通过（tsconfig 引用修复 + `tools/copy-ui.mjs` 拷贝静态页到 `packages/gateway/dist/ui`）。
- e2e 测试：`packages/ui/tests/web.test.ts` 已覆盖首页 200、`/api/commands` 分发、跨源 403、路径穿越 403 断言（当前挂 2 个：部署根解析待复现）。
- 文档：`docs/UI-WEB-PROGRESS.md`（本文件）+ `docs/README.md` 索引。

## 构建链路

`npm run build` 当前顺序：`tsc -b`（gateway/cli/channels/ui） → `vite build packages/ui` → `npm run build --workspace=packages/cli` → `tools/copy-ui.mjs` 把 UI 产物拷到 `packages/gateway/dist/ui`。

## 当前问题

- 静态页 404：`index.html` 能返回 200，`/assets/index-*.js` 在 404。已确认：
  - 产物确实在 `packages/gateway/dist/ui/assets/`；
  - `serveStatic` 用 `isAbsolute(relPath)` 分流（Windows 下 `C:/.../dist/ui` → `.../dist/ui/assets/*.js` 的 `file.startsWith(WEB_UI_ROOT + sep)` 为 `true`）；
  - 在 `/` 上 SPA 回退先于 `/assets/` 分支命中，Escape 顺序待确认。
  - 观感是 `fetch('/assets/index-*.js')` 拿到 "Not found" 10 字节文本（静态 404 分支），具体是哪一个分支待查。
- 当前怀疑点：`serveStatic` 误接了 SPA 回退（`serveStatic(res, WEB_UI_INDEX)`），导致 `/assets/*` 没有走到资产分支就被回退盖掉；或者静态判定顺序问题。
- 复现方式：`npm run build && node --input-type=module -e "const {start}=await import('./packages/gateway/dist/console.js'); const s=await start(0,{provider:()=>({})},'127.0.0.1'); console.log((await fetch(s.url+'assets/index-3IkEjiVv.js')).status); await s.close();"`

## 下一步

1. 复现并修静态资产 404（预计是 `/assets/*` 分支与 SPA 回退的先后问题）。
2. `packages/ui/tests/web.test.ts` 的 2 个挂点修绿。
3. 验证 `mx web` 端到端（真实浏览器 + `/api/commands` 真渠道）。
4. 更新 `docs/CONTRACT-TS.md` §ui-web 契约。

