# 文档索引

工作区 `modelmux` 的文档分两层：

| 层 | 位置 | 放什么 |
| --- | --- | --- |
| 契约与规范 | `docs/`（本目录） | 仓库级规则，改代码前必读 |
| 渠道文档 | `packages/channels/<cid>/docs/` | 每个渠道自己的说明与协议规格（**随包走**） |

> 规则本身写在根 [`AGENTS.md`](../AGENTS.md) §2：契约留在 `docs/`，渠道文档跟包走，
> 每个渠道包都必须带 `docs/README.md`。由 `tools/verify-docs.mjs` 在 `npm test` 里强制检查。

> 各 `packages/channels/<cid>/` 目录里只有 `src/`（实现）与 `docs/`（文档）；
> 唯一例外 `packages/channels/catpaw/AGENTS.md`（给工具读的目录级指令，必须留在原处）。

> 已完成任务的过程记录（逐阶段 RUN-LOG、已结项的 task_plan/progress、已删除渠道的存档）
> 已清理，需要时从 git 历史取。保留标准：**对当前实现或维护仍有用**。

---

## 1. 规范与契约

| 文档 | 一句话 |
| --- | --- |
| [CONTRACT-TS.md](./CONTRACT-TS.md) | **工作区实现契约**：共享层 / 渠道层 7 文件 / 零运行依赖 / 发布构建 / 测试要求 / **CLI 命令形态（§9 动词优先）** / 交付清单 |
| [STORAGE-CONVENTION.md](./STORAGE-CONVENTION.md) | **存储落点与文件命名规范**：统一根 `~/.modelmux/` + 按 cid 分层、命名与权限条文 |
| [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) | **池化架构**：公共模型池（两个跨渠道模型 + 账单额度排序，§2）+ 账号池 |
| [DAEMON-SUPERVISOR.md](./DAEMON-SUPERVISOR.md) | **网关进程生命周期**：监督者 + worker 自动重生（指数退避/代次作废/父死自退，学 CCR 骨架） |
| [UI-WEB-PROGRESS.md](./UI-WEB-PROGRESS.md) | **UI Web 进度**：mx web React 管理看板当前实施与遗留问题 |

## 2. 渠道文档 `packages/channels/<cid>/docs/`

每个渠道的说明与协议规格都在自己的包里。协议规格是从上游客户端/实现里实测提取的，
**改渠道实现前先看这里**；源码注释里写的 `见 packages/channels/<cid>/docs/PROTOCOL.md` 指的就是这些文件。

| cid | 产品 | 文档 |
| --- | --- | --- |
| `catpaw` | CatPaw（美团妙手） | [说明](../packages/channels/catpaw/docs/README.md) · [PROTOCOL](../packages/channels/catpaw/docs/PROTOCOL.md) + [FINDINGS](../packages/channels/catpaw/docs/FINDINGS.md) / [FLOW](../packages/channels/catpaw/docs/FLOW.md) |
| `codearts` | CodeArts（华为云） | [说明](../packages/channels/codearts/docs/README.md) · [PROTOCOL](../packages/channels/codearts/docs/PROTOCOL.md) |
| `lobsterai` | LobsterAI（有道） | [说明](../packages/channels/lobsterai/docs/README.md) · [PROTOCOL](../packages/channels/lobsterai/docs/PROTOCOL.md) |
| `loomy` | Loomy（讯飞） | [说明](../packages/channels/loomy/docs/README.md) · [PROTOCOL](../packages/channels/loomy/docs/PROTOCOL.md) |
| `qoder` | Qoder（国际版 `qoder.com`） | [说明](../packages/channels/qoder/docs/README.md) · [PROTOCOL](../packages/channels/qoder/docs/PROTOCOL.md) |
| `qodercn` | Qoder 国内版（`qoder.com.cn`） | [说明](../packages/channels/qodercn/docs/README.md)；与 `qoder` **同一套协议**（仅域名/身份/模型目录不同），规格见 [qoder PROTOCOL](../packages/channels/qoder/docs/PROTOCOL.md) |
| `raccoon` | Raccoon（商汤） | [说明](../packages/channels/raccoon/docs/README.md) · [PROTOCOL](../packages/channels/raccoon/docs/PROTOCOL.md) |
| `traecn` | TRAE（字节，中国版） | [说明](../packages/channels/traecn/docs/README.md) · [PROTOCOL](../packages/channels/traecn/docs/PROTOCOL.md) |
| `workbuddy` | WorkBuddy（国内版 CodeBuddy） | [说明](../packages/channels/workbuddy/docs/README.md) —— 与 `workbuddyai` **同一套端点协议**，无独立 PROTOCOL.md |
| `workbuddyai` | WorkBuddyAI（国际版） | [说明](../packages/channels/workbuddyai/docs/README.md) —— 协议事实记在说明里，无独立 PROTOCOL.md |
| `orcaterm` | OrcaTerm（腾讯云，登录已实现 / 上游待实现） | [说明](../packages/channels/orcaterm/docs/README.md) · [PROTOCOL](../packages/channels/orcaterm/docs/PROTOCOL.md) + [FINDINGS](../packages/channels/orcaterm/docs/FINDINGS.md) |

