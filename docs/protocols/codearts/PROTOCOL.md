# CodeArts 协议规格（华为云）

提取自 `dsh-our-free-model/vendor/channel-pack/src/`（`llm-adapter.ts` / `oauth.ts` / `login.ts` / `models.ts` / `codearts-credits.ts` / `sign.ts` / `types.ts`）。

---

## 1. 端点总表

| 用途 | 方法 | 完整 URL | 来源 |
|---|---|---|---|
| 对话 | POST | `https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions` | llm-adapter.ts:23, 1117 |
| 并发排队状态 | GET | `.../api/v1/queue/status?model={model}&task_id={sessionId}` | :272, 2040 |
| 常规模型目录 | GET | `.../v1/model/builtin` | models.ts:17 |
| benefit 模型目录 | GET | `https://opengw.developer.huaweicloud.com/api/v1/gateway/config` | models.ts:9 |
| 账户/套餐（含积分） | GET | `.../snap-manager/v1/statistics/plugin` | codearts-credits.ts:79, 82 |
| 活动列表 | GET | `.../v1/ops/delivery?channel=IDE` | :79, 84, 91 |
| 领取 | POST | `.../v1/ops/claim` | :79, 86 |
| 领取确认 | POST | `.../v1/ops/confirm` | :79, 88 |
| OAuth token（STS） | POST | `https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens` | oauth.ts:10 |
| OAuth 授权页 | GET（浏览器） | `https://codearts.huaweicloud.com/portal/authorize` | login.ts:264 |
| portal 登录结果页 | — | `https://codearts.huaweicloud.com/portal/login` | login.ts:266 |
| 旧式 ticket 凭据轮询 | GET | `.../snap-manager/v1/login/ticket?ticket_id={t}&secret={s}` | login.ts:13, 86 |
| 旧式登录跳板 | GET（浏览器） | `https://devcloud.cn-north-4.huaweicloud.com/doer/redirect` | login.ts:11 |
| 旧式华为登录页 | GET（浏览器） | `https://auth.huaweicloud.com/authui/login.html?service={enc redirectUrl}` | login.ts:12, 28 |
| 新式本地回调 | — | `http://127.0.0.1:{port}/oauth/callback`（端口强制 ≥ 10000） | oauth.ts:8, login.ts:359 |
| 旧式本地回调 | — | `http://127.0.0.1:{port}/authentication` | login.ts:26 |

**多区域/多环境：无。** 全部硬编码 `cn-north-4`。

---

## 2. 认证

### 2.1 请求签名：`SDK-HMAC-SHA256`（sign.ts:28-68）

参与签名的头：

| Header | 值 |
|---|---|
| `host` | URL 的 host（**不手工设置，由运行时生成**，发送前被剔除） |
| `x-sdk-date` | `YYYYMMDDTHHMMSSZ`（`new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z')`） |
| `x-sdk-content-sha256` | body 的 SHA-256 hex（GET 为空体哈希） |
| `x-security-token` | 凭据里的 `security_token` |
| `content-type` | `application/json`（**仅非 GET**） |
| `maas_type` | `benefit`（**仅 benefit 模型**） |
| `Authorization` | `SDK-HMAC-SHA256 Access={ak},SignedHeaders={分号连接},Signature={hex}` |

**签名构造（Python 需逐字复刻）**：

```
uri          = url.pathname，若不以 '/' 结尾则补 '/'
query        = url.search 去掉开头的 '?'
payloadHash  = sha256_hex(body)                      # GET 传空 bytes
canonical    = '\n'.join([
                 method, uri, query,
                 各头按 key 排序的 'k:v' 行,
                 '',                              # ← 关键：头行与 SignedHeaders 之间有空行
                 ';'.join(排序后的 key),
                 payloadHash
               ])
stringToSign = 'SDK-HMAC-SHA256\n' + dateStamp + '\n' + sha256_hex(canonical)
signature    = hmac_sha256_hex(sk, stringToSign)
```

