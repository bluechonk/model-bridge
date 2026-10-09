# Gemini Code Assist 协议规格（Google）

提取自 `dsh-our-free-model/vendor/channel-pack/src/gemini*.ts`。

---

## 1. 端点

| 用途 | 方法 | 完整 URL | 来源 |
|---|---|---|---|
| OAuth 授权页 | GET | `https://accounts.google.com/o/oauth2/v2/auth?...` | gemini-oauth.ts:30 |
| OAuth 令牌（exchange + refresh） | POST | `https://oauth2.googleapis.com/token` | :31 |
| userinfo（身份兜底） | GET | `https://www.googleapis.com/oauth2/v2/userinfo` | :32 |
| 撤销 | POST | `https://oauth2.googleapis.com/revoke` | :33 |
| 非流式推理 | POST | `{endpoint}/v1internal:generateContent`（常量定义，**全仓无引用**） | gemini.ts:78 |
| 流式推理 | POST | `{endpoint}/v1internal:streamGenerateContent?alt=sse` | :80 |
| 配额查询 | POST | `https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary` | :82 |
| 账号档位 / 项目探测 | POST | `{endpoint}/v1internal:loadCodeAssist` | :90 |

### 1.1 端点差异（源码实测结论）

- `GEMINI_ENDPOINT_DAILY = 'https://daily-cloudcode-pa.googleapis.com'`
- `GEMINI_ENDPOINT_SANDBOX = 'https://daily-cloudcode-pa.sandbox.googleapis.com'`
- `GEMINI_ENDPOINTS = [DAILY, SANDBOX]`，轮换顺序即此

**源码中不存在 `prod` 端点**（在 `src/`、`pack.js`、整个仓库范围内检索
`prod-cloudcode` / `autopush` 均 0 命中）⇒ 「prod 端点」**未找到**。

**两端点差异未获实验支持**：404 与 project 两类失败在两端点上行为完全一致。
换端点零成本无害，但**不能当 quota 的有效解法** —— 主救场手段是换账号。

**路由特例**：`loadCodeAssist` 与 `retrieveUserQuotaSummary` 两条路径**固定走 sandbox**，
其余（含推理）走轮换端点。

### 1.2 超时与轮换参数

- 推理 120s、SSE 空闲 120s、OAuth 20s、配额 30s、配额缓存 TTL 60s、凭据过期余量 60s
- 最多换 3 个账号、429 冷却 60s、401 冷却 300s、最多升 1 代

---

## 2. 认证

### 2.1 凭据字段（gemini.ts:267-278）

`access_token`（必填）、`refresh_token`、`token_type`、`expires_in`、`scope`、
`expiry`（**RFC3339 字符串**）、`sub`、`email`、`cloudaicompanionProject`

### 2.2 登录流程：浏览器回调式 OAuth

- 授权 URL 参数：`client_id`、`response_type=code`、`redirect_uri`、`scope`、`state`、
 `access_type=offline`、`include_granted_scopes=true`、`prompt=consent`
- 回调地址：`http://localhost:<port>/oauth-callback`
 （host 必须是 `localhost` 而不是 `127.0.0.1`）。默认动态端口，兜底 `8845`

**必须同时监听 `127.0.0.1` 与 `[::1]`** —— 浏览器常把 `localhost` 解析成 IPv6。
**必须先监听再拼 URL**：端口被占时回退到别的端口，先拼 URL 会 `redirect_uri_mismatch`。
**`state` 必须校验**，不匹配一律 400。
授权流程总预算 **6 分钟** —— 原版 `authFlowTimeout` 就是 6 分钟，
3 分钟会把带二次验证的正常用户掐掉。

`state = randomBytes(16).toString('hex')`

### 2.3 client 凭据（逐字常量）

```
GEMINI_DEFAULT_CLIENT_ID     = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
GEMINI_DEFAULT_CLIENT_SECRET = <未记录：原默认值已在公开仓库中脱敏>
```

`client_id` 会出现在每个授权 URL 里，本身不是机密。`client_secret` 原值随官方客户端分发、
早已公开且不可信，故不再记录；需要时由下面的环境变量提供。

