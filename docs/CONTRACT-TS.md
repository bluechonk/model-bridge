# TypeScript 渠道项目契约（工作区 `model-bridge`）

本文件描述**统一后的共享包架构**。所有渠道的实现都必须遵守本契约。

## 0. 一句话架构

**共享层在 `packages/gateway`（工作区名 `@model-bridge/gateway`），渠道差异通过
`Channel` 注册表注入。每个 `channels/<cid>/` 只实现 4 个渠道特有模块，其余一律复用共享包。**

旧实现（已废弃）是「每个项目各存一份共享模块副本 + 用 `scaffold_ts.py` 做字符串替换」，
改一处要重刷 11 份。现在共享模块只有一份，字符串替换已彻底移除。

---

## 1. 工作区布局

```
model-bridge/                     ← 仓库根 = 工作区根 + ZCode 市场根 + 插件宿主
├── packages/gateway/             ← **共享包** `@model-bridge/gateway`
│   └── src/
│       ├── channel.ts            ← 渠道注册表（共享层与渠道层的**唯一边界**）
│       ├── gateway.ts            ← HTTP 网关：/v1/chat/completions、/v1/models、/health
│       ├── daemon.ts             ← start/stop/restart/status/models/credits/logs
│       ├── headless.ts           ← serve / login 的无窗口运行
│       ├── auth-flow.ts          ← 登录与凭证生命周期（与界面解耦）
│       ├── cli.ts                ← 命令行入口与参数解析
│       ├── cli-consts.ts         ← version / defaultAddr / defaultUiPort（取自注册的渠道）
│       ├── console.ts            ← 控制台 API（/api/state 等）
│       ├── paths.ts              ← 本地文件路径（凭证/配置/日志/PID）
│       ├── portfree.ts           ← 端口占用检测与释放、地址工具
│       ├── sse-stream.ts         ← SSE 规范化、聚合、中继
│       ├── model-family.ts       ← 模型池白名单（见 §4）
│       └── index.ts              ← 对外的统一出口
├── plugins/model-bridge/         ← **唯一的 ZCode 插件**（命令/技能/hook）
├── marketplace.json              ← ZCode 市场清单（单条目 → ./plugins/model-bridge）
├── channels/                     ← 10 个渠道（每个 = 一个模型池 + 账号池）
│   └── <cid>/                    ← 结构见下
├── packages/cli/                 ← **仓库级入口**（bin `model-bridge`）
│   └── src/
│       ├── channels.ts           ← import 全部渠道包（副作用 = setChannel）
│       └── cli.ts                ← bin 入口：注册全部渠道后调共享 `main()`
├── docs/                         ← 契约、渠道协议（protocols/）、渠道说明（bridges/）、进度（journals/）
└── tools/                        ← 仓库级工具（verify-storage.mjs 等）
```

`channels/<cid>/` 内部（= 一个**池子**）：

```
channels/<cid>/
└── src/
    ├── channel.ts                ← **本渠道装配**：BridgeConfig + 4 个模块 → setChannel()
    ├── cli.ts                    ← bin 入口：注册本渠道后调共享 `main()`（单渠道调试用）
    ├── index.ts                  ← 重导出共享层 + 渠道模块
    ├── cred.ts                   ← **渠道特有**
    ├── upstream.ts               ← **渠道特有**
    ├── catalog.ts                ← **渠道特有**
    └── billing.ts                ← **渠道特有**
```

> **一个渠道 = 一个池子**：模型池 = `catalog` + 白名单（网关级）；账号池见
> [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md)。
> 多渠道路由下对外模型 id 是 `<cid>/<模型>`（如 `workbuddyai/deepseek-v4.1-flash`）；
> 只注册一个渠道时仍是裸短名（兼容既有客户端配置）。

**每个 `channels/<cid>/` 的 `src/` 只有 7 个文件。** 任何不在上表里的 `src/*.ts`
（`gateway.ts` / `daemon.ts` / `paths.ts` / `sse-stream.ts` …）都是旧副本残留，应删除。

### 1.1 各渠道的共享依赖声明

每个 `channels/<cid>/package.json` 必须声明：

