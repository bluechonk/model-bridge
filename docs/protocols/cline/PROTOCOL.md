# Cline 协议规格

提取自 `dsh-our-free-model/vendor/channel-pack/src/cline*.ts`。

---

## 1. 端点

| 用途 | 方法 | 完整 URL | 认证 |
|---|---|---|---|
| 设备码授权 | POST | `https://api.workos.com/user_management/authorize/device` | 无（仅 client_id） |
| 设备码 token 轮询 | POST | `https://api.workos.com/user_management/authenticate` | 无 |
| 注册 Cline token | POST | `https://api.cline.bot/api/v1/auth/register` | 无（Body 带 WorkOS token） |
| 续期 | POST | `https://api.cline.bot/api/v1/auth/refresh` | 无（Body 带 refreshToken） |
| 对话 | POST | `https://api.cline.bot/api/v1/chat/completions` | `Bearer workos:<jwt>` |
| 全量模型 id | GET | `https://api.cline.bot/api/v1/models` | `Bearer workos:<jwt>` |
| 推荐模型（含 free 数组） | GET | `https://api.cline.bot/api/v1/ai/cline/recommended-models` | **不需要认证** |
| 账号信息 | GET | `https://api.cline.bot/api/v1/users/me` | Bearer |
| 余额 | GET | `https://api.cline.bot/api/v1/users/{userId}/balance` | Bearer |
| 订阅额度窗口 | GET | `https://api.cline.bot/api/v1/users/me/plan/usage-limits` | Bearer |
| models.dev 目录 | GET | `https://models.dev/api.json` | 无 |

**关键常量**：
- `apiBase = 'https://api.cline.bot'`、`appBase = 'https://app.cline.bot'`、`workOsBase = 'https://api.workos.com'`
- `workOsClientId = 'client_01K3A541FN8TA3EPPHTD2325AR'`
- `tokenPrefix = 'workos:'`
- 超时：OAuth 30s、模型目录 20s、余额/额度 30s

---

## 2. 认证

### 2.1 请求头（cline-product.ts:260-265）

```
HTTP-Referer: https://cline.bot
X-Title: Cline
X-IS-MULTIROOT: false
X-CLIENT-TYPE: cline-sdk
```

推理请求组装后：
```
Authorization: Bearer workos:<jwt>
Accept: application/json
+ 上述 4 个 clientHeaders
+ Content-Type: application/json（对话时）
+ Accept: text/event-stream（对话时）
```

### 2.2  `workos:` 前缀不可剥（本渠道最大坑）

`cline.ts:178-182` `clineBearerValue` —— 令牌值**必须**保留服务端下发的 `workos:` 前缀，
实现为幂等补齐（`startsWith(tokenPrefix)` 命中即原样返回）。

实测（cline-product.ts:104-112）：
- `Bearer workos:eyJ…` → `/api/v1/users/me` **200**
- `Bearer eyJ…`（剥前缀）→ **401**，文案 "make sure you're using the latest version of Cline"
 —— 与真实原因毫不相干，会让人误判成「版本过旧」

源码里前缀只在**解码 JWT** 时被剥掉，从不出现在请求头构造里。

### 2.3 凭据字段（cline.ts:27-51）

| 字段 | 必需 | 说明 |
|---|---|---|
| `access_token` | 是 | 带 `workos:` 前缀 |
| `refresh_token` | 续期必需 | 无它即不可静默续期 |
| `expire_time` | 否 | **毫秒**时间戳 |
| `account_id` | 余额查询必需 | 形如 `usr-01M3BCV4FYCGJKAWD3MJG3DBQM` |
| `email` / `nickname` | 否 | 展示用 |

### 2.4 登录流程（WorkOS 设备码，三步）

**第 1 步** 请求设备码：
```
POST https://api.workos.com/user_management/authorize/device
Content-Type: application/x-www-form-urlencoded
body: client_id=client_01K3A541FN8TA3EPPHTD2325AR
→ { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }
```
三字段齐备才通过（`device_code` / `user_code` / `verification_uri`）；
`expires_in` 默认 300 秒、`interval` 默认 5 秒。

