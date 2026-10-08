# Phase 2 · 数据收集（Data Collection）

> **实现语言（2026-10-07）**：本阶段现由 Python 实现 —— `src/catpaw_bridge/data_collection.py`，
> 命令行入口 `uv run catpaw-scan`。下文原始输出来自 TS/Node 版脚本（tag `v0.3.0-ts`）；
> 结论与证据等级不变，详见 [../README.md](../PROTOCOL.md)。

## 目标

把本机上所有可能承载凭据/会话的落点全部枚举出来，回答四个问题：一共有几个候选落点？每个落点里有什么**结构**（JSON 顶层键名 / SQLite 表名 / 编码）？哪些真正承载可用于上游认证的凭据？承载凭据的那些是明文还是密文？最终为 Phase 3 选出唯一的主目标字段。

本阶段只取键名与表名，不取任何值——"哪个文件有凭据"和"凭据是什么"在这里被再次分开。

## 方法与命令

执行命令：

```text
npm run scan           # 等价于 node scripts/scan-credentials.ts
```

入口 `scripts/scan-credentials.ts` 调用 `collectCandidates()` + `formatCandidates()`（`src/phase2-data-collection/index.ts`）。本阶段的行为边界 `[代码]`：

| 动作 | 实现 | 读到的内容 |
| --- | --- | --- |
| 探路径 | `probePath()`（`src/utils/probe.ts`） | 只 stat：存在性 / 类型 / 大小 / mtime |
| 读 JSON 结构 | `jsonTopLevelKeys()`：`JSON.parse` 后 `Object.keys()`，**值全部丢弃** | 只有顶层键名 |
| 读 SQLite 结构 | `sqliteTableNames()`：以 `readOnly: true` 打开，查 `sqlite_master` 的 `name` | 只有表名/视图名 |
| 找记忆库 | `findMemoryDatabases()`：`readdirSync(userDataDir)` + `/^catpaw-memory-.*\.db$/` | 文件名（scope 段不写死） |
| 读 CLI 登录态 | `readDesktopAuth()`：会读取 `auth.loginType`、`auth.accessToken`、`account.uid`、`account.loginName` 并做校验 | 值被读入内存，但渲染层不打印 |
| 打印凭据摘要 | `describeToken()` → `maskSecret()`（`src/utils/redact.ts`）：只留前缀 + 长度 | 如 `AgEKJlOd…[152]`，无原文 |

三条来源线 `[代码]`（文件头注释）：

1. 桌面端加密凭据 `catx-credential.json` → `ssoTokenEnc`（AES-256-GCM，Phase 3~6 的主题）；
2. CLI 明文登录态 `~/.meituan-catpaw/auth.json`（同一 token 的明文副本，用于交叉验证）；
3. 旧版 CatPawAI（VSCode 系）`state.vscdb`（本机不存在，仅保留候选路径做历史对照）。

本次运行的原始输出留存于 `.tmp\runlogs\scan-credentials.txt`，下面「原始输出」一节的内容全部取自该文件。

## 原始输出（节选）

```text

=== Phase 2 · 凭据落点清单 ===
  userData               C:\Users\bluechonk\AppData\Roaming\catpaw-moon
  CLI 目录                 C:\Users\bluechonk\.meituan-catpaw

=== 落点 ===
类别                     状态  大小         修改时间                 编码      凭据
encrypted-credential   OK  326 B      2026-10-03 15:17:18  json    YES
auth-provider-pointer  OK  38 B       2026-10-03 15:17:13  json    no
enterprise-token       OK  92 B       2026-10-03 15:17:13  json    YES
scope-pointer          OK  43 B       2026-10-06 01:53:40  json    no
device-uuid            OK  57 B       2026-10-06 01:53:43  text    no
electron-local-state   OK  490 B      2026-10-03 15:16:09  json    no
desktop-auth-json      OK  442 B      2026-10-06 01:53:43  json    YES
session-memory-db      OK  33.2 MiB   2026-10-06 02:41:36  sqlite  no
session-memory-db      OK  224.0 KiB  2026-10-03 15:17:18  sqlite  no
legacy-vscdb           -   -          -                    sqlite  YES
legacy-vscdb           -   -          -                    sqlite  YES

=== 结构（仅键名/表名） ===
  encrypted-credential: ssoTokenEnc
  # ssoTokenEnc = base64(IV12 ‖ tag16 ‖ AES-256-GCM 密文)，本课题主目标
  auth-provider-pointer: activeProvider
  # activeProvider，指明当前登录通道（catx-passport / 企业版）
  enterprise-token: epToken, entId, activeEntId, sessions, refreshJournal
  # epToken / sessions / refreshJournal，企业版通道会话（本机为空）
  scope-pointer: lastActiveScopeSegment
  # 多租户 scope 指针，值形如 <uid><随机段>，决定加密凭据落在哪个 scope
  device-uuid: <uuid>
  # 设备 UUID（非密钥材料；密钥材料来自机器码，见 Phase 5）
  electron-local-state: os_crypt, uninstall_metrics
  # 含 os_crypt（Electron safeStorage 元数据）；妙手 token 未走这条通道，仅作对照
  desktop-auth-json: auth, account, scopeSuffix, updatedAt
  # CLI 落盘的明文登录态，与 ssoTokenEnc 解密结果互为验证
  session-memory-db: cliapps_decide_receipts, cliapps_ledger_entries, cliapps_ledger_meta, conversations, deleted_sessions, editor_session_data, memory_chunks, memory_chunks_fts, memory_chunks_fts_config, memory_chunks_fts_content, memory_chunks_fts_data, memory_chunks_fts_docsize, memory_chunks_fts_idx, memory_documents, session_journal, session_outbox, session_remote_event_cursor, sessions, sessions_reconcile_meta, sqlite_sequence, ui_sdk_messages, widget_gate_state, widget_read_me_called
  # 会话/记忆库（conversations、sessions、memory_chunks_fts…），不含凭据
  session-memory-db: conversations, deleted_sessions, editor_session_data, memory_chunks, memory_chunks_fts, memory_chunks_fts_config, memory_chunks_fts_content, memory_chunks_fts_data, memory_chunks_fts_docsize, memory_chunks_fts_idx, memory_documents, session_journal, session_outbox, session_remote_event_cursor, sessions, sessions_reconcile_meta, sqlite_sequence, ui_sdk_messages, widget_gate_state, widget_read_me_called
  # 会话/记忆库（conversations、sessions、memory_chunks_fts…），不含凭据
```

