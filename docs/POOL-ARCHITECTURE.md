# 池化架构：模型池 + 账号池（工作区 `model-bridge`）

本文件回答「仓库级插件 + 渠道即池子」这一形态转变下的公共层设计，并给出
**账号池要不要现在做**的结论与顺序。实现契约仍见 `CONTRACT-TS.md`，落点见
`STORAGE-CONVENTION.md`。

---

## 0. 结论：账号池现在「定形」，不实现

| | 现在 | 理由 |
|---|---|---|
| 接口签名（`CredModule` 的池子方法） | **定** | 改签名要动 11 个渠道 + 共享层调用点 |
| 存储布局（`accounts/` + 索引） | **定** | 布局是最贵的一类改动：**刚统一完存储，不想再迁一次** |
| 对外模型 id 形态 | **已定案**：两个公共模型（2026-10-08 定案，后收窄，见 §2） | 客户端不再关心渠道；早期 `<cid>/<模型>` 形态已移除 |
| 池子策略（轮换 / 失败转移 / 健康度） | **已落地**（账单已用量排序 + 失败冷却，见 §2.3） | 排序源是账单已用量，落盘缓存 |

一句话：**先定「形状」（接口、目录、id），后做「策略」。** 形状晚定，就要连带重做存储迁移
与调用点改造；策略晚做只是少个功能。

### 0.1 实施进度（2026-10-08）

| 步骤 | 状态 |
|---|---|
| 1. 注册表多渠化 + `paths` 按 cid 参数化 |  已落地 |
| 2. 网关路由 + `/v1/models` |  已落地；**2026-10-08 改版**：对外只剩公共模型（原 `<cid>/<模型>` 形态已移除，见 §2） |
| 3. 账号池「形状」落地（`accounts/`） |  已落地（`account-pool.ts` + `model-bridge accounts`；实际结构见 §3.4） |
| 4. 插件收敛（仓库级 `plugins/model-bridge/`） |  已落地：**一个**插件（单份清单、一套 `model-bridge-*` 命令、一个技能、一个 hook）+ 工作区根 `marketplace.json`；11 个 bridge 各自的 `plugins/` + `marketplace.json` + `.claude-plugin/` 三层配置已移除 |
| 5. **公共模型池（跨渠道两个模型 + 账单额度排序）** |  已落地（`pool-targets.ts` / `pool-usage.ts`；见 §2） |
| 6. 账号池策略层（AA 选择 / 跨渠道上下架） | ⏳ 未开始（渠道内的 401/403 换号早已在跑，见 §3.3） |

落地时新增的两块公共层（方案里没预写、但实施时发现必须）：

- **渠道上下文**（`channel-context.ts`）：渠道模块内部的 `paths.*` 调用必须知道「现在为哪个
 cid 干活」。用 `AsyncLocalStorage` 而非模块级变量 —— `cred.refresh()` / `login()` 这类异步
 链路中间有 await，模块级变量会被并发请求互相踩（A 在刷 token 时切到 B 的渠道，
 A 就可能把凭据写进 B 的目录）。共享层在**每一次调用渠道模块前**包一层 `runInChannel(cid, fn)`。
- **仓库级入口包**（`packages/model-bridge`，bin `model-bridge`）：共享包按契约不 import 任何
 渠道模块，所以「注册全部渠道」这件事必须有一层独立存在。它只做一件事：`import` 11 个渠道包
 （副作用即 `setChannel`）→ 交给共享 CLI。新增渠道 = 在那里加一行 import。

---

## 1. 形态改变：仓库即插件，渠道即池子

- **一个插件**：`plugins/model-bridge/` —— 一个 marketplace 条目、一个 CLI（`model-bridge`）、
 一个 hook、一个网关进程。渠道不再各自成插件。
- **渠道的新角色**：不是「一个网关」，而是**一个池子**。
 - **模型池**：该渠道能提供哪些模型（= 现有 `catalog` + 白名单 `FAMILY_ALLOWLIST = [/flash/i]`）。
 - **账号池**：该渠道背后有几个账号（现状：只有 1 个）。
