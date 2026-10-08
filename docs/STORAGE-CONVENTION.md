# 存储落点与文件命名规范（工作区 `model-bridge`）

本文件只规定**放在哪里、叫什么名字**：存储根、cid 分层、覆盖用环境变量、目录内的文件命名、
历史名迁移。**凭证/配置的字段内容不在此列** —— 各 `channels/<cid>/` 自己决定
（见 `CONTRACT-TS.md` §5）。

适用范围：工作区内的 11 个渠道包 + 共享包 `packages/gateway`。（2026-10-08 快照：当时为 12 个，zcode 渠道已移除。）

---

## 0. 实施状态（2026-10-08 已落地）

本规范已在工作区落地，全部渠道对齐，`npm test` 全绿（含存储专项测试与规范校验器）。

| 项 | 落地结果 |
|---|---|
| 共享层 | `paths.ts`（单根 + `<cid>` 分层、固定文件名/子目录集中、纯函数 `*For` 供只读巡检）＋ 新增 `migrate.ts`（收拢、并存补齐、文件级收敛、权限基线） |
| 类型 | `BridgeConfig` 去掉 `dirName` / `envVar`；新增 `fileMigrations` / `legacyDebugDumpEnv` |
| 渠道 | 12 个 `channel.ts` 对齐；`.workbuddy-bridge` 误入项已从 10 个渠道移除；workbuddy 调试变量改 `WORKBUDDY_DEBUG_DUMP`；catpaw 加 `daemon.pid → gateway.pid`；codearts 缓存迁入 `cache/` |
| 校验 | `tools/verify-storage.mjs` 断言全部规则并接入工作区 `npm test`（已反向验证：注入跨渠道条目会被拦下） |
| 统计 | `workbuddy paths [--json]` 与 `paths --all`（只读，不触发迁移） |

落地时对方案的两处修正：

1. **`dirName` 直接删除**：被取代的 `.<cid>-bridge` 不是消失，而是降级为 `legacyDirs` 的**首项**
   （迁移来源）—— 现行名与历史名共用一条清单，不再需要额外字段。
2. **收拢的搜索父目录收紧**（实现时踩到）：只有当存储根**不是**由环境变量显式指定时，
   才把用户主目录列入搜索范围。否则测试/便携模式把根指到别处时，收拢会去动真实主目录里的
   旧目录（实测：catpaw 的测试曾把 `~/.catpaw-bridge` 当作历史目录读取）。
   见 `paths.legacySearchParents()`。

---

## 1. 目标布局（一句话）

**工作区只有一个存储根 `~/.model-bridge/`，各渠道按 `cid` 分一层子目录。**

```
~/.model-bridge/                 ← 唯一存储根（MODEL_BRIDGE_HOME 可覆盖）
├── prefs.json                   ← （可选）跨渠道共享偏好
├── workbuddy/                   ← cid 层
│   ├── credentials.json
│   ├── upstream.json
│   ├── prefs.json
│   ├── gateway.pid
│   ├── gateway.log
│   ├── cache/                   ← 可安全删除
│   ├── state/                   ← 跨重启保持
│   └── debug/                   ← 抓包落盘（opt-in）
├── catpaw/
├── trae/
├── codearts/
├── lobsterai/
├── cline/
├── loomy/
├── raccoon/
├── minimax/
├── gemini/
└── qoder/
```

分层名 = `cid`（全小写、仅 `[a-z0-9-]`），**不带点、不带 `-bridge` 后缀** —— 它已经是
收拢目录下的一层，冗余前缀与隐藏前缀都没有意义。

---

## 2. 现状统计（迁移前）

### 2.1 已经统一的部分（12/12 一致）

| 项 | 现状 | 一致性 |
|---|---|---|
| 存储根 | `~/.<cid>-bridge/`（**每渠道一个顶层 dotdir**） | 12/12 符合现规范，但不符合目标布局 |
| HOME 覆盖变量 | `<CID>_HOME` | 12/12 符合现规范 |
| 目录内文件 | `credentials.json` / `upstream.json` / `prefs.json` / `gateway.pid` / `gateway.log` | 12/12 一致（文件名只在 `packages/gateway/src/paths.ts` 定义一处） |
| 文件权限 | `0600` + 临时文件 + 同目录 `rename` 原子替换 | 11/12（qoder 是桩，未落盘） |
| 端口分配 | 每渠道独占一组「网关端口 / 控制台端口」 | 12/12 无冲突 |