⚠️ `canonical` 中头行与 `SignedHeaders` 之间**有一个空行**（sign.ts:24）。
⚠️ dateStamp 保留结尾的 `Z`、毫秒被截掉。

### 2.2 各端点的完整请求头清单

**对话（llm-adapter.ts:1160-1167）**：
签名头全集 + `Authorization` + `Content-Type: application/json` +
`Chat-Id: {32 位 hex}` + `Session-Id: {32 位 hex}` + `lang: en`
（另有框架注入的 attribution headers，**含 harness 的 User-Agent，本适配器不覆盖它**）

**`/v1/model/builtin`（models.ts:202-206）**：
签名头（GET：无 `content-type`）+ 签名后追加（**绝不参与签名**）：
`Content-Type: application/json`、`Agent-Type: PromptCenter`、`X-Language: zh-cn`

**积分/活动四端点（codearts-credits.ts:130-133）**：
签名头 + 签名后追加：`Agent-Type: PromptCenter`、`X-Language: zh-cn`

**排队状态（llm-adapter.ts:2049-2053）**：
签名头 + 签名后追加：`x-snap-traceid: {uuid}`、`Agent-Type: INFERHUB_AGENT`、`X-Language: en`

**`gateway/config`（models.ts:180）**：只有签名头，**无任何额外头**

⚠️ **`Agent-Type` / `X-Language` 绝不能参与签名**（codearts-credits.ts:113-129）：
实测（2026-09-18 真实凭据）进入 canonical request 与 SignedHeaders 会得
`401 {"error_code":"APIG.0301","error_msg":"...verify ak sk signature fail"}`；签名后追加则 200。

⚠️ 而 `maas_type: benefit` 是**反例**——它必须参与签名，不要据此推断。

### 2.3 凭据结构（types.ts:1127-1143）

必填：`access_key_id`、`secret_access_key`、`security_token`、`expires_at`（字符串）
可选：`domain_id`、`user_id`、`user_name`、`refresh_token`、`code_verifier`、
`dpop_private_key_jwk`（`{kty:'EC',crv:'P-256',x,y,d}`）、`model_rate_limits`

### 2.3.1 用户身份只能从 `refresh_token` 里解（**实测 2026-10-08**）

⚠️ **STS 的信封（登录与续期都一样）只给 `credentials` + `refresh_token`**，
**从不给 `user_id` / `domain_id`** —— 凭据里那两个字段实测恒为空串。

而**华为 STS 每次签发都换一套新 AK**。所以「用 AK 派生 uid」会让**同一个人每次登录
都变成新账号**：实测一个用户躺在账号池里 3 条（`HSTANDPR…` / `HSTA5H4…` / `HSTAQAB…`），
它们共享同一个 refresh token 家族，一个被消费就全体作废
（`STS5.1806 the refresh token has been used`），池子的故障转移于是把一次失败
放大成 N 次无效重试。

**稳定身份在 `refresh_token` 的 JWT 里**（本地 base64 解码即可，**不验签**——
它只用于「是不是同一个人」的去重，不参与鉴权）：

```jsonc
// refresh_token 的 payload
{
  "type": "refreshToken",           // ← 只认这个类型
  "user_profile": "<再编码一次的 base64url JSON>"
}
// 解开 user_profile 得到：
{
  "account_id":   "019fb1171afe7d21a114c649628b72e1",   // ← 账号级身份，用它
  "account_name": "hid_2p1fajwaqpov_95",
  "principal_id": "019fb1171afe782f9ecf38e4299658b7",   // account_id 缺失时退到它
  "principal_urn": "iam::019fb1171afe7d21a114c649628b72e1:user:hid_2p1fajwaqpov_95",
  "principal_is_root_user": true
}
```

实测三条伪账号的 `account_id` **完全一致** —— 这就是「同一个人」的铁证。

**uid 取值优先级**（`credentialFromTokenResponse`，顺序不可换）：
1. 信封里的 `user_id`（上游若哪天开始给）
2. `refresh_token` JWT 的 `account_id` → `principal_id`
3. `sha256(access_key_id)[:16]` —— **最后兜底**，每次登录都会变，只保证不空

