# TRAE 协议规格（字节跳动）

提取自 `dsh-our-free-model/vendor/channel-pack/src/trae*.ts`。

---

## 1. 端点与常量

### 1.1 基址

| 字段 | 值 | 来源 |
|---|---|---|
| `agentHost`（对话 + 模型列表） | `https://trae-api-cn.mchost.guru` | trae-product.ts:182 |
| `ugHost`（签到/积分） | `https://api.trae.cn` | 184 |
| `oauthHost`（ExchangeToken / GetUserInfo） | `https://api.trae.com.cn` | 186 |
| `consoleHost`（登录门户） | `https://www.trae.cn` | 188 |
| `clientId` | `en1oxy7wnw8j9n` | 321 |
| `appId` | `6eefa01a-1036-4c7e-9ca5-d891f63bfcd8` | 322 |
| `ideVersion` / `ideVersionCode` | `0.1.52` / `20260811` | 323-324 |
| `deviceBrand` / `osVersion` | `Apple` / `macOS 15.7.4` | 325-326 |
| `function`（默认通道） | `solo_work_lite` | 327 |
| `pluginVersion`（登录 URL 用，≠ideVersion） | `2.3.62834` | 333 |
| `userAgent` | `Trae/0.1.52` | 335 |

**源码中不存在国际版（trae.com）配置** —— 只有这一份 CN 配置。
`trae.cn`（UG/登录门户）与 `trae.com.cn`（OAuth）是同一份配置里的两个 host。

**版本号是模型准入条件**：上游按 `X-Ide-Version` / `X-App-Version-Code` 决定哪些模型可返回，
版本过低时 glm-5.3 等新模型报 `4001 param is invalid`。

### 1.2 端点清单（trae.ts:44-70）

| 用途 | 方法 | 路径 | Host |
|---|---|---|---|
| 对话 | POST | `/api/agent/v3/llm_utils_chat` | agentHost |
| 模型列表（单通道，**无调用方**） | POST | `/api/ide/v1/get_detail_param` | agentHost |
| 模型列表（多通道，**实际使用**） | POST | `/api/ide/v1/batch_get_detail_param` | agentHost |
| ExchangeToken | POST | `/cloudide/api/v3/trae/oauth/ExchangeToken` | oauthHost（或凭据 `api_host`） |
| GetUserInfo | POST | `/cloudide/api/v3/trae/GetUserInfo` | 同上 |
| 签到状态 | POST | `/trae/api/v2/ug/checkin_credits/status` | `https://api.trae.cn`（**硬编码**） |
| 签到领取 | POST | `/trae/api/v2/ug/checkin_credits/claim` | 同上 |
| 积分余额 | POST | `/trae/api/v2/pay/ide_user_ent_usage` | 同上 |
| 登录回调 | — | `http://127.0.0.1:18080/authorize` | 本地 |

超时：控制面 `30000ms`；登录总超时 `600000ms`（trae.ts:68-70）。

---

## 2. 认证

### 2.1 登录：浏览器授权 + 本地回调

**回调直接回传 token**，不是 OAuth `?code=`。

登录 URL：`{consoleHost}/authorization?` + **17 个参数**（trae-oauth.ts:99-127），逐字为：

```
login_version=1
auth_from=solo
login_channel=native_ide
plugin_version=2.3.62834
auth_type=local
client_id=en1oxy7wnw8j9n
redirect=0
login_trace_id=<machineId+deviceId 拼接的尾 16 字符>
auth_callback_url=<实际回调地址>
machine_id
device_id
x_device_id
x_machine_id
x_device_brand=PC
x_device_type=PC
x_os_version=1.0
x_app_version=0.1.52
x_app_type=stable
```

**参数名必须是 `auth_callback_url`**（没有 `callback_url`/`redirect_uri`），
写错登录页**永远停在授权中**（真实缺陷）。

