# AGENTS.md —— 工作区规则（`modelmux`）

本文件是**仓库级**规则，与 `~/.zcode/AGENTS.md` 的个人偏好同时生效；项目约定以本文件为准。

**本文档的编写格式**：小节用 markdown 标题层级（`##`），正文用编号列表（`1.` `2.` `3.`）或短横线列表（`-`）。

## 这是什么

1. 一个本地 OpenAI 兼容网关 CLI（`modelmux`，bin `modelmux` / `mx`）+ 全部渠道。
2. 专注一件事：多个渠道汇成一个 OpenAI 兼容端点，对外暴露各渠道目录里的真实模型。
3. 每个渠道在下游是一个**池子**：模型池（`catalog` 全量暴露）+ 账号池（同渠道多账号）。
4. 对外模型是**动态模型池**（全池，不再限定 flash 家族）；请求落到哪家渠道由网关按各渠道**账单已用量**决定
   （`pool-targets.ts` / `pool-usage.ts`）。

## 仓库结构

```
packages/
├── cli/                      CLI 入口（bin `modelmux` / `mx`，注册全部渠道后交给共享 CLI；
│                             发布名 modelmux，单文件 bundle 自包含，npx/npm -g 直装）
├── ui/                       Web 管理看板（React 19 SPA，`mx web` 托管）
└── core/                     服务端运行时
    ├── gateway/              共享层（gateway / daemon / headless / paths / 渠道注册表；**不许出现渠道知识**）
    └── channels/<cid>/       一个渠道 = 一个池子（每个只实现 4 个渠道特有模块）
        └── docs/             该渠道自己的文档（说明 + 协议规格，随包走）
docs/                         契约与规范（唯一的仓库级文档层）
```

1. `packages/` 只允许 `cli` / `ui` / `core` 三个直接子目录；新增包必须归入其中之一。
2. `packages/core/gateway` 是共享层，**不许出现任何渠道知识**（厂商名、渠道特有字段、渠道模型名一律不得硬编码）。
3. `packages/core/channels/<cid>` 是渠道包，**只实现 4 个渠道特有模块**，其余一律复用共享层。

## 分支与重构

**强制**。

1. **大规模修改或重构必须先创建新分支**，禁止在 `main` 上直接动手。
2. 分支名使用明确的类型前缀：`refactor/<模块名>` / `feat/<模块名>` / `fix/<模块名>`。
3. 分支必须从**最新的 `main`** 创建，保持目标明确、改动可控。
4. 分支完成后必须走完整流程：推送 → 建 PR → 合并 → 删除分支。
5. 判定为「大规模修改」的情形（命中任一即必须开分支）：
   - 改动跨越 `packages/` 下两个及以上包；
   - 涉及目录结构、包边界、`workspaces`、`tsconfig` references 的调整；
   - 涉及契约变更（`docs/CONTRACT-TS.md`）、存储落点（`docs/STORAGE-CONVENTION.md`）、
     池架构（`docs/POOL-ARCHITECTURE.md`）的规则修改；
   - 对外 API 形态或模型 id 形态的变更；
   - 预计改动文件数超过 20 个。
6. 大规模修改**动手前**必须先产出方案：目标、影响范围、迁移路径、验证方式、回滚方式。
7. 重构以**可运行、可测试**为分界；大步骤拆小提交，每个提交保持可构建与逻辑一致。
8. 纯文档、单文件修复、注释订正等小改动可直接在 `main` 上提交。

## 文档规则

**强制**。

1. 契约与规范集中在 `docs/`；渠道文档跟着包走，放在 `packages/core/channels/<cid>/docs/`。
2. 各类文档的落点：

   | 类别 | 位置 | 内容 |
   | --- | --- | --- |
   | 契约与规范 | `docs/*.md` | 改代码前必读；索引见 `docs/README.md` |
   | 渠道说明 | `packages/core/channels/<cid>/docs/README.md` | 用法 / 存储 / 测试 |
   | 渠道协议规格 | `packages/core/channels/<cid>/docs/PROTOCOL.md` | 实测协议（实现的依据） |

3. `.md` **只允许**落在以下位置（`scripts/verify-docs.mjs` 在 `npm test` 里强制）：
   - `docs/` —— 契约与规范 + 文档总入口 `docs/README.md`
   - `README.md`（**仓库根**）—— 仓库门面，GitHub 只渲染根 README
   - `packages/core/channels/<cid>/docs/` —— 该渠道自己的文档（说明 + 协议规格 + 逆向结论层）
   - `packages/core/channels/<cid>/AGENTS.md` —— 目录级工具指令（工具从目录读，不能搬）