```json
{ "dependencies": { "@model-bridge/gateway": "*" } }
```

工作区根 `npm install` 会把共享包软链到 `node_modules/@model-bridge/`。

---

## 2. 零运行依赖

`package.json` 的 `dependencies` **只允许 `@model-bridge/gateway`**（工作区内互相引用）。
技术选型：

| 需要什么 | 用什么 |
|---|---|
| HTTP 服务 | `node:http` 的 `createServer` |
| HTTP 客户端 | 原生 `fetch`（Node 18+，含流式 `response.body`） |
| SSE 解析 | 手写（见 `sse-stream.ts` 与各渠道的 `newTranslator()`） |
| 参数解析 | `node:util` 的 `parseArgs` |
| 测试 | `node:test` + `node:assert/strict` |
| UUID / 哈希 / 编解码 | `node:crypto`、`Buffer` |

`devDependencies` 只允许 `typescript` 与 `@types/node`。

**例外**：若渠道协议**必须**某个第三方库，才可加入 `dependencies`，并在 README 与
代码注释里说明「为什么不能零依赖」。共享包本身**必须零第三方依赖**。

---

## 3. 渠道注册表（共享层与渠道层的唯一接缝）

`packages/gateway/src/channel.ts` 定义 `Channel` 接口与注册函数。渠道在**入口处**
（`src/channel.ts`，模块加载时）调用 `setChannel()`；共享模块在**函数被调用时**
通过 `getChannel()` 取用 —— 所以注册顺序只需早于第一次网络/路径操作即可。

```ts
// 共享包导出
setChannel(channel: Channel): void;
getChannel(): Channel;        // 未注册时抛错
hasChannel(): boolean;        // 供测试/工具探测，不抛错
```

### 3.1 `BridgeConfig`（旧实现里靠字符串替换注入的那批常量）

```ts
interface BridgeConfig {
  cid: string;                 // 渠道 id，如 "catpaw"（日志前缀、服务名、CLI 名、**存储分层名**）
  display: string;             // 展示名，如 "ZCode"
  version: string;             // CLI 版本号
  defaultAddr: string;         // **单渠道独立运行**的网关默认地址，如 "127.0.0.1:8803"
  uiPort: number;              // **单渠道独立运行**的控制台端口（仓库级路由用 REPO_DEFAULT_*）
  legacyDirs?: string[];       // 历史顶层目录名（新→旧），收拢进 <root>/<cid>/（首项通常是 ".<cid>-bridge"）
  legacyEnvVars?: string[];    // 存储根覆盖变量的历史名（新→旧）；现行名是共享的 MODEL_BRIDGE_HOME
  debugDumpEnv: string;        // 抓包落盘目录的环境变量名（值 "1" 表示用渠道内 debug/）
  legacyDebugDumpEnv?: string[]; // 抓包变量的历史名（新→旧）
  fileMigrations?: FileMigration[]; // 渠道层内的历史文件名收敛（幂等）
}
```

⚠ **落点不由渠道决定**：存储根、`<cid>` 分层、目录内文件名全部由共享层
`paths.ts` 推导；渠道只给 `cid` 与历史名清单。完整规范与迁移规则见
[STORAGE-CONVENTION.md](./STORAGE-CONVENTION.md)（含 `FileMigration` 定义）。

### 3.2 `Channel`

```ts
interface Channel {
  config: BridgeConfig;
  cred: CredModule;
  upstream: UpstreamModule;
  catalog: CatalogModule;
  billing: BillingModule;
}
```

各模块的接口见 §5。

---

## 4. 模型池策略（`model-family.ts`）

**目录（数据层）与池子（呈现层）是两件事**：

- **目录**：各渠道的 `catalog.ts` 维护的完整模型表（兜底表 + `models.json` + 远端目录）。
- **池子**：`/v1/models` 与选择器实际暴露的 id —— 由共享层白名单过滤 `exposedIds()` 得到。

白名单是**网关级策略**，放在共享层，一次改动覆盖全部渠道。
判据是**两道闸门同时成立**：家族 + 型号。