**回调解析**（trae-oauth.ts:263-345）：
- `refreshToken`（query，缺则回退 `userJwt.RefreshToken`）
- `userInfo.UserID`、`userInfo.ScreenName`、**`userInfo.TenantID`**（不是 EnterpriseID）
- `userJwt.Token`
- 另有 PKCE 新流程变体 `code` / `authCode` / `authCodeInfo`（**不支持**，明确报「上游走了 PKCE 流程」）
- 昵称有 latin-1 双重编码乱码（实测 `Óû§8847309959`），用 `raw.encode('latin1').decode('utf8')` 修复；
 修不好且无 CJK 时回退 `用户+uid末4位`

**ExchangeToken**（trae-oauth.ts:375-393）：
```
POST {oauthHost}/cloudide/api/v3/trae/oauth/ExchangeToken
Headers: Content-Type: application/json, Accept: application/json, User-Agent
Body: {"ClientID":"en1oxy7wnw8j9n","RefreshToken":"<refreshToken>","ClientSecret":"-","UserID":""}
→ {Result:{Token, RefreshToken, TokenExpireAt, TokenExpireDuration, RefreshExpireAt}}
```
（大小写两种键都接受。**access 与 refresh 都轮换**，续期后必须回写）

**GetUserInfo**（trae-oauth.ts:417-424）：同 host，头加 `X-Cloudide-Token: <accessToken>`；
体 `{"ReqSource":"IDE","IDEVersion":"0.1.52"}`；
响应 `Result.{UserID, ScreenName, EnterpriseID, NonPlainTextMobile, NonPlainTextEmail}`。失败不阻塞登录。

**回调端口 18080**，被占用（EADDRINUSE/EACCES）时回退随机端口，登录 URL 用**实际**端口重算（:479-543）。

**身份生成**：`machine_id` = 16 随机字节的 32 位 hex；`device_id` 同样 **32 位 hex**
（早期误做成 16 位纯数字，与协议不符；trae.ts:1299-1321）。

### 2.2 凭据字段（trae.ts:89-155）

`access_token`、`refresh_token`、`expires_at`（**毫秒字符串**，兼容秒/ISO/JWT exp 兜底）、
`uid`、`nickname`、`phone`（脱敏手机号）、`email`（脱敏邮箱）、
**`machine_id`（32 hex，登录后绝不变）**、**`device_id`（32 hex，每账号互不相同）**、
`domain?`、`api_host?`、`enterprise_id`

同日两账号共用 device_id 会被「该设备已签到」拦截。

### 2.3 续期

同 ExchangeToken 流程；只改 `access_token`/`refresh_token`/`expires_at`，设备指纹字段完全不动（trae-auth.ts:378-432）。

**终态（需重新登录）三条任一**：
- HTTP 401/403
- 错误分类为 `session-dead`
- **2xx 且响应是 JSON 却没有 accessToken**

凭据失效时网关返回 HTML 错误页，必须先 `text()` 再试 `JSON.parse`，不能直接 `.json()`。

---

## 3. 对话请求

### 3.1 请求头（`traeSOLOHeaders`，trae.ts:204-236）

| 头 | 值 |
|---|---|
| `Content-Type` | `application/json` |
| `Accept` | `text/event-stream`（流式）/ `application/json` |
| `User-Agent` | `Trae/0.1.52` |
| `Authorization` | `Cloud-IDE-JWT <access_token>` |
| `X-Cloudide-Token` | `<access_token>` |
| `X-Ide-Token` | `<access_token>` |
| `X-Uid` | `uid` |
| `X-App-Id` | `6eefa01a-1036-4c7e-9ca5-d891f63bfcd8` |
| `X-App-Version` | `default` |
| `X-Ide-Version` / `X-Ide-Version-Code` | `0.1.52` / `20260811` |
| `X-App-Version-Code` | `20260811` |
| `X-Ide-Version-Type` | `stable` |
| `X-Device-Type` | `macos` |
| `X-OS-Version` | `macOS 15.7.4` |
| `X-Device-Brand` | `Apple` |
| `Request-Traffic-Type` | `prod` |
| `X-Machine-Id` | `machine_id` |
| `X-Device-Id` | `device_id` |

**同一 token 设三处**（Authorization / X-Cloudide-Token / X-Ide-Token），**缺任一个都可能被拒**。

### 3.2 请求体（`transformToSOLOBody`，trae.ts:1545-1577）

