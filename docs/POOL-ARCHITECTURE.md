# 池化架构：模型池 + 账号池（`modelmux`）

本文件回答「一个 CLI + 渠道即池子」形态下的公共层设计，并给出
**账号池要不要现在做**的结论与顺序。实现契约仍见 `CONTRACT-TS.md`，落点见
`STORAGE-CONVENTION.md`。

---

## 0. 结论：账号池现在「定形」，不实现

| | 现在 | 理由 |
|---|---|---|
| 接口签名（`CredModule` 的池子方法） | **定** | 改签名要动全部渠道 + 共享层调用点 |
| 存储布局（`accounts/` + 索引） | **定** | 布局是最贵的一类改动：**刚统一完存储，不想再迁一次** |
| 对外模型 id 形态 | **已定案**：`<cid>/<模型>` 池 id（2026-10-17 定案，见 §2） | 客户端用渠道前缀显式选池子 |
| 池子策略（轮换 / 失败转移 / 健康度） | **已落地**（账单已用量排序 + 失败冷却，见 §2.3） | 排序源是账单已用量，落盘缓存 |

一句话：**先定「形状」（接口、目录、id），后做「策略」。** 形状晚定，就要连带重做存储迁移
与调用点改造；策略晚做只是少个功能。

## 1. 形态：一个 CLI，渠道即池子

- **一个 CLI**：`mx`（bin `modelmux` 全名等价）—— 一个网关进程、一个入口；
  早期 per-channel 插件形态已全部移除（2026-10-13）。
- **渠道的新角色**：不是「一个网关」，而是**一个池子**。
 - **模型池**：该渠道能提供哪些模型（= 现有 `catalog` + 两道闸门白名单 `(deepseek|glm)` + `flash`，见 `CONTRACT-TS.md` §4.2）。
 - **账号池**：该渠道背后有几个账号（现状：只有 1 个）。
- **对外形态**：一个 base URL（`http://127.0.0.1:4412/v1`）+ **`<cid>/<模型>` 池 id**
 （`loomy/kimi-k2.6` 这种）。客户端用渠道前缀显式指定渠道；
 渠道内部的账号池轮换照旧 —— 见 §2。

>  2026-10-17 前的「无前缀 + 账本决定落到谁」形态**已被取代**：
> 裸模型名（不带渠道前缀）现在一律 `400 unknown_model` —— 渠道选择权在请求方手里。

---

## 2. 公共模型池：`<cid>/<模型>` 池 id（全渠道模型并集）

网关对外暴露**全部渠道 `catalog` 归一化后的模型**，每个 id 挂上渠道前缀：

```
/v1/models = ⋃ 各渠道 exposedIds()  →  归一化（小写、版本号点号、去 `-official`/日期/`-latest`、剥厂商路径段）  →  渠道内去重  →  <cid>/<模型>  →  排序
```

历史：早期只放行 `(deepseek|glm) × flash` 两个家族 → 放宽为全池 →
2026-10-17 起 id 挂渠道前缀（此前「不带前缀、账本决定落到谁」的形态废弃）。
上游目录里有什么就对外暴露什么（各渠道的 kimi / qwen / MiniMax / 豆包 / 盘古 等型号同样进池）。

**归一化只作用于前缀之后的模型段**（渠道 id 原样；模型段收敛各渠道的不同写法）：

| 渠道 | 目录里的原始写法（实测） | 对外池 id |
|---|---|---|
| raccoon | `sn-deepseek-v4-1-flash` | `raccoon/deepseek-v4.1-flash` |
| traecn | `DeepSeek-V4-Flash-Official` | `traecn/deepseek-v4-flash` |
| loomy | `deepseek-v4-flash-0731` | `loomy/deepseek-v4-flash` |
| qoder / qodercn | `gfmodel`（按展示名归一） | `qoder/glm-5.3-flash` |

**跨渠道不合并**：`catpaw/glm-5.3-flash` 与 `raccoon/glm-5.3-flash` 是两个独立 id ——
同名模型用哪家渠道，由请求方写前缀决定。

> 过滤只由**渠道自己的目录**决定：隐藏条目（`hidden` / `visible === false`）、
> 官方「自定义模型」占位（`custom_model_*`）、上游标记不可用的通道会被各渠道排除，
> 共享层不再做家族闸门。`traecn` 的隐藏条目与 `custom_model_*` 同样不出现在 `/v1/models`。

来源：`packages/core/gateway/src/pool/pool-targets.ts`（目标与匹配）、`pool-usage.ts`（账本与排序）。

### 2.1 匹配 = 归一化 + 精确相等

各渠道目录的命名完全不同，所以池层先归一化（`canonicalModelId`）：

1. 取 `/` 最后一段（去 `deepseek/`、`z-ai/` 这类厂商前缀）
2. 全小写
3. 去渠道包装前缀（`sn-`）
4. 「数字-数字」的连字符转点：`v4-1` → `v4.1`、`5-3` → `5.3`
5. 去尾部修饰：`-official`、`-<4位数字>`、`-latest`