- **对外形态**：一个 base URL（`http://127.0.0.1:8787/v1`）+ **两个公共模型 id**
 （`deepseek-v4.1-flash` / `glm-5.3-flash`）。客户端只写模型名，
 落到哪家渠道由网关自己挑 —— 见 §2。

>  早期设计的 `<cid>/<模型>` 形态（ZCode 里配 `trae/deepseek-v4.1-flash` 那种）
> **已移除**：带 `/` 的模型名现在一律 `400 unknown_model`。

---

## 2. 公共模型池：跨渠道的两个模型

网关对外**只有两个模型**，与「这些模型来自哪个渠道」无关：

| 对外 id | 候选渠道 | 各家目录里的写法（归一化后命中，实测示例） |
|---|---|---|
| `deepseek-v4.1-flash` | cline、codearts、raccoon、workbuddy、workbuddyai | `deepseek-v4.1-flash`（codearts / workbuddy / workbuddyai）、`sn-deepseek-v4-1-flash`（raccoon）、`deepseek/deepseek-v4.1-flash`（cline） |
| `glm-5.3-flash` | catpaw、cline、codearts、lobsterai、loomy、qoder、qodercn、raccoon | `glm-5.3-flash`（catpaw / codearts / lobsterai）、`GLM-5.3-Flash`（loomy）、`sn-glm-5-3-flash`（raccoon）、`gfmodel`（qoder / qodercn，展示名 `GLM-5.3-Flash`） |

> `deepseek-v4-flash`（4.0，早期池内模型）**已移出池**：各渠道上游目录里仍有它
> （catpaw / codearts / lobsterai 的 `deepseek-v4-flash`、trae 的 `DeepSeek-V4-Flash`、
> loomy 的 `deepseek-v4-flash-0731`），经渠道 CLI 仍可用，只是不再作为对外模型、
> 也不出现在 `/v1/models`。**`trae` 因此不再贡献任何池内模型。**

来源：`packages/gateway/src/pool-targets.ts`（目标与匹配）、`pool-usage.ts`（账本与排序）。

### 2.1 匹配 = 归一化 + 精确相等

各渠道目录的命名完全不同，所以池层先归一化（`canonicalModelId`）：

1. 取 `/` 最后一段（去 `deepseek/`、`z-ai/` 这类厂商前缀）
2. 全小写
3. 去渠道包装前缀（`sn-`）
4. 「数字-数字」的连字符转点：`v4-1` → `v4.1`、`5-3` → `5.3`
5. 去尾部修饰：`-official`、`-<4位数字>`、`-latest`

然后与两个目标名做**精确相等** —— 用包含匹配的话，`glm-5.3-flash` 会把
`glm-5.3-flashx` 一起捞进来，精确相等是唯一的隔离保证。

客户端请求名**不做**第 1 步：带 `/` 的旧形态一律判为未知 —— 这是刻意的破坏性更新，
否则 `随便什么前缀/deepseek-v4.1-flash` 会被剥成池内 id 而蒙混命中。

**不进池的**：`deepseek-v4-flash`（4.0，已移出池）、`glm-5.3-flashx`、
`deepseek-v4-flash-vision-exp`、无版本号的 `deepseek-flash`。
它们仍在渠道自己的目录里（渠道 CLI 仍可直接调用），只是不出现在 `/v1/models`。

### 2.2 排序：账单已用量（失败当 0）

同一模型有多家渠道能提供时，**落到谁**由账本决定：

- 排序键 = 渠道的**账单已用量**（`CreditsResult.total.used`）降序；
- 失败的渠道进入冷却（默认 60 秒），冷却期内得分**当 0** —— 即「请求失败的直接当为 0」；
- 同分保持渠道注册顺序（`poolCandidates` 的返回序）；一次请求最多试 3 个候选
 （`BRIDGE_POOL_MAX_TRIES` 可覆盖）。

上游账单**没有「请求次数」**这种字段，只有额度（积分 / credits / 美元，各家单位不同）——
所以跨渠道横比是**近似**的。这是刻意的取舍：换来零额外网络开销 + 跨渠道统一口径。