> `orcaterm` 是**渠道包**（7 文件齐备并已注册），但只有**登录已实现**：
> `upstream` / `catalog` / `billing` 按契约做成「尚未实现」桩 —— 上游对话协议
> （`/messages*` 请求体与鉴权）尚未抓到，见其 FINDINGS。
> 登录支持两路：腾讯云 / 微信（`mx login orcaterm` 弹菜单）；GitHub 仅协议事实，未实现。

`catpaw` 的规格不是单文件，而是一条完整的凭据逆向链路（`PROTOCOL.md` 是它的索引）：

- [PROTOCOL.md](../packages/channels/catpaw/docs/PROTOCOL.md) —— 全部结论速览 + 方法论 + 证据等级约定
- [FINDINGS.md](../packages/channels/catpaw/docs/FINDINGS.md) —— 结论汇总（逐条标注证据等级）
- [FLOW.md](../packages/channels/catpaw/docs/FLOW.md) —— 端到端数据流：登录态怎么落盘、怎么加密、怎么被解出来

## 3. 其它位置的文档

| 位置 | 是什么 |
| --- | --- |
| `README.md`（**仓库根**） | 仓库门面（GitHub 只渲染根 README），全中文 |
| `packages/channels/<cid>/docs/README.md` | 该渠道的说明（用法 / 存储 / 测试） |
| `packages/channels/catpaw/AGENTS.md` | 该目录的 agent 级指令（工具从目录读取，不能搬） |

## 4. 其它客户端怎么接（Hermes / 任意 OpenAI 客户端）

网关是一个**普通 HTTP 端点**，不依赖 ZCode：任何能配 OpenAI 兼容 base url 的客户端直接指向
`http://127.0.0.1:8787/v1` 就能用，模型 id 只有两个（`deepseek-v4.1-flash` /
`glm-5.3-flash`）—— 请求落到哪家渠道由网关按账单已用量自己决定，
客户端不关心、也不能指定（旧的 `<cid>/<模型>` 形态已移除，见
[POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §2）。

**不需要**为任何客户端做适配层：网关就是标准 OpenAI 兼容端点，任何客户端把 base url
指到 `http://127.0.0.1:8787/v1` 即可（凭据与账号池都由网关统一管理）。
历史上的插件形态（per-channel 插件 → 单 ZCode 插件 → Hermes 适配）已于 2026-10-13 全部移除。

## 5. 新增一个渠道要动哪些地方

1. 建 `packages/channels/<cid>/`：7 个 `src/*.ts`（`channel`/`cli`/`index` + `cred`/`upstream`/`catalog`/`billing`）
   + `tests/selftest.test.ts` + `package.json` + `tsconfig.json`
2. `packages/channels/<cid>/docs/`：`README.md`（渠道说明）+ `PROTOCOL.md`（协议规格，实测结论）
3. `packages/cli/src/channels.ts` 加一行 `import "@modelmux/<cid>"`（包名 = `@modelmux/` + 目录名，装好后由工作区软链解析）
4. 工作区根 `package.json` 的 `workspaces`（`packages/cli` 不必声明依赖：发布 bundle 自包含）
5. `npm install && npm test`（自带 `build`；`verify-storage` 校验落点规范、`verify-docs` 校验文档归属）
