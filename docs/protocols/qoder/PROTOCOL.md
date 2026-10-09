# Qoder 协议规格（阿里系）

> ** 修订（2026-10-09，渠道已实现）**：本文件 §7.1「WASM 签名无纯代码替代，只能 wasmtime +
> 重写 glue」的结论**已过时**。社区至少三个独立项目用纯代码复刻出了同一套算法
> （RSA-PKCS1v15 包裹会话密钥 + AES-128-CBC 加密身份体 + MD5 签名 + 自定义 Base64 请求体编码），
> **完全不需要 WASM** —— 渠道已按这条路线实现（`channels/qoder/src/upstream.ts`）。
> 其余需要修订的点：
>
> | 项 | 本文件（旧） | 实际 |
> | --- | --- | --- |
> | 签名 | 只能靠 WASM | 纯 `node:crypto` 可复刻 |
> | COSY 版本 | `1.1.49` | `1.1.64` |
> | 请求体 | 未提编码 | 需经**自定义 Base64 变体**编码后才发 |
> | 模型列表 | 「端点需 WASM 签名，不实现，恒用静态表」 | 可动态拉：`GET /algo/api/v2/model/list?Encode=1`，**GET 也要带 `qoder_encode("{}")` 作 body**（否则 403） |
> | `chat_context.text` | 记作字符串 | 实际是**对象** `{type:"text",text}` |
> | 旧签名 | 提到 `Appcode`/固定 SECRET | 那套已失效（无账号身份参与），现行是 COSY bearer |
>
> 完整依据、参考项目清单（含许可证）与「照抄不改」清单见
> [`docs/journals/qoder/findings.md`](../../journals/qoder/findings.md)。下文保留作历史记录。

提取自 `dsh-our-free-model/vendor/channel-pack/src/` 的 TypeScript 实现（下称 `<SRC>`）。
行号对应提取时的源码。

**本项目覆盖双版本**：国际版 `qoder`（qoder.com）与中国版 `qodercn`（qoder.cn）。
两站共用同一套实现，差异全部收敛在 product 配置里。

---

## 1. 端点

### 1.1 产品配置（域名差异全部在这里）

| 字段 | 国际版 `qoder` | 中国版 `qodercn` | 来源 |
|---|---|---|---|
| `authBase` | `https://qoder.com` | `https://qoder.cn` | qoder-product.ts:442 / 592 |
| `openApiBase` | `https://openapi.qoder.sh` | `https://openapi.qoder.com.cn` | 443 / 593 |
| `inferBase`（公开 OpenAI 兼容，**无调用方**） | `https://api2-v2.qoder.sh` | `https://gateway.qoder.com.cn` | 444 / 601 |
| `encryptedInferBase`（加密推理，实际使用） | `https://api2.qoder.sh` | `https://gateway.qoder.com.cn` | 445 / 604 |
| `clientId` | `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb` | `732aef47-9cf2-46a2-95fe-4cebb5d0d1fa` | 446 / 609 |
| `sashClientType` | `'10'` | `'10'` | 455 / 626 |
| `userAgentPrefix` | `qoder`（拼成 `qoder/1.0.0`） | 同 | 456 / 628 |
| `clientMetadata` | `{client_type:'5', business_product:'cli', business_type:'agent', scene:'assistant'}` | 同 | 448-453 / 619-624 |

`client_id` **必须用 prod 值**：用 test 值会被服务端在回调阶段拒绝，页面报「参数无效 / 你可以稍后前往 IDE 客户端并登录Qoder」（qoder.ts:103-107，真实缺陷记录）。

### 1.2 端点清单

| 用途 | 方法 | 完整 URL | 来源 |
|---|---|---|---|
| 授权页（登录） | GET（浏览器） | `{authBase}/device/selectAccounts?challenge&challenge_method=S256&nonce&machine_id&client_id` | qoder.ts:23, 109-118 |
| 轮询取 token | GET | `{openApiBase}/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256` | qoder.ts:25, 127-134 |
| 续期 | POST | `{openApiBase}/api/v1/deviceToken/refresh` | qoder.ts:27 |
| 用户信息 | GET | `{openApiBase}/api/v1/userinfo` | qoder.ts:29 |
| 对话（公开端点，**无调用方**） | POST | `{inferBase}/model/v1/chat/completions` | qoder.ts:31 |
| 对话（加密端点，**实际使用**） | POST | `{encryptedInferBase}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1` | qoder-wasm.ts:10-12, 231 |
| 用量/余额 | GET | `{openApiBase}/sash/api/v2/me/usage` | qoder-credits.ts:77 |
| 活动列表（签到状态） | GET | `{openApiBase}/sash/api/v1/me/campaigns` | qoder-credits.ts:79 |
| 领取 | POST | `{openApiBase}/sash/api/v1/me/campaigns/{campaignId}/claim`，body 为**空串** | qoder-credits.ts:610-617 |
| 模型列表 | — | `/api/v2/model/list`（仅注释提及「需 WASM 签名」，**未实现**） | qoder-credits.ts:7 |

