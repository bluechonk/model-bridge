# AGENTS.md —— 工作区规则（`model-bridge`）

本文件是**仓库级**规则（与 `~/.zcode/AGENTS.md` 的个人偏好同时生效；项目约定以本文件为准）。

## 1. 这是什么

一个本地 OpenAI 兼容网关 + 11 个渠道，**仓库本身就是一个 ZCode 插件**。
每个渠道在下游是一个**池子**：模型池（`catalog` + `(deepseek|glm) × flash` 白名单）+ 账号池（同渠道多账号）。
**对外只有两个跨渠道模型**（`deepseek-v4.1-flash` / `glm-5.3-flash`），
请求落到哪家渠道由网关按各渠道**账单已用量**决定（`pool-targets.ts` / `pool-usage.ts`）。

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
- 对外模型 id **只有两个、恒小写、不带渠道前缀**：`deepseek-v4.1-flash` /
  `glm-5.3-flash`；客户端请求名不剥路径段（`<cid>/<模型>` 旧形态一律 400）。
  匹配与排序见 `docs/POOL-ARCHITECTURE.md` §2。
- 每个改动都要有测试兜底；测试必须**完全离线**、不碰真实主目录（存储根指向 `mkdtemp`）。

## 4. 命令

```bash
npm install                       # 装工作区依赖（含软链）
npm run build                     # 全仓一次编译（tsc -b，按依赖图增量）
npm test                          # 两个校验器 + 全部包的测试
npm run test:all                  # build + test
npm run build --workspace=channels/<cid>    # 只编一个渠道（也走引用链）
node packages/cli/dist/cli.js --help        # 仓库级 CLI：多渠道路由，**唯一网关端口 8787**（REPO_DEFAULT_ADDR）
node packages/cli/dist/cli.js model list    # 池视图：两个模型 → 候选渠道 + 账单用量 + 冷却
node packages/cli/dist/cli.js channels      # 渠道视角：每个渠道贡献了池内哪些模型
node packages/cli/dist/cli.js <cid> login   # 对某个渠道操作：login / status / models / billing / checkin / accounts / paths / logs
node channels/<cid>/dist/cli.js --help      # 单渠道 CLI（调试/回归用；只有它才用该渠道的 defaultAddr）
```

**端口语义**：仓库级网关只监听**一个**端口（`REPO_DEFAULT_ADDR = 127.0.0.1:8787`，
控制台 8788），11 个渠道从它后面供给那两个公共模型；`BridgeConfig.defaultAddr`/`uiPort`
只在**单渠道独立运行**（`channels/<cid>/dist/cli.js start|serve`）时生效。`--addr` 可覆盖。

**构建模型**：根 `tsconfig.json` 是 *solution* 文件（`files: []` + `references` 列出 13 个包），
公共编译选项在根 `tsconfig.base.json` 里（各包 `extends` 它）；`tsc -b` 一次调度整个依赖图，
产物仍落在各包 `dist/`（包边界不破），增量状态在 `dist/tsconfig.tsbuildinfo`。
实测：冷编译 ~5s、无改动 ~1.2s、改一个渠道 ~1.3s、改共享层公开 API ~4s（连带重编依赖者）。

## 5. 提交前检查

- `npm test` 全绿（含 `verify:storage` / `verify:docs`）。
- 文档与代码**同一个 commit** 更新。
- 不要提交运行时数据（`~/.model-bridge/`、`dist/`、`node_modules/`）。

## 6. 改完代码要重启网关（**别让用户测旧进程**）

`npm run build` 只更新 `dist/`，**不会**重启已在跑的守护进程。旧进程继续用内存里的
旧代码服务请求 —— 表现为「修复看起来没生效」：

- 用户以为登录/凭证坏了，实际是进程没重启；
- 日志里留着早已修掉的错误（如 `上游返回 HTTP 500`），把排查带偏；
- agent 以为改动无效，开始重复排查同一个 bug。

**曾发生过的真实事故**：网关启动于 21:29:59，修复 21:33 才编译完 —— 用户随后几次请求
全打在旧代码上，看到的是修之前的行为（详见 `docs/CONTRACT-TS.md` 的「陈旧构建」一节）。

规则：

1. 改完共享层或渠道代码并 `npm run build` 后，**主动 `restart`**，别只 build。
2. 涉及登录链路/上游协议的改动，必须走一次真机验证（`<cid> login` → `status` → 一次真实对话）。
3. 判断当前进程是不是旧代码：`node packages/cli/dist/cli.js status`
   —— 它会主动报 `⚠ 网关在跑旧代码：构建产物 … 比进程启动 … 新`；
   `status --json` 里是 `stale_build: true`。实现见 `packages/gateway/src/stale-build.ts`。
