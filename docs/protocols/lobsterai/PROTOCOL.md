# LobsterAI 协议规格（有道）

提取自 `dsh-our-free-model/vendor/channel-pack/src/lobsterai*.ts`。

---

## 1. 端点

Base（API）：`https://lobsterai-server.youdao.com`（lobsterai-product.ts:63）
Base（Portal）：`https://lobsterai.youdao.com`（:77）

| 用途 | 方法 | 完整路径 | 来源 |
|---|---|---|---|
| 授权码换 token | POST | `{apiBase}/api/auth/exchange` | lobsterai.ts:32 |
| 静默续期 | POST | `{apiBase}/api/auth/refresh` | :34 |
| 对话 | POST | `{apiBase}/api/proxy/v1/chat/completions` | :45 |
| 模型列表 | GET | `{apiBase}/api/models/available?{keyfrom query}` | :36 |
| 积分余额 | GET | `{apiBase}/api/user/profile-summary` | lobsterai-credits.ts:40 |
| 活动槽位 | GET | `{apiBase}/api/client-activities/slot?placement=desktop_sidebar&clientVersion={v}&containerApiVersion=2&platform=win32` | :36, 50-52 |
| 活动上下文 | GET | `{apiBase}/api/client-activities/{activityCode}/context?configRevision={rev}` | :38 |
| 签到 | POST | `{apiBase}/api/client-activities/{activityCode}/actions/check_in` | :261 |
| 客户端版本号 | GET | `https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update` | lobsterai-product.ts:85-86 |
| 登录页（浏览器） | GET | `{portalBase}/portal#/login?source=electron&redirect_uri=...&state=...` | lobsterai-oauth.ts:104-116 |
| 本地回调 | — | `http://127.0.0.1:{port}/auth/callback?code=...&state=...` | :109 |

**多区域/多环境：无。** 单一域名。

---

## 2. 认证

### 2.1 请求头（lobsterai.ts:492-570）

**通用带认证头 `lobsteraiAuthHeaders`**：
```
Authorization: Bearer {credential.access_token}
Accept: {accept}            # 默认 application/json
Content-Type: application/json
User-Agent: LobsterAI/0.1.0
```

**对话头 `lobsteraiChatHeaders`** = 上述 + `Accept: text/event-stream, application/json` + 两个能力头：
```
X-LobsterAI-Client-Capabilities: kimi-k3-agentic-v1,thinking-level-control-v1
X-LobsterAI-Client-Version: {动态版本号，如 2026.9.4}
```

**模型列表头 `lobsteraiModelsHeaders`** = 通用头 + **同样两个** `X-LobsterAI-Client-*` 头。

⚠️ **这两个头在模型端点是准入条件**（2026-09-17 实测）：
不带 `X-LobsterAI-Client-Capabilities` 时 `/api/models/available` 只返回 25 个模型且
**没有 `kimi-k3`**，带上才 26 个。`thinking-level-control-v1` 是 `reasoning_effort: "off"` 的前提
—— 不带该能力时服务端直接 HTTP 500。

**匿名头 `lobsteraiAnonymousHeaders`（exchange / refresh）**：
只有 `Accept: application/json`、`Content-Type: application/json`、`User-Agent: LobsterAI/0.1.0`
—— **不带 `Authorization`**。

⚠️ LobsterAI **不认** CodeBuddy 那套 `X-Domain` / `X-Product` / `X-Product-Code` / `X-IDE-*` 归属头，
带上无用且可能让服务端按错误客户端形态归因。

### 2.2 凭据结构（lobsterai.ts:79-114）

```
access_token: string          # 必填
refresh_token: string         # 必填但允许空串
expires_at?: string           # 毫秒时间戳字符串
uid?: string
user_id?: string              # 有道 yid
nickname?: string
uuid?: string                 # 安装 UUID，exchange/refresh 必带
first_keyfrom?: string        # 首次登录时间戳（毫秒字符串）
latest_keyfrom?: string       # 最近活动时间戳（毫秒字符串）
```

