# 存储落点与文件命名规范（工作区 `modelmux`）

本文件只规定**放在哪里、叫什么名字**：存储根、cid 分层、覆盖用环境变量、目录内的文件命名、
历史名迁移。**凭证/配置的字段内容不在此列** —— 各 `channels/<cid>/` 自己决定
（见 `CONTRACT-TS.md` §5）。

适用范围：工作区内全部渠道包 + 共享包 `packages/gateway`（清单以 `mx model list` 为准）。

---

## 1. 目标布局（一句话）

**工作区只有一个存储根 `~/.modelmux/`，各渠道按 `cid` 分一层子目录。**

```
~/.modelmux/                 ← 唯一存储根（MODELMUX_HOME 可覆盖）
├── prefs.json                   ← （可选）跨渠道共享偏好
├── gateway.pid / gateway.log    ← 仓库级网关的 PID 与日志（不属于任何渠道）
├── pool-usage.json              ← 公共模型池的渠道账本（账单已用量 + 失败冷却）
├── workbuddyai/                 ← cid 层
│   ├── credentials.json
│   ├── upstream.json
│   ├── prefs.json
│   ├── gateway.pid
│   ├── gateway.log
│   ├── cache/                   ← 可安全删除（含 cache/models.json）
│   ├── state/                   ← 跨重启保持
│   └── debug/                   ← 抓包落盘（opt-in）
├── catpaw/
├── traecn/
├── codearts/
├── lobsterai/
├── loomy/
├── raccoon/
└── qoder/
```

分层名 = `cid`（全小写、仅 `[a-z0-9-]`），**不带点、不带 `-bridge` 后缀** —— 它已经是
收拢目录下的一层，冗余前缀与隐藏前缀都没有意义。

---

## 2. 渠道登记表

### 2.2 逐渠道登记表

| cid | 现存储目录（**迁移来源**） | 目标层 | 现覆盖变量 | 调试覆盖 | legacyDirs（新→旧） | legacyEnvVars |
|---|---|---|---|---|---|---|
| workbuddy | `.workbuddy-bridge` | `<root>/workbuddy` | `WORKBUDDY_HOME` | `WBAI_DEBUG_DUMP`  | `.zcode-workbuddy-bridge`, `.zcode-connect-workbuddyai`, `.workbuddyai2api`, `.workbuddyai-gateway` | `ZCB_HOME`, `WBAI2API_HOME` |
| catpaw | `.catpaw-bridge` | `<root>/catpaw` | `CATPAW_HOME` | `CATPAW_DEBUG_DUMP` | `.zcode-catpaw-bridge`, `.zcode-connect-catpaw` | `ZCC_HOME` |
| traecn | `.trae-bridge` | `<root>/traecn` | `TRAE_HOME` | `TRAECN_DEBUG_DUMP` | `.zcode-workbuddy-bridge` , `.zcode-connect-trae`, `.trae2api`, `.trae-gateway` | — |
| codearts | `.codearts-bridge` | `<root>/codearts` | `CODEARTS_HOME` | `CODEARTS_DEBUG_DUMP` | `.zcode-workbuddy-bridge` , `.zcode-connect-codearts`, `.codearts2api`, `.codearts-gateway` | — |
| lobsterai | `.lobsterai-bridge` | `<root>/lobsterai` | `LOBSTERAI_HOME` | `LOBSTERAI_DEBUG_DUMP` | `.zcode-workbuddy-bridge` , `.zcode-connect-lobsterai`, `.lobsterai2api`, `.lobsterai-gateway` | — |
| qoder | `.qoder-bridge` | `<root>/qoder` | `QODER_HOME` | `QODER_DEBUG_DUMP` | `.zcode-workbuddy-bridge` , `.zcode-connect-qoder`, `.qoder2api`, `.qoder-gateway` | — |
| loomy | `.loomy-bridge` | `<root>/loomy` | `LOOMY_HOME` | `LOOMY_DEBUG_DUMP` | `.zcode-workbuddy-bridge` , `.zcode-connect-loomy`, `.loomy2api`, `.loomy-gateway` | — |
| raccoon | `.raccoon-bridge` | `<root>/raccoon` | `RACCOON_HOME` | `RACCOON_DEBUG_DUMP` | `.zcode-workbuddy-bridge` , `.zcode-connect-raccoon`, `.raccoon2api`, `.raccoon-gateway` | — |
| gemini | `.gemini-bridge` | `<root>/gemini` | `GEMINI_HOME` | `GEMINI_DEBUG_DUMP` | `.zcode-workbuddy-bridge` , `.zcode-connect-gemini`, `.gemini2api`, `.gemini-gateway` | — |

= 违反规范，见 §3。（**均已修复**，§3 保留迁移前的盘点作为历史依据。）此后渠道有过增删：`zcode` 移除、`workbuddy` 拆成 `workbuddy` + `workbuddyai`、`gemini` / `minimax` 移除 —— 下表是**迁移当时**的快照，不代表当前渠道集合。`<root>` = `~/.modelmux`。

> 上表是**迁移前快照**，其中 `workbuddy` 一行指的是**当时**那个兼做国际/国内的渠道
> （后来改名为 `workbuddyai`）。该渠道现已**拆成两条**，见 §2.4。

### 2.3 目录外的落盘点（唯一一处）

codearts 的模型缓存主落点是 `<root>/codearts/cache/`；历史位置 `~/.cache/deveco/`
只作一次性兼容读，不再写入。

其余目录外文件都是**只读的包内资源**，不是用户存储，属正当例外：
各包根目录的 `models.json`（兜底模型表，随包分发）。

`*_DEBUG_DUMP` 是运行期由用户指定的抓包目录（opt-in），不构成固定落点，但命名见 §3.3。