4. 新增或修改文档时：
   - 渠道协议 → `<cid>/docs/PROTOCOL.md`；渠道说明 → `<cid>/docs/README.md`；
     **渠道文档不要写进仓库级 `docs/`**（包要能单独打包发布）。
   - 同步更新 `docs/README.md`（文档总入口）。
   - markdown 链接用**相对路径**；源码注释里的引用用**仓库根相对路径**
     （如 `packages/core/channels/catpaw/docs/PROTOCOL.md`）。
   - 跑 `npm test`：`scripts/verify-docs.mjs` 拦住落错位置的 md，`scripts/verify-storage.mjs` 校验落点规范。
5. 完成后不再有用的过程记录（RUN-LOG、已结项计划、已删渠道存档）**随任务结束删除**，
   需要时从 git 历史取 —— 不设 `archive/` 目录，避免死文档堆积。
6. **第三方参考实现（`reference/`）约定**：
   - 逆向学习用的开源反代项目 clone 到 `packages/core/channels/<cid>/reference/<owner>_<repo>/`
     （`--depth 1`），由渠道级 `.gitignore` 的 `reference/` 条目忽略，**不入库**；
   - 从参考实现学到的**结论**写进该渠道自己的 `docs/PROTOCOL.md`（每条标注来源仓库与文件）；
   - 渠道 `docs/README.md` 必须维护「参考实现」一节，列出全部已 clone 仓库的 **GitHub 链接**
     与一句话用途 —— 克隆或删除参考仓库时同步更新本节。

## 代码约定

1. 渠道包 `src/` **只能有 7 个文件**（`channel` / `cli` / `index` + `cred` / `upstream` / `catalog` / `billing`）；
   多出来的共享模块副本一律删除。详见 `docs/CONTRACT-TS.md`。
2. 零第三方运行依赖：渠道包 `dependencies` 只允许 `@modelmux/gateway`；共享层 `dependencies` 必须为空。
3. **落点由共享层按 `cid` 推导**：渠道不许自己拼路径（见 `docs/STORAGE-CONVENTION.md`）。
4. 调用渠道模块前必须包 `runInChannel(cid, …)`（`AsyncLocalStorage` 上下文；
   否则渠道内部的 `paths.*` 在多渠道路由下不知道为谁解析）。
5. 对外模型 id 是**动态模型池**，形态为 `<cid>/<规范模型名>`（如 `loomy/kimi-k2.6`）：
   渠道由请求方通过前缀显式指定；模型段按各渠道 `catalog.exposedIds()` 归一化（恒小写），
   渠道内去重、**跨渠道不合并**（`catpaw/glm-5.3-flash` 与 `raccoon/glm-5.3-flash` 是两个 id）。
   裸模型名（无前缀）一律 400。模型收集与匹配见 `pool-targets.ts`，规则见 `docs/POOL-ARCHITECTURE.md`。
6. **共享层内部单向分层**（`scripts/verify-layering.mjs` 在 `npm test` 里强制）：
   `runtime(0) < pool(1) / auth(1) < http(2) < app(3)` —— **只能 import 层级 ≤ 自己的目录**，
   向上依赖一律失败。`index.ts` 是桶导出，不受限。
   - `runtime/` = 渠道 SDK（channel / paths / account-pool / secret-file / catalog-cache / cli-consts）
   - `pool/` = 模型池与账本；`auth/` = 登录链路
   - `http/` = 网关与转发；`app/` = 进程编排（cli / daemon / headless / supervisor…）
   - 需要跨层动作时**下沉或经回调注入**，不要直接向上 import。
   - 极少数必要例外列在脚本的 `ALLOWLIST`（必须写理由）；新增例外要慎重，
     且条目失效时（不再向上）脚本会报错要求删除。
7. **测试只做端到端真实测试**：跑真实网关、真实上游、真实登录链路，以「用户视角能跑通」为准；
   **不写单元测试、不写集成测试**，也不再要求测试「完全离线」。
8. **测试红线：禁止使用用户真实凭证**（违反 = 拿用户真实账号去撞上游风控，先警告后封号）：
   - 任何测试（`npm test`、渠道 selftest、仓库级测试）**不得读取或依赖** `~/.modelmux/` 下的
     真实数据（凭据、账号池、账本、目录缓存）：存储根一律用 `MODELMUX_HOME` 指向临时目录
     （`paths.ts` 对该变量惰性解析，测试进程永远打不开真实主目录）；
   - 测试代码与 fixture **禁止**对真实上游发任何请求（含对话、签到、账单、登录轮询），
     上游一律用本机假服务；真实上游验证只能走「真机手动验证」（见下文）；
   - 真实 uid / label / token 等身份信息**不得**出现在测试、fixture、示例或文档中，
     一律用明显虚构的占位值。