⚠️ **refresh 请求体不是只带 refreshToken**，还要带 `firstKeyfrom` / `latestKeyfrom` / `uuid`
—— 这三个字段必须随凭据持久化，丢了就只能重新登录（lobsterai.ts:72-77）。
**这是与 CodeBuddy 最大的结构差异。**

### 2.3 刷新流程（lobsterai-auth.ts:519-562）

```
POST {apiBase}/api/auth/refresh
Headers: 匿名头（无 Authorization）
Body: {
  firstKeyfrom:  {credential.first_keyfrom ?? ''}
  latestKeyfrom: {credential.latest_keyfrom ?? ''}     # ← 用存储值，不是当前时刻
  version:       {动态版本号}
  uuid?:         {仅非空时带该键}
  userId?:       {仅非空时带该键}
  refreshToken:  {credential.refresh_token}
}
超时: 30_000 ms
```

⚠️ `latestKeyfrom` **刻意不更新为当前时刻**（虽然字段名叫「最近活动」）：
严格对齐 Go 的 `RefreshToken` 只改 token 与过期时间，`LatestKeyfrom` 永久停在登录那一刻，
续期时原样回发。

响应：`{code:0, data:{accessToken, refreshToken, expiresIn, user:{id,yid,userId,nickname}}}`

**终态判定（lobsterai-auth.ts:544-560）**：
- HTTP 401 / 403 → `RefreshTokenExpiredError`
- 或信封失败且 `classifyLobsteraiError` 判出 `session-dead`
- `code:0` 但 `accessToken` 为空 → 也判终态
- 其余（网络抖动、5xx、429）→ 普通 Error，走可重试路径

⚠️ **响应可能不返回新 refreshToken** → 保留旧值（不能覆盖成空串）。

### 2.4 登录流程（本地回调 + authCode）

| 步骤 | 内容 |
|---|---|
| 1. 会话 | `uuid = randomUUID()`；`firstKeyfrom = String(Date.now())`；`state = randomUUID()` |
| 2. 回调服务器 | `127.0.0.1` **随机空闲端口**（`listen(0)`），路径 `/auth/callback` |
| 3. 登录 URL | `{portalBase}/portal#/login?source=electron&redirect_uri=http%3A%2F%2F127.0.0.1%3A{port}%2Fauth%2Fcallback&state={state}` |
| 4. 回调校验 | `code` 非空且 `state` 严格相等，否则 400 |
| 5. exchange | 立即在进程内 POST `/api/auth/exchange` |
| 6. 成功页 | `200 text/html`「登录成功，可以关闭此窗口了」；失败 `500` |
| 7. 超时 | 10 分钟 |

⚠️ `redirect_uri` 必须是 `http://127.0.0.1:{port}/auth/callback` 形态（登录页会校验）；
hash 段 `#/login` 必须显式拼装，不能用 `URL.searchParams`。

**exchange 请求**（lobsterai-oauth.ts:130-185）：
```
POST {apiBase}/api/auth/exchange
Headers: 匿名头
Body: {
  authCode:      {回调里的 code}
  firstKeyfrom:  {session.firstKeyfrom}
  latestKeyfrom: String(Date.now())      # ← 登录时用当前时刻
  uuid:          {session.uuid}
  version:       {动态版本号}
}
超时: 30_000 ms
响应: {code:0, data:{accessToken, refreshToken, expiresIn, user:{id,yid,userId,nickname}, quota}}
```

**uid 四级回退**（lobsterai.ts:401-406）：
`user.id` → `user.userId` → `user.yid` → `sha256(accessToken).hex[:16]`

⚠️ 刻意**不在 yid 与哈希之间插入 JWT `sub` 回退** —— Go 没有这一级，
插进去会让同一账号在两边得到不同 uid。

**expires_at 取值顺序**（lobsterai.ts:423-432）：
`expiresIn`（相对秒数，基准取**当前时刻**）→ access_token 的 JWT `exp` → 留空。
无法解析时**不判定过期**。

### 2.5 客户端版本号（lobsterai.ts:588-675）