---

## 2. 认证

### 2.1 登录：PKCE 设备码轮询（不起本地回调服务器）

授权 URL 查询参数逐字为：`challenge`、`challenge_method=S256`、`nonce`、`machine_id`、`client_id`（qoder.ts:110-116）。

**PKCE 细节**（qoder.ts:39, 56-69）：
- verifier 长度 `43 + floor(86*random)`（43..128）
- 字符集 `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~`（66 个）
- challenge = `base64url(sha256(verifier))` 且**去 padding**（带 `=` 服务端校验失败）

**machine_id**（qoder.ts:71-95）：客户端自生成随机 UUID 并**持久化**。
不是硬件指纹 —— 官方是 SMBIOS UUID + salt 的 sha256，本实现**刻意不复刻**。

**轮询规则**（qoder-oauth.ts:119-164）：
- 间隔 `1000ms`、总超时 `300000ms`、连续网络失败上限 5
-  **HTTP 404 = 用户尚未授权，继续轮询**（实测 404 体 `{"errorCode":"NotFound"}`；任意不存在路径返回 401，说明该端点被网关豁免认证）
- 其他非 2xx 立即抛错
- 轮询请求头只有 `Accept: application/json`

**token 响应字段**（登录与续期字段名不同，都接受，qoder.ts:211-235）：
`token` / `device_token` / `access_token`（取第一个非空）、`refresh_token|refreshToken`、
`expires_at|expiresAt`、`refresh_token_expires_at`、`user_id|userId`、`user_name|userName`

**踩坑**：设备码轮询响应**不带 `user_name`**，故登录后必须补一次
`GET /api/v1/userinfo` 取 `name` 作昵称（qoder.ts:344-394）。`uid` 实际来源是设备码响应的 `user_id`。

### 2.2 凭据字段（qoder.ts:144-164）

| 字段 | 说明 |
|---|---|
| `security_oauth_token` + `access_token` | **双写同值**；取用顺序 `security_oauth_token ?? access_token` |
| `refresh_token?` | 有它才可静默续期 |
| `expire_time?` / `refresh_token_expire_time?` | 毫秒时间戳 |
| `machine_id` | **必须持久化**，续期请求体需要它，且参与服务端设备绑定 |
| `uid?` | **加密推理必需**（`generate_runtime_auth_fields` 用它派生 `encrypt_user_info`；缺了会签名无效或挂起） |
| `nickname?` | 展示名 |

### 2.3 续期

```
POST {openApiBase}/api/v1/deviceToken/refresh
Headers: Content-Type: application/json, Accept: application/json, User-Agent: qoder/1.0.0
Body: {"refresh_token": "...", "machine_id": "..."}
```
（qoder-auth.ts:398-404；qoder.ts:287-292。官方还会带 `machine_token`，本实现没有 UMID 子系统故不发）

**终态判定**（qoder-auth.ts:414-437）：
- HTTP 401/403 → 需重新登录
- 200 但无 token → 同样视为终态
- 其余（5xx/429/网络）可重试

**合并规则**：续期响应不含 `machine_id`/`uid`/`nickname`，必须从旧凭据保留（qoder.ts:324-341）。

### 2.4 推理请求头

`qoderChatHeaders`（qoder.ts:295-316）在仓库内**无调用方** —— 实际推理走 WASM 生成的签名头：

| 头 | 值 |
|---|---|
| `Authorization` | `Bearer COSY.<载荷>.<签名>`（**不是**普通 Bearer） |
| `Accept` | `text/event-stream` |
| `Content-Type` | `application/json` |
| `X-Request-ID` / `X-Session-ID` | 请求级随机 id |
| `User-Agent` | `qoder/1.0.0` |

用普通 Bearer 覆盖会 `403 Signature invalid`（qoder-wasm.ts:649-655）。