```ts
export const FAMILY_ALLOWLIST: RegExp[] = [/\bdeepseek/i, /\bglm/i];  // 家族（并集）
export const REQUIRED_ALLOWLIST: RegExp[] = [/\bflash/i];             // 型号（必须全中）
```

- **只放行 `(deepseek | glm)` 的 flash 模型**。因此：
  - 同家族的非 flash（`deepseek-v4-pro`、`glm-5.2`）**挡下**；
  - **别家的 flash 也挡下**（`qwen3.8-flash`、`gemini-3.8-flash`、`mimo-v2.6-flash`）。
- **两条判据都用前置词边界** `\b`：
  - 上游写法里家族名/型号名前面总是 `-` / `/` / `~` / 串首，都有词边界 —— `\b` 覆盖
    全部真实变体（`deepseek-v4.1-flash`、`sn-glm-5-3-flash`、`z-ai/glm-5.3-flashx`、
    `~deepseek/deepseek-flash-latest`、`DeepSeek-V4-Flash-Official`）；
  - 而裸子串会误命中 `alglmx-flash`、`glimmer-flash`、`flashlight` 这类名字 ——
    误放行 = 把别家模型塞进用户的选择器。
  - `REQUIRED_ALLOWLIST` **只加前置边界**（`\bflash`）：同系变体靠后缀识别
    （`glm-5.3-flashx` 的 FlashX、`glm-flash-latest` 的跟随最新），加后置 `\b` 会全丢。
- 判据同时看 **id 与展示名**（`isAllowedFamily(id, name, slug)`）：某些渠道的家族信息
  只在展示名里（如 Qoder 的 `dfmodel`）。
- **过滤只发生在呈现层**：被挡在池外的模型**仍保留在目录里**（`catalog.details()` 可见），
  数据不丢。各渠道的 `resolveModel()` 对这些 id 仍能正常解析。
- 想放行全部模型：把 `FAMILY_ALLOWLIST` 置为 `[]`。
- 想放宽型号要求：把 `REQUIRED_ALLOWLIST` 置为 `[]`（不再强制 flash）。
- 临时排查：设 `BRIDGE_ALLOW_ALL_MODELS=1` 绕过白名单（不改代码）。

> ⚠ 策略收窄有**渠道级后果**：没有 deepseek/glm 产品的渠道池子会恒空。
> `gemini` / `minimax` 两个渠道因此已被删除（见 `docs/README.md` 的「已移除的渠道」）。

> ⚠ 各渠道 **不要**在自己的 `catalog.ts` 里再实现一遍家族过滤。`exposedIds()`
> 只需调用共享的 `isAllowedFamily()`，被判据覆盖的完整条目仍从 `details()` 给出。

---

## 5. 渠道特有模块的接口契约

共享层的 `gateway.ts` / `headless.ts` / `daemon.ts` / `auth-flow.ts` 按下面这套接口
调用渠道模块。**实现渠道时只要满足这些签名，网关就能工作。**

> 类型定义在 `packages/gateway/src/channel.ts`（`CredModule` / `UpstreamModule` /
> `CatalogModule` / `BillingModule`）。凭据/配置的具体形态各渠道不同，故这些位置用
> `any` —— 共享层只在**结构**上依赖它们，不做跨渠道的类型统一（那会在 10 个异构
> 渠道间制造大量摩擦）。

### 5.1 `cred.ts`

```ts
export const DEFAULT_BASE_URL: string;
export class NotLoggedInError extends Error {}

export interface Credentials {
  readonly accessToken: string;
  readonly uid: string;
  readonly domain: string;
  // ... 渠道自己的字段
}
export function load(): Credentials;                 // 不可用抛 NotLoggedInError
export function save(c: Credentials): Promise<void>;  // 原子替换 + 0600
export function login(baseUrl: string, options?: {
  onUrl?: (url: string) => void;
  onStatus?: (msg: string) => void;
}): Promise<Credentials>;
export function refresh(c: Credentials): Promise<Credentials>;
export function resolveBaseUrl(realm?: string): string;
```

