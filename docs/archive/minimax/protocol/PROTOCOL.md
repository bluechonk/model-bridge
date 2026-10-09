# MiniMax Code 协议规格

提取自 `dsh-our-free-model/vendor/channel-pack/src/minimax*.ts`。

**本渠道是 Anthropic Messages 协议族**（不复用 OpenAI 兼容层）。

---

## 1. 端点

| 用途 | 方法 | 完整 URL | 来源 |
|---|---|---|---|
| OAuth 设备码申请 | POST | `https://account.minimax.cn/oauth2/device/code` | minimax-product.ts:155, 179 |
| OAuth 令牌（轮询 + 续期共用） | POST | `https://account.minimax.cn/oauth2/token` | :155, 181 |
| OAuth 撤销 | POST | `https://account.minimax.cn/oauth2/revoke`（常量定义，**全仓无引用**） | :183 |
| 模型目录 | GET | `https://agent.minimax.cn/mavis/api/v1/models?region=cn&buildEnv=prod` | :156, 185 |
| 对话（Anthropic Messages） | POST | `https://agent.minimax.cn/mavis/api/v1/llm/v1/messages` | :192 |
| 签到状态 | GET | `https://agent.minimax.cn/minimax-cloud/api/v1/signin/status?timezone_id=<IANA>` | :194 |
| 签到领取 | POST | `https://agent.minimax.cn/minimax-cloud/api/v1/signin/claim?timezone_id=<IANA>`，body `{}` | :196 |
| 积分明细 | GET | `https://agent.minimax.cn/minimax-cloud/api/v1/credit/details` | :198 |

- `accountHost = https://account.minimax.cn`
- `apiHost = https://agent.minimax.cn`
- `region='cn'`、`buildEnv='prod'`
- 超时：业务请求 30s、OAuth 20s、目录 TTL 300s

---

## 2. 认证

### 2.1 凭据字段（minimax.ts:18-49）

`access_token`（必填，前缀 `mmoat_`，实测 60 字符）、
`refresh_token`（实测 60 字符，前缀 `mmort_`）、`token_type`（恒 `'Bearer'`）、
`expires_at`（毫秒时间戳**字符串**；读取时 `> 1e12` 视为毫秒否则视为秒）、
`scope`、`account_id`、`nickname`

**实测硬事实**：`access_token` **不是 JWT**（`mmoat_` 前缀、60 字符、0 个点）
⇒ `decodeJwtExpMs` 对真实凭据恒返回 `undefined`，
**必须**由 `expires_in` 自算并写入 `expires_at`。

### 2.2 请求头

**业务请求头**：仅 `Authorization: Bearer <access_token>` + `Accept: application/json`。
不需要 machine 头、不需要签名。

**推理请求头**：`Authorization: Bearer <token>` + `Content-Type: application/json` +
`Accept: text/event-stream`。

实测**不需要** `anthropic-version` 头（2026-09-29 真实请求 200）
—— 源码明确要求「不照抄 Anthropic 官方文档加那个头」。

### 2.3 登录流程：OAuth 设备码 + PKCE

1. **生成 PKCE**：`code_verifier = base64url(randomBytes(32))`；
  `code_challenge = base64url(sha256(verifier, 'ascii'))`
2. **设备码请求体**（`application/x-www-form-urlencoded`）：
  ```
  client_id=mcode-public
  scope=agent.default
  audience=agent-backend
  code_challenge=<S256>
  code_challenge_method=S256
  ```
3. **设备码响应解析**：`device_code`、`user_code`、
  `verification_uri`（或 `verification_url`）、`expires_in` 必填；
  `interval` 可选，**单位秒**，缺省 5；
  `verification_uri_complete` 可选（优先用它，用户点开即完成）
4. **轮询请求体**：
  ```
  grant_type=urn:ietf:params:oauth:grant-type:device_code
  device_code
  client_id
  code_verifier
  ```

**轮询必须认两种「还在等」形态**（minimax-oauth.ts:10-16, 271-296）：
- 形态一：**HTTP 200** + `{"status":"pending"}`（MiniMax 自有）
- 形态二：非 200 + `{"error":"authorization_pending"}`（OAuth 标准）