### 2.4 刷新流程（oauth.ts:96-176）

```
POST https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens
Headers: DPoP: {ES256 JWS}
         Content-Type: application/x-www-form-urlencoded
Body (form-urlencoded):
  client_id=codearts-agent
  code_verifier={凭据里的 code_verifier}
  grant_type=refresh_token
  refresh_token={凭据里的 refresh_token}
超时: 60_000 ms
```

响应：`{credentials:{access_key_id, secret_access_key, security_token, expiration},
refresh_token, error, error_code, error_msg}`

**终态判定（只认两种，oauth.ts:134-140）**：
`error === 'invalid_grant'` 或 `error_code` 包含 `ExpiredRefreshToken`。

⚠️ **`InvalidDPoPHeader` 明确被移出终态**（oauth.ts:126-133 长注释）：
它说的是「这一次 proof 没过校验」（时钟偏差 / 重放判定 / 网关抖动），
与 refresh_token 能否继续用无关；当终态会把材料完好的账号一步标死。

⚠️ **refresh_token 一次性轮换**：华为 STS 签发新凭据时旧的 `refresh_token` 即失效
（实测 `STS5.1806 the refresh token has been used`）。三条并发入口必须用 per-ref 串行队列，
且**判终态前先重读凭据**确认「我刚才用的那份 refresh_token 是否还是当前那份」。

### 2.5 登录流程（新式 IAM OAuth，默认）

| 步骤 | 内容 |
|---|---|
| 1. PKCE | `code_verifier = randomBytes(48).toString('base64url')`；`code_challenge = base64url(sha256(verifier))` |
| 2. DPoP | 生成 ES256 / P-256 密钥对，`exportJWK` 得 `privateKeyJwk`（持久化）与 `publicKeyJwk` |
| 3. ticket_id | `randomBytes(32).toString('hex')` |
| 4. 本地回调服务器 | `127.0.0.1`，**端口必须 ≥ 10000** |
| 5. 授权 URL | 见下 |
| 6. 回调 | 优先取 `?code=`（新流程）→ 立即 exchange；若收到 `?secret=` 则是旧流程回退，307 重定向 + 后台轮询 ticket |
| 7. 结果页 | exchange 成功后 307 到 `https://codearts.huaweicloud.com/portal/login?login_succeed=true&uri_scheme=codearts-agent&locale=zh-cn` |
| 8. 超时 | 180 秒 |

**授权 URL 逐字（login.ts:282-291）**：

```
https://codearts.huaweicloud.com/portal/authorize?theme=2&locale=zh-cn
&uri_scheme=codearts-agent&client_id=codearts-agent&port={port}
&code_challenge={challenge}&code_challenge_method=SHA-256
&ticket_id={ticketId}&plugin-name=snap_AIIDE&plugin-version=5.2.0
```

常量逐字值：`OAUTH_THEME='2'`、`OAUTH_LOCALE='zh-cn'`、
`LOGIN_PLUGIN_NAME='snap_AIIDE'`、`LOGIN_PLUGIN_VERSION='5.2.0'`

⚠️ **三个实测踩坑**（源码注释明写）：
- `code_challenge_method` 必须是 **`SHA-256`**（非 RFC 标准缩写 `S256`）；
  portal 以此识别 OAuth 授权，错值会**静默回退旧 ticket 流程**
- 授权 URL **不能带 `auth_callback_url`** —— portal 仅凭 `port` 参数构造回调
- 回调端口 < 10000 会被 portal 拒绝

**授权码换取**（oauth.ts:147-161）：同一 STS 端点，form 体为
`client_id=codearts-agent`、`code=`、`code_verifier=`、`grant_type=authorization_code`、
`redirect_uri=http://127.0.0.1:{port}/oauth/callback`

### 2.6 DPoP JWS 构造（oauth.ts:74-85）—— Python 需要哪些库