**第 2 步** 轮询 token：
```
POST https://api.workos.com/user_management/authenticate
Content-Type: application/x-www-form-urlencoded
body: grant_type=urn:ietf:params:oauth:grant-type:device_code
     &device_code=<device_code>&client_id=<client_01K3A541FN8TA3EPPHTD2325AR>
→ 200 { access_token, refresh_token, token_type }
→ 错误体 { error: "authorization_pending" | "slow_down" | … }
```

**状态机（cline-oauth.ts:230-307）**：
- `authorization_pending` → **不是错误**，继续按 interval 轮询
  判据是响应体 `error` 字段，**不是** HTTP 状态码 —— 按状态码判会把
 「用户还没点授权」误报成失败
- `slow_down` → `intervalMs += 1000` 后继续（**必须真的累积退避**）
- `access_denied` / `expired_token` / `invalid_grant` → 终态失败
- 其它非 2xx → 终态失败
- 网络失败容忍 5 次连续失败
- 轮询间隔下限 1 秒（服务端可能下发 0 或负数）
- 2xx 但缺 token → 视为服务端异常（不是「等用户」），避免死循环

**第 3 步** 换 Cline 自己的 token：
```
POST https://api.cline.bot/api/v1/auth/register
Content-Type: application/json
+ clientHeaders
body: { accessToken: <WorkOS access_token>, refreshToken: <WorkOS refresh_token> }   ← 驼峰
→ { success: true, data: { accessToken: "workos:eyJ…", refreshToken: "tmgEeM…",
                          expiresAt: "2026-09-25T05:23:47.000Z", tokenType: "Bearer",
                          userInfo: { clineUserId: "usr-…", email: "…",
                                      firstName: "", lastName: "" } } }
```

登录 URL 优先用 `verification_uri_complete`（带 `user_code`，用户少一步输入）。

### 2.5 响应解析判据（cline.ts:121-157）

**判据是 `success && data.accessToken`**，**不是**裸 `accessToken`
—— 只看裸字段会把失败信封当成功。

- 注册与续期响应**同构**，都过同一个解析函数
- `expiresAt` 实测是 **ISO 8601 字符串**；解析器同时兼容数字（10 位当秒、13 位当毫秒）
- `account_id` 取自 `data.userInfo.clineUserId`
- 兼容裸响应（无 `data` 信封）

### 2.6 续期流程（cline.ts:263-268）

```
POST https://api.cline.bot/api/v1/auth/refresh
Content-Type: application/json
Accept: application/json
+ clientHeaders
body: { "refreshToken": "<refresh_token>", "grantType": "refresh_token" }
```

**字段名是驼峰 `refreshToken` + `grantType`**，
**不是** OAuth 标准的 `refresh_token` / `grant_type`。
两者都是必填；写错字段名服务端不会明确报「缺字段」，而是回一个泛化的认证失败，极难定位。

**终态判定**：
- HTTP 401 / 403 → `RefreshTokenExpiredError`
- 200 但缺 accessToken → `RefreshTokenExpiredError`
- 传输层失败 / 5xx / 429 → 普通 Error（可重试）

续期后**保留** `account_id` / `email` / `nickname`。

---

## 3. 对话请求

### 3.1 请求体（cline-adapter.ts:569-603）

```json
{
 "model": "<模型 id，如 cline-free/mimo-v2.6-flash>",
 "messages": [ ... ],
 "stream": true,
 "tools": [ { "type": "function", "function": { "name", "description", "parameters" } } ],
 "temperature": <number>,
 "max_tokens": <number>,
 "stop": [ ... ],
 "reasoning_effort": "<none|low|medium|high|max>"
}
```

- `system` 提示词拼为 `messages[0]` 的 `{role:'system', content}`
- `tools` 的 `parameters` **必须先清洗**（见下）
-  `reasoning_effort` **原样透传，绝不做白名单校验** —— 档位表是客户端内嵌目录的快照，
 校验等于把上游新增档位静默丢弃；且上游对完全不认识的档位也只是静默忽略
 （实测 `reasoning_effort: 'banana'` 返回 HTTP 200、思考量 0，不报错）