1. `stream` **强制 true**
2. `function` = 该模型所属通道（缺省 `solo_work_lite`）
3. `model` 与 `config_name` **双字段都设为 config_name**；`__` 后缀（`__dev`/`__max`）去掉
4. `messages[].content` 字符串 → `[{type:"text",text:...}]`；已是数组则透传
5. assistant 的 `tool_calls[].function` → `function_call`；无 `function_call.name` 的调用被剔除
6. `tools[].function.parameters` 对象 → **JSON 字符串**（SOLO 要求）
7. `tool_choice` 归一化：`"none"`/`{type:"none"}` → 删 `tool_choice` + 删 `tools`/`functions`；
  `auto`/`required` → 字符串；`{type:"function",function:{name}}` → 字符串 name
8. `max_tokens` 收敛到安全上限 **64000**（实测客户端索要 131072 会被上游打成 4xx）
9. `reasoning_effort` 原样透传

**Max 模式（1M 上下文）字段**（trae.ts:1508-1525，仅远端 `display_config.max_mode === true` 的模型允许）：
`model_auto_selection:{strategy:'max',...}`、`model_selection_strategy:'max'`、`mode_type:1`、
`context_window_size:<maxContext>`、`prompt_max_tokens:936000`、`max_tokens:<__max 明细或 64000>`
只调大 `max_tokens` 无效，必须成套下发。

### 3.3 特殊约束

- 请求体**不存在** `query` 字段
- **本地无历史裁剪闸门**
-  **工具消息顺序硬约束**：`role:'tool'` 必须紧跟其 assistant `tool_calls`，
 中间插任何消息（含带图 user 消息）会被拒
 `code=4027 Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`；
 坏报文会落进会话历史导致**永久无法对话**（trae-adapter.ts:463-506）
- 图片能力逐模型判定（远端 `display_config.multimodal`）
- 空响应（HTTP 200 但一个事件都没发）判为可重试的 TRANSPORT，同账号重试一次

---

## 4. 流式响应（自定义 SSE，非 OpenAI 标准）

### 4.1 事件类型（trae.ts:1714-1733）

| event | data 字段 | 说明 |
|---|---|---|
| `metadata` / `timing_cost` / `extra_info` | 未消费 | 出现即算「上游已开工」 |
| `output` | `response`（正文**增量**）、`reasoning_content`（思考**增量**）、`tool_calls`（null 或数组） | 主要帧 |
| `token_usage` | `prompt_tokens`、`completion_tokens`、`reasoning_tokens` | 用量 |
| `done` | `finish_reason` | **流结束标志** |
| `error` | `code`、`message` | 业务错误 |

- `tool_calls[]` 里 `function_call` → `function`，并清理 SOLO 专属字段 `namespace` / `partial_arguments`
- 帧格式：`event:<name>\n` + `data:<json>\n\n`，空行是事件分隔；`data:` 可跨行拼接；
 注释行（`:`）忽略（trae.ts:1860-1917）
- 结束：`done` 事件（非 `[DONE]`）；转成 OpenAI 时最后发 `data: [DONE]\n\n`

### 4.2 错误码与换号

| 码 | 语义 | 处理 | 来源 |
|---|---|---|---|
| `1005` | Plan 权益不足 → `hard-plan`，冷却 12h | 换号 | trae-errors.ts:78-79 |
| `4008` | 配额耗尽 → `quota-exceeded`（**判定必须先于 4011**） | 换号 | :96-98 |
| `4011` | 频率超限 → `soft-rate`，60s | 换号 | :101-103 |
| `4001` | 模型不可调用（`param is invalid`） | **不换号**，如实报错 | trae-adapter.ts:550-555 |
| `4027` | tool 消息顺序错误 | 直接失败 | :468-472 |
| `4023` | `the model is unknown`（不可调用通道） | 通道白名单已挡 | trae-product.ts:110 |
| `3003` | `model service is unavailable`（`inline_chat`） | 同上 | :110 |
| `9074` | 签到人数过多（设备级限流） | 冷却 300s | trae-credits.ts:107 |