| 项 | 值 |
|---|---|
| Header | `{"alg":"ES256","typ":"dpop+jwt","jwk":{kty,crv,x,y}}` |
| Payload | `{"htm":"POST","htu":"https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens","iat":{unix 秒},"jti":{randomBytes(32) hex}}` |
| 密钥 | P-256（ES256） |
| nonce | **无** |

- `htu` 是**完整 URL**（含 path），`htm` 是大写 HTTP 方法
- **每次请求都要新签**（`jti` 随机）

**Python 库建议**：
- 最省事：**`jwcrypto`**（原生支持 `jwk` 头、ES256、JWK 导出/持久化）
- 或 `cryptography` + 手写 JWS
- 或 `PyJWT` + 自定义 headers（需自行把 JWK 转 PEM，较繁）
- PKCE 只需 `hashlib` + `base64.urlsafe_b64encode` + `secrets.token_bytes(48)`

**持久化只需存私钥 JWK**（含 `d`）；公钥由 `x`/`y` 重建。

### 2.7 登录流程（旧式 ticket，回退路径）

- `ticket_id = randomUUID()`；`secret = 32 随机字节的 hex`
- `redirectUrl = https://devcloud.cn-north-4.huaweicloud.com/doer/redirect?IdeaType=jetbrains&auth_callback_url={enc http://127.0.0.1:{port}/authentication}&plugin-name=snap_jetbrains&plugin-version=26.3.3&ticket_id={ticketId}`
- `loginUrl = https://auth.huaweicloud.com/authui/login.html?service={enc redirectUrl}`
- 轮询：GET `.../snap-manager/v1/login/ticket?ticket_id=&secret=`，
  请求头 `Content-Type: application/json;charset=UTF-8`、`plugin-name: snap_jetbrains`、
  `plugin-version: 26.3.3`；间隔 1 秒、最多 120 次
- 凭据解析兼容两种形状（login.ts:33-62）：
  `data.credential.{access,secret,securitytoken|securityToken,expires_at|expiresAt}`
  或 `data.result.{accessKeyId,secretAccessKey,securityToken,expiration|expiresAt}`
- `expires_at` 无法解析时回退 `now + 24h`

---

## 3. 对话请求

### 3.1 请求体顶层键（llm-adapter.ts:1085-1116）

| 键 | 值 / 条件 |
|---|---|
| `model` | 模型 id |
| `messages` | 见下 |
| `stream` | **恒 `true`** |
| `prompt_cache_key` | `sessionId`（32 hex）；缺失时服务端缓存命中恒为 0 |
| `include` | `["reasoning.encrypted_content"]` |
| `reasoning_summary` | `"auto"` |
| `thinking` | `{"type":"disabled"}`，**仅当** `reasoningEffort === 'off'` |
| `tool_stream` | `true` |
| `max_tokens` | `options.maxTokens ?? 65536`（实测 65536 可用、131072 触发空流被拒） |
| `tools` | OpenAI function 数组；**DSML 模式下不发** |

### 3.2 消息结构（llm-adapter.ts:116-182）

| role | 字段 |
|---|---|
| `system` | `{role, content: string}` |
| `user` | `{role, content: string}` |
| `assistant` | `{role, content: string, reasoning_content: string（**恒带，无推理时空串**）, tool_calls?: [...]}` |
| `tool` | `{role:'tool', tool_call_id, content}`（工具结果从 harness user 消息**展开**为独立消息） |

⚠️ **`reasoning_content` 恒带是硬要求**：deepseek-v4 系对缺失该字段的历史直接
400 `Missing reasoning_content field`（llm-adapter.ts:148-152）。

- 只保留 `text` 块；`reasoning` 块折叠进 `reasoning_content`；**图片块被丢弃**
- 孤儿 tool_call / tool_result 必须剔除，否则后端对之后每条消息都 400
- `options.system` 非空时 `messages.unshift({role:'system', ...})`
  —— **没有**「首条必须是 system」的硬约束（那是 WorkBuddy 的机制）

### 3.3 DSML 工具模式（llm-adapter.ts:202-264, 1076-1084）