## 命令

```bash
npm install                       # 装工作区依赖（含软链）
npm run build                     # 全仓编译（tsc -b 增量 + cli 单文件 bundle）
npm test                          # build + 三个校验器 + 全部包的测试
npm run build --workspace=packages/core/channels/<cid>    # 只编一个渠道（也走引用链）
node packages/cli/dist/cli.js --help        # 仓库级 CLI：多渠道路由，唯一网关端口 4412（REPO_DEFAULT_ADDR）
node packages/cli/dist/cli.js model list    # 池视图：动态模型 → 候选渠道 + 账单用量 + 冷却
node packages/cli/dist/cli.js model usage   # 池账本；--refresh 立刻重查
node packages/cli/dist/cli.js login <cid>   # 对某个渠道操作：login / relogin / status / models / billing / accounts / paths / logs
node packages/core/channels/<cid>/dist/cli.js --help      # 单渠道 CLI（调试/回归用；只有它才用该渠道的 defaultAddr）
```

1. **命令形态（动词优先）**：`mx` 的**动词永远在第一个位置**，渠道 id 是**第二个位置的操作对象**：

   ```
   mx <动词> [<cid>] [参数...]     # 如 mx login traecn / mx status traecn / mx models traecn
   ```

2. 对齐 `git` / `docker` / `gh` / `kubectl` / `npm` 的心智（`<动词> [<对象>]`），也让 `mx login <TAB>`
   能直接补全渠道名 —— 补全器只需在位置 2 补「已注册渠道」这一个维度。
3. **命令组**（名词在位置 1、子命令在位置 2）同样遵循「动词在前」：`mx model list` / `mx model usage`。
4. **仓库级动词**（`start` / `stop` / `restart` / `status` / `logs`）**不接受**渠道 id；
   `mx status <cid>` 才是「某渠道的状态」。
5. **反面写法 `mx <cid> <动词>` 一律不采用**：渠道名与动词共享位置 1 的命名空间会让两者二义
   （一旦某个渠道叫 `models`，`mx models` 就无法区分），且与主流 CLI 心智相悖。
6. **单端口语义**：仓库级网关只监听**一个**端口（`REPO_DEFAULT_ADDR = 127.0.0.1:4412`），
   Web 控制台与网关**共用该端口**，挂在 `REPO_UI_PREFIX = /web` 下（控制台 API 位于 `/web/api/*`）。
   `ChannelConfig.defaultAddr` / `uiPort` 只在**单渠道独立运行**时生效。`--addr` 可覆盖。
   - 路由分工：`/` `/v1/*` `/health` 归网关；`/web` 与 `/web/*` 归控制台 handler
     （由 `createConsoleHandler(bridge, "/web")` 注入 `GatewayOptions.console`；不注入时网关是纯 API 服务）。
   - `mx web` = 「确保网关在跑 → 打开 `http://127.0.0.1:4412/web/`」，不再起独立进程。
7. **构建模型**：根 `tsconfig.json` 是 *solution* 文件（`files: []` + `references` 列出全部包），
   公共编译选项在根 `tsconfig.base.json`（各包 `extends` 它）；`tsc -b` 一次调度整个依赖图，
   产物落在各包 `dist/`，增量状态在 `dist/tsconfig.tsbuildinfo`。
8. `npm run build` 末尾追加 `packages/cli` 的 bundle 步骤（esbuild 内联成 `dist/cli.bundle.js`）。
   **这一步不能省**：全局 `mx` / `modelmux` 的 `bin` 指向该 bundle。
9. `npm run build` 末尾还要跑 `scripts/copy-ui.mjs`，把 UI 产物拷到**两个**落点
   （`packages/core/gateway/dist/ui` 与 `packages/cli/dist/ui`）—— 少拷一份，全局 `mx web` 就报「UI 未构建」。

## 提交前检查

**强制**。

1. `npm test` 全绿（自带 `build`，含 `verify:storage` / `verify:docs` / `verify:commits`）。
2. **测试链读的是各包 `dist/`（不是 `src/`）**，所以编译必须在链首：`npm test` 已内置 `npm run build`；
   单独跑 `npm run verify:storage` 或 `npm test --workspace=packages/core/channels/<cid>` 前必须**先** `npm run build`。
3. **CI 不通过禁止提交**：
   - 提交前必须先在本地 WSL 跑通与 CI 等价的命令（`npm test`），本地全绿才允许 `git commit` / `git push`。
   - 推送后必须确认 GitHub Actions 的 CI 为 `success`；**CI 红着时禁止继续提交新 commit**，
     必须先把红的那次修绿。
   - **禁止用 `--no-verify` 绕过** `.githooks/pre-push` 门禁；确需绕过必须先说明理由并获同意。
   - 禁止「先推再修」：不得以「后面会修」为由推送明知会红的提交。