可被环境变量 `CMDC_PAK_GOOGLE_CLIENT_ID` / `CMDC_PAK_GOOGLE_CLIENT_SECRET` 覆盖。

### 2.4 OAuth scope 清单（六项逐字）

```
openid
https://www.googleapis.com/auth/cloud-platform
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/cclog
https://www.googleapis.com/auth/experimentsandconfigs
```

### 2.5  三条上游硬约束（原版 oauth.go 实测踩过）

1. **token 端点强制校验客户端身份**：只发 `client_id` 会回
  `invalid_request: client_secret is missing`，症状是「浏览器显示授权成功，
  但面板里账号一直不出现」⇒ `exchange` / `refresh` 表单**必须**带 `client_secret`
2. 必须先监听再拼 URL
3. `state` 必须校验

### 2.6 令牌交换与续期

**交换表单**：`client_id`、`client_secret`、`code`、`grant_type=authorization_code`、`redirect_uri`
**续期表单**：`client_id`、`client_secret`、`refresh_token`、`grant_type=refresh_token`

-  **Google 偶尔会轮换 refresh_token**：响应给了新的必须回写
-  令牌请求**刻意不设 `User-Agent`** —— 伪装只用在 Cloud Code 端点
- `expires_in` 缺失或非正数时默认 3600；`expiry` 由 `expires_in` 自算为 RFC3339
- 身份从 `id_token` 解（`sub` / `email`，**不验签**）；userinfo 只是兜底，
 字段名是 `id`（映射为 `sub`）与 `email`
- 凭据过期判定含 **60 秒余量**

### 2.7 推理请求头（`geminiHeaders`）

`Authorization: Bearer <token>` + `Content-Type: application/json` +
**身份五头逐字写死**，且**流式请求刻意不带 `Accept`**。

**不要**加 `x-goog-api-key` / `x-goog-api-client`（原版不带）。

**身份五头（逐字常量）**：
```
User-Agent: antigravity/4.3.0 (cmdc-pak)
x-client-name: antigravity
x-client-version: 4.3.0
x-machine-id: cmdc-pak
x-vscode-sessionid: proxy
```

信封里的 `userAgent` 字段 = `'antigravity'`

---

## 3. 对话请求（Cloud Code 信封）

### 3.1 信封结构

```json
{
 "model": "<带档位后缀的上游模型名>",
 "project": "<探测到的 project，兜底 aicode-consumers>",
 "request": {
   "contents": [{ "role": "user"|"model", "parts": [...] }],
   "systemInstruction": { "role": "system", "parts": [{ "text": "..." }] },
   "tools": [{ "functionDeclarations": [{ "name", "description", "parameters" }] }],
   "toolConfig": { "functionCallingConfig": { "mode", "allowedFunctionNames": [...] } },
   "generationConfig": {
     "maxOutputTokens": 64000,
     "thinkingConfig": { "includeThoughts": true, "thinkingBudget": 4000 },
     "temperature": 0.7
   },
   "sessionId": "<派生值>"
 },
 "requestId": "agent/<毫秒时间戳>/<8 hex>",
 "userAgent": "antigravity"
}
```

### 3.2  三条必须保留的上游对齐细节

1. **身份五头逐字写死、不许随机**，且不带 `x-goog-api-key` / `x-goog-api-client`
2. **流式请求刻意不带 `Accept` 头**（抓包一致）
3. **信封逐层字母序序列化**（`marshalAlphabetical` / `sortedStringify`）
  —— Go 的 `encoding/json` 对 map 键自动字母序排，TS 的 `JSON.stringify` 按插入序；
  不排序就与上游看到的字节不同。**递归排序，数组保持顺序**

Python 对应：`json.dumps(obj, sort_keys=True, separators=(',',':'))`（**递归**，需手写或依赖 `sort_keys`）。

### 3.3 role 与 sessionId

**role 只有 `user` / `model`**（assistant → `model`，其余 → `user`）