仅 `^deepseek-v4-(flash|pro)$`（**无日期后缀**）触发。

不发送 `tools` 字段，改为把工具 JSON Schema 以文本注入一条**额外的 system 消息**
（插在首个 system 之后、user 之前），要求模型用 `<｜DSML｜tool_calls>` 语法输出。

**理由**：标准 tool_calls 需一次性打包参数，生成期间 SSE 静默 > 60s 被 APIG 网关掐断
（`terminated`）；DSML 走 `delta.content` 流式通道，实测 1000 行 write 全程最大静默 204ms。

**DSML magic string（llm-adapter.ts:627-634）**：

```
<｜DSML｜tool_calls>  </｜DSML｜tool_calls>
<｜DSML｜invoke name="...">  </｜DSML｜invoke>
<｜DSML｜parameter name="..." string="true">  </｜DSML｜parameter>
<thought>  </thought>
```

（`｜` 是 U+FF5C 全角竖线）

`content` 与 `reasoning_content` 各用一个独立提取器；`<thought>` 内容作为 reasoning 增量输出。
DSML 解析出的工具调用 id 用 `dsml-{uuid 去横线}`。

### 3.4 思考控制

⚠️ 唯一生效的是**顶层** `thinking.type`；`reasoning_effort` 与嵌套 `reasoning.effort`
均被接受但**完全无效**（实测 2026-09-29，判据为 reasoning_tokens）。

故只声明「开启/关闭」两档，`disabled` → reasoning_tokens 3/3 全为 0。

---

## 4. 流式响应（标准 OpenAI SSE）

| 事件 | payload 字段 |
|---|---|
| 正文 | `choices[0].delta.content` |
| 思考 | `choices[0].delta.reasoning_content` |
| 工具调用 | `choices[0].delta.tool_calls[] = {index, id?, function:{name?, arguments?}}` |
| 结束原因 | `choices[0].finish_reason` |
| 用量 | `usage.{prompt_tokens, completion_tokens, prompt_tokens_details.cached_tokens, prompt_cache_hit_tokens, completion_tokens_details.reasoning_tokens}` |
| **结束标志** | `data: [DONE]` |

⚠️ **该通道的 `reasoning_content` 内容全部作为 reasoning 输出**（`text + reasoning` 合并）——
因为实测 deepseek-v4-flash 的 reasoning_content 通常不带 `<thought>` 标签，
若把提取器的 `text` 部分发给正文块，思考会泄漏到正文。

### 4.1 内嵌错误帧（HTTP 200）

顶层 `error_code` / `error_msg`（llm-adapter.ts:1642-1662），分类优先级**不可颠倒**：

| 判据 | 处理 |
|---|---|
| `error_code.includes('4291')` 或 `/insufficient[\s_-]+quota/i.test(message)` | 额度用尽 → **不可重试**，标账号受限 + 换号 |
| `error_code === 'TM.00001041'` 或 `/81111\|TPM\|(^\|[^0-9])429([^0-9]\|$)\|rate.?limit\|too many requests\|排队\|限流/i` | 排队/限流 → 可重试 |
| `error_code === 'InferHub.4004.200'` | 账号无 benefit 包 → 去掉 `maas_type` 头重试一次 |
| 其它 | `INVALID_REQUEST` |

⚠️ **`429` 必须锚定为独立数字**：无边界子串会让额度码 `InferHub.4291.200` 命中 `429` 前缀
而被误判成「可重试排队」，进入 30 分钟静默重试、界面零输出
（真实缺陷，2026-10-02 实测 25 秒内 4 次 chat + 3 次探测、产出 0 chunk）。

### 4.2 HTTP 非 2xx 分类（llm-adapter.ts:550-561）

401/403 → `AUTH`（先 refresh 一次再重试）；429 → `RATE_LIMIT`；
400 → `CONTEXT_WINDOW_EXCEEDED`（命中上下文超限措辞）否则 `INVALID_REQUEST`；
≥500 → `SERVER`；其它 `HTTP_{status}`。