### 2.2 逐渠道登记表

| cid | 现存储目录（**迁移来源**） | 目标层 | 现覆盖变量 | 调试覆盖 | legacyDirs（新→旧） | legacyEnvVars |
|---|---|---|---|---|---|---|
| workbuddy | `.workbuddy-bridge` | `<root>/workbuddy` | `WORKBUDDY_HOME` | `WBAI_DEBUG_DUMP` ⚠ | `.zcode-workbuddy-bridge`, `.zcode-connect-workbuddyai`, `.workbuddyai2api`, `.workbuddyai-gateway` | `ZCB_HOME`, `WBAI2API_HOME` |
| catpaw | `.catpaw-bridge` | `<root>/catpaw` | `CATPAW_HOME` | `CATPAW_DEBUG_DUMP` | `.zcode-catpaw-bridge`, `.zcode-connect-catpaw` | `ZCC_HOME` |
| zcode | `.zcode-bridge` | `<root>/zcode` | `ZCODE_HOME` | `ZCODE_DEBUG_DUMP` | `.zcode-workbuddy-bridge` ⚠, `.zcode-connect-zcode`, `.zcode2api`, `.zcode-gateway` | — |
| trae | `.trae-bridge` | `<root>/trae` | `TRAE_HOME` | `TRAE_DEBUG_DUMP` | `.zcode-workbuddy-bridge` ⚠, `.zcode-connect-trae`, `.trae2api`, `.trae-gateway` | — |
| codearts | `.codearts-bridge` | `<root>/codearts` | `CODEARTS_HOME` | `CODEARTS_DEBUG_DUMP` | `.zcode-workbuddy-bridge` ⚠, `.zcode-connect-codearts`, `.codearts2api`, `.codearts-gateway` | — |
| lobsterai | `.lobsterai-bridge` | `<root>/lobsterai` | `LOBSTERAI_HOME` | `LOBSTERAI_DEBUG_DUMP` | `.zcode-workbuddy-bridge` ⚠, `.zcode-connect-lobsterai`, `.lobsterai2api`, `.lobsterai-gateway` | — |
| cline | `.cline-bridge` | `<root>/cline` | `CLINE_HOME` | `CLINE_DEBUG_DUMP` | `.zcode-workbuddy-bridge` ⚠, `.zcode-connect-cline`, `.cline2api`, `.cline-gateway` | — |
| loomy | `.loomy-bridge` | `<root>/loomy` | `LOOMY_HOME` | `LOOMY_DEBUG_DUMP` | `.zcode-workbuddy-bridge` ⚠, `.zcode-connect-loomy`, `.loomy2api`, `.loomy-gateway` | — |
| raccoon | `.raccoon-bridge` | `<root>/raccoon` | `RACCOON_HOME` | `RACCOON_DEBUG_DUMP` | `.zcode-workbuddy-bridge` ⚠, `.zcode-connect-raccoon`, `.raccoon2api`, `.raccoon-gateway` | — |
| minimax | `.minimax-bridge` | `<root>/minimax` | `MINIMAX_HOME` | `MINIMAX_DEBUG_DUMP` | `.zcode-workbuddy-bridge` ⚠, `.zcode-connect-minimax`, `.minimax2api`, `.minimax-gateway` | — |
| gemini | `.gemini-bridge` | `<root>/gemini` | `GEMINI_HOME` | `GEMINI_DEBUG_DUMP` | `.zcode-workbuddy-bridge` ⚠, `.zcode-connect-gemini`, `.gemini2api`, `.gemini-gateway` | — |
| qoder | `.qoder-bridge` | `<root>/qoder` | `QODER_HOME` | `QODER_DEBUG_DUMP` | `.zcode-workbuddy-bridge` ⚠, `.zcode-connect-qoder`, `.qoder2api`, `.qoder-gateway` | — |

⚠ = 违反规范，见 §3。（**均已修复**，§3 保留迁移前的盘点作为历史依据；此后 zcode 渠道已移除，故下表 12 行对应的是当时的 12 个渠道。）`<root>` = `~/.model-bridge`。

### 2.3 目录外的落盘点（唯一一处）

