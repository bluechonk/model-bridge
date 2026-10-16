# AGENTS.md —— 工作区规则（`modelmux`）

本文件是**仓库级**规则（与 `~/.zcode/AGENTS.md` 的个人偏好同时生效；项目约定以本文件为准）。

## 1. 这是什么

一个本地 OpenAI 兼容网关 CLI（`modelmux`，bin `modelmux` / `mx`）+ 全部渠道：
专注一件事——多个渠道汇成一个 OpenAI 兼容端点，对外丢出两个池内模型。
每个渠道在下游是一个**池子**：模型池（`catalog` + `(deepseek|glm) × flash` 白名单）+ 账号池（同渠道多账号）。
**对外只有两个跨渠道模型**（`deepseek-v4.1-flash` / `glm-5.3-flash`），
请求落到哪家渠道由网关按各渠道**账单已用量**决定（`pool-targets.ts` / `pool-usage.ts`）。

```
packages/gateway/    共享层（gateway / daemon / headless / paths / 渠道注册表；**不许出现渠道知识**）
packages/cli/        CLI 入口（bin `modelmux` / `mx`，注册全部渠道后交给共享 CLI；
                     发布名 modelmux，单文件 bundle 自包含，npx/npm -g 直装）
channels/<cid>/      一个渠道 = 一个池子（每个只实现 4 个渠道特有模块）
  docs/              该渠道自己的文档（说明 + 协议规格，随包走）
docs/                契约与规范（唯一的仓库级文档层）
```

## 2. 文档规则（**强制**）

**契约与规范集中在 `docs/`；渠道文档跟着包走，放在 `channels/<cid>/docs/`。**

| 类别 | 位置 | 内容 |
| --- | --- | --- |
| 契约与规范 | `docs/*.md` | 改代码前必读；索引见 `docs/README.md` |
| 渠道说明 | `channels/<cid>/docs/README.md` | 用法 / 存储 / 测试 |
| 渠道协议规格 | `channels/<cid>/docs/PROTOCOL.md` | 实测协议（实现的依据） |

完成后不再有用的过程记录（RUN-LOG、已结项计划、已删渠道存档）**随任务结束删除**，
需要时从 git 历史取 —— 不设 `archive/` 目录，避免死文档堆积。

**`.md` 只允许落在以下位置**（`tools/verify-docs.mjs` 在 `npm test` 里强制）：

0. `docs/` —— 契约与规范 + 文档总入口 `docs/README.md`
1. `README.md`（**仓库根**）—— 仓库门面，GitHub 只渲染根 README
2. `channels/<cid>/docs/` —— 该渠道自己的文档（说明 + 协议规格 + 逆向结论层）
3. `channels/<cid>/AGENTS.md` —— 目录级工具指令（工具从目录读，不能搬）

新增或修改文档时：

- 渠道协议 → `channels/<cid>/docs/PROTOCOL.md`；渠道说明 → `channels/<cid>/docs/README.md`
   （**渠道文档不要写进仓库级 `docs/`**，包要能单独打包发布）
- 同步更新 `docs/README.md`（它是文档总入口）
- markdown 链接用**相对路径**；源码注释里的引用用**仓库根相对路径**
  （如 `channels/catpaw/docs/PROTOCOL.md`）—— 搬完文件要顺手检查链接
- 跑 `npm test`：`tools/verify-docs.mjs` 会拦住落错位置的 md，`tools/verify-storage.mjs` 会校验落点规范

## 3. 代码约定（摘要；详见 `docs/CONTRACT-TS.md`）

- 渠道包 `src/` **只能有 7 个文件**（`channel` / `cli` / `index` + `cred` / `upstream` / `catalog` / `billing`）；
 多出来的共享模块副本一律删除。
- 零第三方运行依赖：`dependencies` 只允许 `@modelmux/gateway`。
- **落点由共享层按 `cid` 推导**：渠道不许自己拼路径（见 `docs/STORAGE-CONVENTION.md`）。
- 调用渠道模块前必须包 `runInChannel(cid, …)`（`AsyncLocalStorage` 上下文；否则渠道内部的
 `paths.*` 在多渠道路由下不知道为谁解析）。
