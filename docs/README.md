# 文档索引

工作区 `model-bridge` 的**全部文档集中在本目录**，按用途分四类：

| 目录 | 放什么 |
| --- | --- |
| `docs/`（本层） | 规范与契约 —— 改代码前必读 |
| `docs/protocols/<cid>/` | 各渠道的**协议规格**（实现的依据，实测结论） |
| `docs/bridges/<cid>.md` | 各渠道包的**说明**（用法 / 存储 / 测试） |
| `docs/journals/<cid>/` | 各渠道的**进度与调研**（寻宝记录，不参与构建） |
| `docs/archive/` | 已废弃的历史产物 |

> 各 `channels/<cid>/` 目录里只留一份**指针 README**（指向本目录），
> 免得同一份说明散在 12 个子文件夹里各改一遍。
> 唯一例外：`channels/catpaw/AGENTS.md`（那是给工具读的目录级指令，必须留在原处）。

---

## 1. 规范与契约

| 文档 | 一句话 |
| --- | --- |
| [CONTRACT-TS.md](./CONTRACT-TS.md) | **工作区实现契约**：共享层 / 渠道层 7 文件 / 零运行依赖 / 测试要求 / 交付清单 |
| [STORAGE-CONVENTION.md](./STORAGE-CONVENTION.md) | **存储落点与文件命名规范**：统一根 `~/.model-bridge/` + 按 cid 分层、迁移规则 |
| [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) | **池化架构**：模型池（已落地）+ 账号池（形状已定、待实现）；仓库即插件 |
| [CONTRACT.md](./CONTRACT.md) | 早期契约（历史存档，描述字符串替换时代的约定） |

## 2. 渠道协议规格 `docs/protocols/<cid>/PROTOCOL.md`

从上游客户端/实现里实测提取的协议规格。**改渠道实现前先看这里**，注释里写的
`见 docs/protocols/<cid>/PROTOCOL.md` 指的就是这些文件。

| cid | 产品 | 规格 |
| --- | --- | --- |
| `catpaw` | CatPaw（美团妙手） | [PROTOCOL.md](./protocols/catpaw/PROTOCOL.md) —— **一整套逆向记录**（见下） |
| `cline` | Cline | [PROTOCOL.md](./protocols/cline/PROTOCOL.md) |
| `codearts` | CodeArts（华为云） | [PROTOCOL.md](./protocols/codearts/PROTOCOL.md) |
| `gemini` | Gemini Code Assist | [PROTOCOL.md](./protocols/gemini/PROTOCOL.md) |
| `lobsterai` | LobsterAI（有道） | [PROTOCOL.md](./protocols/lobsterai/PROTOCOL.md) |
| `loomy` | Loomy（讯飞） | [PROTOCOL.md](./protocols/loomy/PROTOCOL.md) |
| `minimax` | MiniMax Code | [PROTOCOL.md](./protocols/minimax/PROTOCOL.md) |
| `qoder` | Qoder | [PROTOCOL.md](./protocols/qoder/PROTOCOL.md)（**桩**：模块尚未实现） |
| `raccoon` | Raccoon（商汤） | [PROTOCOL.md](./protocols/raccoon/PROTOCOL.md) |
| `trae` | TRAE（字节） | [PROTOCOL.md](./protocols/trae/PROTOCOL.md) |
| `workbuddy` | WorkBuddyAI | [findings.md](./journals/workbuddy/findings.md) —— 该渠道的协议事实记在调研笔记里（无独立 PROTOCOL.md） |
| `zcode` | ZCode（智谱） | [PROTOCOL.md](./protocols/zcode/PROTOCOL.md) |

`catpaw` 的规格不是单文件，而是一条完整的凭据逆向链路（`PROTOCOL.md` 是它的索引）：