流内 `event:error` 在**尚未产出任何内容**时用内部哨兵码抛出交给外层换号；
**已有输出则如实抛错，绝不重放**（防重复计费）（trae-adapter.ts:1120-1200）。
换号上限 3 个账号，限流标记回退时长 1 小时。

---

## 5. 模型目录

### 5.1 拉取（trae-auth.ts:676-706）

```
POST {agentHost}/api/ide/v1/batch_get_detail_param
Body:
 functions: [22 个通道，逐字]
   ui_builder_v2, solo_coder, chat_v3, solo_builder, builder_v3, builder,
   chat, inline_chat, git_ai, custom_agent_generation, utils, code_reviewer,
   code_review_summary, solo_agent, solo_agent_remote, solo_work_remote,
   solo_agent_lite, solo_work_lite, solo_design_lite, solo_design_remote,
   multimodal, system_diagnosis
 agent_type: ""
 current_config_info: { config_name: "", is_custom_model: false }
 mode_type: 0
 access_type: 0
 ab_force_vids: ""
 ab_autotest_advanced_mode: 0
 show_custom_model: true
```

响应 `{function_configs:[{function, config_info_list:[...]}]}`，每个 function 各自一套目录。

条目字段：`config_name`（id）、`display_config{display_name, is_custom_model, max_mode, multimodal,
tool_response_multimodal}`、`context_window_tokens{dev,max}`、
`model_detail_list[{model_name, max_tokens}]`（`__dev`/`__max` 后缀区分）、
`reasoning_effort_config{default_level, options[], support_thinking}`、`usage`、`config_switch`、
`is_invisible_to_user`、`display_contact_config`（**JSON 字符串**，内含 `consumption_rate` 与 `activity_discount`）

缓存 TTL 30 秒、含空结果。

### 5.2 通道白名单机制（重点）

白名单（顺序即优先级，共 15 个，可用 `DSH_TRAE_CHANNELS` 覆盖整张表）：

```
solo_agent, solo_work_lite, solo_agent_remote, solo_work_remote, solo_agent_lite,
chat_v3, builder_v3, solo_coder, solo_design_lite, solo_design_remote,
git_ai, code_reviewer, code_review_summary, multimodal, system_diagnosis
```

它**同时是白名单与排序表**：不在表内的通道**整组丢弃**（连同其独有模型）；
同一模型被多个白名单通道列出时，按「空档位不得覆盖有档位」→「两侧都有档位时取更靠前者」→
其余「后覆盖前」合并。

**稳定被拒的通道**：`chat`（4023）、`builder`（4001）、`inline_chat`（3003）
**目录恒空**：`ui_builder_v2`、`solo_builder`、`custom_agent_generation`、`utils`

**硬过滤**：`usage !== 'chat_completion'` 剔除、`config_switch === false` 剔除、
`is_invisible_to_user === true` 剔除；`is_custom_model === true` 运行时过滤（实测 5/5 报 4001）。

### 5.3 兜底静态模型表（32 条，trae-product.ts:196-229）

```
DeepSeek-V4-Flash-Official, Doubao-Seed-2.1-Pro, seed-code-pro-0430,
Doubao-Seed-2.1-Turbo, Doubao-Seed-2.0-Code, browser_use_subagent(hidden),
glm-5.2, glm-5-turbo, glm-5, DeepSeek-V4-Pro, DeepSeek-V4-Flash,
kimi-k3, kimi-k2.7-code, kimi-k2.6, minimax-m3, qwen-3.7-plus,
sagitta, aquila, custom_model_gemini, custom_model_placeholder,
custom_model_1M_text, custom_model_1M, custom_model_kimi, custom_model_claude,
custom_model_gpt-5, custom_model_no-fc, custom_model_deepseek_chat,
custom_model_deepseek_reasoner, custom_model_deepseek_v4,
explore_sub_agent_v13(hidden), explore_sub_agent_v2(hidden), summary(hidden)
```

全部 `contextWindow=200000`（估值，远端可用时完全采信远端），产品级兜底输出上限 32000。

---

## 6. 额度查询（签到）

全部走 `https://api.trae.cn`（**硬编码**，未用 `product.ugHost`）。