- 来源端点 `https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update`
  （**第三方域名，非统一信封**）
- 响应形状：`{data:{value:{version, date, windowsX64:{url}, macIntel, macArm, changeLog}},
  code:0, msg:"OK"}` —— `code`/`msg` 在**外层**，载荷在 `data.value`
- 版本号正则：`^(\d+(?:\.\d+)*)(?:-[0-9A-Za-z.-]+)?$`
- 缓存 TTL 12 小时
- 兜底常量 `LOBSTERAI_FALLBACK_CLIENT_VERSION = '2026.9.4'`
- **三个消费点**：exchange 的 `version`、refresh 的 `version`、签到 slot 的必填 query 参数

---

## 3. 对话请求

URL：`POST {apiBase}/api/proxy/v1/chat/completions`

### 3.1 请求体（lobsterai-adapter.ts:1008-1033）

| 键 | 值 / 条件 |
|---|---|
| `model` | 模型 id |
| `messages` | 见下 |
| `stream` | **恒 `true`** —— 上游只支持 SSE，`stream: false` 返回 **500** |
| `tools` | OpenAI function 数组，仅非空时带 |
| `temperature` | 透传 |
| `max_tokens` | 透传 |
| `stop` | 透传（非空数组） |
| `reasoning_effort` | **透传**，仅调用方显式传入时；取值用远端 `openclawLevel`（**无 `max`**） |

**不发** `prompt_cache_key`；**不发** `tool_choice`。

### 3.2 消息结构（lobsterai-adapter.ts:455-568）

- `system` / `user` / `assistant` / `tool` 四角色，格式同 OpenAI
- assistant：正文为空且有 tool_calls 时 `content` 必须为 **`null`**（OpenAI 规范）；
  `reasoning_content` **仅非空时带**（不强制，与 buddy 不同）
- 工具结果内嵌图片挂起到其后的**独立 user 消息**
  （`role:'tool'` 的 content 只能是字符串，且必须紧跟其 tool_call，中间插消息会 400）；
  载体文本 `Attached image(s) from tool result:`
- 孤儿 tool_call / tool_result 必须剔除

**图片**（lobsterai-adapter.ts:371-426, 931-967）：
形态必须是 `{type:'image_url', image_url:{url:'data:{mediaType};base64,...'}}`
—— `{type:'image'}` 与裸 base64 字符串都返回 HTTP 500。
对远端声明不支持的模型显式报 `UNSUPPORTED_CONTENT`（不静默丢弃）。

⚠️ 请求体体积实测：12 张 2560×1600 原图能过、13 张（≈50 MiB）回 `SERVER code=500`。

**无「首条必须 system」约束**；`options.system` 非空时 `unshift` 到 messages 首。

---

## 4. 流式响应（标准 OpenAI SSE）

| 事件 | payload 字段 |
|---|---|
| 正文 | `choices[0].delta.content` |
| 正文兼容回退 | `choices[0].message.content` —— **仅当从未收到过 `delta.content`** |
| 思考 | `choices[0].delta.reasoning_content` |
| 工具调用 | `choices[0].delta.tool_calls[] = {index, id?, function:{name?, arguments?}}` |
| 结束原因 | `choices[0].finish_reason` |
| 用量 | `usage.{prompt_tokens, completion_tokens, prompt_tokens_details.cached_tokens, prompt_cache_hit_tokens, completion_tokens_details.reasoning_tokens}` |
| **结束标志** | `data: [DONE]` |
| **流内错误** | 顶层 `{error:{message}}`（HTTP 200） |

⚠️ **`data:` 后无空格**是上游实测形态（sse.go:37-39 注释「龙虾上游实测无空格」）
—— `line.slice(5).trim()` 天然兼容两种。

⚠️ `content` 与 `reasoning_content` **另一侧恒为显式 `null`**
（实测 335 帧中 content=null 227 帧、reasoning_content=null 107 帧），
必须用 `typeof === 'string'` 判，只判 `!== undefined` 会在 `.length` 上崩
（表现为「每轮对话第一帧就报 Cannot read properties of null」）。