- [PROTOCOL.md](./protocols/catpaw/PROTOCOL.md) —— 目录 + **全部结论速览** + 方法论 + 证据等级约定
- [FINDINGS.md](./protocols/catpaw/FINDINGS.md)、[FLOW.md](./protocols/catpaw/FLOW.md) —— 结论汇总 / 端到端数据流
- `phase1…phase7/RUN-LOG.md` —— 逐阶段的可复现记录（侦察 → 数据收集 → 格式 → 加密识别 → 密钥提取 → 解密 → 上游协议）
- [phase7/API-REFERENCE.md](./protocols/catpaw/phase7-upstream-protocol/API-REFERENCE.md) —— 上游接口速查
- [PYTHON-REWRITE-RECORD.md](./protocols/catpaw/PYTHON-REWRITE-RECORD.md)、[APPENDIX-legacy-lines.md](./protocols/catpaw/APPENDIX-legacy-lines.md) —— 历史重写记录 / 旧线路对照

## 3. 渠道说明 `docs/bridges/<cid>.md`

各渠道包的使用说明（原 `channels/<cid>/README.md` 的内容）：特性、快速开始、存储与配置、
模型映射、测试、上游约束。

| 渠道 | 渠道 | 渠道 | 渠道 |
| --- | --- | --- | --- |
| [catpaw](./bridges/catpaw.md) | [cline](./bridges/cline.md) | [codearts](./bridges/codearts.md) | [gemini](./bridges/gemini.md) |
| [lobsterai](./bridges/lobsterai.md) | [loomy](./bridges/loomy.md) | [minimax](./bridges/minimax.md) | [qoder](./bridges/qoder.md) |
| [raccoon](./bridges/raccoon.md) | [trae](./bridges/trae.md) | [workbuddy](./bridges/workbuddy.md) | [zcode](./bridges/zcode.md) |

## 4. 进度与调研 `docs/journals/<cid>/`

| 渠道 | 文件 | 说明 |
| --- | --- | --- |
| workbuddy | [findings](./journals/workbuddy/findings.md) · [progress](./journals/workbuddy/progress.md) · [task_plan](./journals/workbuddy/task_plan.md) | 调研结论 / 进度日志 / 任务计划 |
| catpaw | [findings](./journals/catpaw/findings.md) · [progress](./journals/catpaw/progress.md) · [task_plan](./journals/catpaw/task_plan.md) | 同上 |

`progress.md` 是**追加式日志**（按会话追加，不删旧条目）；`task_plan.md` 是阶段与勾选项；
`findings.md` 是上游事实（登录流程、端点、踩坑）—— 与 `docs/protocols/` 的区别是：
协议规格写「协议长什么样」，findings 写「我们怎么发现的、踩了什么坑」。

## 5. 归档 `docs/archive/`

- `legacy-scaffolders/` —— 字符串替换时代的脚手架（`scaffold.py` / `scaffold_ts.py` /
  `sync_gateway.py`）。共享层抽出来之后就废弃了，仅作历史参考。

## 6. 其它文档（不在本目录）

| 位置 | 是什么 |
| --- | --- |
| `plugins/model-bridge/` | ZCode 插件的命令/技能/hook（**必须**待在插件目录里，工具按固定路径加载） |
| `channels/catpaw/AGENTS.md` | 该目录的 agent 级指令（工具从目录读取，不能搬） |
| `packages/*/README.md`、`channels/<cid>/README.md` | 指针，指向本目录 |

## 7. 新增一个渠道要动哪些地方

1. 建 `channels/<cid>/`：7 个 `src/*.ts`（`channel`/`cli`/`index` + `cred`/`upstream`/`catalog`/`billing`）
   + `tests/selftest.test.ts` + `package.json` + `tsconfig.json` + 指针 `README.md`
2. `packages/cli/src/channels.ts` 加一行 `import "<cid>-bridge"`（**包名**仍为 `<cid>-bridge`；目录名与包名解耦，npm 不要求同名）
3. 工作区根 `package.json` 的 `workspaces`；`packages/cli/package.json` 的 `dependencies`
4. `docs/protocols/<cid>/PROTOCOL.md`、`docs/bridges/<cid>.md`
5. `npm install && npm run build && npm test`（`tools/verify-storage.mjs` 会校验落点规范）