### 2.4 拆分歧义名（`workbuddy` / `workbuddyai`）

`workbuddyai` 拆成**国际版** `workbuddyai`（workbuddy.ai）与**国内版** `workbuddy`
（codebuddy.ai）两条渠道后，出现一组**歧义历史名**：

| 历史名 | 历史归属 | 现归属 |
|---|---|---|
| `~/.workbuddy-bridge/` | 国际版旧凭证（实测 `domain=www.workbuddy.ai`） | **都不认领** |
| `WORKBUDDY_HOME` | 国际版的存储根覆盖变量 | **都不认领** |
| `WORKBUDDY_DEBUG_DUMP` | 国际版的抓包变量 | 归 `workbuddy`（= 它的 `<CID>_DEBUG_DUMP`，§3.3 强制） |

规则：**一个历史名只能属于一个渠道**（见本文件 §4 条文第 12 条）。这里故意让两条渠道都**不**认领
前两个名字 —— 因为认领它们就是把**国际版**数据迁进**国内版**渠道（跨产品串号），比"不迁移"更糟。
旧数据早已在改名时迁入 `<root>/workbuddyai/`，不迁也无损。

`workbuddy` 因此声明 `legacyDirs: []` / `legacyEnvVars: []`（它是新建渠道，本就没有历史）；
`workbuddyai` 的 `legacyDirs` / `legacyEnvVars` / `legacyDebugDumpEnv` 也相应移除了这三个裸
`workbuddy` 名字。校验器只在「双方同时声明」时报错，此处的空声明是**有意为之**，不是遗漏。

---

## 4. 目标规范（条文）

1. **单一存储根**：`~/.modelmux/`，由共享层唯一解析，渠道不得自行拼绝对路径。
2. **按 cid 分层**：`<root>/<cid>/`。`cid` 全小写、仅 `[a-z0-9-]`、等于 `BridgeConfig.cid`。
3. **根目录覆盖变量**：`MODELMUX_HOME`（唯一）。旧的 `<CID>_HOME` 降级为兼容别名：
  读到即视为覆盖根（并打一条 deprecation 日志）—— 现状脚本与测试不会断。
4. **目录内固定文件名**（唯一定义处：`packages/gateway/src/paths.ts`）：

  | 文件 | 用途 |
  |---|---|
  | `credentials.json` | 登录凭证 |
  | `upstream.json` | 上游端点与鉴权头名称 |
  | `prefs.json` | 渠道内偏好（`auto_start` 等） |
  | `gateway.pid` | 守护式网关 PID |
  | `gateway.log` | 守护进程 stdout/stderr |

5. **渠道特有文件必须落在自己的 cid 层内**：
  - `cache/` 可安全删除、可重建（缓存，丢了只是变慢/回落兜底表）
    - `cache/models.json` —— **远端模型目录缓存**：各渠道 `upstream.fetchModels()`
      拉到的真实目录，由共享层 `catalog-cache.ts` 原子写入（信封
      `{version, fetched_at, models}`，权限 `0600`）。
      - **谁写**：渠道的 `catalog.ts` 在成功拉到远端目录的那一刻写一次（每次成功拉取覆盖）。
      - **谁读**：同一渠道的 `catalog.ts` 在**首次被问**时读一次做种子 —— 于是
        `model list` 这类**新进程**能看到真实目录，而不是回落到随包发布的兜底快照。
      - **常态是读、不是写**：`model list` 命中缓存时**不打网络**；只有本地没有缓存
        （首次使用）才会拉一次并记录。要更新用 `<cid> models --refresh`。
      - **可安全删除**：删掉只影响下一个新进程的显示（回到兜底表），不影响登录态与额度。
      - 没有远端目录层的渠道不会产生这个文件（它只是「不存在」，不是错误）。
  - `state/` 跨重启保持的**状态**：目前唯一使用者是 `state/signin.json`（签到台账：
    `{version, timezone, last_claim, history}`，由共享层在**领取成功**或**上游回填**时写入）
  - `debug/` 抓包落盘默认位置（`<CID>_DEBUG_DUMP` 仅作覆盖，值须为绝对路径）
  - **禁止**写 `~/` 下任何其它目录（含 `~/.cache/`、`~/.config/`）
6. **权限**：根 `0700`，各 cid 层 `0700`，`credentials.json` 等含密文件 `0600`。
  渠道只能写自己的层。
7. **命名细则**：全小写；单词用 `-` 连接；扩展名固定 `.json` / `.log` / `.pid`；
  临时文件同目录加 `.tmp`；**不用**大写、下划线、渠道名前缀。
8. **迁移链**：`legacyDirs` / `legacyEnvVars` 只允许填**本渠道**的历史名，按「新→旧」排序。
9. **端口**：每渠道独占一组，登记在 `BridgeConfig.defaultAddr` / `uiPort`，不与他渠道重复。
10. **（可选）根级共享偏好**：`<root>/prefs.json` 放跨渠道设置；渠道内 `prefs.json` 只放
   本渠道设置。本期可不实现，但预留位置，避免以后又想加一层。
12. **一个历史名只能属于一个渠道**：`legacyDirs` / `legacyEnvVars` 不得包含**其它**渠道的
   cid 或历史目录名（防跨渠道数据劫持；`verify-storage.mjs` 强制校验）。两个渠道声明
   同一个历史名时直接报错。
13. **根级共享运行时文件**：属于「全部渠道」而不属于任一渠道的文件放根上 ——
   `gateway.pid` / `gateway.log`（仓库级网关）、`pool-usage.json`（公共模型池的渠道账本：
   账单已用量 + 失败冷却，见 `docs/POOL-ARCHITECTURE.md` §2.3）。走 `paths.rootFile()`，
   文件名同样受本节第 7 条的校验。

---