---

## 3. 对话请求（加密端点）

### 3.1 明文请求体结构

逐项复刻官方 `G4A()`（qoder-wasm.ts:245-326）：

```
request_id / request_set_id / chat_record_id   = 同一个随机 UUID
session_id                                      = 随机 UUID
stream                                          = true（固定）
chat_task                                       = "FREE_INPUT"
chat_context = {
 text            = 最后一条 user 消息的文本
 features        = []
 extra = {
   context: [],
   modelConfig: { key: <目录key>, is_reasoning: bool },
   originalContent: <同 text>
 }
 chatPrompt      = ""
 imageUrls       = null            ← 官方也恒置 null，图片不走这里
}
is_reply = true, is_retry = false, source = 1, version = "3"
agent_id = "agent_common", task_id = "common"
session_type = "qodercli"（国际）/ "qoder_work"（国内）
aliyun_user_type = ""
model_config = {
 key, display_name, model: "", format: "openai",
 is_vl: bool, is_reasoning: bool, api_key: "", url: "",
 source: "system", max_input_tokens: number(默认 200000)
}
custom_model = null
system  = [{type:"text", text}] 或 []
messages = [{role, content, tool_calls?, tool_call_id?}]   ← 图片走 content 多模态数组
tools    = [{type:"function", function:{name, description?, parameters?}}]  ← 顶层，必须真发
parameters = { max_tokens?, reasoning_effort?, enable_thinking?, context_length? }
business = { type: "agent" }   ← 必填
```

### 3.2 特殊约束（都是实测踩坑记录）

| 约束 | 后果 | 来源 |
|---|---|---|
| `business` 必填 | 缺失时请求恒被路由到故障节点 `oa_qwen-plus-2025-04-28`，返回 `[FAIL]node:... msg:Execution failed` | qoder-wasm.ts:205-215 |
| `uid` 必须有 | 缺 uid 时 WASM 产出**签名无效**的请求 → `Signature invalid (101)` | qoder-adapter.ts:661-667 |
| 顶层 `tools` 必须真发 | 不下发时模型只能用正文 XML 臆造工具调用；无工具时是**空数组**而非缺字段 | qoder-wasm.ts:216-227 |
| 目录 key 只能走加密端点 | 把 `qfmodel` 发给公开端点 → `{"code":"invalid_model_error"}` | qoder-product.ts:311-343 |
| `chat_context` 不能传空对象 | — | qoder-wasm.ts:238-241 |
| `imageUrls` 恒 `null`；图片走 `messages[].content` 的 `{type:'image_url',image_url:{url}}` 数组 | 早期把 content 压成纯文本导致图片全部消失 | qoder-wasm.ts:123-136 |
| assistant 的 `tool_calls` 与 `role:'tool'` 的 `tool_call_id` 必须保留 | 早期过滤会丢掉它们，多步工具调用彻底坏掉 | qoder-adapter.ts:313-364 |
| 请求体体积 | 实测 8 张 2560×1600 原图可过、15 张（≈57 MiB）`TRANSPORT: fetch failed` | qoder-product.ts:280-287 |

### 3.3 加密端点实际请求头（WASM 生成，必须原样透传）

从 `qoder-auth-wasm.wasm` 二进制内字符串提取的头名集合：
`Authorization`、`Content-Type: application/json`、`Cosy-Version`、`Cosy-MachineId`、
`Cosy-MachineToken`、`Cosy-MachineType`、`Cosy-ClientType`、`Cosy-Business-Product`、
`Cosy-Business-Type`、`Cosy-Scene`、`Cosy-User`、`Cosy-Date`、`Cosy-Organization-Id`、
`Cosy-Organization-Tags`、`Cosy-Data-Policy`、`Cosy-ClientIp`、`Login-Version: v2`、
`X-Model-Key`、`X-Model-Source`、`Accept: text/event-stream`、`Cache-Control: no-cache`、
`Connection: keep-alive`、`Accept-Encoding: identity`

签名相关字面量：`authsign` / `cosy` / `Date` / `Appcode` / `Signature` / `Bearer COSY.`，
以及一个 base64 常量 `d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==`（解码为 `war, war never changes`）。

适配器只额外补一个 `Accept: text/event-stream`（qoder-adapter.ts:1024-1025）。

---

## 4. 流式响应

### 4.1 信封（qoder-envelope.ts）

加密端点每帧多一层信封：