`slow_down` 两形态都处理：`intervalMs += 5000`。
`status=denied|access_denied` → 用户取消；`status=expired|expired_token` → 过期。

源码注释明确：「只认标准形态会立刻抛错，用户来不及授权」。

**令牌响应硬校验**（:150-194）：
- `access_token` 非空
- `refresh_token` 非空（缺失回退上一个）
- `token_type.toLowerCase() === 'bearer'`
- `expires_in` 正数
- **`scope` 必须含产品 scope（`agent.default`）**，否则抛错

产出 `expires_at = String(fromJwt ?? Date.now() + expires_in*1000)`。

**续期请求体**：`grant_type=refresh_token`、`refresh_token`、`client_id`、`scope`、`audience`。
续期响应同样过 `parseMinimaxTokenGrant`（保留旧 refresh_token）。

**凭据 ref**：`MINIMAX_ACCESS_TOKEN`

---

## 3. 对话请求（Anthropic Messages 形状）

### 3.1 请求体（`buildMinimaxMessagesPayload`，minimax-messages.ts:77-140）

顶层键：
- `model`（模型 ID）
- `stream: true`（恒 true）
- `messages`（Anthropic 形状数组）
- `max_tokens`（可选）
- `system`（可选，**顶层字符串**，不是 `role:'system'` 消息）
- `temperature`（可选）
- `stop_sequences`（可选，数组）
- `tools`（可选）：`[{name, description, input_schema}]`
- `thinking`（条件下发）：`{type:'adaptive'}` 或 `{type:'disabled'}`
- `output_config`（条件下发）：`{effort: <档位>}`

### 3.2 思考决策表（真机实测）

| 情形 | 请求体 | 实测行为 |
|---|---|---|
| `effort === 'none'` | `thinking:{type:'disabled'}` | 0 思考字符 |
| `effort === 'on'` | `thinking:{type:'adaptive'}` | 2785+ 字符 |
| 有档位 effort | `thinking:{type:'adaptive'}` + `output_config.effort` | 档位真的改变思考量 |
| `requiresAdaptiveThinking`（模型名前缀 `MiniMax-M3.1`） | `thinking:{type:'adaptive'}` | 必须，否则 400 |
| 其余（M2.7 系） | **整个不发** | 服务端默认思考 |

- 必须 adaptive 的模型按**前缀**判定：`MINIMAX_ADAPTIVE_ONLY_PREFIX = 'MiniMax-M3.1'`；
 传 `disabled` 会被硬拒 `400 ... requires adaptive thinking ... not allowed (2013)`
-  **M3 不发 `thinking` 时默认「不思考」**（两轮实测各 0 字符），
 故 `on` 档必须显式发 `adaptive`

### 3.3 消息序列化（`serializeMinimaxMessages`，:186-356）

- assistant 的 `tool-call` 块 → `{type:'tool_use', id, name, input:<JSON 对象>}`
 （`input` 解析失败退化 `{}`）
- `tool-result` → user 消息里的 `{type:'tool_result', tool_use_id, content, is_error?}`
 （Anthropic 无 `role:'tool'`）
-  **成对提交规则**（:237-354）：harness 是「一条 assistant（N 个 tool_use）+ N 条独立 tool 消息」，
 必须把 assistant 与其全部结果**成对提交**（assistant 先进待发区，
 遇到结果或任何非工具消息时一起 push）。
 三种错误形态都会报 2013（逐条下发 / assistant 立即下发结果攒到下一轮 /
 纯 reasoning 空 assistant 被丢弃）
- 历史里的 `reasoning` 块**不回传**（Anthropic 要求 thinking 带签名，本地不持久化签名）
- 图片走 Anthropic `image` 块：`{type:'image', source:{type:'base64', media_type, data:<裸 base64>}}`
  **裸 base64，无 `data:` 前缀**。OpenAI 的 `image_url` 形状被明确拒绝：
 `400 ... unsupported content type 'image_url' (2013)`
- 消息体里的图片内联失败 → **抛错**（不静默丢图）；工具结果里的图片读不到 → 跳过

### 3.4 必需请求头

只有 `Authorization` / `Content-Type` / `Accept: text/event-stream`。**无任何伪装头**。

---

## 4. 流式响应（Anthropic SSE）