- 对外模型 id **只有两个、恒小写、不带渠道前缀**：`deepseek-v4.1-flash` /
 `glm-5.3-flash`；客户端请求名不剥路径段（`<cid>/<模型>` 旧形态一律 400）。
 匹配与排序见 `docs/POOL-ARCHITECTURE.md` §2。
- **测试只做端到端真实测试**：跑真实网关、真实上游、真实登录链路，以「用户视角能跑通」为准；
  **不写单元测试、不写集成测试**，也不再要求测试「完全离线」。

## 4. 命令

```bash
npm install                       # 装工作区依赖（含软链）
npm run build                     # 全仓编译（tsc -b 增量 + cli 单文件 bundle）
npm test                          # build + 三个校验器 + 全部包的测试（链首编译，见 §5）
npm run build --workspace=channels/<cid>    # 只编一个渠道（也走引用链）
node packages/cli/dist/cli.js --help        # 仓库级 CLI：多渠道路由，**唯一网关端口 8787**（REPO_DEFAULT_ADDR）
node packages/cli/dist/cli.js model list    # 池视图：两个模型 → 候选渠道 + 账单用量 + 冷却
node packages/cli/dist/cli.js model usage   # 池账本；--refresh 立刻重查
node packages/cli/dist/cli.js login <cid>   # 对某个渠道操作：login / relogin / status / models / billing / accounts / paths / logs
node channels/<cid>/dist/cli.js --help      # 单渠道 CLI（调试/回归用；只有它才用该渠道的 defaultAddr）
```

**命令形态（动词优先）**：`mx` 的**动词永远在第一个位置**，渠道 id 是**第二个位置的操作对象**：

```
mx <动词> [<cid>] [参数...]        # 如 mx login traecn / mx status traecn / mx models traecn / mx billing traecn
```

- 对齐 `git` / `docker` / `gh` / `kubectl` / `npm` 的心智（`<动词> [<对象>]`），也让 `mx login <TAB>`
 能直接补全渠道名 —— 补全器只需在位置 2 补「已注册渠道」这一个维度。
- **命令组**（名词在位置 1、子命令在位置 2）同样遵循「动词在前」：`mx model list` / `mx model usage`。
- **仓库级动词**（`start` / `stop` / `restart` / `status` / `logs`）**不接受**渠道 id ——
 它们操作的网关是仓库级的（见「端口语义」）；`mx status <cid>` 才是「某渠道的状态」。
- **反面写法 `mx <cid> <动词>` 一律不采用**：渠道名与动词共享位置 1 的命名空间会让两者二义
 （一旦某个渠道叫 `models`，`mx models` 就无法区分），且与主流 CLI 心智相悖。

**端口语义**：仓库级网关只监听**一个**端口（`REPO_DEFAULT_ADDR = 127.0.0.1:8787`，
控制台 8788），10 个渠道从它后面供给那两个公共模型；`ChannelConfig.defaultAddr`/`uiPort`
只在**单渠道独立运行**（`channels/<cid>/dist/cli.js start|serve`）时生效。`--addr` 可覆盖。

**构建模型**：根 `tsconfig.json` 是 *solution* 文件（`files: []` + `references` 列出全部包），
公共编译选项在根 `tsconfig.base.json` 里（各包 `extends` 它）；`tsc -b` 一次调度整个依赖图，
产物仍落在各包 `dist/`（包边界不破），增量状态在 `dist/tsconfig.tsbuildinfo`。
实测：冷编译 ~5s、无改动 ~1.2s、改一个渠道 ~1.3s、改共享层公开 API ~4s（连带重编依赖者）。

`npm run build` 末尾追加 `packages/cli` 的 bundle 步骤（esbuild 内联成 `dist/cli.bundle.js`，
见 `docs/CONTRACT-TS.md` §2.1）。**这一步不能省**：全局 `mx` / `modelmux` 的 `bin` 指向该 bundle，
只跑 `tsc -b` 会让它在下次调用时报 `Cannot find module … dist/cli.bundle.js`。