然后做**精确相等**匹配 —— 用包含匹配的话，`glm-5.3-flash` 会把
`glm-5.3-flashx` 一起捞进来，精确相等是唯一的隔离保证。

客户端请求名走同一条归一化路径（渠道归属由**第一个 `/`** 显式声明，模型段再剥厂商路径
不会串渠道）；裸模型名（无 `/`）判为格式错误，一律 `400 unknown_model`。

渠道目录里的一切条目都对外暴露（全池）；请求时该渠道目录里没有的模型回
`400 unknown_model`（渠道没货，换渠道是客户端的决定），登录态问题回 `503`。

### 2.2 账本：观察渠道健康度（不再决定路由）

账本（`pool-usage.json`）仍按渠道记录账单已用量与 ok / fail 计数，但**不再决定请求去向**
—— 渠道由 `<cid>/` 前缀显式指定。它现在的用途：

- `mx model list` / Web 控制台展示渠道健康度（已用量、冷却、连败）；
- 失败冷却仍然生效：刚失败的渠道**下一次请求**会被短暂排除（冷却只是短暂状态，
  全部候选都在冷却时回退为照常尝试），避免对已知不可用的渠道白打一轮。

上游账单**没有「请求次数」**这种字段，只有额度（积分 / credits / 美元，各家单位不同）——
账本数字只作健康度参考，不作路由依据。

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
- 手动刷新：`mx model usage --refresh`。
- 账单查询失败只更新尝试时刻、**保留上一次的用量数字**（不把账清零，也不用 0 冒充）。

### 2.4 路由与失败转移

1. **解析**：`<cid>/<模型>` → 渠道段（大小写不敏感）+ 模型段（归一化）；
   渠道未注册 / 目录未命中 → `400 unknown_model`。
2. **单候选尝试**：渠道已由请求方指定，候选**至多一条**；请求体由该渠道单独构建
   —— 上游 slug 与渠道一一对应（TRAE 认 `DeepSeek-V4-Flash`，不认全小写），
   且 `catpaw` 的 `prepareChat` 有建会话副作用，只能在轮到它时才执行。
3. **只在「上游响应头到达之前」重试**：一旦开始转发就不能换请求（响应头已发给客户端）。
4. **渠道内部**先跑完 401/403 的「刷新 token → 换池内账号」（见 §3.3）；
   全部尝试失败 → 返回最后一个错误的语义（鉴权类 503/502，其余 502）。

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

注意：这是**请求级**的等待重试（单活跃账号模型下的简化形态）；参考实现里的账号轮换冷却
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
| `mx model list` | **池视图**：对外模型（`<cid>/<模型>`）+ 各渠道账本状态（健康度观察，不再表示路由顺序） |
| `mx models <cid>` | **渠道视角**：该渠道对外暴露哪些模型（`--refresh` 重拉上游目录） |
| `mx model usage [--refresh]` | 看账本；`--refresh` 立刻重查各渠道账单额度 |

> 单渠道独立运行（`packages/core/channels/<cid>/dist/cli.js start`）**也走池**：
> `/v1/models` 同样是 `<cid>/<模型>` 形态，只是候选渠道只有一个。

---

## 3. 账号池

> 设计记录 + 已实现结构：§3.1/§3.2 是当时「定形不实现」的决策；§3.4 是后来落地的实际结构；
> §3.3 的轮换/失败转移策略仍未实现。

### 3.1 目录布局（现在定）

```
<root>/<cid>/
├── credentials.json        ← 「当前生效账号」的兼容镜像（现有代码零改动）
├── accounts.json           ← 索引：账号列表 + 当前选中 + 每账号元信息
└── accounts/
   └── <account-key>.json  ← 单账号凭证（account-key = 稳定账号标识）
```

- **为什么保留 `credentials.json`**：全部渠道的 `cred.load()/save()`、CLI 命令、以及刚统一的
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

这样：现在全部渠道一个都不实现，模型池照常工作；将来某个渠道实现了，池子能力自动生效。

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

`accounts.json`（示例值为**占位**，禁止放真实账号信息 —— 见 `CONTRACT-TS.md` §7 的测试红线）：