| 事件 | 用途 |
|---|---|
| `message_start` | `message.usage.input_tokens`、`cache_read_input_tokens` |
| `ping` | 保活，必须忽略 |
| `content_block_start` | `content_block.type` ∈ `thinking` / `text` / `tool_use` |
| `content_block_delta` | `thinking_delta` / `text_delta` / `signature_delta` / `input_json_delta` |
| `content_block_stop` | 该块结束 |
| `message_delta` | `delta.stop_reason`、`usage.output_tokens`（含 `thinking_tokens`） |
| `message_stop` | 结束 |
| `error` | `{type:'error', error:{type,message}}` |

细节：
- 帧自带 `type` 字段，优先用它（`event:` 行可能被代理吞掉）
- `content_block_delta` 的子类型判据：`delta.type === 'text_delta'` → 文本；
 `'thinking_delta'` → 思考（字段 `delta.thinking`）；
 `'input_json_delta'` → 工具参数（字段 `delta.partial_json`）
-  **`signature_delta` 必须忽略** —— 「当初把它当文本会往回答里注入一串十六进制」
-  **`thinking` 块要映射成 reasoning 块**，否则思考内容污染正文
- `index` 直接用服务端下发的 `index`，不自己计数
- 收尾：解码器 flush 后把 buffer 余量按整行再走一遍
 —— 否则被截断的流会丢掉携带 `stop_reason`/`usage` 的最后一帧
- 无任何内容块 → **抛错**
- `stop_reason` 映射：`tool_use` → tool-calls、`max_tokens` → max-tokens、
 `refusal`/未知/缺失 → stop
- usage 映射：`output_tokens_details.thinking_tokens` → reasoningTokens
 （是 output 的子集，**不相加**）

---

## 5. 模型目录

### 5.1 拉取

`GET {apiHost}/mavis/api/v1/models?region=cn&buildEnv=prod`，
头 `Authorization` + `Accept: application/json`

**响应形状**（`parseMinimaxModelsPayload`）：
```
{ providers: [ { providerId: "minimax", config: { models: { "<长名>": {...} }, model_order: [...] } } ] }
```

- 必须找到 `providerId === 'minimax'` 且 `config.models` 是非空对象
-  **对象 key 注入为 `id`（长名，如 `MiniMax-M3.1-Flash-Preview`），
 条目的 `name` 是短名（如 `M3.1-Flash-Preview`）** —— 两者必须分别保留
- 按 `model_order` 排序（若提供），否则保持插入序

**单条目归一**（`normalizeMinimaxModel`）：
- `contextWindow` 取 `context_window_options` **最大档**，无档位表回退 `limit.context`
- `maxTokens` 取 `limit.output`（只放行安全正整数）
- `supportsImage = modalities.input` 含 `image`
- `effortOptions` 取 `effort_options`
- `defaultEffort` 取 `default_effort` 且**必须落在 effortOptions 内**否则丢弃
- `thinkingMode` 取 `thinking_config.mode`

只实现 snake_case 字段名（实测远端即 snake_case）。
远端失败 / 解析出 0 条 → 回退兜底表并留 warn 日志。

### 5.2 兜底静态模型表（顺序照抄远端 `model_order`）

| id | name | contextWindow | maxTokens | supportsImage | effortOptions | defaultEffort | thinkingMode |
|---|---|---|---|---|---|---|---|
| `MiniMax-M3.1-Flash-Preview` | `M3.1-Flash-Preview` | 1_000_000 | 128_000 | true | `['default','low','medium','high','xhigh','max']` | `default` | `forced_on` |
| `MiniMax-M3` | `M3` | 1_000_000 | 128_000 | true | 无 | 无 | `switchable` |
| `MiniMax-M2.7-highspeed` | `M2.7-highspeed` | 200_000 | 128_000 | false | 无 | 无 | `forced_on` |
| `MiniMax-M2.7` | `M2.7` | 200_000 | 128_000 | false | 无 | 无 | `forced_on` |

- 窗口口径：`MiniMax-M3.1-Flash-Preview` 的 `limit.context` 是 512000，
 但 `context_window_options` 是 `[512000, 1000000]` ⇒ **取档位表最大档 1M**