另有 `isAuthError`：body 含 `APIG.0602` 或 `invalid token`/`token expired`/`token is invalid` 也归 AUTH。

### 4.3 排队重试与超时

- 每 10 秒重发**整个** chat 请求，上限 180 次 = 30 分钟；排队期间**不产出任何 chunk**
- **SSE 空闲超时分两阶段**：首 token 300_000 ms、chunk 间 600_000 ms
  （依据：APIG 网关对 SSE 有 ~60s 空闲断连策略，`reader.read()` 抛 `TypeError: terminated`）

---

## 5. 模型目录

### 5.1 两个端点合并去重（models.ts:159-227）

| # | 端点 | 提取路径 | 条目字段 |
|---|---|---|---|
| 1 | `OPENGW_GATEWAY_CONFIG_URL` | `result.models[]` | `model_id`、`model_name` |
| 2 | `SNAP_MODEL_BUILTIN_URL` | `builtinModels[]` | `model_id`、`model_name` |

**归一化（models.ts:77-100）**：
- `normalizeModelId(id)`：去掉末尾 `-` + 4 位数字（`deepseek-v4-flash-0731` → `deepseek-v4-flash`）。
  chat 端点只认不带后缀的 id
- 过滤 id 含 `-VL-` 或以 `-VL` 结尾的视觉模型
- `name` 取 `model_name`（同样归一化），缺失时用 id；按 id 去重

### 5.2 benefit 集合缓存（models.ts:159-227）

只记录 gateway/config 里**归一化未改写**的 id（即 `normalizeModelId(rawId) === rawId`）
—— 带日期后缀的 `-0731` 与无后缀是后端**两个不同模型、benefit 属性相反**，
记录改写后的 id 会让无后缀模型被误标。

缓存文件 `~/.cache/deveco/codearts_benefit_models.json`（`DSH_CODEARTS_CACHE_DIR` 可覆盖）。
**同步写入**（chat 签名前要读）。

### 5.3 静态兜底模型表（llm-adapter.ts:48-54，共 9 个）

```
GLM-5.2, GLM-5.1, GLM-5, glm-5.3-flash,
openpangu-2.0-flash, openpangu-2.0-pro,
deepseek-v4-flash, deepseek-v4-pro, deepseek-v4.1-flash
```

**benefit 静态兜底集合（models.ts:52，2 个）**：`['glm-5.3-flash', 'deepseek-v4.1-flash']`

**上下文窗口表（llm-adapter.ts:65-71）**：
`GLM-5.2`=202752、`glm-5.3-flash`=1048576、`deepseek-v4-flash`=1048576、
`deepseek-v4-pro`=1048576、`deepseek-v4.1-flash`=1000000

### 5.4 ⚠️ `maas_type: benefit` 的完整机制

`opengw.developer.huaweicloud.com/api/v1/gateway/config` 返回 **benefit（免费额度）模型列表**；
**这些模型即 benefit 集合**：chat 时必须带 `maas_type: benefit`（且**参与签名**），否则 404 未注册。

实测矩阵（2026-09-23）：

| 模型 id | 不带 maas_type | 带 maas_type |
|---|---|---|
| `glm-5.3-flash` | 404 未注册 | ✓ |
| `deepseek-v4.1-flash` | 404 未注册 | ✓ |
| `deepseek-v4-flash-0731` | 404 未注册 | ✓ |
| `deepseek-v4-pro-0813` | 404 未注册 | ✓ |
| `deepseek-v4-flash`（无后缀） | ✓ | ✗ unsupported model |
| `deepseek-v4-pro`（无后缀） | ✓ | ✗ unsupported |
| `GLM-5.2`（model/builtin） | ✓ | ✗ unsupported |

补充机制：若 SSE 返回 `InferHub.4004.200 benefit not found`（积分制账户无 benefit 包），
去掉该头重试**一次**。

---

## 6. 额度查询

### 6.1 账户/套餐（codearts-credits.ts:461-484）