`verify:contract` 兜底 `references` 形状：根 solution 文件的引用必须与 `channels/*` + `packages/*`
逐一对应，且每个条目恰含一个 `path`。空条目与合并条目（一条目两个 `path`）都是脚本化增删渠道的
残留 —— TS 自己的解析器会保留重复键，编译照过，只有该渠道的 `dist/` 悄悄缺席。

## 5. 提交前检查

- `npm test` 全绿（自带 `build`，含 `verify:storage` / `verify:docs`）。
  **测试链读的是各包 `dist/`（不是 `src/`）**，所以编译必须在链首：`npm test` 已内置
  `npm run build`；单独跑 `npm run verify:storage` 或 `npm test --workspace=channels/<cid>`
  前要先 `npm run build`，否则校验的是旧产物。
- 文档与代码**同一个 commit** 更新。
- 不要提交运行时数据（`~/.modelmux/`、`dist/`、`node_modules/`）。

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
2. 涉及登录链路/上游协议的改动，必须走一次真机验证（`login <cid>` → `status` → 一次真实对话）。
3. 判断当前进程是不是旧代码：`node packages/cli/dist/cli.js status`
  —— 它会主动报 ` 网关在跑旧代码：构建产物 … 比进程启动 … 新`；
  `status --json` 里是 `stale_build: true`。实现见 `packages/gateway/src/stale-build.ts`。

## 7. 开发规范（与全局 `~/.zcode/AGENTS.md` 一致，落到本仓库）

| 项 | 要求 |
| --- | --- |
| 换行 | 一律 **LF**；根 `.gitattributes` 强制（`* text=auto eol=lf`），**禁止 CRLF 混入提交** |
| 敏感信息 | 严禁提交 apikey / accesskey / secret / token / 密码 / 私钥 / 证书 / 含真实凭据的 `.env`。敏感内容进 `.gitignore`，改用环境变量；提交前自查 `git status` 与 `git diff` |
| 注释 | **中文**、简洁、不复述代码；随代码同步更新，**禁止留过时或误导性注释** |
| 日志 | 运行时日志一律**英文**（避免 Git Bash / PowerShell 下的编码问题）；CLI 报表属**产品界面**，保持中文 |
| 文档 | 全部**中文**、**不使用 emoji**；根 `README.md` 是仓库门面，必须全中文 |
| 提交信息 | 遵循 Conventional Commits 并改中文：格式 `type(scope): 中文描述`（`type` ∈ feat / fix / docs / style / refactor / perf / test / chore）；**scope 必填**（模块或对象名）；描述简体中文、**结尾不加句号**；破坏性变更可加 `!`（如 `refactor(repo)!:`）。校验器 `tools/verify-commits.mjs`（已接入 `npm test`） |
| 依赖与环境 | Python 一律走 `uv`（`uv add` / `uv run` / `uv sync` / `uv venv`）；命令行只用 PowerShell 7 与 Git Bash |
| 复用优先 | 开发前先检索现成方案（GitHub 优先），优先复用而非自建；借鉴重构前先检查许可证 |

> 这一节是全局偏好的**项目内落点**：全局规则在 `~/.zcode/AGENTS.md`，本仓库要遵守的具体形态写在这里
> （例如"日志英文"在本项目的边界是——运行时日志英文、CLI 报表中文）。

### 提交信息规范

格式 `type(scope): 中文描述`，即 Conventional Commits 的中文版（`tools/verify-commits.mjs` 已接入 `npm test`）：

| 部分 | 要求 |
| --- | --- |
| type | feat / fix / docs / style / refactor / perf / test / chore |
| scope | 必填，变更涉及的模块或对象名（如 `cli` / `gateway` / `repo`） |
| 描述 | 简体中文，一句话说清改了什么，结尾不加句号 |
| 正文 | 可选；与主题空一行；不要求解释「为什么」 |
| footer | 可选；破坏性变更用 `!` 或 `BREAKING CHANGE: …` 标注 |