- 只有 M3.1-Flash-Preview 有 `effort_options`，其余远端**没有**该字段
- `thinkingMode` 实测三种值：`forced_on`（M3.1 传 disabled 硬 400；M2.7 静默忽略）、
 `switchable`（M3 可开关）
-  兜底表路径**不调用归一函数**，直接搬运字面量

### 5.3 思考档位声明（`minimaxReasoningInfo`）

- `efforts` = 远端 `effort_options`；
 `thinkingMode === 'switchable'` 时**追加 `on` 与 `none`**
 （顺序：先 `on` 后 `none`，`none` 显示名「关闭思考」、`on` 显示名「开启思考」）
- `forced_on` 的模型**绝不**追加任何开关
- 两者皆无 → 返回 `undefined`（不声明）

---

## 6. 额度 / 签到

### 6.1 常量

```python
MINIMAX_SIGNIN_STATUS = {Upcoming: 1, Claimable: 2, Claimed: 3, Disabled: 4}
MINIMAX_CLAIM_RESULT  = {Claimed: 1, AlreadyClaimed: 2}
MINIMAX_PANEL_SCENE   = {Unknown: 0, First: 1, Active: 2, Completed: 3, Broken: 4}
```

请求头同业务头（Bearer + Accept）；有 body 时加 `Content-Type: application/json`。

### 6.2  五个必须记住的点（minimax-credits.ts:12-23, 262-328）

1. **`timezone_id` 是 query 参数且必填**，值取
  `Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"`
  （Python 对应：`datetime.now().astimezone().tzname()` 不够，
  应用 `zoneinfo` 或直接取 `time.tzname`；**必须传 IANA 名**）。
  请求头传无效、都不带报 `invalid timezone_id`
2. **业务码在 `base_resp.status_code`**（不是 `code`），
  且 `invalid timezone_id` 也是 **HTTP 200**
3. **两个端点响应形状不同**：
  `signin/status`、`signin/claim` 是信封（业务字段在 `data` 下）；
  `credit/details` 是**平铺的**（`total_count` 与 `base_resp` 同级，**无 `data` 键**）。
  解析函数 `unwrapEnvelopeData` 兼容两者
4. `points` 是总数、`bonus_points` 是其中的额外部分，**不得相加**（实测 800 / 400）
5. 「今日已领」判据是 `is_today && status === 3`；
  领取幂等判据是 `claim_result === 2`（重复领取同样 HTTP 200）

### 6.3 签到面板硬校验（`parseMinimaxSigninPanel`）

`days` 恰好 7 条、`day_no` 1..7 整数且无重复、`points` 非负、
`is_today` 是 boolean、`status` ∈ {1,2,3,4}、最多 1 条 Claimable、
最多 1 条 `is_today`、`scene` ∈ {0..4}

### 6.4 积分余额（`fetchMinimaxCreditBalance`）

- **余额 = Σ `details[].remaining_amount`**（字符串形态，需宽容解析）
- 实测原始响应：
 ```json
 {"details":[{"remaining_amount":"800.00","consumed_amount":"0.00","granted_amount":"800.00",
              "credit_type":2,"granted_at_ms":...,"expire_at_ms":...}],
  "total_count":1,"base_resp":{"status_code":0,"status_msg":"ok"}}
 ```
-  `total_count` 是 **`details[]` 的记录条数**，不是余额
 （:405-422 记录了这个已被生产数据推翻的误读）
- `details` 缺失 → 余额 0（「真的为 0」）；`base_resp.status_code` 非 0 → `null`（真失败）
- `expiredTotal` 恒 0、`packages` 恒空（不凭猜测分类）

`isStreakDay` 字段当前**不可判读且几乎恒为 true**，未修复。
Python 实现建议直接置 false 或省略。

---

## 7. 未实测项（如实说明）

- 单图上限 10 MiB / 请求体上限 64 MiB：源码标注「远端 `capabilities.*`，**未实测**」
- 内联图片路径：目录条目声明 M3.1 / M3 支持图片，但源码注释说「带图请求未实测」，
 同时另一处又说 2026-09-29 真机实测通过（自造 40x40 纯红 PNG → 模型答「红色」）。
 两处注释口径不一致，**按后者（已实测）为准**，但请留意这一矛盾
- `/oauth2/revoke`：常量有定义但**全仓零引用** —— 退出登录路径是否真的调它，未找到