**`sessionId` 不是常量**（2026-10-05 真机对照实验推翻）：
```
sessionId = f(project, contents[0].text, lane)
```
- 吃：`project`、`contents[0]` 的文本、lane（`infer` / `smoke`）
- **不吃**：model、maxOutputTokens、systemInstruction、对话轮数、后续文本、机器特征

**派生算法**（`deriveGeminiSessionId`）：FNV-1a 64 位哈希，
输入 `${project}\u0000${lane}\u0000${firstUserText}`（升代时追加 `\u0000${generation}`），
按**有符号** 64 位解释后转十进制串。

**取值不与原版逐字相同** —— 原版哈希本体尚未反推出来（已否证 50+ 种），
对齐的是依赖维度与「同输入同输出」。

历史常量（已 deprecated）：`GEMINI_SESSION_ID_INFER = '3124275334370613369'`、
`GEMINI_SESSION_ID_SMOKE = '-6686302828062879362'`

`geminiFirstUserText` 只取 `contents[0]`（role 为 `''` 或 `user`）里的**首个非空文本 part**。

**会话升代自愈**：上游按 sessionId 在服务端累计对话输入，长工具循环把累计推过 1M 后，
该 sessionId 的每个请求都 400 `The input token count exceeds the maximum number of tokens
allowed 1048576`，直到服务端会话过期。升一代 = 换全新 sessionId = 上游开新会话。
`generation === 0` 时不把代数拼进输入（否则升级该功能本身会让所有进行中对话换一次 sessionId，
丢 prompt cache）。

### 3.4 思考档位

- 模型 id：`GEMINI_UPSTREAM_FLASH = 'gemini-3.8-flash'`
- 上游模型名 = `gemini-3.8-flash-<tier>`，tier ∈ `low|medium|high|tiered`。
 **模型名是准入钥匙**：发裸 `gemini-3.8-flash` 上游 404
- 预算：`low=1000`、`medium=4000`、`high=10000`、`tiered=-1`
- **tiered 档只发 `includeThoughts`，不发 `thinkingBudget`**
- `includeThoughts` **恒 true** —— 「关闭思考」是假关：关掉照样思考照样计费（实测 195 token）
 ⇒ 不提供 `none` 档
- 档位归一：未知/缺省一律 `medium`
- 实测：名字叫 `medium` 但预算给 10000 → 213 token；给 4000 → 164 token。
 **名字只是标签，预算才是行为**
- 默认档位 `medium`；中文显示名 low/medium/high/tiered → 低/中/高/自适应
- `maxOutputTokens` 缺省 **64_000**

### 3.5 工具 schema 清洗（`sanitizeGeminiSchema`）

白名单外键**整键删除**（上游对未知键是硬 400）。白名单：

```
type, format, description, nullable, enum, items, minItems, maxItems,
properties, required, minProperties, maxProperties, minLength, maxLength,
pattern, anyOf, propertyOrdering, minimum, maximum
```

**三条规则**：
- 白名单外删除
- `properties`/`items`/`anyOf` 递归清洗（`items` 可能是对象或数组）
- `type` 为数组形态时收敛成单个 type 并补 `nullable:true`
- `enum` 含任何非字符串值就整删

### 3.6 工具结果

`functionResponse` 的 `name` 必须来自对应 `tool_use` 的 name
（上游按 name 而非 id 配对），故先扫全消息建 `tool_use.id → name` 映射；
`name` 为空时**整块丢弃**。响应体是 `{content: <纯文本>, error?: true}`。

### 3.7 图片

`{inlineData: {mimeType, data}}`，裸 base64。内联失败**抛错**。

- 单张上限 10 MiB
- 请求体上限 64 MiB，**发送前真实检查**，超限归 `CONTEXT_WINDOW_EXCEEDED`
 （触发 harness 压缩重试）而不是 `INVALID_REQUEST`

---

## 4. 流式响应（Gemini 自有格式）

- 路径 `POST {endpoint}/v1internal:streamGenerateContent?alt=sse`
- 每帧是 `{"response": {...}}` **或**裸 `Response`（先试信封再试裸）
-  **只有 `candidates` 非空才算内容帧**；纯 `usageMetadata` 的收尾帧要继续读
- 结束标志：`data: [DONE]`
- 注释行（`:` 开头，心跳）跳过；`event:` 行忽略；每帧是**单行 `data:`**，不做多行拼接