### 2.3 账本落点与刷新节奏

`<root>/pool-usage.json`（**根级共享文件**，不属于任何渠道）：

```json
{ "version": 1, "channels": {
   "codearts": { "used": 17, "size": 100, "remain": 83, "unit": "credits",
                 "billing_at": "2026-10-08T…", "billing_ok": true,
                 "ok": 12, "fail": 0, "cooldown_until": 0 } } }
```

- 账单**一天刷两三次**（TTL 8 小时）：网关启动时、以及 TTL 到期后的下一次请求，
 在**后台**异步刷新（`maybeRefreshBilling`），绝不阻塞正在处理的请求。
- 手动刷新：`model-bridge model usage --refresh`。
- 账单查询失败只更新尝试时刻、**保留上一次的用量数字**（不把账清零，也不用 0 冒充）。

### 2.4 路由与失败转移

1. **收集候选**：遍历全部已注册渠道，各自目录里归一化命中该模型的即候选。
2. **依次尝试**：每个候选**单独建请求体** —— 上游 slug 与渠道一一对应（TRAE 认
  `DeepSeek-V4-Flash`，不认全小写），且 `catpaw` 的 `prepareChat` 有建会话副作用，
  只能在轮到它时才执行。
3. **只在「上游响应头到达之前」转移**：一旦开始转发就不能换渠道（响应头已发给客户端，
  换渠道会变成两个响应）。
4. **全部候选失败** → 返回最后一个错误的语义（鉴权类 503/502，其余 502）。

账号池的 401/403 换号仍在**渠道内部**先跑完（见 §3.3），池层只在「这个渠道整体不可用」时接管。

#### 非标准状态码的鉴权失败（`isAuthFailure`）

有些上游不用 401/403 表达凭据失效 —— 如 codearts 的 APIG 网关对过期 token 回
`HTTP 400 + {"error_code":"APIG.0602"}`。渠道声明 `upstream.isAuthFailure(status, body)`
后，共享层在收到 **4xx 且非 401/403** 的响应时问一次该钩子；返回 true 就归一成 401，
走既有的「刷新 token → 换池内账号」链路。未声明的渠道行为不变。

#### 排队帧退避重试（`isQueueError`）

有些上游过载/排队时**不拒绝连接**，而是回 HTTP 200 + SSE 里投递一个业务错误帧
（qoder / qodercn 的 `code:"10605"` + `retryAfterSeconds`）。渠道声明
`upstream.isQueueError(frame)` 后，共享层在**尚未向客户端写出任何字节**时消费上游流做探测：

- 翻译器逐帧处理：内容帧 → 立即停止（已有实质输出，不能再重试）；
  错误帧 → 问 `isQueueError`：是排队就记下延迟继续等，否则**记下来交回转发/回报**（不能吞）；
- 排队帧 → 按 `retryAfterSeconds`（封顶 10s）等待后**重开上游**（同一请求体、重新取凭据）；
- 总时长上限 5 分钟（含首次尝试与所有等待）；耗尽仍无内容 → 流式给 error 帧、
  非流式给 503 `upstream_queued`；
- 探测阶段已消费的帧**按原序补写**给客户端再续传剩余流，不丢前缀；探测用的**翻译器实例
  也一并与转发层共享**（它的行缓冲里可能还有半行）。

⚠ 这是**请求级**的等待重试（单活跃账号模型下的简化形态）；参考实现里的账号轮换冷却
（多账号场景）不在本仓库范围（账号池定形不实现，见 §3）。

**三个易踩的坑（真机踩过，均有回归测试锁死）**：

1. **排队信号可能裹在非 200 信封里**。实测 qoder 排队回的是
   `statusCodeValue:403` + `body={"code":"403","message":"{\"code\":\"10605\",…\"isQueued\":true,\"retryAfterSeconds\":30}"}`——
   内层才是真正的排队载荷。翻译器若对「非 200」直接短路成通用文案，会把 10605 丢掉，
   `isQueueError` 永远判不出排队，重试就不触发。所以翻译器对非 200 信封要**先解析 body 保真内层
   code/message**，取不到才退回通用文案。