| 渠道 | 位置 | 文件 | 覆盖变量 |
|---|---|---|---|
| codearts | `~/.cache/deveco/` ⚠ | `codearts_models.json`, `codearts_benefit_models.json` | `DSH_CODEARTS_CACHE_DIR` / `CODEARTS_CACHE_DIR` |

其它渠道的目录外文件都是**只读的包内资源**，不是用户存储，属正当例外：

- `channels/zcode/tools/zcode-identity.json`（身份块，随包分发；`ZCODE_IDENTITY_FILE` 可覆盖路径）
- 各包根目录的 `models.json`（兜底模型表，随包分发）

`*_DEBUG_DUMP` 是运行期由用户指定的抓包目录（opt-in），不构成固定落点，但命名见 §3.3。

---

## 3. 偏差清单

### 3.0【高】结构性：12 个顶层 dotdir 未收拢

现状每渠道在 `~/` 下各占一个 `.<cid>-bridge`。目标改为单根 `~/.model-bridge/<cid>/`。

**为什么值得改**：一份覆盖变量（`MODEL_BRIDGE_HOME`）而不是 12 个；目录权限可以在根上一处设定；
备份/迁移/巡检/清理都是一个路径；`ls ~/.model-bridge/` 就是完整统计，不必再数 `ls ~` 里的星号。

**代价（要认）**：根目录成了单点——用户误删 `~/.model-bridge/` 会让所有渠道同时掉登录态，
而现状下各渠道是隔离的。隔离性可以用「每渠道一个 `0700` 子目录 + 只写自己那一层」来补偿
（见 §4.6）。

### 3.1【高】10 个渠道的 `legacyDirs` 混入了 `.zcode-workbuddy-bridge`

除 workbuddy / catpaw 外的 10 份 `channel.ts`，迁移链首项都是 workbuddy 的历史目录名
（模板复制扩散的产物）。而迁移逻辑是「新目录不存在时，按 `legacyDirs` 顺序把第一个存在的
旧目录整体搬过来」——若该旧目录还在而 trae 抢先启动，它会**把 workbuddy 的旧目录搬成自己的**，
凭证被掠走且不可逆。

**处置**：非 workbuddy 渠道一律删除该条。收拢到单根后，这一条同样必须清掉，否则
「搬进 `<root>/trae/`」的对象会是 workbuddy 的数据。

### 3.2【高】迁移不支持「新旧并存」

```ts
if (existsSync(target)) return target;   // 新目录在 → 直接返回，legacyDirs 完全不看
```

新目录一旦存在（哪怕空），旧目录里的凭证就被**永久搁置**：不迁移、不报错、不提示。
本机 catpaw 正处于这个状态。收拢迁移必然遇到「根目录已建、某个旧 dotdir 还在」，
这条缺陷必须先修，否则迁移会静默丢数据。

**处置**：改成「新位置不存在 → 整体搬；新位置存在且旧位置也存在 → 逐文件补齐（只补缺失的）+
记日志」。

### 3.3【中】workbuddy 的调试变量名是 `WBAI_DEBUG_DUMP`

其余 11 个都是 `<CID>_DEBUG_DUMP`，只有它用了更早的 `WBAI_` 前缀，与自己的
`WORKBUDDY_HOME` 都不一致。`WBAI_` 只应出现在 legacy 列表里。

**处置**：改为 `WORKBUDDY_DEBUG_DUMP`，旧名进 `legacyEnvVars`。

### 3.4【中】codearts 把模型缓存写到 `~/.cache/deveco/`

唯一一处「渠道把自有状态写到存储根之外」，绕开了覆盖变量、权限、迁移链与巡检。

**处置**：迁入 `<root>/codearts/cache/`；文件名去掉渠道前缀（`models.json` /
`benefit-models.json`）——已在渠道层内，前缀冗余。旧路径作一次性兼容读，读到即搬。

### 3.5【中】文件级迁移缺失

目录迁移只处理目录改名，不管目录**内部**的历史文件名。本机已有两例：

| 渠道 | 目录内历史文件 | 现规范名 | 来源 |
|---|---|---|---|
| catpaw | `daemon.pid` | `gateway.pid` | Python 版守护进程的命名 |
| workbuddy | `webview/` | 无（GUI 层已删除） | Python 版 GUI 残留 |