## 结论

### 落点总表

下表「凭据」列直接对应输出的 `凭据` 列（`YES`/`no`）`[实测]`，其取值由 `collectCandidates()` 中每条候选的 `credentialBearing` 字段写死 `[代码]`；「明文/密文」列由结构键名与本阶段已知格式判定（Evidence 逐行标注）。

| 落点 | 大小 | 是否承载凭据 | 加密与否 | 角色 |
| --- | --- | --- | --- | --- |
| `catx-credential.json` | 326 B | 是 `[实测]` | **密文**：`ssoTokenEnc` = base64(IV12 ‖ tag16 ‖ AES-256-GCM 密文) `[代码]` | 主目标：桌面端 SSO token 的唯一加密落点，Phase 3~6 的主题 |
| `catx-auth-provider.json` | 38 B | 否 `[实测]` | 明文 JSON（可被 `JSON.parse` 取到键名）`[实测]` | 指针：`activeProvider` 指明当前登录通道（catx-passport / 企业版）`[代码]` |
| `catx-enterprise-token.json` | 92 B | 是 `[实测]` | 明文 JSON（键名可见，未见加密信封）`[实测]`+`[推断]` | 企业版通道会话：`epToken` / `entId` / `activeEntId` / `sessions` / `refreshJournal` `[实测]`；本机未登录该通道 |
| `catx-scope-pointer.json` | 43 B | 否 `[实测]` | 明文 JSON `[实测]` | 指针：`lastActiveScopeSegment` 决定加密凭据落在哪个 scope `[代码]` |
| `catpaw-uuid` | 57 B | 否 `[实测]` | 明文 text `[实测]`（编码列为 text） | 设备 UUID；脚本注明"非密钥材料" `[代码]`，本阶段未验证 |
| `Local State` | 490 B | 否 `[实测]` | 明文 JSON `[实测]` | Electron safeStorage 元数据（`os_crypt` / `uninstall_metrics`），仅作对照 `[实测]` |
| `~\.meituan-catpaw\auth.json` | 442 B | 是 `[实测]` | **明文** JSON `[实测]` | CLI 落盘的登录态；Phase 6 交叉验证用的独立来源 `[代码]` |
| `catpaw-memory-<scope>.db` | 33.2 MiB | 否 `[实测]` | 明文 SQLite `[实测]` | 会话/记忆库，23 张表（含 `cliapps_*` 3 张）；与凭据无关 `[实测]` |
| `catpaw-memory-anon.db` | 224.0 KiB | 否 `[实测]` | 明文 SQLite `[实测]` | 同上，20 张表（比上一行少 3 张 `cliapps_*`）`[实测]` |
| `Roaming\CatPawAI\User\globalStorage\state.vscdb` | —（不存在） | 候选标记为是 `[代码]` | — | 旧版 VSCode 系线路，本机不存在，仅作历史对照 `[实测]` |
| `%USERPROFILE%\AppData\Roaming\CatPawAI\User\globalStorage\state.vscdb` | —（不存在） | 候选标记为是 `[代码]` | — | 同上（与上一行默认是同一路径的两种拼法）`[代码]` |

### 逐条结论