### 4.1 内容 part 字段

`text`、`thought`（boolean）、`thoughtSignature`、
`functionCall{name, args}`、`functionResponse{name, response}`、`inlineData{mimeType, data}`

- 思考内容：`part.thought === true` 的 part 映射为 reasoning 块
  **思考分片上的签名刻意不存**（只有 functionCall 上那个被校验）
-  工具调用**独占一个块**，参数一次性发完再关块
 （上游 functionCall 是完整的、不是增量）。工具 id 由本地生成：
 `gemini_tool_<base36 时间戳>_<index>`

### 4.2 用量

`usageMetadata` 的字段是 `promptTokenCount` / `candidatesTokenCount` /
`thoughtsTokenCount` / `totalTokenCount` / `cachedContentTokenCount`

**取「见过的最大 `totalTokenCount` 的那一份」**
（上游会在多个帧里重复播报 usage，早期帧数字偏小）

**usage 映射**：
- `inputTokens = max(0, promptTokenCount - cachedContentTokenCount)`
 （DSH 的计数互斥，不减会双重计费）
- `outputTokens = candidatesTokenCount`
- `cacheReadTokens = cachedContentTokenCount`
- `reasoningTokens = thoughtsTokenCount`（是 output 的子集，**不相加**）

### 4.3 finishReason 映射

有工具调用 → `tool-calls`；`MAX_TOKENS` → max-tokens；
`STOP` / `STOP_SEQUENCE` / `FINISH_REASON_UNSPECIFIED` / 未知 → `stop`

### 4.4 空闲超时

`GEMINI_IDLE_TIMEOUT_MS = 120_000`：上游生成大 functionCall 参数期间可能长时间不 flush，
裸 `reader.read()` 会**无限期挂起**（表现为「发消息后永远转圈」）。

收尾余量必须按整行再走一遍。无任何内容块 → 抛错。

### 4.5 错误分类（实测报文）

```json
{"error":{"code":400,"message":"The input token count (1200000) exceeds
the maximum number of tokens allowed (1048576).","status":"INVALID_ARGUMENT"}}
```

该报文里**一个 `context` 都没有**，harness 的 `isContextWindowExceededError` 认不出
⇒ 需补专属判据：`/\btoken\s+count\b[\s\S]{0,60}?\bexceeds?\s+the\s+maximum\b/i`

**服务端按 sessionId 累计超 1M** 与 **本地历史把单次请求撑过窗口** 是**两条不同的路**：
- 前者升代就够
- 后者升代没用（请求体本身还是那么大）

上游对两者回**同一句话**，无法从报文区分 ⇒ 处置是升级式的：
先升代（便宜），升过仍失败就归 `CONTEXT_WINDOW_EXCEEDED` 交给 harness 压缩（贵但能根治）。

`isGeminiSessionOverflow` 必须**先于** `isGeminiQuotaText` 判定。

归错码代价不对称：归成 `INVALID_REQUEST` 就**连一次压缩的机会都没有**。

---

## 5. 模型目录

**Gemini 是静态表，不拉远端目录**（用户拍板；Cloud Code 没有模型列表端点）。

静态表只有 **1 条**：

| id | name | contextWindow | maxTokens | supportsImage | effortOptions | defaultEffort |
|---|---|---|---|---|---|---|
| `gemini-3.8-flash` | `Gemini 3.8 Flash` | 1_000_000 | 64_000 | true | `['low','medium','high','tiered']` | `medium` |

- **不暴露 4 个带后缀的模型名**（档位走 efforts 下拉框）
- **不暴露 lite**：真机实测 `gemini-3.8-flash-lite` 在两端点上**恒 404**
 （`{"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}`），
 与是否传档位无关 ⇒ 该模型名不在本账号的准入表里