```json
{
 "version": 1,
 "active": "0123abcd4efd5678",
 "accounts": [
   {
     "key": "0123abcd4efd5678",
     "uid": "1b2f4d3e-5a67-4c89-9d01-2e3f4a5b6c7d",
     "domain": "www.example.com",
     "label": "example-user",
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
 所以全部渠道**零改动**就支持账号池。
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
| `mx accounts`（`<cid>` / `--json`） | 列出池子；**首次查看会把已登录的凭证自动收进池子** |
| `mx accounts add <cid>` | 走渠道自己的登录流程（浏览器授权）→ 成功后入池并设为生效 |
| `mx accounts use <key>` | 切换生效账号 |
| `mx accounts remove <key>` | 从池子删除（生效账号 → 同时登出） |
| `login` 成功后 / 守护 `start` 前 | 自动同步（登录即入池；刷新过的 token 回灌） |

**未实现（策略层，见 §3.3）**：一个渠道内多账号的轮询 / 失败转移 / 配额耗尽自动换号。

## 4. 「先完成公共层」的具体含义

公共层要完成三件事，才有「仓库级 CLI」：

### 4.1 注册表：单槽 → 多槽（已落地）

原状：`setChannel()` 是进程级单例，`getChannel()` 未注册就抛错；共享层有 **30 处**
`getChannel()` 调用点（`gateway` / `daemon` / `headless` / `console` / `sse-stream` /
`auth-flow` / `paths` / `cli` / `cli-consts` / `report`），全部假设「一个进程一个渠道」。

落地后的 API（**保留了 `setChannel` 签名**，全部渠道一行都没改）：

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
省略时按「渠道上下文 → 唯一渠道」解析。现有渠道与全部既有测试**无需同步修改** ——
这条渐进策略是本次改造能一次通过 470 项测试的关键。

### 4.2 路由层（已落地）

- `/v1/chat/completions`：**池路由** —— 客户端用 `<cid>/<模型>` 显式指定渠道（见 §2.4）。
  早期「无前缀 + 账本挑渠道」的做法**已废弃**。
- `/v1/models`：动态全池，id 挂渠道前缀（见 §2）。
- `/health`：报告**整体**状态 + 每个渠道一行（登录/池子/是否上架），而不是单个渠道。

### 4.3 进程与入口收敛（部分落地）

现状：各渠道都有自己的 `defaultAddr` / `uiPort` 与单渠道守护进程（仓库级网关不用它们，见上文）。

目标：仓库级 CLI 只跑**一个**网关进程 + **一个**控制台端口；各渠道的 bin 保留为
「单渠道独立运行」的调试入口（不删，但不再是主路径）。对外只有一个 CLI
（动词在前、渠道作操作对象，如 `mx billing catpaw`）。

已落地：

- **动词优先**：`mx <动词> [<cid>]`（见 [`CONTRACT-TS.md` §9](./CONTRACT-TS.md)）；
 不带渠道名时按「单渠道模式 / 仓库级」解析。
- **守护进程的「范围」**：渠道级（显式 `cid` 或只注册 1 个渠道）用渠道层文件
 `<root>/<cid>/gateway.pid|gateway.log|prefs.json`；**仓库级**（多渠道路由、未指定 cid）
 用根级 `<root>/gateway.pid|gateway.log|prefs.json` —— 一个服务多池的进程不属于任何单个渠道。
- **仓库级默认端口**：多渠道路由时用 `REPO_DEFAULT_ADDR = 127.0.0.1:4412` /
 控制台挂在 `REPO_UI_PREFIX = /web`，而不是取某个渠道的端口。
- **修掉一个潜伏 bug**：`daemon.start` 原本 spawn **共享包的 `cli.js`**，而那个文件只是一组
 导出、没有自带入口调用 → 守护进程起来立刻退出（TS 版 `start` 一直是坏的）。现在改为重跑
 **当前进程的入口**（`process.argv[1]`），任何入口（单渠道 bin / 仓库级 bin）都自洽。
- **服务身份**：单渠道 = `cid`；多渠道路由 = `modelmux`。守护进程探测时接受
 「本进程认得的全部身份」，所以单渠道的 `status` 也认得多渠道路由的网关。
- **`model list` / `model usage` 子命令**：池视图（两个模型各自会落到哪家、账本用量与
 冷却/暂不可用）与池账本；渠道视角并入 `models <cid>`。
- **仓库级 CLI 已可用**：`packages/cli`（bin `modelmux` / `mx`）。
- **插件层已整体移除（2026-10-13）**：`plugins/` 与 `marketplace.json` 删除，项目更名
 `modelmux`，定位 = 纯 npx/npm -g 可装的 CLI；集成方式就是「任何 OpenAI 兼容客户端
 指向 `http://127.0.0.1:4412/v1`」。（更早：per-channel 插件 → 单插件收敛 → 全部移除。）

### 4.4 三层进程模型（2026-10-16 落地）

网关的生命周期由三层进程承担（契约细节见 [`DAEMON-SUPERVISOR.md`](./DAEMON-SUPERVISOR.md)）：

```
mx start（短命命令，写 PID 文件后退出）
  └─ mx supervise  监督进程（detached 常驻；只管 spawn / 重生 / 心跳）
       └─ mx serve  网关 worker（stderr → gateway.log；IPC + supervisor-ping 双通道感知父死）
```

- **谁管谁**：`start` 拉起的是监督者，PID 文件（`gateway.pid`）记监督者 pid；
 worker pid 由监督者维护到 `gateway-worker.pid`。
- **自动重生**：worker 意外退出且死前曾 healthy → 指数退避重生
 （1s→2→4→8→16→30s 封顶；稳定 ≥60s 计数清零；从未 healthy 的启动窗口死亡不重生）。
- **干净终止**：`mx stop` 杀监督者即作废重生，再等 worker IPC/心跳自退（≤3s），
 最后兜底清 worker；`mx serve` 直跑是调试路径，无监督、不自动拉回。