⚠ **`onUrl(authorizeUrl)` 必须在拿到 URL 后立刻调用**（界面据此弹窗）。
⚠ **登录必须是真实 URL 链路**（设备码 / OAuth 回调 / 扫码轮询）——
**不得**从其它应用的本地文件读取登录态。真实 URL 方案见 §6。
⚠ **没有续期端点的渠道**，`refresh()` 做**有效性探测**（调 `fetchModels`），
失效时抛错 —— **不要假装续期成功**（那会让 UI 显示「已续期」而请求仍 401）。
⚠ `load()` 遇到「老凭据缺新字段」时，能补就补，而不是拒绝整条凭据。

### 5.2 `upstream.ts`

```ts
export const DEFAULT_BASE_URL: string;
export const WIRE: "openai" | "custom";        // 决定网关是否需要翻译层
export const DISPLAY_NAME: string;              // 状态页/日志用
export class UpstreamUnauthorized extends Error {}

export interface Config { baseUrl: string; /* ... 渠道自己的字段 */ }
export function defaultConfig(): Config;
export function loadConfig(): [Config, boolean];       // [配置, 是否来自磁盘]
export function saveConfig(cfg: Config): Promise<void>;
export function chatUrl(cfg?: Config): string;
export function modelsUrl(cfg?: Config): string;
export function buildHeaders(credential: any, cfg?: Config): Record<string, string>;
export function buildChatBody(req: Record<string, unknown>, upstreamModel: string): Record<string, unknown>;
export function fetchModels(credential: any): Promise<Record<string, unknown>>;
export function resolveConfig(data: Record<string, unknown>, fallback?: Config): Config;

// 仅当 WIRE === "custom" 时需要：
export function newTranslator(): StreamTranslator;
```

**`WIRE` 怎么选**：

| 上游协议 | WIRE | 需要 `newTranslator` |
|---|---|---|
| 标准 OpenAI SSE delta | `"openai"` | 否 |
| Anthropic Messages（`content_block_delta` 等） | `"custom"` | **是** |
| 自定义 event 流（`event:output` 等） | `"custom"` | **是** |
| 累积式帧（每帧给全文） | `"custom"` | **是** |

**`StreamTranslator` 的契约（必须是增量）**：

```ts
export interface StreamTranslator {
  /** 喂入一块字节，返回本次可产出的 **OpenAI SSE 帧**（Buffer 或 string 数组）。 */
  feed(chunk: Buffer): Array<Buffer | string>;
  /** 流结束：处理残余、补 `finish_reason` 帧与 `data: [DONE]`。 */
  finish(): Array<Buffer | string>;
}
```

⚠ **不能是「读完再翻」** —— 那会让流式失去意义（用户要等整轮生成完才看到第一个字）。
⚠ **必须跨 chunk 保留半帧**：SSE 事件会被 TCP 切在任意位置（中文多字节字符与
`\n\n` 分隔符都会被切开）。用 `new TextDecoder("utf-8")` 的流式解码 + 字符串缓冲，
**不要**对每个 chunk 单独 `toString()`。

**`buildChatBody(req, upstreamModel)`** 把下游 OpenAI 请求改写成上游能接受的形状：

- 标准 OpenAI 渠道：通常 `{...req, model: upstreamModel}`，可能补 system、强制 `stream: true`
- Anthropic 渠道：翻成 `{model, system, messages, max_tokens, stream}`
- 自定义渠道：翻成上游字段名（如 TRAE 的 `function` / `config_name` / `messages[].content`）

⚠ 上游只支持流式时**恒设 `stream: true`**（客户端要非流式由网关聚合）。

**`buildHeaders(credential)`** 返回**完整**的上游请求头（含鉴权与伪装）。
网关只会额外补 `Accept: text/event-stream`（若头里没有）。

### 5.3 `catalog.ts`

```ts
export function exposedIds(): string[];              // 池内模型短名（已过白名单）
export function resolveModel(name: string): string;  // 短名 → 上游 slug；未知原样返回
export function details(): Array<Record<string, unknown>>;  // 可选，供状态页
export function refresh?(): Promise<void>;           // 可选：强制重拉上游目录（CLI --refresh）
```