```
data:{"headers":{...},"body":"{\"choices\":[{\"delta\":{\"content\":\"Q\"}}]}","statusCodeValue":200,"statusCode":"OK"}
```

- **内层 `body` 未加密**（只有请求体要 WASM 加密）；`body` 是 JSON 字符串时直接取，是对象时 `JSON.stringify`（:42-52）
- 剥完后就是**标准 OpenAI SSE**
- 内层帧分类（:54-102）：
 - `chunk`：有 `choices` 数组（**`choices: []` 也算**）或 `usage`
 - `heartbeat`：`null`、空串、`{}`、裸标量 → **整帧跳过**（早期把 `body:null` 当业务错误，导致正常回完内容却报失败，issue IKJOZ8）
 - `error`：显式带 `code` / `message` / `error` / `statusCodeValue` / `type` 之一 → 抛出，且**保真转发** `{code, message, type:'model_error'}`（`code` 必须独立字段，下游靠 `code==='10605'` 识别排队）
- 非 `data:` 行（如 `event:finish`）原样保留；`[DONE]` 原样传递（:145-154, 204）

### 4.2 事件与结束标志

标准 OpenAI delta：
- 正文 `choices[0].delta.content`
- 思考 `choices[0].delta.reasoning_content`（与 content **互斥**，另一侧恒为 `null`）
- `choices[0].finish_reason` ∈ `stop|tool_calls|length`
- `usage` 帧单独消费
- `data: [DONE]` 结束

### 4.3 业务错误码（重点）

| 码 | 语义 | 处理 | 来源 |
|---|---|---|---|
| `10605`（字符串） | 模型排队 | 内层 `message` 是 **JSON 字符串**，需二次解析：`{"isQueued":true,...,"retryAfterSeconds":30}`；延迟优先序 `retry_after_ms` → `retryAfterMs` → `retryAfterSeconds×1000`，**封顶 10 秒**；最大 180 次；总时长默认 30 分钟（`DSH_QODER_QUEUE_TIMEOUT_MS` 可覆盖，0 合法） | model-queue.ts:36, 138, 188-255 |
| `110` | 额度用尽（`Billing daily count exceeded`） | 归 `QUOTA_EXCEEDED`（**不可重试**）；文案兜底正则 `/billing\s+daily\s+count\s+exceeded\|billing_error/i` | model-queue.ts:73-130 |
| `105` | `auth_error`（与 10605 独立，不可合并） | 续期后重试 | model-queue.ts:26 |
| 409 | `duplicate_request` | 不刷新凭据，直接重发一次 | qoder-adapter.ts:834-838 |

排队错误的**两种下发形态都必须处理**（只修一条会回归）：
HTTP 403 + 排队 JSON 体；HTTP 200 + SSE 内嵌 `{code:"10605",...}` 帧（qoder-adapter.ts:744-757）。

额度错误实测走 SSE（HTTP 200）通道；受限时标记「该账号 + 该模型」到 **UTC+8 当日 24:00**，
然后切换账号池下一个账号。

---

## 5. 模型目录

**不发网络请求**：Qoder 的模型列表端点需 WASM 签名，本实现不实现，恒用静态兜底表（qoder-adapter.ts:514-552）。

### 5.1 国际版 17 条（qoder-product.ts:387-435）

| id | 名称 | 上下文 | 倍率 | 备注 |
|---|---|---|---|---|
| auto | Auto | 200K | 0.5 | |
| ultimate | Ultimate | 1M | 2 | efforts xhigh/high/low/max/medium，默认 high，可关闭 |
| performance | Performance | 1M | 1.1 | 同上，默认 medium |
| efficient | Efficient | 1M | 0.3 | |
| smodel | Sonus | 1M | 8 | 5 档，默认 high，**不能关** |
| cmodel | Cantus | 1M | 4 | 同上 |
| qmodel_38max | Qwen3.8-Max | 1M | 0.2 | **免费**，efforts xhigh/low/medium，默认 xhigh，可关，22:00–08:00 4 折 |
| qfmodel | Qwen3.8-Flash | 1M | **0（免费）** | 原价 0.1，efforts xhigh/low/medium，默认 medium，可关 |
| qmodel_latest | Qwen3.7-Max | 1M | 0.1 | 仅「关闭思考」，促销 2 折 |
| qmodel | Qwen3.7-Plus | 1M | 0.04 | 仅「关闭思考」，促销 4 折 |
| kmodel_latest | Kimi-K3 | 1M | 1.4 | efforts high/low/max，默认 max |
| kmodel | Kimi-K2.8-Preview | 1M | 0.8 | 同上 |
| gmodel | GLM-5.3 | 1M | 0.8 | 同上 |
| gfmodel | GLM-5.3-Flash | 1M | 0.1 | efforts high/max，默认 max |
| dmodel | DeepSeek-V4-Pro | 1M | 0.5 | efforts high/max，默认 max，可关 |
| dfmodel | DeepSeek-Flash | 1M | 0.1 | efforts high/max/low，默认 max，可关 |
| mmodel | MiniMax-M3 | 1M | 0.2 | |