- `max_tokens` 上界 `943_718`；非有限值 / ≤0 返回 undefined（不编造）

### 3.2  工具参数 `enum` 必须清洗空串成员

（cline-adapter.ts:126-139，实测 400 用户报障 2026-09-25）

harness 下发的工具 schema 里某些参数 `enum` 含空字符串成员，
Gemini 系（经 `google` / `vertex` provider）严格校验直接拒绝整个请求：

```
GenerateContentRequest.tools[0].function_declarations[34]
 .parameters.properties[permission].enum[3]: cannot be empty
```

**三条边界**：
- **只删空字符串**（含纯空白），其余成员原样保留 —— `enum` 可能是数字/布尔数组，
 按「只留字符串」过滤会把合法数值枚举整段丢掉
- 过滤后为空则**整个 `enum` 键丢弃**（空 `enum` 同样非法），而非留下 `[]`
- **递归下钻**：`properties` / `items` 等嵌套层里的 `enum` 同罪

### 3.3  403 必须先排除地域限制（cline-adapter.ts:965-977）

Cline 对「该地区不可用」的模型返回 **403**，与凭据问题同码。实测：

```
403 {"error":"access forbidden: cline-free/muse-spark-1.3-contributor
     is not available in your region","success":false}
```

若不区分，会触发续期 → 重试 → 仍 403 → 归成 `AUTH` → 渲染成「API 密钥无效」，
真实原因（地域限制）被完全掩盖，且每次请求白跑一次续期。

认三种表述（取特征词，小写比对）：
```
not available in your region
access forbidden
region not supported
not available in your country
```

命中时**跳过续期**并直接抛 `PERMISSION_DENIED`。

### 3.4 图片输入

- 能力按**模型**判定，来自目录条目的 `supportsImage`（两级判据：本地兜底表 > models.dev）
- Cline **没有**腾讯那道「图片视觉 token 预算」—— 实测 24 张 2560×1600 原图
 （≈159K 图片 token）全部成功，直到 32 张（≈122 MiB）才因**请求体体积** `TRANSPORT` 失败
- 图片编码为 `data:<mediaType>;base64,<...>`，放在 `{type:'image_url', image_url:{url}}` part

### 3.5 换号策略（cline-adapter.ts:643-720）

- 只有**限流**才换号：HTTP 429 / 402，或响应体命中额度文案标记：
 `insufficient` / `quota` / `rate limit` / `too many requests` / `balance` / `credit` /
 `payment required` / `exceeded` / `积分不足` / `额度不足` / `余额不足` / `频率限制` / `超出限制`
- 最多换 `CLINE_MAX_ROTATE = 3` 次
- 400（请求格式错）/ 5xx 换号无用
- 401 / 403 时先续期一次再重试（地域限制除外）

---

## 4. 流式响应（标准 OpenAI SSE）

`data:` 帧 + `data: [DONE]` 终止。

### 4.1  Cline 专属差异：思考字段名

**思考增量字段是 `delta.reasoning`，不是 `delta.reasoning_content`**。

实测 SSE 形如：`{"delta":{"reasoning":"The","reasoning_details":[…]}}`

只认 `reasoning_content` 会让 Cline 的思考内容被静默丢弃
（表现为「模型不思考」，且 reasoning 档位看似无效）。

解析器用 `delta?.reasoning_content ?? delta?.reasoning` 合并（同一帧只会出现其中一个）。

### 4.2 网关路由元数据（cline-routing.ts）

逐帧观测、**最后一次非空为准**：

| 形态 | 路径 |
|---|---|
| **流式（真实链路）** | `choices[0].delta.provider_metadata.gateway.routing.finalProvider` |
| 非流式 / planner | `choices[0].message.provider_metadata.gateway.routing.finalProvider` |
| 帧顶层 | `provider_metadata.gateway.routing.finalProvider` |
| direct 管线 | `delta.provider` / 顶层 `provider` |