⚠ **兜底表是必需的**：未登录或上游目录失败时用户仍应看到模型（否则渠道在选择器里
凭空消失，用户以为插件坏了）。
⚠ 调用共享的 `isAllowedFamily()` 做池过滤，**不要自行实现家族判据**（见 §4）。
⚠ 但**不要列出实测用不了的模型** —— 用户选中后拿到空回答，而错误指向「模型」
而非真实原因，比不列更糟（ZCode 的 `GLM-5-Turbo` 就是这种情况，已从目录移除）。

#### 目录来源优先级（**所有渠道一致，按此顺序**）

1. **磁盘缓存** `<root>/<cid>/cache/models.json` —— **常态来源**。上次真实拉到的目录，
   由共享层 `readCatalogCache()` / `writeCatalogCache()` 读写（信封
   `{version, fetched_at, models}`，原子写入 + `0600`；落点见
   `STORAGE-CONVENTION.md` §4 第 5 条）。
2. **远端目录**（`upstream.fetchModels()`）—— **只在本地没有缓存时才拉**（首次使用），
   拉到后**必须立刻写一次缓存**，否则下一个进程拿不到它。
3. **随包快照**（渠道内的 `models.json` / 内置兜底表）—— 拉不到时的最后兜底。

一句话：**第一次 `model list` 把真实目录记到本地，之后一直用那个文件**；
要更新就 `model refresh` / `--refresh`。

规则：

- **兜底表是数据、不是机制**：它随包发布，必然随时间与上游脱节（实测 lobsterai 兜底只有
  1 条 flash，上游真实 8 条）。别指望它准；它的意义只是「未登录/离线时不留空白」。
- 拉取失败 / 未登录时**不要清空缓存**：旧的远端目录通常比随包快照新，继续用它显示。
- 惰性读取：`catalog.ts` 在**首次被问**时读缓存、再决定是否拉远端，避免模块加载期就碰磁盘
  （模块加载可能发生在渠道上下文之外，那时 `paths.*` 不知道为谁解析）。
- 没有远端目录层的渠道（catalog 只有兜底/随包快照）**不需要**缓存，也**不要**实现
  `refresh()` —— 共享层据此回报「模型表是内置的」；先补该渠道的 fetch/parse，
  缓存才有意义。

#### `refresh()`：显式刷新的契约

有远端目录层的渠道**必须**实现 `refresh()`（CLI 的 `--refresh` / `model refresh` 调它）：

- **绕过 TTL / 冷却**：用户显式要求刷新，不能拿缓存糊弄；
- **成功写缓存**：下次新进程直接读到新目录；
- **失败抛错**：自动路径静默回落是为了不打扰，但显式刷新失败必须可见 ——
  用户看到旧表却以为刷成功了是最坏的结果。失败时**不要**把失败记进 TTL/冷却状态，
  否则会挡住后续的自动刷新；
- 解析/落盘若已在 `upstream.fetchModels()` 里做过，`refresh()` 只需「要一次真实拉取 +
  校验结果非空」，不要重复实现解析。

共享层负责的（渠道不用管）：缓存命中判断、失败时回落内置表、退出码、
以及告诉用户这次看的是哪份数据。

### 5.4 `billing.ts`

```ts
export class CreditsError extends Error {}
export function fetchCredits(options?: { refreshOn401?: boolean }): Promise<CreditsResult>;

interface CreditsResult {
  ok: true;
  total: { remain: number; size: number; used: number; unit: string; remain_percent: number };
  packages: CreditPackage[];
  claimable?: Array<Record<string, unknown>>;
}

// 签到 / 领取能力（**必需**：每个渠道都要提供；CLI 的 `<cid> checkin` 用）
export const signin: SigninModule;
interface SigninModule {
  // 只读。claimedToday：**今天是否已签**（渠道能判断就给；判断不了用 null）；
  // daily：是否"每日"语义（false = 一次性奖励，如 raccoon）
  status(): Promise<{
    claimable: boolean | null;
    summary: string;
    items?: …;
    claimedToday?: boolean | null;
    daily?: boolean;
  }>;
  claim(): Promise<{ ok: boolean; summary: string; detail?: unknown }>;          // 写：会真的领掉
}
```