### 5.2 中国版 14 条（qoder-product.ts:531-580）

`auto`(200K,0.5)、`qmodel_38max`(1M,0.2,免费,默认 medium)、`qfmodel`(1M,0,免费)、
`qmodel_latest`(1M,0.1)、`qmodel`(1M,0.04)、**`q37fmodel` Qwen3.7-Flash**(1M,0.1，CN 独有)、
`dmodel`(1M,0.5)、`dfmodel`(1M,0.1)、`gmodel`(1M,0.8)、`gfmodel`(1M,0.1)、
**`gm51model` GLM-5.2**(1M,0.6，CN 独有)、`kmodel_latest`(1M,1.4)、`kmodel`(1M,0.8)、
**`mmodel` MiniMax-M2.7**(200K,0.2，版本与国际版 M3 不同)

### 5.3 档位与上下文口径

- 档位白名单（asar 常量 `Qj`）：`['none','low','medium','high','xhigh','max']`，
 别名 `disabled→none`、`off→none`
- 中文名：`none:关闭思考 / minimal:最小 / low:低 / medium:中 / high:高 / xhigh:极高 / max:最大`（qoder-product.ts:113-117）
-  **上下文口径**：取目录 `context_config` 档位表**最大档**，不是 `max_input_tokens`
 （两者经常矛盾，官方客户端只认档位表）。实测服务端上限因模型而异：
 `dfmodel` 999,991 通过、`qfmodel` 983,490 通过（越界报 `Range of input length should be [1, 983616]`）、
 `dmodel` 852,951 通过（qoder-product.ts:485-520）

---

## 6. 额度查询

### 6.1 余额

```
GET {openApiBase}/sash/api/v2/me/usage
Headers: Accept: application/json, Authorization: Bearer <token>,
        Cosy-ClientType: 10, User-Agent: Qoder,
        Cosy-MachineToken: <配对头>, Cosy-MachineType: <配对头>
```
（qoder-credits.ts:229-240）

响应：`displayMode: "qoder"|"enterprise"`（enterprise 无额度数字，返回 null）；
`qoderUsage.userQuota{total,used,remaining,unit}`、`qoderUsage.addOnQuota{...}`、
`qoderUsage.dedicatedResourcePackages[]`、`expiresAt`。

**余额不只在 `userQuota`**（实测 userQuota.remaining=0 而 addOnQuota.remaining=100）。

### 6.2 活动与领取

```
GET  /sash/api/v1/me/campaigns
→ {showCampaign, claimable, campaigns:[{campaignId, campaignKey, actionType, claimStatus, benefit:{amount,...}}]}

POST /sash/api/v1/me/campaigns/{campaignId}/claim
body: 空串（不是 {}）
```
- 只有 `actionType==='CLAIM_BENEFIT' && claimStatus==='CLAIMABLE'` 才可领；`VIEW_DETAILS` 不领
- 幂等判据是响应体 `replayed:true`（重复领取同样 HTTP 200，但不含 `benefit`、`claimedAt` 是旧时间）
-  活动每日 **10:00（UTC+8）刷新**（`QODER_CAMPAIGN_REFRESH_HOUR_UTC8 = 10`，qoder-credits.ts:89）；
 刷新前看到的 `CLAIMED` 属昨天，**不能报「今天已领」**

---

## 7. 特殊机制

### 7.1 WASM 签名（`qoder-auth-wasm.wasm`，298 KB）

**用途**：为私有加密端点生成「加密请求体 + 签名头」。

导出函数（从二进制提取）：`generate_runtime_auth_fields`、`qodercontext_new`、
`qodercontext_prepareInferRequest`、`qodercontext_prepareRequest`、`qodercontext_refreshAuthFields`、
`requestresult_url/headers/headerCount/body`、`model_cache_decrypt`、`model_cache_encrypt`、
`decrypt_server_response`、`profileencryptor_new/encryptChunk/header`

