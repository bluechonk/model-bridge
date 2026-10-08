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
├── channels/                     ← 12 个渠道（每个 = 一个模型池 + 账号池）
│   └── <cid>/                    ← 结构见下
├── packages/cli/                 ← **仓库级入口**（bin `model-bridge`）
│   └── src/
│       ├── channels.ts           ← import 全部 12 个渠道包（副作用 = setChannel）
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
> 多渠道路由下对外模型 id 是 `<cid>/<模型>`（如 `workbuddy/deepseek-flash`）；
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
  cid: string;                 // 渠道 id，如 "zcode"（日志前缀、服务名、CLI 名、**存储分层名**）
  display: string;             // 展示名，如 "ZCode"
  version: string;             // CLI 版本号
  defaultAddr: string;         // 网关默认监听地址，如 "127.0.0.1:8803"
  uiPort: number;              // 控制台 API 默认端口
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

白名单是**网关级策略**，放在共享层，一次改动覆盖全部渠道：

```ts
export const FAMILY_ALLOWLIST: RegExp[] = [/flash/i];
```

- **只放行 flash 家族，大小写不敏感**（`/flash/i` 用宽匹配：模型名里 flash 常靠连字符
  或大小写混排 —— `M3.1-Flash-Preview`、`glm-5.3-flash`、`sn-deepseek-v4-1-flash`）。
- 判据同时看 **id 与展示名**（`isAllowedFamily(id, name, slug)`）：某些渠道的家族信息
  只在展示名里（如 Qoder 的 `dfmodel`）。
- **过滤只发生在呈现层**：被挡在池外的模型**仍保留在目录里**（`catalog.details()` 可见），
  数据不丢。各渠道的 `resolveModel()` 对这些 id 仍能正常解析。
- 想放行全部模型：把 `FAMILY_ALLOWLIST` 置为 `[]`。
- 临时排查：设 `BRIDGE_ALLOW_ALL_MODELS=1` 绕过白名单（不改代码）。

> ⚠ 各渠道 **不要**在自己的 `catalog.ts` 里再实现一遍家族过滤。`exposedIds()`
> 只需调用共享的 `isAllowedFamily()`，被判据覆盖的完整条目仍从 `details()` 给出。

---

## 5. 渠道特有模块的接口契约

共享层的 `gateway.ts` / `headless.ts` / `daemon.ts` / `auth-flow.ts` 按下面这套接口
调用渠道模块。**实现渠道时只要满足这些签名，网关就能工作。**

> 类型定义在 `packages/gateway/src/channel.ts`（`CredModule` / `UpstreamModule` /
> `CatalogModule` / `BillingModule`）。凭据/配置的具体形态各渠道不同，故这些位置用
> `any` —— 共享层只在**结构**上依赖它们，不做跨渠道的类型统一（那会在 11 个异构
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
```

⚠ **兜底表是必需的**：未登录或上游目录失败时用户仍应看到模型（否则渠道在选择器里
凭空消失，用户以为插件坏了）。
⚠ 调用共享的 `isAllowedFamily()` 做池过滤，**不要自行实现家族判据**（见 §4）。
⚠ 但**不要列出实测用不了的模型** —— 用户选中后拿到空回答，而错误指向「模型」
而非真实原因，比不列更糟（ZCode 的 `GLM-5-Turbo` 就是这种情况，已从目录移除）。

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
```

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
| **A. 创建 flow + 轮询** | `POST .../auth/state` 或 `.../oauth/cli/init` → 取 `authorize_url`/`authUrl` → 轮询拿 token | workbuddy、zcode |
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
测试要锁定这个语义（见 `minimax-bridge/tests/selftest.test.ts`）。

---

## 8. 交付检查清单

- [ ] `src/` 只有 7 个文件；无共享模块副本残留
- [ ] `package.json` 的 `dependencies` 只含 `@model-bridge/gateway`
- [ ] `channel.ts` 用 `setChannel()` 注册了 `BridgeConfig` + 4 个模块
- [ ] `catalog.ts` 调用共享 `isAllowedFamily()`，未自行实现家族判据
- [ ] 登录是真实 URL 链路，未读取其它应用的本地文件
- [ ] `npm install && npm run build` 无错误（`tsc` 严格模式）
- [ ] `node --test tests/selftest.test.ts` 全绿
- [ ] 全仓验证：`npm run build --workspaces --if-present && npm run test --workspaces --if-present` 退出码 0
- [ ] README 更新为 TypeScript 安装/使用说明，并指向 `docs/protocols/<cid>/PROTOCOL.md`
- [ ] `docs/protocols/<cid>/PROTOCOL.md` 保留（协议规格，实现的依据）