**处置**：建立「文件级迁移表」（旧名 → 新名 / 删除），`ensureDir()` 时幂等执行。

### 3.6【低】小的重复与桩

- workbuddy / catpaw 的 `cred.ts` 各自重复 export 了一份 `CREDENTIALS_FILE`（仅供测试），
  应删掉，测试改用共享层 `paths`。
- qoder 是桩（22 处 `todo`），登记信息合规但无落盘行为，统计里应标「未实现」。

---

## 4. 目标规范（条文）

1. **单一存储根**：`~/.model-bridge/`，由共享层唯一解析，渠道不得自行拼绝对路径。
2. **按 cid 分层**：`<root>/<cid>/`。`cid` 全小写、仅 `[a-z0-9-]`、等于 `BridgeConfig.cid`。
3. **根目录覆盖变量**：`MODEL_BRIDGE_HOME`（唯一）。旧的 `<CID>_HOME` 降级为兼容别名：
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
   - `cache/` 可安全删除、可重建（含模型目录缓存）
   - `state/` 跨重启保持的状态
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

---

## 5. 共享层改造

### 5.1 `paths.ts`：根与分层集中解析

```ts
export function rootDir(): string;        // MODEL_BRIDGE_HOME || ~/.model-bridge（不创建）
export function channelDir(): string;     // rootDir()/<cid>
export function channelFile(name: string): string;  // channelDir()/<name>，并校验 name 合法（§4.7）
export function cacheDir(): string;       // channelDir()/cache
export function stateDir(): string;       // channelDir()/state
export function debugDir(): string;       // channelDir()/debug
```

`BridgeConfig.dirName` 字段**删除**（目录名不再由渠道决定）；`cid` 复用现有的
`BridgeConfig.cid`。五个固定文件名改为函数内部常量，不再散落多处。

渠道的 `legacyDirs` 语义调整为「迁移来源的**顶层**目录名清单」——共享层负责把
`~/<legacyName>` 的内容搬进 `rootDir()/<cid>/`。

### 5.2 `migrate.ts`（新增）：幂等迁移

```ts
// 一、顶层 dotdir 收拢：~/.<cid>-bridge  →  <root>/<cid>/
//     依次尝试 [dirName 现名, ...legacyDirs]，按「新→旧」
//     新位置不存在 → 整体搬（rename；跨设备退化为 copy+delete）
//     新旧并存     → 逐文件补齐（只补缺失）+ 日志
//     skipMerge：fileMigrations 里 action="delete" 的条目**不搬运**
//     （GUI 时代的 webview/ 有 29MB，没有理由复制一份）
export function collectLegacyDirs(options: CollectOptions): string;

// 二、文件级收敛（目录内历史文件名）
//     [{ from: "daemon.pid", to: "gateway.pid" }, { from: "webview", action: "delete" }]
export function migrateFiles(): void;

// 三、权限基线：root 0700 / cid 层 0700 / 含密文件 0600
export function enforcePermissions(): void;
```

渠道只在 `channel.ts` 里填「文件级迁移表」，不写迁移代码：

```ts
fileMigrations?: Array<{ from: string; to?: string; action?: "delete" }>;
```

### 5.3 校验器（可执行的规范）

`tools/verify-storage.mjs`：加载 12 份 `channel.ts` 的 `config`，逐条断言：

| 断言 | 对应条文 |
|---|---|
| 所有渠道的存储根相同（都等于共享 `rootDir()`，渠道配置里不再有 dirName） | §4.1 |
| 分层名 == `cid`，匹配 `^[a-z0-9-]+$` | §4.2 |
| `debugDumpEnv === cid.toUpperCase() + "_DEBUG_DUMP"` | §3.3 |
| `legacyDirs` 不含任何**其它**渠道的 `cid` / 历史 `dirName` | §3.1 / §4.8 |
| `legacyEnvVars` 不含任何**其它**渠道的现 `envVar` | §4.8 |
| `defaultAddr` / `uiPort` 在 12 渠道间唯一 | §4.9 |

失败即非零退出，接入工作区 `npm test`。**这就是把「统一统计」固化成回归测试。**

### 5.4 巡检命令（统计出口）

`bridge paths [--json]`（共享 CLI 子命令）：