### 4.1 think 标签归位（lobsterai-adapter.ts:1563-1593）

收尾**无条件**调用 `splitThinkTaggedContent` —— `</think:hex>` 标签**前**的内心独白
归入 reasoning 块，标签**后**的才是正文。

⚠️ 逐帧探测必然漏判（实测二分帧 7/11 漏），故**不能加「先探测有没有标签」的门禁**。
裸 `</think>` 兜底剥离**默认关闭**（`DSH_THINK_LEAK_STRIP=1` 才启用）。

### 4.2 空闲超时与 finish reason

- 首 token 120_000 ms、chunk 间 120_000 ms
- **finish reason 映射顺序**（lobsterai-adapter.ts:1672-1680）：
  `length` / 未收到 finish_reason 但有工具调用 / 参数残缺 / 被上游停止串截断 /
  丢弃了无名 tool-call → 一律 **`max-tokens`**；只有确认完整才报 `tool-calls`。
  理由：报 tool-calls 会让 harness 执行残缺 JSON 参数并污染会话历史。

---

## 5. 模型目录

### 5.1 拉取

`GET {apiBase}/api/models/available?{query}`（lobsterai-adapter.ts:1727-1735）

- query 是 **keyfrom 身份载荷**：`firstKeyfrom` / `latestKeyfrom` / `version` / `uuid?` / `userId?`
  （只带非空值）—— **不含 `refreshToken`**（放 query 既泄露又非预期输入）
- 必须带 `lobsteraiModelsHeaders`（含两个 `X-LobsterAI-Client-*` 头）
- 响应**两种形状都必须认**（:241-252）：
  `{code:0, message:'success', data:[...]}`（单层，实测真实形态）
  或 `{code:0, msg:'OK', data:{data:[...]}}`（双层）
  ⚠️ **不能复用 `parseLobsteraiEnvelope`** —— 它要求 `data` 必须是对象，
  而此端点 `data` 恰恰是数组，复用会让列表恒为空并静默回退兜底表

### 5.2 条目字段（:263-297）

`modelId`（必填）、`modelName`、`contextWindow`、`maxTokens`、`supportsImage`、
`supportsThinking`、`thinkingConfig{options:[{level, openclawLevel}], defaultLevel}`、
`requestCapabilities[]`、`description`、`costMultiplier`（**裸数字**，实测 0.05 / 1.08 / 20
—— 与 buddy 的字符串 `"x0.05"` 形态不同）

不取 `provider` / `apiFormat` / `runtimeProfile`。

⚠️ `level` 与 `openclawLevel` **语义不同不可混用**（:106-124）：
- `level` 是产品侧档位名（含 `max`，用于 UI 展示）
- `openclawLevel` 是发给服务端的 wire 值（`off/minimal/low/medium/high/xhigh`，**没有 `max`**）

实测远端把 `level:'max'` 映射到 `openclawLevel:'xhigh'`；
直接发 `reasoning_effort:'max'` 与不带参数无差异。

### 5.3 兜底静态模型表（19 个，lobsterai-product.ts:183-203）

全部 `contextWindow: 131072`：

```
deepseek-v4-flash, deepseek-v4-pro, MiniMax-M3, MiniMax-M2.7,
qwen3.7-max, qwen3.7-plus, qwen3.6-plus, qwen3.5-plus-2026-04-20,
kimi-k2.7-code, kimi-k2.7-code-highspeed, kimi-k2.6, kimi-k2.5,
doubao-seed-2-1-pro-260628, doubao-seed-2-1-turbo-260628,
doubao-seed-2-0-code-preview-260215,
glm-5.2, glm-5.1, glm-5v-turbo, glm-5
```

来源：`lobsterai2api/internal/server/handler.go:94-114` 的 `staticModels`，
注释标明「2026-08-06 从 `GET /api/models/available` 实测拉取」。

⚠️ `contextWindow: 131072` 是桥接层**统一填的估计值**，不是逐个实测
—— 远端实测多数模型返回 `1000000`。
⚠️ 兜底表**不含 `costMultiplier`**（编译期快照，价格会变，不猜）。

