# 存储落点与文件命名规范（工作区 `modelmux`）

本文件只规定**放在哪里、叫什么名字**：存储根、cid 分层、覆盖用环境变量、目录内的文件命名。
**凭证/配置的字段内容不在此列** —— 各 `channels/<cid>/` 自己决定（见 `CONTRACT-TS.md` §5）。

适用范围：工作区内全部渠道包 + 共享包 `packages/gateway`（清单以 `mx model list` 为准）。
历史布局兼容（`legacyDirs` / `fileMigrations` / 旧环境变量）已随 modelmux 更名整体移除：
**只认下面这一种布局**，不做任何旧目录/旧名字迁移。

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
└── …（其余渠道同构）
```

分层名 = `cid`（全小写、仅 `[a-z0-9-]`），**不带点、不带任何前缀后缀** —— 它已经是
存储根下的一层，冗余前缀与隐藏前缀都没有意义。

## 2. 渠道约定

- 渠道清单以 `mx model list` 为准（本文件不维护逐渠道表，避免两处漂移）。
- **调试变量命名**：每渠道为 `<CID 大写、- 换 _>_DEBUG_DUMP`（如 `TRAECN_DEBUG_DUMP`），
  由 `tools/verify-storage.mjs` 逐渠道强制校验。
- **端口**：每渠道独占一组，登记在 `ChannelConfig.defaultAddr` / `uiPort`，不与他渠道重复
  （仓库级网关不用它们，见 AGENTS.md §4；单渠道独立运行才生效）。
- `*_DEBUG_DUMP` 是运行期抓包目录（opt-in，值须为绝对路径或 `1`），不构成固定落点。
- 各包根目录的 `models.json` 是**只读的包内资源**（兜底模型表，随包分发），不是用户存储。

---

## 3. 目标规范（条文）

1. **单一存储根**：`~/.modelmux/`，由共享层唯一解析，渠道不得自行拼绝对路径。
2. **按 cid 分层**：`<root>/<cid>/`。`cid` 全小写、仅 `[a-z0-9-]`、等于 `ChannelConfig.cid`。
3. **根目录覆盖变量**：`MODELMUX_HOME`（唯一；没有别的名字，也不读历史变量）。
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
        （首次使用）才会拉一次并记录。要更新用 `models <cid> --refresh`。
      - **可安全删除**：删掉只影响下一个新进程的显示（回到兜底表），不影响登录态与额度。
      - 没有远端目录层的渠道不会产生这个文件（它只是「不存在」，不是错误）。
  - `state/` 跨重启保持的**状态**：`state/signin.json`（签到台账：
    `{version, timezone, last_claim, history}`，由共享层在**领取成功**或自动签到回填时写入）、
    `state/auto-signin.json`（自动签到的当日失败计数，连败 3 次熔断）。
  - `debug/` 抓包落盘默认位置（`<CID>_DEBUG_DUMP` 仅作覆盖，值须为绝对路径）
  - **禁止**写 `~/` 下任何其它目录（含 `~/.cache/`、`~/.config/`）
6. **权限**：根 `0700`，各 cid 层 `0700`，`credentials.json` 等含密文件 `0600`。
  渠道只能写自己的层。
7. **命名细则**：全小写；单词用 `-` 连接；扩展名固定 `.json` / `.log` / `.pid`；
  临时文件同目录加 `.tmp`；**不用**大写、下划线、渠道名前缀。
8. **端口**：每渠道独占一组（见 §2），不与他渠道重复。
9. **（可选）根级共享偏好**：`<root>/prefs.json` 放跨渠道设置；渠道内 `prefs.json` 只放
   本渠道设置。本期可不实现，但预留位置，避免以后又想加一层。
10. **根级共享运行时文件**：属于「全部渠道」而不属于任一渠道的文件放根上 ——
   `gateway.pid` / `gateway.log`（仓库级网关）、`pool-usage.json`（公共模型池的渠道账本：
   账单已用量 + 失败冷却，见 `docs/POOL-ARCHITECTURE.md` §2.3）。走 `paths.rootFile()`，
   文件名同样受本节第 7 条的校验。