- 模型 id 归一：剥掉已知档位后缀 `-low/-medium/-high/-tiered`
-  **`modelId` 严格校验**：不在表内直接抛 `INVALID_REQUEST`（带 `status: 404`）。
 曾经「任何 id 都放行」是宽容的，但代价是用户写错模型名时**静默跑出 3.8 的答案且无任何征兆**
 （网关实测 `gemini/gemini-9.9-fake`、`gemini/totally-bogus` 均 200 并正常作答
 —— 名字根本没参与上游请求）
- 静态表**每次现算**，不做任何缓存

---

## 6. 额度查询（配额窗口，不是积分）

端点 `POST https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary`，
头与推理请求**完全一致**（含五个伪装头，`includeAccept` 保持 false）。

### 6.1  请求体必须带 `project`

- 字段名是 `project`，**不是** `cloudaicompanionProject`
 （后者会 400 `Unknown name "cloudaicompanionProject": Cannot find field.`）
- 值取凭据里的 `cloudaicompanionProject`，缺失退到 `aicode-consumers`

原版发空对象 `{}` 是单账号抓包的结论；实测第二个 Google 账号用 `{}` 会被拒
`403 PERMISSION_DENIED SUBSCRIPTION_REQUIRED (#3501) "You do not have a valid license
of this product."`，带上 `{"project":"aicode-consumers"}` 就 200。

### 6.2 响应形状（实测，普通 JSON 不是 protobuf）

```json
{"groups":[{"displayName":"Gemini Models","buckets":[
 {"bucketId":"gemini-weekly","window":"weekly","resetTime":"…","remainingFraction":0.99},
 {"bucketId":"gemini-5h","window":"5h","resetTime":"…","remainingFraction":0.99}]},
{"displayName":"Claude and GPT models","buckets":[…]}]}
```

- 桶 id 常量：`GEMINI_BUCKET_FIVE_HOUR = 'gemini-5h'`、`GEMINI_BUCKET_WEEKLY = 'gemini-weekly'`
-  **按 `bucketId` 匹配，不按 `displayName` / `window`**
 （显示名是文案会变，`window` 字段在实测里出现过缺失）
- 第三组桶（`3p-*`）属 Claude/GPT 产品线，与本 provider 无关
-  **`resetTime` 解析失败 ⇒ 整条桶丢弃**
- 两个桶都没认出来 ⇒ `null`（真失败），**不伪造 100%**
- 展示：单位 `%`，`total` 取两窗口剩余百分比的**平均**
 （取 min 会把「周 99% / 5 小时 20%」显示成 20%，误导）
- 缓存 60 秒，键用 `access_token`
- 未授权**不是错误**：返回 `{balance: null, error: '尚未授权 Google 账号'}`

### 6.3 账号档位（`tier`）搭这趟车

- 端点 `POST .../v1internal:loadCodeAssist`，与配额**并行发**在同一次调用里
- 请求体是**逐字常量**（content-length 恰为 38）：
 ```json
 {"metadata":{"ideType":"ANTIGRAVITY"}}
 ```
 **不带** `platform` / `pluginType` / `cloudaicompanionProject`
-  **判据是 `paidTier`，不是 `currentTier`**：实测两个账号的 `currentTier` 都是
 `{id:'free-tier',name:'Antigravity'}`，完全一样；真正区分的是 `paidTier`
 （`g1-pro-tier` / `Google AI Pro` 对 `free-tier` / `Antigravity Starter Quota`）
- 短标签规则（顺序有意义）：含 `ultra` → Ultra；含 `pro` → Pro；含 `free` → Free
 （上游把「Pro 但已降级」也叫 `free-tier`，故不能只看 id 的 `-tier` 后缀）
- 档位失败绝不污染配额结果

### 6.4 403/401 文案挖掘

上游错误体是
`{"error":{"status":"PERMISSION_DENIED","details":[{"reason":"SUBSCRIPTION_REQUIRED",…}]}}`。
凭据真失效时通常是 `UNAUTHENTICATED` / `invalid_grant`；
`SUBSCRIPTION_REQUIRED` 完全是另一回事（账号形态差异）
⇒ 必须把上游 `reason` 透出来，否则面板只会误导人去重新登录。

---