---

## 6. 额度查询

### 6.1 余额

`GET {apiBase}/api/user/profile-summary`（lobsterai-credits.ts:310-396）

- 信封 `{code, msg, data}`
- `data.totalCreditsRemaining`（**负数 clamp 到 0**）
- `data.creditItems[] = {type, label, creditsRemaining, expiresAt}`
  —— `label` 是展示名（实测「每日登录奖励」），`type` 是机器分类码（`campaign`）；
  `expiresAt` 是 **ISO 8601**（实测 `"2026-10-23T01:21:23"`）
- 面值推断：服务端**无面值字段**，取「同组（label 相同）有效包的剩余量最大值」当 `total`

⚠️ **不用 `/api/user/quota`**：它只有 `freeCreditsTotal=300`，**不含活动积分**
（实测某账号 profile-summary 有 5297.72，quota 只有 300）。
⚠️ `total === 0 && packages.length === 0` → 返回 `null`（「查不到」而非「余额为 0」）。

### 6.2 签到三步（lobsterai-credits.ts:234-295）

| 步 | 请求 | 响应字段 |
|---|---|---|
| 1 | `GET /api/client-activities/slot?placement=desktop_sidebar&clientVersion={v}&containerApiVersion=2&platform=win32` | `data.slotState`、`data.activity.activityCode`、`data.activity.configRevision` |
| 2 | `GET /api/client-activities/{activityCode}/context?configRevision={rev}` | `data.state.claimedToday`、`data.actions[]` |
| 3 | `POST /api/client-activities/{activityCode}/actions/check_in`，body `{configRevision, idempotencyKey: uuid4, payload: {}}` | `data.result.{creditsGranted \| rewardCredits \| credits}` |

三个固定 query 常量：`placement='desktop_sidebar'`、`containerApiVersion='2'`、`platform='win32'`。

⚠️ `platform=win32` 是**伪装客户端形态**，即使跑在 macOS/Linux 上也照发，
与运行环境无关，改了可能拿不到活动。

⚠️ 幂等是**客户端**保证：`idempotencyKey`（UUID4）+ 先查 `claimedToday` / `actions` 含 `check_in`。
两步预检都要做。

积分三级回退：`creditsGranted` → `rewardCredits` → `credits`。

---

## 7. 错误分类逻辑（`Classify()` 移植自 Go）

**判定顺序即优先级（lobsterai-errors.ts:107-124，完全对齐 `classify.go:66-93`，不要重排）**：

| # | 判据 | 结果 |
|---|---|---|
| 1 | `status === 402` | `hard-credit` |
| 2 | body 命中 hard 关键词 | `hard-credit` |
| 3 | body 命中 session-dead 标记 | `session-dead` |
| 4 | `status === 429` | `soft-rate` |
| 5 | `status === 404` | `not-found` |
| 6 | `status >= 500` | `server` |
| 7 | `status >= 400` | `client` |
| 8 | 其它 | `none` |

⚠️ **为什么 body 关键词排在状态码之前**（除 402）：
实测上游用 **400 + 中文「积分不足」**表达余额耗尽，只按状态码会误判成 `client`（可重试），
于是反复重试一个永远不会成功的账号。

⚠️ **为什么 session-dead 排在 429/404 之前**：`40100`/`40101` 可能与 4xx 同时出现，
会话已死时任何换号重试都没意义。

**`hard-credit` 关键词全表（逐字）**：

```
insufficient credit, no credit, credit exhausted, out of credit,
quota exceeded, quota exhaust, payment required, credit not enough,
not enough credit, freecreditsused, free credits used,
free quota, quota used up, upgrade your plan, upgrade to continue,
积分不足, 额度不足, 余额不足, 积分用完, 额度用尽, 没有积分, 积分耗尽,
额度已用完, 升级套餐
```

⚠️ 最后 6 个中文 + 4 个英文是 2026-09 补充的（真实缺陷）：
额度耗尽的**实际文案**是「免费额度已用完，请升级套餐」，
而早期表里只有「额度用尽」「积分用完」——「已用完」与「用尽」字面不同，
于是这个**最主要的失败模式**判成 `none`（不换号、不记徽章）。