### 6.1 签到头（约 20 个，trae.ts:281-314）

```
Content-Type: application/json
Accept: */*
Accept-Encoding: gzip, deflate
Accept-Language: zh-CN
User-Agent: VSCode 1.107.1 (TRAE SOLO CN)
Authorization: Cloud-IDE-JWT <token>
X-Market-Client-Id: VSCode 1.107.1
X-Market-User-Id: <派生 UUIDv4>
X-User-Region: CN
X-Device-Id: <派生 15 位数字>
X-Lgw-Req-Sdk-Type: 3
Package-Type: stable_cn
X-Lscbd-Aid: 787976
X-Lscbd-Platform: windows
App-Version: <product.ideVersion>
X-Tt-Trace-Id: 00-<randomHex(16)>-01
Vscode-Sessionid: <派生 64 hex>
X-Request-Id: <uuidV4>
Sec-Fetch-Dest/Mode/Site: empty/no-cors/none
```

**设备身份确定性派生**（对齐 trae-mate `device_map.rs`，trae.ts:324-381）：
`SHA256(utf8("<salt>:<user_id>") ++ counterBE32)` 串联流
- `deviceId15` salt=`devid`（15 位数字）
- `marketUserId` salt=`market`（version 4 / variant RFC4122 的 UUID）
- `sessionId` salt=`sess`（64 hex）

每个账号稳定唯一，从而规避「每设备每天一次」配额。

### 6.2 三个端点

```
POST /trae/api/v2/ug/checkin_credits/status   body {} 
 → {code:0, checked_in, credits, enable, streak_days, total_credits}

POST /trae/api/v2/ug/checkin_credits/claim    body {}（不是 {"req_source":2}）
 → 成功响应仅 {"code":0,"message":"success"}，**不含积分数**，必须补查一次 status 拿 credits（实测 150）

POST /trae/api/v2/pay/ide_user_ent_usage      body {"require_usage": true, "req_source": 2}
 → user_entitlement_pack_list[]，每条取 entitlement_base_info.display_desc（包名）、
   entitlement_base_info.quota.credits_limit、usage.credits_amount、
   条目级 expire_time（**秒**级 Unix，×1000 才是毫秒）
   remaining = credits_limit - used
```

### 6.3 错误分类冷却表（trae-credits.ts:74-100）

`200+code1005` → PlanLimit 43200s；429 → SoftRate 60s；401 → SessionDead 永久；
404 → 60s；5xx → 600s；4xx → 600s；业务码非 0 → 300s

`classifyTraeError` 标记表（trae-errors.ts:46-60）：
- session-dead 标记 `['login','token 失效','token invalid','session','unauthorized','401']`
- plan 标记 `['"code":1005','1005']`
- 配额标记 `['4008','"code":4008','quota','exceeded the quota']`

判定顺序：1005+plan → 4008 → 4011 → 401 → 429 → 404 → 5xx → 4xx → none

---

## 7. 其他特殊机制与坑

- **machine_id 默认不轮换**：只有 `DSH_TRAE_ROTATE_MACHINE_ID=1` 时每 4 次请求派生一代
- **签到设备轮换代次**：`deriveCheckinDeviceId` = `sha256(base#genN)` 前 32 hex；
 9074 是 **device_id 级**限流
- **思考档位**：`reasoning_effort_config.options` 是单值字符串（既展示名也是 wire 值）；
 默认档**采信上游 `default_level`**（实测上游会下发不在 options 里的 `default_level:'max'`，
 此时必须退到最强档，不能照抄）
- **展示名带倍率**：`名称 · x0.08` 或活动期 `名称 · x0.80→x0.08`；`rate===0` 显示「免费」；
 `display_contact_config` 必须二次 `JSON.parse`（它是字符串）
- `is_invisible_to_user`（官方隐藏）与「能否调用」是两个独立维度：
 `glm-5.1` 属「可调用但被官方隐藏」
- **模型昵称**：`ScreenName` 是按 uid 自动生成的默认名（`用户26815487395`），
 必须用 `NonPlainTextMobile`（脱敏手机号）优先、邮箱兜底