2. **非流式不能二次探测同一条流**。探测会推进流的位置；若转发层再探一次，第一次吞掉的
   帧就丢了，聚合结果退化成空 completion（`content:""`、usage 全 0、`finish_reason:"stop"`）。
   因此探测只在路由层做一次，转发层只把探测结果（前缀内容帧 / 错误帧）与流剩余部分拼起来聚合；
   遇到「有错误帧但零内容」明确报 502，而不是回空 completion。
3. **探测退出点一个帧都不能丢**（两个丢帧向量，症状：tool_call 参数 JSON 中间缺段 → 客户端
   报 `model.tool_input.normalize_failed` / Bash 参数语法错误）：
   a) 一个 TCP 块里常有**多帧**，探测在第一个内容帧处返回时，同块**剩余帧**必须一并收走；
   b) 翻译器的行缓冲里可能留着**半行**（跨块的帧前缀），转发层必须**接着用同一个翻译器实例**，
   换新实例会让残行收尾时解析失败、整帧被丢。
   实测 `AAACCC`（丢了 `BBB`）就是这两个向量的产物。

### 2.5 看池子用哪个命令

| 命令 | 看什么 |
|---|---|
| `model-bridge model list` | **池视图**：两个模型，各自挂出候选渠道 + 已用量 + 冷却状态（顺序就是实际路由顺序） |
| `model-bridge model show <cid>` | **渠道视角**：该渠道贡献了池内哪些模型 |
| `model-bridge model usage [--refresh]` | 看账本；`--refresh` 立刻重查各渠道账单额度 |
| `model-bridge channels` | 同「渠道视角」，覆盖全部渠道 |
| `model-bridge model refresh [cid]` | 重拉上游**目录**（与「刷账单」是两件事） |

> 单渠道独立运行（`channels/<cid>/dist/cli.js start`）**也走池**：`/v1/models` 同样是那两条，
> 只是候选渠道只有一个（提供不了的模型请求时回 503）。

---

## 3. 账号池（定形，不实现）

### 3.1 目录布局（现在定）

```
<root>/<cid>/
├── credentials.json        ← 「当前生效账号」的兼容镜像（现有代码零改动）
├── accounts.json           ← 索引：账号列表 + 当前选中 + 每账号元信息
└── accounts/
   └── <account-key>.json  ← 单账号凭证（account-key = 稳定账号标识）
```

- **为什么保留 `credentials.json`**：11 个渠道的 `cred.load()/save()`、插件命令、以及刚统一的
 `paths` 全都依赖它。保留 = 零改动兼容，池子新增的 `accounts/` 承载多账号。
- `accounts.json` 每条的元信息建议：`key` / `uid` / `nickname` / `domain`（realm）/ `expires_at` /
 `last_used` / `health`（ok / unauthorized / quota）。
- `account-key` 用渠道已有的稳定标识派生（各渠道现在都有自己的 uid 兜底策略：
 JWT sub / `sha256(token)[:16]` / `accountId` ……），**不要用递增序号**（重登会串号）。

### 3.2 接口（现在定，方法**可选**）

```ts
interface CredModule {
 load(): any;                       // 现状语义不变：当前生效账号
 save(c: any): Promise<void>;       // 现状语义不变：写当前生效账号

 // ↓ 池子扩展：可选实现，共享层用 hasAccountPool() 探测后启用
 listAccounts?(): AccountSummary[];
 loadAccount?(key: string): any;
 setActiveAccount?(key: string): Promise<void>;
 refreshAccount?(key: string): Promise<any>;
}
```

这样：现在 11 个渠道一个都不实现，模型池照常工作；将来某个渠道实现了，池子能力自动生效。

### 3.3 策略（以后做，先记下要解决什么）