**大小写两种拼写都要认**：`provider_metadata` 与 `providerMetadata`。
`finalProvider` 既可能是基础设施商（`alibaba`）也可能是模型厂商自己的 API（`deepseek`）
—— 原样展示，不要归类。
读不到就返回空串，绝不编造。

### 4.3 思考档位实测数据（cline-product.ts:216-231）

`stealth/space-bunny-alpha`，同题 3 次采样均值：

| effort | reasoning 字符数 |
|---|---|
| 不传 / `none` | 0（**不传 = 不思考**） |
| `low` | 67 |
| `medium` | 379 |
| `high` | 294 |
| `xhigh` | 259（与 high 无可辨差异 → 伪档位，跳过） |
| `max` | **1192**（high 的 4 倍 → 最高档） |

档位 id 与展示名刻意不同：UI 菜单是 None/Low/Medium/High/**Extra**，
wire 值是 `none/low/medium/high/max`。默认档位 `high`。

### 4.4 空闲超时

首 token 与 chunk 间隔各 120_000 ms
（**每次 `stream()` 调用时读取**环境变量，模块顶层常量会在 import 时定型导致测试失效）。

---

## 5. 模型目录

**三个来源**：

### 来源 A：`GET /api/v1/ai/cline/recommended-models`（**唯一权威的 free 集合**）

无需认证。响应解析取三个数组：
```json
{ "free": [{id, name, description}], "recommended": [...], "clinePass": [...] }
```

**`clinePass` 不是免费集合** —— 它是 Cline Pass 订阅制模型（`cline-pass/*`），
按订阅额度计费。把它当免费会误导用户。
实测条目只有 `{id, name, description, tags}` —— **不下发任何能力字段**。

### 来源 B：`GET /api/v1/models`（需认证）

响应形状：`{ data: [{ id, object, created, owned_by }] }`，解析取 `data[].id`。

实测 **460 个 id 里根本没有 `cline-free/*`** —— 免费模型**只**由
`recommended-models` 下发。这是「只调 `/models` 会看不到任何免费模型」的原因。

### 来源 C：`https://models.dev/api.json`（补名字/窗口/图片能力）

- 常量：`CLINE_MODELS_DEV_URL`，超时 20_000 ms，TTL **6 小时**
- provider 块位置有**两种**实测形态，两者都认：`json['cline-pass']` 与 `json.providers['cline-pass']`
- 模型 id 可能是**裸 id**，需补 `cline-pass/` 前缀
- 读取字段：`name`、`limit.context` → contextWindow、`modalities.input` 含 `image` → supportsImage
- **只认 `image`**：models.dev 还报 `audio` / `video` / `pdf`，而 DSH 模态词表只有 `text` / `image`
- **不取 `limit.output`（maxTokens）** —— 一旦下发就是真写进请求体的 `max_tokens`
- **失败绝不抛到调用方**：拿不到就保持「未知」，退回本地兜底表；
 `undefined` = 还没读到（不是「空目录」）

### 免费判定（cline-models.ts:89-98，不硬编码模型名）

```
isFree(id) = remoteFreeIds.has(id)        // recommended-models 的 free 数组
         || id.endsWith(':free')          // 内嵌目录里的 :free 条目
         || id.startsWith('cline-free/')  // 命名约定兜底
         || fallbackEntry.isFree === true // 静态兜底表
```

用**后缀**而非 `includes(':free')`：`openrouter/free` 这类 id 不含冒号。
**免费模型是独立 id**：`cline-free/deepseek-v4.1-flash`（免费）与
`deepseek/deepseek-v4.1-flash`（按量计费）是两个不同条目。

### 合并顺序（cline-models.ts:200-264）

1. 远端 `free` 数组（最权威，顺序有意义）
2. 兜底表（**仅用于给远端仍认识的条目补元数据**）
3. `recommended` / `clinePass` 里未覆盖的
4. 远端 `/models` 其余 id（放最后 —— 460 个，放前面会把免费模型挤到看不见）

**兜底表不是无条件并入的**：远端成功下发目录时，兜底表里「远端已不认识」的条目会被丢弃
（那是上游下架的模型），只在远端不可用时才整表保底。
判据用 `entries` 非空（三者拼成），**不是** `freeIds` 非空。

真实报障：`cline-free/deepseek-v4.1-flash` 于 2026-10-05 从 `free` 数组移除后仍在模型列表里
以「免费」出现，选中却回 `404 {"error":"model not found"}`。

### 兜底静态模型表（cline-product.ts:164-195，实测 2026-10-05 复测：free 共 3 个）

| id | name | contextWindow | maxTokens | supportsImage | isFree |
|---|---|---|---|---|---|
| `stealth/space-bunny-alpha` | Space Bunny Alpha | 1_000_000 | 524_288 | true | true |
| `cline-free/mimo-v2.6-flash` | MiMo-V2.6-Flash | 1_048_576 | 131_072 | true | true |
| `cline-free/muse-spark-1.3-contributor` | Muse Spark 1.3 Contributor | 1_048_576 | 943_718 | true | true |

这条表要与远端 `free` 数组同步 —— 它是**编译期快照**。已发生两次下架未同步。

### 思考档位表（全 provider 统一）

```
none / low / medium / high / max        （name: None/Low/Medium/High/Extra）
```

远端**不下发**档位；档位只存在于客户端内嵌目录，而那张表覆盖不了远端 460 个 id。
故对所有模型统一给这 5 档。已知局限：对不在内嵌目录里的模型档位是猜的
—— 但上游对不认识的档位静默忽略而不报错，最坏情况是「开关无效」。

### 展示名

免费模型拼 ` · 免费`。
**必须写进 `name` 而非 `description`** —— composer 的模型切换菜单只渲染 `name`。

---

## 6. 额度查询

Cline 有**两个不同的额度概念**。

### 6.1 余额（还剩多少钱）

```
GET https://api.cline.bot/api/v1/users/{userId}/balance
Authorization: Bearer workos:<jwt>
Accept: application/json
+ clientHeaders
→ { "data": { "userId": "usr-…", "balance": 500000 }, "success": true }
```

**`userId` 用凭据里的 `account_id`，不是 JWT 的 `sub`**：
实测传 `sub`（`user_01M3BCQ86DV4S9KKBT85X4GKTV`）返回 `400 {"error":"Invalid request format"}`。
两者形态完全不同（`usr-…` vs `user_…`），极易混用。

换算系数 `CLINE_BALANCE_SCALE = 100_000`：
-  **这是全模块唯一的不确定点**。实测 `balance: 500000`，按 1e-5 USD 解释则 ÷100000 = **$5.00**
- **没有源码证据**
-  **不要用 `/usages` 的 `costUsd` 反推本系数**：两个字段口径不同，不可互推

**失败形态有两种，必须都认**：
- `{success:false, error:"…"}`（业务层失败，HTTP 200）
- `{error:"Unauthorized: …"}`（网关层失败，HTTP 401 —— **没有 `success` 字段**）

### 6.2 订阅额度窗口

```
GET https://api.cline.bot/api/v1/users/me/plan/usage-limits
→ { success: true, data: { limits: [{ type, percentUsed, resetsAt }] } }
  type ∈ five_hour | weekly | monthly
```

**三条实测坑**：
1. **`resetsAt` 是 ISO 字符串且带纳秒精度**（9 位小数）—— 不要按毫秒去解析
2. **用量为 0 的窗口 `resetsAt` 是空串**
3. **额度端点用字面量 `users/me`**，由网关按 Bearer 令牌判定账号，
  **不依赖凭据里的 `account_id`**

- `percentUsed` **不做夹取** —— 网关若给 120（超额）如实透传
- `resetsAt` 若某天回数字时间戳，**不在这里猜单位**
- 失败一律「作为数据上报」（`ok:false` + `error`），不抛错
-  **不把「查不到」显示成 0**

### 6.3 签到：**不存在**

对整个 sidecar 做字符串扫描，`checkin` / `check-in` / `daily` / `campaign`
均无任何 Cline 业务端点命中。

---

## 7. 特殊机制

### 7.1 限流 / rate limit（cline-rate-limit.ts）

**Cline 不给 `retry-after` 头，也不给绝对时刻**，它把等待时长写在**人类可读的英文句子**里。
直连取证（2026-10-03）：

```
POST /api/v1/chat/completions   {"model":"cline-free/deepseek-v4.1-flash"}
→ HTTP 429
 no-retry: true                     ← 没有任何 retry-after 头
 {"error":{"code":"INFERENCE_CAP_ERROR",
   "message":"Error 429: Daily free limit reached on model
              deepseek/deepseek-v4.1-flash. Try again in 19h 39m"}}
```

**取值优先级（4 层）**：
1. `retry-after` 响应头
2. 报文里的 `Try again in 19h 39m` —— 正则 `try again in\s+([^.;\n]*)`
3. 通用句式（绝对时刻 + 时区）
4. 快照式兜底

时长 token 正则：`(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])`

尾部 `(?![a-z])` **不可去掉**：没有它，`2 minutes` 里的 `m` 也会命中，
同一段被算两次 → 时长翻倍。

各 token **累加**（`1h 30m` = 90 分钟），**不设上限**。
必须每次重置 `lastIndex`。

**必须同时认三种错误外壳**：`{error:{code,message}}`、`{error:"…"}`、`{message:"…"}`，
甚至**非 JSON 的纯文本**。

**只有 429 记限流徽章** —— 402（额度耗尽）没有「多久后重置」可言。

**当日免费额度是按模型单独计的**（同一时刻实测）：

| 模型 | 结果 |
|---|---|
| `cline-free/deepseek-v4.1-flash` | 429 `Daily free limit reached … Try again in 19h 29m` |
| `cline-free/mimo-v2.6-flash` | **200**（正常出字） |
| `cline-free/muse-spark-1.3-contributor` | **200** |

**不要建议「改用 `cline-pass/*` 付费通道」**：那是**订阅**通道，
实测有余额（`balance: 500000`）但未订阅时回
`403 {"error":{"code":"ENTITLEMENT_ERROR","message":"the user is not subscribed to required model plan"}}`。

**三种情形的动作完全不同**：

| 形态 | 正确动作 |
|---|---|
| 402 `Insufficient credits` | 去 app.cline.bot 充值 |
| 429 `Daily free limit reached` | **等没用**（按天结算），改用同一账号的**另一个免费模型** |
| 429 其它 | 等一会儿 / 换账号 |

文案**不用 markdown**：`**加粗**` 在 harness 的错误气泡里**原样显示星号**。

### 7.2 请求记录（cline-request-log.ts）—— 本地流水

| | 本地流水 | 网关 `/users/{id}/usages` |
|---|---|---|
| 记什么 | **本插件发出的**每笔请求 | 该账号在 Cline **官方所有渠道**的消费 |
| 延迟/首块 | ✓ | ✗ |
| 成本 | ✗ | ✓ `costUsd` |

- 存储是**进程内存**，重启即丢（刻意），上限 **100** 条
- `record()` **绝不抛错**
-  **`usageReported` 与「token 为 0」不是一回事**：网关没发 usage 时表格必须显示 `—`
-  **`ttftMs` 与 `ttfcMs` 是两个时刻**：`ttftMs` 是「收到的第一块」（可能是思考增量），
 `ttfcMs` 是「第一块**正文**」。速率的正确口径是**正文阶段**：
 分子 = `outputTokens − reasoningTokens`，分母 = `totalMs − ttfcMs`
 （用户报障的 `11814.8 t/s` 就是拿 `outputTokens ÷ (totalMs − ttftMs)` 算出来的）
-  `effort` 与 `upstream` **始终写字符串**（缺省空串）
-  **请求记录的「账号」列必须用池 id**，不能用凭据里的 `account_id`
-  换号过程**不逐笔记**：只记**最终结果**一笔
