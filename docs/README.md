# 文档索引

工作区 `modelmux` 的**全部文档集中在本目录**，按用途分四类：

| 目录 | 放什么 |
| --- | --- |
| `docs/`（本层） | 规范与契约 —— 改代码前必读 |
| `docs/protocols/<cid>/` | 各渠道的**协议规格**（实现的依据，实测结论） |
| `docs/bridges/<cid>.md` | 各渠道包的**说明**（用法 / 存储 / 测试） |
| `docs/journals/<专题>/` | 仍有持续价值的**调研记录**（不参与构建） |

> 规则本身写在根 [`AGENTS.md`](../AGENTS.md) §2：**所有 `.md` 必须在 `docs/` 里**（只有包根指针 README、
> 目录级 AGENTS.md 两类例外）。由 `tools/verify-docs.mjs` 在 `npm test` 里强制检查。

> 各 `channels/<cid>/` 目录里只留一份**指针 README**（指向本目录），
> 免得同一份说明散在 10 个子文件夹里各改一遍。
> 唯一例外：`channels/catpaw/AGENTS.md`（那是给工具读的目录级指令，必须留在原处）。

> 已完成任务的过程记录（逐阶段 RUN-LOG、已结项的 task_plan/progress、已删除渠道的存档）
> 已清理，需要时从 git 历史取。保留标准：**对当前实现或维护仍有用**。

---

## 1. 规范与契约

| 文档 | 一句话 |
| --- | --- |
| [CONTRACT-TS.md](./CONTRACT-TS.md) | **工作区实现契约**：共享层 / 渠道层 7 文件 / 零运行依赖 / 发布构建 / 测试要求 / 交付清单 |
| [STORAGE-CONVENTION.md](./STORAGE-CONVENTION.md) | **存储落点与文件命名规范**：统一根 `~/.modelmux/` + 按 cid 分层、迁移规则 |
| [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) | **池化架构**：公共模型池（两个跨渠道模型 + 账单额度排序，§2）+ 账号池 |

## 2. 渠道协议规格 `docs/protocols/<cid>/PROTOCOL.md`

从上游客户端/实现里实测提取的协议规格。**改渠道实现前先看这里**，注释里写的
`见 docs/protocols/<cid>/PROTOCOL.md` 指的就是这些文件。

| cid | 产品 | 规格 |
| --- | --- | --- |
| `catpaw` | CatPaw（美团妙手） | [PROTOCOL.md](./protocols/catpaw/PROTOCOL.md) —— 结论速览 + 方法论（见下） |
| `codearts` | CodeArts（华为云） | [PROTOCOL.md](./protocols/codearts/PROTOCOL.md) |
| `lobsterai` | LobsterAI（有道） | [PROTOCOL.md](./protocols/lobsterai/PROTOCOL.md) |
| `loomy` | Loomy（讯飞） | [PROTOCOL.md](./protocols/loomy/PROTOCOL.md) |
| `qoder` | Qoder（国际版 `qoder.com`） | [PROTOCOL.md](./protocols/qoder/PROTOCOL.md) |
| `qodercn` | Qoder 国内版（`qoder.com.cn`） | 与 `qoder` **同一套协议**（仅域名/身份/模型目录不同），见 [PROTOCOL.md](./protocols/qoder/PROTOCOL.md) |
| `raccoon` | Raccoon（商汤） | [PROTOCOL.md](./protocols/raccoon/PROTOCOL.md) |
| `traecn` | TRAE（字节，中国版） | [PROTOCOL.md](./protocols/traecn/PROTOCOL.md) |
| `workbuddy` | WorkBuddy（国内版 CodeBuddy） | 与 `workbuddyai` **同一套插件端点协议**（无独立 PROTOCOL.md）；差异与用法见 [bridges/workbuddy.md](./bridges/workbuddy.md) |
| `workbuddyai` | WorkBuddyAI（国际版） | [findings.md](./journals/workbuddyai/findings.md) —— 该渠道的协议事实记在调研笔记里（无独立 PROTOCOL.md） |