- **选择**：当前选中 / 轮询 / 最久未用。
- **失败转移**：401 → 换账号；429 或额度耗尽（上游返回的额度码）→ 换账号。
- **退避与健康度**：坏账号要能被标记并冷却，否则一个坏账号会吃光重试预算。
- **与 realm 共存**：workbuddy 有 intl/cn 两域，一个账号属于一个域；账号切换 = 可能连 base url 一起切。

---

### 3.4 实际结构（已实现）

```
<root>/<cid>/
├── credentials.json          当前生效账号（渠道的 cred.load() / save() 语义不变）
├── accounts.json             索引：账号列表 + 当前选中 + 元信息
└── accounts/<key>.json       单账号凭证（与 credentials.json 同构）
```

`accounts.json`：

```json
{
 "version": 1,
 "active": "c8d6714b701aa7c3",
 "accounts": [
   {
     "key": "c8d6714b701aa7c3",
     "uid": "ad58938a-0eda-4573-b3d6-ce733130442a",
     "domain": "www.workbuddy.ai",
     "label": "bluechonk",
     "added_at": "2026-10-08T10:00:48.647Z",
     "last_used_at": "2026-10-08T10:00:49.109Z",
     "expires_at": null,
     "health": "ok",
     "health_at": "2026-10-08T10:00:48.647Z"
   }
 ]
}
```

规则（`account-pool.ts`）：

- **`key = sha256(domain\0uid)[:16]`** —— 稳定（重登不变）、文件名安全（全小写 hex，
 过得了 `paths.channelFile` 的校验）。uid 为空的渠道退化为按 token 派生（那类渠道重登会得到新
 key，属已知限制）。
- `label` / `expires_at` 是**尽力而为的展示字段**（取不到就空 / `null`），不参与任何判据。
- `health`：`ok` | `unauthorized` | `unknown`。由**网关**在刷新失败时写 `unauthorized`、
 请求成功时写 `ok`；同值短路（进程内缓存），稳态下不产生额外 I/O。
- **共享层不解析渠道磁盘格式**：只做「复制文件 + 记下 `cred.load()` 的契约字段 uid/domain」，
 所以 11 个渠道**零改动**就支持账号池。
- **同步按身份，不按时间**：`credentials.json` 变新时先比 `accountKey` —— 同一账号 → 回灌池内
 那份（渠道 `refresh()` 只写 live 文件）；不同账号 → 收成新账号并设为 active。
 > 实现时踩过：只看 mtime 回灌，会在「换账号登录」时把旧账号的池内文件覆盖成别人的凭证。
- **切换** = 把 `accounts/<key>.json` 复制回 `credentials.json` + 更新 `active`（不用重新授权）。
- **删除生效账号 = 同时登出**（删 `credentials.json`），否则下次同步会把它又收回来；
 删除非生效账号不动 live 文件。
- 权限：`accounts/` 0700、其中文件 0600（`enforcePermissions` 递归一层）。

命令入口与自动化时点：

| 入口 | 行为 |
|---|---|
| `model-bridge accounts`（`--channel` / `--json`） | 列出池子；**首次查看会把已登录的凭证自动收进池子** |
| `model-bridge accounts add --channel <cid>` | 走渠道自己的登录流程（浏览器授权）→ 成功后入池并设为生效 |
| `model-bridge accounts use <key>` | 切换生效账号 |
| `model-bridge accounts remove <key>` | 从池子删除（生效账号 → 同时登出） |
| `login` 成功后 / 守护 `start` 前 | 自动同步（登录即入池；刷新过的 token 回灌） |

**未实现（策略层，见 §3.3）**：一个渠道内多账号的轮询 / 失败转移 / 配额耗尽自动换号。

## 4. 「先完成公共层」的具体含义

公共层要完成三件事，才有「仓库级插件」：

### 4.1 注册表：单槽 → 多槽（已落地）

原状：`setChannel()` 是进程级单例，`getChannel()` 未注册就抛错；共享层有 **30 处**
`getChannel()` 调用点（`gateway` / `daemon` / `headless` / `console` / `sse-stream` /
`auth-flow` / `paths` / `cli` / `cli-consts` / `report`），全部假设「一个进程一个渠道」。