- 本渠道：打印根、cid 层、五个固定文件与三个子目录的绝对路径、是否存在、权限位。
- `--all`：读工作区根 `package.json` 的 `workspaces` 得到全渠道清单，
  一张表输出：`cid / 层目录 / 是否存在 / 文件清单 / 权限 / 凭证摘要(脱敏) / 最后修改 /
  是否有待迁移的旧顶层目录或历史文件`。

有了单根，这个命令就是「目录 + 分层」规范的自动统计，不需要人肉 `ls ~`。

---

## 6. 迁移策略（顶层 → 单根分层）

| 步骤 | 动作 | 兼容/回退 |
|---|---|---|
| 1 | 建 `<root>/`（0700） | 已存在则复用 |
| 2 | 对每个渠道：把 `~/.<cid>-bridge` 与全部 `legacyDirs` 的**内容**并入 `<root>/<cid>/` | 新位置不存在 → 整体搬；并存 → 逐文件补齐 |
| 3 | 旧顶层空目录删除（仅当确认已清空） | 非空则保留并记日志，绝不强删 |
| 4 | 文件级收敛（`daemon.pid` → `gateway.pid`；`webview/` 需人工确认后删） | 幂等，可重复执行 |
| 5 | `~/.cache/deveco/` 的 codearts 缓存搬到 `<root>/codearts/cache/` | 旧路径保留为一次性兼容读 |
| 6 | 权限基线：root 0700 / 层 0700 / 含密文件 0600 | 每次 `ensureDir()` 都执行 |

全程**不删用户数据**：只「搬移 / 补齐 / 保留」。唯一的删除项是 workbuddy 的空 `webview/`，
且要求人工确认。

> ⚠ 迁移**没有独立命令**：任何走 `paths` 的读写（`status` / `models` / `start` / `serve`）都会
> 在首次访问时触发收拢。所以「装了新版第一次跑命令」就等于迁移；若旧目录正被**运行中的**
> 旧进程占用（Windows 下 rename 会 `EPERM`），收拢退化为「逐文件补齐」并保留旧目录原样 ——
> 两边各一份，不会丢数据，但要换到新位置需先停掉旧进程再跑任一命令。

---

## 7. 验收清单

- [ ] 存储根唯一：所有渠道都落在 `~/.model-bridge/<cid>/`，`BridgeConfig` 不再有 `dirName`
- [ ] `MODEL_BRIDGE_HOME` 可整体搬移根；`<CID>_HOME` 仍被识别（deprecation 日志）
- [ ] 各渠道 `legacyDirs` 中不再出现 `.zcode-workbuddy-bridge`（workbuddy 自身除外）
- [ ] 迁移在「新旧并存」时补齐而非搁置（造一个并存场景做回归测试）
- [ ] workbuddy 调试变量为 `WORKBUDDY_DEBUG_DUMP`；`WBAI_DEBUG_DUMP` 在 legacy 列表
- [ ] codearts 缓存落在 `<root>/codearts/cache/`，不再写 `~/.cache/deveco/`
- [ ] `~/.catpaw-bridge/daemon.pid` 收敛为 `<root>/catpaw/gateway.pid`
- [ ] 权限：根 0700、层 0700、凭证 0600
- [ ] `tools/verify-storage.mjs` 全绿并接入工作区 `npm test`
- [ ] `model-bridge paths --all` 一张表列出全部渠道的落点与状态
- [ ] `npm run build --workspaces && npm run test --workspaces` 退出码 0

---

## 8. 实施顺序

1. 共享层：`paths.ts` 改「单根 + `<cid>` 分层」并把文件名/子目录集中；`BridgeConfig.dirName` 下线
2. `migrate.ts`：顶层收拢（含并存补齐）+ 文件级收敛 + 权限基线
3. 校验器 `tools/verify-storage.mjs`，先跑一遍拿到 12 份的完整违规清单
4. 修 §3.1（删 10 条误入 legacy）与 §3.3（workbuddy 调试变量名）—— 纯配置，风险最低
5. 修 §3.4（codearts 缓存迁入）与 §3.5（文件级迁移表）
6. 拿 workbuddy 试点全链路（本机有真实凭证，正好验证搬移不丢登录态），再抽查一个空目录渠道
7. 其余渠道对齐 → `bridge paths --all` 出统计 → 全量构建/测试收尾