`GET {SNAP}/snap-manager/v1/statistics/plugin`

⚠️ **响应是裸对象，无 `{code,data}` 信封**（与 `ops/*` 不同）

- `package.is_credit_package`（积分账户判定）、`package.is_token_package`、
  `package.spec_code`、`package.package_name_cn` / `package_name_en`、`package.status`
- `metrics[]`：`name` / `package_credit_amount` / `package_credit_used` / `package_credit_remain`
- metric 名（codearts-credits.ts:142-150）：`usageTotalPackageCredit`（总积分包）、
  `usageBasicPackageCredit`、`usageOnDemandPackageCredit`、`usageBonusPackageCredit`

⚠️ 总额取 `usageTotalPackageCredit` 的 `package_credit_remain`，**不累加分类明细**；
总额 metric 缺失才回退分类求和。无任何 credit metric → 返回 `undefined`（与 `total: 0` 严格区分）。

### 6.2 活动列表与领取

`GET {SNAP}/v1/ops/delivery?channel=IDE`
- 信封 `{code, message, data}`，`code !== 0` 即失败
- `data.items[]`，每项字段：`campaignId`（**数字**）、`title`、`type`、
  `benefitAmount`（**可领积分，值 1000**）、`benefitUnit`、`displayConfig`、`pageUrl`、
  `claimable`、`hooks`、`extra`、`description`、`status`（不可领取时为 **`null`**）、
  `pendingCount`、`pendingTotalAmount`
- 每日签到活动 `type === 'USER_LOGIN'`

`POST {SNAP}/v1/ops/claim`，body `{"campaignId": "<字符串化的 id>", "channel": "IDE"}`
`POST {SNAP}/v1/ops/confirm`，body `{"campaignId": "..."}`
—— 仅当 claim 响应 `data.id !== null && !== undefined` 时补发
（漏掉积分停在「待确认」不入账）

⚠️ **幂等**：**无幂等键、无「今天已签到」业务码**；唯一保护是活动列表预检。
`claimable === false` 且 `status ∈ {CLAIMED, CONFIRMED, CONSUMED}` → `already-claimed`。

---

## 7. 踩坑注释汇总

1. **`Agent-Type` / `X-Language` 绝不能参与签名**（见 §2.2）
2. **`campaignId` 是数字**（实测 `1`）。用只接受字符串的解析会得到空串 →
   领取判 `failed`「活动缺少 campaignId」（真实缺陷）
3. **可领积分字段是 `benefitAmount`**（实测 1000），不是 `amount`；读错恒为 0
4. **不可领取活动的 `status` 是 `null`**，解析要能容忍
5. **`429` 判据必须锚定为独立数字**（见 §4.1）
6. **额度报文不含重置时刻**：`InferHub.4291.200` 的 `details` 只有
   requestId/timestamps/modelId/traceId，故按 **UTC+8 自然日次日 00:00** 自行推算
7. **官方文档给的 portal 路径不可用**：`codearts.huaweicloud.com/portal/...` 是 BFF、
   依赖浏览器 Cookie，实测带 AK/SK 签名也只返回 IAM 登录跳转 HTML
8. **ESM 下不能用 `require('node:fs')`**：本包 `"type": "module"`，
   `require` 未定义、抛 ReferenceError 后被 catch 静默吞掉 → 磁盘缓存读写长期失效
9. **tool_call 的 `id` 偶发完全不返回**：必须兜底 `call_{wireIndex}`，
   空串 id 会让会话永久报废
10. **`function.name` 只允许非空覆盖**：后续分片带空串 `""`，直接覆盖会清空工具名 →
    `unknown tool ""`
11. **`usage` 的缓存字段**：`prompt_tokens_details.cached_tokens` 或 `prompt_cache_hit_tokens`；
    `inputTokens` 只计未命中部分
12. **`openBrowser` 在 Windows 下必须用 `cmd /c start "" "{url}"` + `windowsVerbatimArguments: true`**
    （否则 `&` 被当命令分隔符截断 URL）
