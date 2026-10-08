# AGENTS.md —— 工作区规则（`model-bridge`）

本文件是**仓库级**规则（与 `~/.zcode/AGENTS.md` 的个人偏好同时生效；项目约定以本文件为准）。

## 1. 这是什么

一个本地 OpenAI 兼容网关 + 11 个渠道，**仓库本身就是一个 ZCode 插件**。
每个渠道在下游是一个**池子**：模型池（`catalog` + flash 白名单）+ 账号池（同渠道多账号）。

```
packages/gateway/    共享层（gateway / daemon / headless / paths / 渠道注册表；**不许出现渠道知识**）
packages/cli/        仓库级入口（bin `model-bridge`，注册全部渠道后交给共享 CLI）
channels/<cid>/      一个渠道 = 一个池子（每个只实现 4 个渠道特有模块）
plugins/model-bridge/  唯一的 ZCode 插件（命令 / 技能 / hook）
docs/                全部文档
```

## 2. 文档规则（**强制**）

**所有 `.md` 文档统一放在 `docs/`，按类别分层。**子文件夹里不再散落内容型文档。

| 类别 | 位置 | 内容 |
| --- | --- | --- |
| 契约与规范 | `docs/*.md` | 改代码前必读；索引见 `docs/README.md` |
| 渠道协议规格 | `docs/protocols/<cid>/PROTOCOL.md` | 实测协议（实现的依据） |
| 渠道说明 | `docs/bridges/<cid>.md` | 用法 / 存储 / 测试 |
| 进度与调研 | `docs/journals/<cid>/` | `findings.md` / `progress.md` / `task_plan.md` |
| 归档 | `docs/archive/` | 已废弃产物 |

**唯一允许留在 `docs/` 之外的 `.md`**（工具或生态按固定路径加载，搬走即失效）：

1. `plugins/model-bridge/**` —— 插件命令 / 技能 / 说明，ZCode 与技能加载器按固定路径读
2. `channels/<cid>/README.md` —— **包根指针 README**：只许写指向 `docs/` 的链接，不写正文
3. `channels/<cid>/AGENTS.md` —— 目录级工具指令（工具从目录读，不能搬）

新增或修改文档时：

- 渠道协议 → `docs/protocols/<cid>/PROTOCOL.md`；渠道说明 → `docs/bridges/<cid>.md`（**不要在渠道包里写正文**）
- 同步更新 `docs/README.md`（它是文档总入口）
- 引用其他文档用**相对路径**，搬完文件要顺手检查链接
- 跑 `npm test`：`tools/verify-docs.mjs` 会拦住散落的 md，`tools/verify-storage.mjs` 会校验落点规范

## 3. 代码约定（摘要；详见 `docs/CONTRACT-TS.md`）

- 渠道包 `src/` **只能有 7 个文件**（`channel` / `cli` / `index` + `cred` / `upstream` / `catalog` / `billing`）；
  多出来的共享模块副本一律删除。
- 零第三方运行依赖：`dependencies` 只允许 `@model-bridge/gateway`。
- **落点由共享层按 `cid` 推导**：渠道不许自己拼路径（见 `docs/STORAGE-CONVENTION.md`）。
- 调用渠道模块前必须包 `runInChannel(cid, …)`（`AsyncLocalStorage` 上下文；否则渠道内部的
  `paths.*` 在多渠道路由下不知道为谁解析）。
- 对外模型 id **恒小写**：`<cid>/<模型>`（见 `docs/POOL-ARCHITECTURE.md` §2）。
- 每个改动都要有测试兜底；测试必须**完全离线**、不碰真实主目录（存储根指向 `mkdtemp`）。

## 4. 命令

```bash
npm install                       # 装工作区依赖（含软链）
npm run build                     # 全仓一次编译（tsc -b，按依赖图增量）
npm test                          # 两个校验器 + 全部包的测试
npm run test:all                  # build + test
npm run build --workspace=channels/<cid>    # 只编一个渠道（也走引用链）
node packages/cli/dist/cli.js --help        # 仓库级 CLI：多渠道路由，**唯一网关端口 8787**（REPO_DEFAULT_ADDR）
node channels/<cid>/dist/cli.js --help      # 单渠道 CLI（调试/回归用；只有它才用该渠道的 defaultAddr）
```

**端口语义**：仓库级网关只监听**一个**端口（`REPO_DEFAULT_ADDR = 127.0.0.1:8787`，
控制台 8788），11 个渠道按 `<cid>/<模型>` 从它路由；`BridgeConfig.defaultAddr`/`uiPort`
只在**单渠道独立运行**（`channels/<cid>/dist/cli.js start|serve`）时生效。`--addr` 可覆盖。

**构建模型**：根 `tsconfig.json` 是 *solution* 文件（`files: []` + `references` 列出 14 个包），
公共编译选项在根 `tsconfig.base.json` 里（各包 `extends` 它）；`tsc -b` 一次调度整个依赖图，
产物仍落在各包 `dist/`（包边界不破），增量状态在 `dist/tsconfig.tsbuildinfo`。
实测：冷编译 ~5s、无改动 ~1.2s、改一个渠道 ~1.3s、改共享层公开 API ~4s（连带重编依赖者）。

## 5. 提交前检查

- `npm test` 全绿（含 `verify:storage` / `verify:docs`）。
- 文档与代码**同一个 commit** 更新。
- 不要提交运行时数据（`~/.model-bridge/`、`dist/`、`node_modules/`）。