`catpaw` 的规格不是单文件，而是一条完整的凭据逆向链路（`PROTOCOL.md` 是它的索引）：

- [PROTOCOL.md](./protocols/catpaw/PROTOCOL.md) —— 全部结论速览 + 方法论 + 证据等级约定
- [FINDINGS.md](./protocols/catpaw/FINDINGS.md) —— 结论汇总（逐条标注证据等级）
- [FLOW.md](./protocols/catpaw/FLOW.md) —— 端到端数据流：登录态怎么落盘、怎么加密、怎么被解出来

## 3. 渠道说明 `docs/bridges/<cid>.md`

各渠道包的使用说明（原 `channels/<cid>/README.md` 的内容）：特性、快速开始、存储与配置、
模型映射、测试、上游约束。

| 渠道 | 渠道 | 渠道 | 渠道 | 渠道 |
| --- | --- | --- | --- | --- |
| [catpaw](./bridges/catpaw.md) | [codearts](./bridges/codearts.md) | [lobsterai](./bridges/lobsterai.md) | [loomy](./bridges/loomy.md) | [qodercn](./bridges/qodercn.md) |
| [raccoon](./bridges/raccoon.md) | [traecn](./bridges/traecn.md) | [workbuddy](./bridges/workbuddy.md) | [workbuddyai](./bridges/workbuddyai.md) |

## 4. 调研记录 `docs/journals/<专题>/`

只保留**对新实现/维护仍有参考价值**的调研：

| 专题 | 文件 | 说明 |
| --- | --- | --- |
| `workbuddyai` | [findings](./journals/workbuddyai/findings.md) | 该渠道的协议事实（登录流程 / 端点 / 上游约束） |

## 5. 其它文档（不在本目录）

| 位置 | 是什么 |
| --- | --- |
| `channels/catpaw/AGENTS.md` | 该目录的 agent 级指令（工具从目录读取，不能搬） |
| `channels/<cid>/README.md` | 指针，指向本目录 |

## 6. 其它客户端怎么接（Hermes / 任意 OpenAI 客户端）

网关是一个**普通 HTTP 端点**，不依赖 ZCode：任何能配 OpenAI 兼容 base url 的客户端直接指向
`http://127.0.0.1:8787/v1` 就能用，模型 id 只有两个（`deepseek-v4.1-flash` /
`glm-5.3-flash`）—— 请求落到哪家渠道由网关按账单已用量自己决定，
客户端不关心、也不能指定（旧的 `<cid>/<模型>` 形态已移除，见
[POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §2）。

**不需要**为任何客户端做适配层：网关就是标准 OpenAI 兼容端点，任何客户端把 base url
指到 `http://127.0.0.1:8787/v1` 即可（凭据与账号池都由网关统一管理）。
历史上的插件形态（per-channel 插件 → 单 ZCode 插件 → Hermes 适配）已于 2026-10-13 全部移除。

## 7. 新增一个渠道要动哪些地方

1. 建 `channels/<cid>/`：7 个 `src/*.ts`（`channel`/`cli`/`index` + `cred`/`upstream`/`catalog`/`billing`）
   + `tests/selftest.test.ts` + `package.json` + `tsconfig.json` + 指针 `README.md`
2. `packages/cli/src/channels.ts` 加一行 `import "<cid>-bridge"`（**包名**仍为 `<cid>-bridge`；目录名与包名解耦，npm 不要求同名）
3. 工作区根 `package.json` 的 `workspaces`；`packages/cli/package.json` 的 `dependencies`
4. `docs/protocols/<cid>/PROTOCOL.md`、`docs/bridges/<cid>.md`
5. `npm install && npm run build && npm test`（`tools/verify-storage.mjs` 会校验落点规范）