1. 本阶段共枚举出 **11 条候选记录**：7 个文件（json/text）+ 2 个 SQLite 记忆库 + 2 条旧版 `state.vscdb` 候选路径 `[实测]`。
2. 主目标锁定为 `catx-credential.json` 的 **`ssoTokenEnc`**：该文件顶层**只有这一个键**，且被标为承载凭据 `[实测]`。
3. `catx-enterprise-token.json` 顶层为 `epToken, entId, activeEntId, sessions, refreshJournal` `[实测]`；"本机为空"这句话出现在输出的注释行里，属于脚本内固定文案 `[代码]`，本阶段只取键名、不取值，因此**未能证实**该通道是否真为空（见「踩坑与修正」第 2 条）。
4. CLI 侧明文副本 `C:\Users\bluechonk\.meituan-catpaw\auth.json`（442 B）顶层键为 `auth, account, scopeSuffix, updatedAt` `[实测]`；代码读取的子字段为 `auth.loginType`、`auth.accessToken`、`account.uid`、`account.loginName` `[代码]`。它是与 `ssoTokenEnc` 解密结果互证的"另一条独立来源" `[代码]`。
5. `catx-auth-provider.json`（`activeProvider`）、`catx-scope-pointer.json`（`lastActiveScopeSegment`）是**指针**类落点，本身不承载凭据，但决定"用哪个通道、凭据属于哪个 scope" `[实测]`+`[代码]`。
6. `catpaw-uuid` 编码为 text、结构标为 `<uuid>` `[实测]`；它是设备标识而非密钥材料，真正的密钥材料要到 Phase 5 才追 `[代码]`。
7. `Local State` 顶层键 `os_crypt, uninstall_metrics` `[实测]`：`os_crypt` 是 Electron safeStorage 的元数据；妙手的 token 并未落在这条通道上、而是走 `catx-credential.json` 的自有信封，故此处仅作对照 `[推断]`（依据：token 字段在 `catx-credential.json`，`Local State` 只有 safeStorage 元数据键）。
8. 两个记忆库的表名集合**不含任何凭据语义**（`conversations` / `sessions` / `memory_chunks_fts*` / `ui_sdk_messages` / `widget_*` 等）`[实测]`，脚本据此判定"不含凭据" `[代码]`，与本阶段观察一致 `[推断]`。两者表数分别为 23 与 20，差集恰为 `cliapps_decide_receipts` / `cliapps_ledger_entries` / `cliapps_ledger_meta` `[实测]`+`[推断]`。
9. 记忆库文件名形如 `catpaw-memory-<scope>.db`，**scope 段不能写死**：`findMemoryDatabases()` 用文件名正则匹配、`sort()` 后枚举 `[代码]`。表里两行记忆库与两个文件的对应关系，由该排序（升序：`<uid>` 段以数字开头，排在 `anon` 之前）+ 命名推得：33.2 MiB（23 表）对应 `<scope>` 库、224.0 KiB（20 表）对应 `anon` 库 `[推断]`。
10. 旧版线路确认**本机不存在**：两条 `state.vscdb` 候选路径探测结果均为 `-`（无大小、无 mtime）`[实测]`，说明本机没有 VSCode 系旧版 CatPawAI 的凭据库，该线路只保留作历史对照 `[推断]`。
11. 本阶段全程只读、未写盘、未打印任何凭据值 `[代码]`；唯一会读到值的路径是 `readDesktopAuth()`，其输出被 `maskSecret()` 收敛为"前缀 + 长度" `[代码]`。

## 踩坑与修正

1. **`凭据` 列是"预期承载"，不是"已确认承载"。** `credentialBearing` 是构造每条候选时写死的布尔值（`collectCandidates()` 里的字面量），本阶段没有做任何内容级判定；最明显的证据是两条 `legacy-vscdb` 候选在文件**不存在**的情况下依然被标成 `YES`。读这张表时必须知道这一列的含义 `[代码]`。
2. **"本机为空"是文案，不是测量。** 企业版文件的输出里只有键名，`（本机为空）`来自 `note` 常量。本阶段不读值，因此无法证明 `epToken` 是否为空——这条留白，不应作为结论引用 `[代码]`。
3. **落点表没有路径列。** 表头只有"类别/状态/大小/修改时间/编码/凭据"，两个 33.2 MiB / 224.0 KiB 的记忆库行不带路径，两个 `legacy-vscdb` 行之间也看不出哪条对应哪个候选路径。要精确到路径必须改渲染函数或直接读 `layout`；本文件中的对应关系一律标为 `[推断]` `[代码]`。
4. **两条旧版候选路径在默认环境下是同一条。** `paths.ts` 里第二条写成 `join(profile, 'AppData', 'Roaming', 'CatPawAI', ...)`，而 `roaming` 默认就是 `join(profile, 'AppData', 'Roaming')`——除非 `APPDATA` 被覆盖，两者指向同一个 `state.vscdb`。所以输出里那两行 `legacy-vscdb` 是同一路径的重复探测，不是两个不同位置 `[代码]`。
5. **时间同样按 UTC 打印**（`formatTime()` 实现为 `toISOString()` 截断），表里的 `2026-10-06 01:53:40` 等均为 UTC `[代码]`。

## 下一步

Phase 3 把本阶段选出的唯一主目标字段 `ssoTokenEnc` 当作黑盒字节串来量：base64 解码长度、按 IV/tag 切分后的三段长度、熵、可打印占比与首字节结构。