## 7. 其他踩坑

- **续期互斥**：`per-ref` `SerialQueue`。
  **Google 对 refresh_token 有重放检测**，交错请求会让其中一次拿到 `invalid_grant`，
 进而被误判成「终态失效」把好账号标死
- **终态判定前先确认「刚才用的那一份 refresh_token 还是不是当前那一份」**：
 并发下服务端拒的是旧的那份，磁盘上此刻躺着一份新的可用凭据
 ⇒ 这属于「他处已续成功」，不加这层判据一次交错就会把好账号永久标死
- **`refreshable` 只是凭据材料的镜像**，每轮由凭据本体对账得出；
 凭据齐全而被误写成 false 时本轮**自动改回 true（自愈）**。`refreshAll` **不看 `enabled`**
- **刷新终态错误的 `name` 必须是字符串 `'RefreshTokenExpiredError'`**
 —— 判据是结构化比较 + 文案正则兜底，写成类名会让第一个分支恒不命中，
 `RefreshScheduler` 会无限重试

---

## 8. `gemini-project.ts` 与 `gemini-sigstore.ts` 说明

### 8.1 `gemini-project.ts`：探测并缓存信封里 `project` 的值

**三级缓存**：进程内 Map → 凭据字段 `cloudaicompanionProject` → 现探 `loadCodeAssist`

**取值顺序**：顶层 `cloudaicompanionProject` → `currentTier.cloudaicompanionProject`

**免费档账号的 LCA 返回空 project** ⇒ 回落兜底串 `GEMINI_DEFAULT_PROJECT = 'aicode-consumers'`。
历次抓包都看到该值只是这个原因。

**「探测失败」与「探测成功但为空」必须分开**：
- LCA 200 且 project 非空 → 用探测值
- LCA 200 但 project 为空 → 回落兜底串并**照常发推理**
- LCA 失败（网络/非 2xx/空响应）→ 返回 `error`，调用方**不发推理**

探测端点顺序 sandbox 优先，超时 30s。
缓存键用 `email` → `sub` → `access_token`（用 token 当键会每次续期后失效）。
回写凭据**只回写探测到的非空值**，不回写兜底串。

### 8.2 `gemini-sigstore.ts`：`thoughtSignature` 的本地缓存

它**不是** Sigstore（供应链签名服务）。

**成因**：DSH 的 `ReasoningBlock{type:'reasoning';text}` **不携带签名**，签名无处安放。

**键算法（逐字）**：`key = sha256(role + '\0' + body)[:16]`（hex，16 字符），
其中 `body` 超过 **512 字符**时只取前 512；
工具调用用 `role = 'tool:' + name`、`body = canonicalArgs(argsJson)`（按键名升序的 JSON）。

- 落盘文件 `gemini-sigs.json`，与 `state.json` **同目录**；条目上限 2000，
 超限淘汰最旧一半；原子写
- 查询顺序：精确键优先，miss 时回退 `latestForTool(name)`（按**写入顺序**判最近）
- 只存 `functionCall` 上的签名，纯文本 part 的签名不存
- **Python 完全可以复现**：纯本地缓存，算法只有 `sha256` + hex 截断 + JSON 读写

**实测修正**：低档 + 不带 `tool_choice` 时**没有签名也能成功**
（全新进程、无缓存，直接发带 `tool_result` 的请求，上游回 200）。
所以「否则上游以 400 拒绝」过于绝对；缓存的价值是推理链连续性。

### 8.3 `gemini-adapter.ts` 的救场控制流

1. 签名被拒 → 去签重试一次（同账号同端点）
2. 403/404、400(quota|permission|unsupported|project) → 先换端点一次
3. 429 第一次 → 先换端点，第二次 → 换账号
4. 401 → 先续期一次，续不动 → 换账号
5. 换账号用局部可变的 `currentAccountId`，`tried` 集合跨轮保留
6. 全部试完 → 抛 `QUOTA_EXCEEDED`

错误归类：403/404 归 `SERVER`（**不**用 AUTH，因为这两个码在 Cloud Code 上
更多是「入口/模型注册表不认」）。