⚠ **「今日是否签到过」的判定顺序**（CLI 侧）：① 上游 `claimedToday` → ② 本地台账
`state/signin.json`（记"我们发起过的领取"）→ ③ 都没有就明确报未知，不猜。上游说已签而台账
没有时会**回填**台账（自愈：覆盖"在客户端签的"这种情况）。`claimedToday` 缺失 + 台账也没有时，
CLI 原样输出渠道自己的 `summary`（它最清楚是"没端点"还是"查不到"）。

⚠ `signin` 是**必需**的（契约统一，共享层**不做能力探测、不特判任何渠道**）：
上游确实没有签到端点的渠道，也照样实现它 —— `status()` 返回 `claimable: false` + 一句**自己的说明**，
`claim()` 原样回同一句；那**不是失败**，也不影响退出码。用户看到的就是那句说明。
各渠道叫法不同（`check-in` / `signin` / 活动 `claim` / 上游自动发），统一收敛成 `status()` + `claim()`
两个动作；`claim()` 必须是幂等的或至少可安全重复调用。
未实现的渠道（桩）保持「立即抛错 + 实现依据指引」的语义。

⚠ **「查不到」不能显示成 0**：失败时抛 `CreditsError`，而不是返回 `remain: 0`。
⚠ 未登录时抛 `cred.NotLoggedInError`。
⚠ 没有额度端点的渠道，抛 `CreditsError("该渠道没有公开的额度查询端点")` 并在 docstring
说明原因 —— 不要伪造数字。

---

## 6. 登录：真实 URL 链路（禁止读本地文件）

登录必须走**渠道自己的真实授权 URL**，由程序解析出 URL 后交给浏览器，再轮询/回调拿令牌。
下面是已验证的三类骨架（`src/cred.ts` 里实现）。**不得**从其它 AI 应用的本地文件
（凭据数据库、`auth.json`、Local Storage 等）读取登录态。

| 类型 | 用法 | 渠道 |
|---|---|---|
| **A. 创建 flow + 轮询** | `POST .../auth/state` 或 `.../oauth/cli/init` → 取 `authorize_url`/`authUrl` → 轮询拿 token | workbuddyai、workbuddy |
| **B. 本地回调服务器** | 起 `http://127.0.0.1:<port>` 回调服务 → 拼授权 URL（含 PKCE/DPoP 等）→ 等浏览器重定向回填 | trae、codearts、lobsterai |
| **C. 设备码 / 扫码轮询** | 申请 device code 或二维码 URL → 轮询 token | cline、loomy、raccoon |

共同要求：

1. **`onUrl(url)` 拿到 URL 后立刻回调**，再 `openBrowser(url)`（打不开浏览器不影响轮询）。
2. **轮询的终态判据**：HTTP 4xx（除 408/429）才是失败；5xx 与网络错误继续重试。
3. **超时**给明确上限，超时抛错并提示重试。
4. 成功即 `save()` 落盘（原子替换 + 0600）。

---

## 7. 测试要求

每个渠道要有 `tests/selftest.test.ts`，用 `node:test`，**照已有渠道写**：

1. **完全离线**：所有上游调用指向本机假服务（`node:http` 起）
2. **不需要真实凭据**：`cred.save()` 写假凭据，存储根用 `MODEL_BRIDGE_HOME` 指向
   `mkdtempSync()` 的临时目录（旧的 `<CID>_HOME` 仍兼容，但已弃用）
3. **import 顺序**：先 `await import("@model-bridge/gateway")`，再
   `await import("../dist/channel.js")`（触发注册），最后引渠道模块