比较策略：英文走 `toLowerCase()` 包含，中文走原文包含。

**`session-dead` 标记全表**：`40100`、`40101`、`token rejected`、`refresh token was rejected`

**流内错误专用分类器 `classifyLobsteraiStreamError(message)`**：
传 `200` 表示「状态码不可用」，只让关键词分支参与；未命中 → **`client`（可轮转）而非 `none`**。
⚠️ 不能直接复用 `classifyLobsteraiError`：它的优先级里状态码排最前，
而流内错误的 HTTP 状态是 200，那些分支全部失效。

**三个派生谓词**：
- `shouldRotateLobsteraiAccount(kind)`：`kind !== 'none'` —— **除成功外每一类都换号**
- `recordsLobsteraiRateLimit(kind)`：仅 `hard-credit` | `soft-rate` | `not-found`
  —— 其余只轮转、不留徽章（否则一个 400 请求错误会被显示成「该模型限流 1 小时」）
- `isLobsteraiTerminalError(kind)`：仅 `session-dead`

**换号上限**：`LOBSTERAI_MAX_ROTATE = 3`。
⚠️ 循环里判据是 `attempt >= LOBSTERAI_MAX_ROTATE - 1`（**减 1**）
—— 因为进循环前已用首个凭据发过一次请求，不减会变成 1+3=4 次。

**限流重置时间兜底**：`LOBSTERAI_RATE_LIMIT_FALLBACK_MS = 3_600_000`（1 小时）。

⚠️ **不移植 Go 的冷却状态机**（有意分歧）：Go 的 `internal/pool` 会在分类后自动
`Cooldown(CoolHard, 12h)` / `Disable(uid)`，表现为账号被**静默停用**。
本实现刻意不这样做 —— 只有 `modelRateLimits` 与用户手工 `enabled` 开关。
**轮转**（这次请求换个人试试）与**冷却**（标记账号不可用一段时间）是两件事：采纳前者，不用后者。

---

## 8. 其他踩坑注释

1. **额度耗尽走 HTTP 200 + SSE 流内错误帧**，而早期实现把整个换号循环放在 `if (!response.ok)` 之内
   —— 流内错误在消费阶段才抛出，根本走不到换号逻辑（用户报障「一个账号用完出错但没有切换」）。
   现在两种失败模式共用同一个循环与同一套成组状态。
2. **已产出内容后绝不能换号**（lobsterai-adapter.ts:1082-1098）：
   换号会重放请求，新的 `consumeSse` 生成器 `nextIndex` 从 0 重新开始，
   **再发一次 `block-start(index=0)`** → DSH 硬失败 `LLM stream repeated block-start index 0`。
3. **错误码与状态码必须「成组同源」**：早期把 `kind` 留在循环外只算一次，
   导致「A=402(积分不足) → B=503」时错误码变成 SERVER，用户看不到真实原因。
4. **账号池 `refreshable` 单向门**：`refreshAll` 第一行仍是 `if (!entry.refreshable) continue`
   —— 这是 codearts 已修但其余 8 个 provider 仍存在的缺陷。
   **Python 重实现时应读凭据本体判定材料，不读这个布尔快照。**
5. **手机号昵称掩码**（lobsterai.ts:143-185）：服务端把**手机号本身**当 `nickname` 下发且
   只脱敏到「露末 4 位」（实测 `130****1100`），需归一化为只露**末 2 位**（`130******00`），
   幂等、只对「像手机号」的输入生效。
6. **`refreshAccountCredential` 必须回写账号池 `expiresAt`**：UI 读的是池值，
   只 `credentials.set` 会让「已过期」红字在续期成功后依然挂着。
7. **`code !== 0` 与 `data` 为空是两个独立失败信号**：上游在凭据失效时倾向返回
   `code:0` 但 `data:null`，只看 code 会把这种情况当成功，随后在解引用时崩在更远的地方。