落地后的 API（**保留了 `setChannel` 签名**，11 个渠道一行都没改）：

```ts
setChannel(channel: Channel): void;   // 按 config.cid 存进注册表（同 cid 重复注册即替换）
channels(): Channel[];                // 全部已注册
channelFor(cid: string): Channel;     // 指定 cid，未注册抛错
channelCount(): number;               // 1 = 单渠道模式
clearChannels(): void;                // 仅供测试
getChannel(cid?: string): Channel;    // 省略 cid：仅当恰好注册 1 个渠道时返回它（单渠道兼容）
hasChannel(cid?: string): boolean;
```

配套：`paths` 全部函数加**可选 `cid`**（`channelDir(cid)`、`credentialsPath(cid)`、`pidPath(cid)`…），
省略时按「渠道上下文 → 唯一渠道」解析。现有 11 个渠道与全部既有测试**无需同步修改** ——
这条渐进策略是本次改造能一次通过 470 项测试的关键。

### 4.2 路由层（已落地）

- `/v1/chat/completions`：**池路由** —— 客户端只给两个池模型 id，落到哪家渠道由网关按账本挑
 （见 §2.2 / §2.4）。早期按 `<cid>/` 前缀选渠道的做法**已移除**。
- `/v1/models`：恒两个公共模型（见 §2）。
- `/health`：报告**整体**状态 + 每个渠道一行（登录/池子/是否上架），而不是单个渠道。

### 4.3 进程与入口收敛（部分落地）

现状：11 个渠道各有 `defaultAddr` / `uiPort` 与各自的守护进程（仓库级网关不用它们，见上文）。

目标：仓库级插件只跑**一个**网关进程 + **一个**控制台端口；各渠道的 bin 保留为
「单渠道独立运行」的调试入口（不删，但不再是主路径）。插件只挂一个 hook、暴露一个 CLI
（子命令用 `--channel <cid>` 选渠道）。

已落地：

- **`--channel <cid>`**：共享 CLI 的所有子命令都支持；省略时按「单渠道模式 / 仓库级」解析。
- **守护进程的「范围」**：渠道级（显式 `cid` 或只注册 1 个渠道）用渠道层文件
 `<root>/<cid>/gateway.pid|gateway.log|prefs.json`；**仓库级**（多渠道路由、未指定 cid）
 用根级 `<root>/gateway.pid|gateway.log|prefs.json` —— 一个服务多池的进程不属于任何单个渠道。
- **仓库级默认端口**：多渠道路由时用 `REPO_DEFAULT_ADDR = 127.0.0.1:8787` /
 `REPO_DEFAULT_UI_PORT = 8788`（与 ZCode 里既有 provider 一致），而不是取某个渠道的端口。
- **修掉一个潜伏 bug**：`daemon.start` 原本 spawn **共享包的 `cli.js`**，而那个文件只是一组
 导出、没有自带入口调用 → 守护进程起来立刻退出（TS 版 `start` 一直是坏的）。现在改为重跑
 **当前进程的入口**（`process.argv[1]`），任何入口（单渠道 bin / 仓库级 bin）都自洽。
- **服务身份**：单渠道 = `<cid>-bridge`；多渠道路由 = `model-bridge`。守护进程探测时接受
 「本进程认得的全部身份」，所以单渠道的 `status` 也认得多渠道路由的网关。
- **`channels` / `model list` 子命令**：前者是**渠道视角**（每个渠道贡献了池内哪些模型），
 后者是**池视图**（两个模型各自会落到哪家、账本用量与冷却）。
- **仓库级 CLI 已可用**：`packages/model-bridge`（bin `model-bridge`）。
- **插件收敛已完成**：`<工作区>/plugins/model-bridge/`（单插件）+ `<工作区>/marketplace.json`（单条目）。
 各 bridge 的 bin 保留为「单渠道独立运行」的调试入口，但不再各带一套插件。
 未动：`.hermes-plugin/`（Hermes 侧的另一套集成，不在本次范围）。