4. **覆盖**：
   - `paths`：存储根覆盖（`MODEL_BRIDGE_HOME`）、`<cid>` 分层、历史目录收拢
   - `catalog`：别名映射、未知名透传、**白名单过滤只作用于呈现层**（`details()` 仍全量）
   - `cred`：未登录抛错、落盘读回、损坏容忍
   - `upstream`：URL 组装、鉴权头、请求体改写的关键字段（对照 `docs/protocols/<cid>/PROTOCOL.md`）
   - **`newTranslator()`（`WIRE === "custom"` 时）**：事件映射、`finish()` 补帧，
     且**必须测逐字节喂入**（切帧 bug 的高发区）
   - **端到端网关**：假上游 + 真实网关，断言流式与非流式都能出正文，
     并核对上游**真实收到**的头与体
   - 错误路径：上游 5xx → 502 且**不回传上游原文**；请求校验 400 统一信封
5. 断言用 `node:assert/strict`；失败即测试失败（不要静默 catch）

**未实现的渠道**（`cred`/`upstream`/`catalog`/`billing` 是桩）必须让每个函数
**立即抛错且消息含「尚未实现 + 实现依据指引」**，而不是返回空值。
测试要锁定这个语义（见 `qoder-bridge/tests/selftest.test.ts`）。

---

## 8. 陈旧构建：改了代码别忘了重启网关

`npm run build` 只更新 `dist/`，**不会**重启已在跑的守护进程 —— 旧进程继续用内存里的
旧代码服务请求。这是本仓库最容易让排查跑偏的坑，因为症状会伪装成「修复无效」。

### 8.1 真实事故（2026-10-08）

1. 用户报「catpaw 登录成功后模型还是不能用」；
2. 排查发现网关进程启动于 `21:29:59`，而相关修复 `21:33` 才编译完 ——
   期间用户几次请求**全打在旧代码上**（日志里还留着早已修掉的 `上游返回 HTTP 500`）；
3. 同时暴露第二个问题：模型名写错（`catpaw/deepseek-v4.1-flash`，catpaw 实际叫
   `deepseek-v4-flash`）被报成 `500 internal_error 网关内部错误` 而不是可读的 400 ——
   进一步把排查引向「网关/登录坏了」。

两者叠在一起，「修复没生效」和「参数写错」看起来一模一样。

### 8.2 机制化防线（**不靠人记**）

`packages/gateway/src/stale-build.ts`：比较**构建产物的最新 mtime**（工作区内各
`packages/*/dist`、`channels/*/dist` 下的 `.js`）与**守护进程启动时刻**
（pid 文件的 mtime，`start` 亲手写的那一刻，等价且零平台依赖）。

- `model-bridge status`：命中时打印
  `⚠ 网关在跑旧代码：构建产物 <t1> 比进程启动 <t2> 新。跑 model-bridge restart …`；
  `status --json` 里是 `stale_build: true`
- `model-bridge start`：**「已在运行」分支**也要检查 —— 那正是「改完 build 再来 start
  被拦下、用户以为已经启动好了」的漏点

只**报告**、不自动重启：是否重启由用户决定（自动重启会打断正在服务的会话）。

### 8.3 agent 的操作规则

改完共享层/渠道代码并 `npm run build` 后，**主动 `restart` 再验证**；
涉及登录链路/上游协议的改动必须走一次真机验证（`<cid> login` → `status` → 一次真实对话）。

---

## 9. 交付检查清单

- [ ] `src/` 只有 7 个文件；无共享模块副本残留
- [ ] `package.json` 的 `dependencies` 只含 `@model-bridge/gateway`
- [ ] `channel.ts` 用 `setChannel()` 注册了 `BridgeConfig` + 4 个模块
- [ ] `catalog.ts` 调用共享 `isAllowedFamily()`，未自行实现家族判据
- [ ] 登录是真实 URL 链路，未读取其它应用的本地文件
- [ ] `npm install && npm run build` 无错误（`tsc -b`，严格模式；各包 `extends` 根 `tsconfig.base.json`）
- [ ] `node --test tests/selftest.test.ts` 全绿
- [ ] 全仓验证：`npm run build && npm test` 退出码 0（根 `tsconfig.json` 为 solution 文件，一次 `tsc -b` 编全仓）
- [ ] README 更新为 TypeScript 安装/使用说明，并指向 `docs/protocols/<cid>/PROTOCOL.md`
- [ ] `docs/protocols/<cid>/PROTOCOL.md` 保留（协议规格，实现的依据）