4. 文档与代码**同一个 commit** 更新。
5. 不要提交运行时数据（`~/.modelmux/`、`dist/`、`node_modules/`）。
6. 核对口径：`gh run list --limit 5` 中本次推送对应的 run 必须是 `completed / success`。

## 改完代码的执行顺序

**强制**。

改动 `packages/core/**`、`packages/cli/**`、`packages/ui/**` 后，必须按顺序完成全部四步：

1. **构建**：`npm run build`
2. **重启**：`node packages/cli/dist/cli.js restart`
3. **确认无陈旧构建**：`node packages/cli/dist/cli.js status` —— 输出必须**不含** `网关在跑旧代码`。
4. **真机验证**：涉及 `login` / `cred` / `upstream` 的改动，必须走一遍
   `mx login <cid>` → `mx status <cid>` → 一次真实对话。

禁止事项：

- 禁止只 `build` 不 `restart`。
- 禁止以「改动很小」「只改了注释」为由跳过 `restart`。
- 禁止在 `status` 报陈旧构建时继续验证或宣称修复生效。
- 禁止修改 `packages/core/gateway/src/app/stale-build.ts` 的判据来让 `status` 不再报警。

判定口径：`status --json` 的 `stale_build` 必须为 `false`。
实现见 `packages/core/gateway/src/app/stale-build.ts`；事故记录见 `docs/CONTRACT-TS.md` 的「陈旧构建」一节。

## 开发规范

1. 换行一律 **LF**；根 `.gitattributes` 强制（`* text=auto eol=lf`），**禁止 CRLF 混入提交**。
2. 严禁提交 apikey / accesskey / secret / token / 密码 / 私钥 / 证书 / 含真实凭据的 `.env`。
   敏感内容进 `.gitignore`，改用环境变量；提交前自查 `git status` 与 `git diff`。
3. 注释一律**中文**、简洁、不复述代码；随代码同步更新，**禁止留过时或误导性注释**。
4. 运行时日志一律**英文**（避免 Git Bash / PowerShell 下的编码问题）；
   CLI 报表属**产品界面**，保持中文。
5. 文档全部**中文**、**不使用 emoji**；根 `README.md` 是仓库门面，必须全中文。
6. Python 一律走 `uv`（`uv add` / `uv run` / `uv sync` / `uv venv`）；
   命令行只用 PowerShell 7 与 Git Bash。
7. 开发前先检索现成方案（GitHub 优先），优先复用而非自建；借鉴重构前先检查许可证。
8. 临时文件一律写入项目根目录下的 `.tmp/`（必须已被 `.gitignore` 覆盖），任务结束前清理。

## 提交信息规范

格式 `type(scope): 中文描述`，即 Conventional Commits 的中文版（`scripts/verify-commits.mjs` 已接入 `npm test`）。

1. `type` 可取：`feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `chore`，以及专供合并提交的 `merge`。
   - 语义提示：`feat` 新功能、`fix` 缺陷修复、`docs` 文档、`style` 格式、`refactor` 重构、
     `perf` 性能、`test` 测试、`chore` 杂项、`merge` 合并其他分支。
   - 不确定时按「改动的主要意图」选，不要为凑 type 拆提交。
2. `scope` **必填**，填变更涉及的模块或对象名（如 `cli` / `gateway` / `repo`）。
3. 描述为简体中文，一句话说清改了什么，**结尾不加句号**。
4. 正文可选，与主题空一行；不要求解释「为什么」。
5. footer 可选；破坏性变更用 `!` 或 `BREAKING CHANGE: …` 标注（如 `refactor(repo)!:`）。
6. 一次逻辑变更只产生一个提交；能合并的改动不要拆成多个 commit。

**merge commit 同样适用**（校验器不过滤 merge）：

1. 本地合并写：`git merge --no-ff -m "merge(scope): 中文描述"`。
2. **禁止** `Merge pull request #N from …` 这类 GitHub 默认标题（无 type / scope / 中文）。
3. 仓库设置已固定为 `merge_commit_title=PR_TITLE`，故建 PR 时**PR 标题本身**必须是
   `type(scope): 中文描述` —— 它会被直接用作 merge commit 标题。
4. GitHub Actions 在 `pull_request` 事件里构造的临时合并提交（`Merge <sha> into <sha>`）
   不由人编写、也不可修改，校验器会**自动跳过**，无需处理。