默认客户端版本常量 `COSY_VERSION = '1.1.49'`（qoder-wasm.ts:66；注意与桌面端 0.3.4 不是一个号）。

**调用链**：
```
generate_runtime_auth_fields({uid, security_oauth_token, organization_id,
                             organization_tags, data_policy_agreed})
 → {encrypt_user_info, key}
qodercontext_new(machineId, version, userInfoJson, clientMetadataJson)
qodercontext_prepareInferRequest(host, body, modelKey, source)
 → {url, headers, body}    其中 Authorization: Bearer COSY.<载荷>.<签名>
```
（qoder-wasm.ts:545-698）

**Python 复现路线**：
- **无纯 Python 替代**，源码里也没有第二实现
- 唯一可行路线是用 `wasmtime` / `wasmtime-py` 加载**同一个 .wasm**，并自己重写 wasm-bindgen glue
 （本仓库的 glue 约 200 行 TS，qoder-wasm.ts:357-543）
- 三个必须照抄的坑（qoder-wasm.ts:390-410, 462-527）：
 1. 两个 `getRandomValues` import 签名方向相反（`__wbg_getRandomValues_d49329ff89a07af1` 写 wasm 内存；
    `_c44a50d8cfdaebeb` 调 JS 对象），写反得到 Rust panic `unreachable`
 2. 返回值布局两套：字符串类 `ptr/len/valIdx/isErr`，而 `qodercontext_new`/`prepareInferRequest`
    是 `ptr/errIdx/isErr`，混用得 `null pointer passed to rust`
 3. `requestresult_url(栈指针, ptr)` 参数顺序与直觉相反
- 另需实现对象堆（1024 个 undefined + 4 个哨兵 undefined/null/true/false，索引 ≥1028 可回收）
 与 `IMPORT_MODULE = './qoder_auth_wasm_bg.js'` 的 import 表

**不想要的替代路径**：公开端点 `/model/v1/chat/completions` 只需 Bearer，
但只认通用名（`qwen-flash` 等）、不认目录 key，且拿不到 Qwen3.8 系列。

### 7.2 设备头 `Cosy-MachineToken` / `Cosy-MachineType`

来源优先级（qoder-machine.ts:211-231, 319-471）：

1. **实时 spawn** `<home>/.qoder/.bin/umid-<platform>-<hash>/runtime-info(.exe)`，
  参数**必须**是 `['3', '--account-stdin']`（environment 是第一个位置参数，
  漏掉会拿到另一套身份：`machineType=15e6683914666dab9f` 只回 1 条 `VIEW_DETAILS`；
  正确 `3` 得 `3582ddfb14d9bf289a` 并回 `CLAIM_BENEFIT/CLAIMABLE/100`），
  stdin 写 `{"account": ""}`，单次约 3.8 秒、超时 20 秒；输出 JSON 取 `machineToken` / `machineType`
2. 退路：读 `machine_token.json`（`%APPDATA%\Qoder\SharedClientCache\cache\machine_token.json`，
  也列 `Qoder CN` 与 macOS/Linux 路径），取 `token` / `type`；
  实测该文件可陈旧 179 天且跑 exe 不更新它
3. 都拿不到 → 不带这两个头（保守降级）

环境变量覆盖：`QODER_MACHINE_TOKEN_PATH`、`QODER_RUNTIME_INFO`。

**消融结论**：`Cosy-MachineToken` 与 `Cosy-MachineType` **必须成对**，缺一即失效；
`Cosy-MachineId` / `Cosy-Version` / `MachineOS` / `MachineHostname` / `MachineCode` 实测**均非必需**。
另外 `Cosy-ClientType: 10`（桌面 app 身份）是「必要但不充分」前提 —— 只用 `5`（CLI）时 campaigns 恒 `campaigns:[]`。

### 7.3 其他踩坑

- 排队 `10605` 与额度 `110` 与认证 `105` 是**三个独立码**，不能合并
- `Cosy-ClientType` 两个身份不可合并：推理信封的 `clientMetadata.client_type='5'`（CLI）
 与 `/sash/` 的 `sashClientType='10'`（桌面 app）
- 续期请求体缺 `machine_id` 会破坏设备绑定；续期后必须保留 `machine_id`/`uid`/`nickname`
