# Raccoon 协议规格（商汤小浣熊）

提取自 `dsh-our-free-model/vendor/channel-pack/src/raccoon*.ts`。

---

## 1. 端点

API 基址 `https://xiaohuanxiong.com`，四个前缀：

```
RACCOON_AUTH_PREFIX    = '/api/web/auth/v1'
RACCOON_LLM_PREFIX     = '/api/web/llm/v2'
RACCOON_POINTS_PREFIX  = '/api/web/points/v1'
RACCOON_DESKTOP_PREFIX = '/api/web/desktop/v1'
```

| 用途 | 方法 | 完整 URL | 认证 |
|---|---|---|---|
| 授权页（网页登录第一步，官方桌面端同款） | GET | `/code/authorize?login_source=desktop&appname=办公小浣熊客户端&state=<32位hex>` | 无 |
| 授权码换凭证（网页登录第二步） | POST | `/api/web/auth/v1/login_with_authorization_code` | 无 |
| 发短信验证码 | POST | `/api/web/auth/v1/send_sms` | 无 |
| 短信登录 | POST | `/api/web/auth/v1/login_with_sms` | 无 |
| 续期 | POST | `/api/web/auth/v1/refresh` | 无（body 带 refresh_token） |
| 用户信息 | GET | `/api/web/auth/v1/user_info` | Bearer |
| 对话 | POST | `/api/web/llm/v2/chat/completions` | Bearer |
| 模型目录 | GET | `/api/web/llm/v2/model_catalog` | Bearer |
| 积分余额 | GET | `/api/web/points/v1/balance` | Bearer |
| 账单（查奖励是否已领 / 今日入账） | GET | `/api/web/points/v1/bills?paging.limit=50&paging.offset=0` | Bearer |
| 登录奖励（一次性） | POST | `/api/web/desktop/v1/login/points/grant` | Bearer + `X-Client-Platform` |
| 每日积分触发器（签到） | GET | `/api/web/office/v3/setting_info` | Bearer + `X-Client-Platform` |

**关键常量**：
- `RACCOON_REQUEST_TIMEOUT_MS = 60_000`
- `RACCOON_LOGIN_TIMEOUT_MS = 5 * 60 * 1000`（等待用户完成网页登录并粘贴回调）
- `RACCOON_TOKEN_REFRESH_WINDOW_SECONDS = 300`（access_token 寿命约 3 小时，实测 `exp - nbf = 10805s`）
- 授权页参数：`login_source = 'desktop'`、`appname = '办公小浣熊客户端'`
- 回调深链：`office-raccoon://auth/callback?code=…&state=…`；换码失败业务码 `200035`
- `clientPlatform = 'desktop-windows'`、`clientVersion = 'v1.0.35'`、
 `userAgent = 'Raccoon Work/1.0.35 (Windows)'`

---

## 2. 认证

### 2.1 请求头（raccoon.ts:271-293）

```python
{
 "Accept": "application/json",
 "Content-Type": "application/json",
 "Authorization": f"Bearer {access_token}",
 "X-Org-Code": office_identity or "",        # 个人账号为空串；客户端总是发送该头
 "X-Raccoon-Language": "zh",
 # 可选：
 "X-Client-Platform": platform,              # 必须是 desktop-windows / desktop-macos / desktop-linux
 "X-Client-Version": version,
 "X-Client-Device-ID": device_id,            # 32 位 hex 设备指纹
}
```

`X-Client-Platform` 对 `desktop/v1/login/points/grant` **必需**
（依据主进程 `desktopDeviceIdentity.js` 的 `resolveDesktopClientPlatform`，`win32` → `desktop-windows`）。猜错会被拒。

**对话请求的头是内联构造的**（upstream.ts），只含
`Accept` / `Content-Type` / `Authorization` / `X-Org-Code` / `X-Raccoon-Language` / `X-Client-Platform`
（**不含** `X-Client-Version` 与 `X-Client-Device-ID`）。

**模型目录请求也是内联的**（upstream.ts），只含
`Accept` / `Authorization` / `X-Org-Code` / `X-Raccoon-Language`（**不含** platform）。

### 2.2 凭据字段（raccoon.ts:78-106）

| 字段 | 必需 | 说明 |
|---|---|---|
| `access_token` | 是 | JWT（服务端下发） |
| `refresh_token` | 是 | 续期用 |
| `expires_at` | 否 | **毫秒时间戳字符串**，由 JWT 的 exp 推算 |
| `office_identity` | 否 | `personal` 或组织码 |
| `user_id` | 否 | 用户 id |
| `nickname` | 否 |  服务端的 `name` 是**自动生成的默认名**（实测 `RaccoonAva`），登录**不回传用户昵称** |
| `phone` | 否 | 绑定/注册的手机号，用于**多账号消歧** |
| `device_id` | 否 | 设备指纹（32 位 hex） |

**过期时间取值优先级**（raccoon.ts:142-150）：
`expires_at`（显式字段）→ **JWT 的 `exp`**（本地 base64url 解码 payload，**只解码不验签**）

**回退到 JWT 是必需的，不是锦上添花**：`expires_at` 是可选字段，
老凭据或手工导入的凭据可能没有它。只读 `expires_at` 会让过期判定**恒为 false**，
于是 `refreshAll` 永远跳过这些账号 —— 表现为「凭据悄悄过期、续期从不触发」（静默失效，无任何报错）。

### 2.3  手机号 AES-128-CFB 加密（raccoon.ts:174-201）

算法照抄客户端（渲染层模块 68284 的 `yv()`）：

```
key   = UTF8("senseraccoon2023")  → 16 字节 ⇒ AES-128
iv    = 随机 16 字节
mode  = CFB, padding = NoPadding
输出  = Base64(iv ‖ ciphertext)
```

密钥常量：`RACCOON_PHONE_CIPHER_SECRET = 'senseraccoon2023'`

-  **公开常量**（客户端把它硬编码在前端 bundle 里），
 只用于防止手机号明文出现在日志/代理里，**不是安全边界**
-  必须**显式**写 `aes-128-cfb`：密钥是 16 字节，写成 `aes-256-cfb` 会因长度不足而抛错
-  填充语义已实测：CFB 是流密码，`setAutoPadding(true/false)` 输出**完全一致**
- Python 等价：`cryptography.hazmat.primitives.ciphers` 的
 `Cipher(algorithms.AES(key), modes.CFB(iv))`；或 `pycryptodome` 的
 `AES.new(key, AES.MODE_CFB, iv, segment_size=128)`

**不加密的后果**：`send_sms` 回 `100003 params_encryted_error`。

### 2.4 登录流程 A：网页登录（授权码，官方桌面端同款）

官方桌面端 `electron/main/desktopLogin.js` 的链路（本插件照搬；另两个开源实现
agent2api / xiaohuanxiong2api 同构）：

```
① 浏览器打开授权页（官方参数：login_source=desktop + appname=办公小浣熊客户端）：
   https://xiaohuanxiong.com/code/authorize?login_source=desktop&appname=办公小浣熊客户端&state=<32位hex>
   （官方不带 state；我们带，并在回调时逐字比对）
② 用户在页面上用微信 / 验证码 / 密码登录成功
   → 页面跳转自定义协议回调：office-raccoon://auth/callback?code=…&state=…
③ 换凭证：
POST https://xiaohuanxiong.com/api/web/auth/v1/login_with_authorization_code
Content-Type: application/json
body: { "authorization_code": "<回调里的 code>" }
→ { code: 0, data: { access_token, refresh_token, office_identity, office_org_name, office_org_role } }
   失败：HTTP 400 + { "code": 200035, "message": "authorization_code_not_found_error" }（终态：码已失效/已消费）
```

**回调怎么回收**：本插件是宿主机里的普通 Node 进程，注册不了
`office-raccoon://` 自定义协议 → **提示用户把地址栏里的整条回调 URL 粘贴回来**
（与 agent2api 的 Docker 形态一致；也可用环境变量 `RACCOON_LOGIN_CALLBACK` 注入）。

**为什么不用 `/login/mp?code=…`**：那条是**官方手机 App 扫码**专用（官方桌面端的
二维码、网站自己的微信登录二维码都用它），但网页端**没有该路由** —— 真实浏览器
打开只会落到 SPA 兜底页，是死链（真机踩过）。授权码链路才是「浏览器里能走通」的那条。

### 2.5 登录流程 B：短信验证码

**第 1 步** 发短信：
```
POST https://xiaohuanxiong.com/api/web/auth/v1/send_sms
body: {
 "captcha_param": "<阿里云滑块产物>",
 "nation_code": "86",
 "phone": "<AES-128-CFB 加密后 base64>"
}
```
`captcha_param` **必需**（否则 `100006 captcha_verify_error`）。

**第 2 步** 登录：
```
POST /api/web/auth/v1/login_with_sms
body: { "nation_code": "86", "phone": "<加密后>", "sms_code": "<6位>" }
→ { code: 0, data: { access_token, refresh_token, office_identity } }
```

### 2.6  阿里云验证码（raccoon-login-page.ts）

本地登录页**真实加载官方脚本**，SceneId / prefix 来自客户端配置：

```
script src = https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js
sceneId   = '1pkmy0x3'
prefix    = 'hk1r5l'
mode      = 'popup'
slideStyle= { width: 320, height: 40 }
language  = 'cn'
```

脚本未加载（离线/被拦截）时**退化为直接提交**（`captchaParam: ''`），
让服务端报明确原因。

### 2.7 续期流程

```
POST https://xiaohuanxiong.com/api/web/auth/v1/refresh
body: { "refresh_token": "<refresh_token>" }
→ { code: 0, data: { access_token, refresh_token? } }
```

**终态判定**：HTTP 401 **或** `envelope.code === 200003` → 抛「登录态已过期，请重新登录」（**不重试**）

服务端可能**只返回新的 access_token**（不带新 refresh_token），此时必须**保留旧值**
—— 否则续期一次就把账号变成不可续期。
服务端不返回的附加字段（昵称、身份、设备号）也要保留。

### 2.8 用户信息

```
GET https://xiaohuanxiong.com/api/web/auth/v1/user_info
→ { code: 0, data: { id, name, office_identity, phone } }
```

失败时返回**空对象**而不是抛错：用户信息只用于昵称展示。
`nickname` 取的是远端的 `name`，而**它是服务端自动生成的默认名**，
故多账号消歧要靠 `phone`。

### 2.9 本插件的登录交互（非上游协议，供实现对照）

**没有本地登录页**：`mb raccoon login` 直接打印授权页 URL（见 §2.4），用户在浏览器里
完成登录后，把地址栏里的整条回调 URL 粘贴回终端；非交互场景可用环境变量
`RACCOON_LOGIN_CALLBACK` 注入回调 URL。

手机号本地校验：`/^1[3-9]\d{9}$/`；短信登录是备用链路（`send_sms` + `login_with_sms`）。

---

## 3. 对话请求

### 3.1 请求体

```json
{
 "model": "<模型 id，如 sn-glm-5-3>",
 "messages": [ ... ],
 "stream": true,
 "max_tokens": <number>,
 "temperature": <number>,
 "stop": [ ... ],
 "tools": [ { "type": "function", "function": { "name", "description", "parameters" } } ],
 "extra_body": { "thinking": { "type": "enabled" | "disabled" } }
}
```

- `system` 提示词拼为 `messages[0]` 的 `{role:'system', content}`
-  **`tools` 必须真的下发到请求体顶层** —— Qoder 与 TRAE 都因漏发而让模型在正文里臆造
 XML 工具调用，harness 认不出 → 任务终止
-  **`thinking` 必须在 `extra_body` 内** —— 实测放顶层会被忽略（连非法值都不报错）

### 3.2 必需请求头

```
Accept: text/event-stream
Content-Type: application/json
Authorization: Bearer <access_token>
X-Org-Code: <office_identity or "">
X-Raccoon-Language: zh
X-Client-Platform: desktop-windows
```

### 3.3  思考控制的完整实测结论（upstream.ts 的 buildChatBody）

**唯一有效通道是 `extra_body.thinking.type`**（Anthropic 风格对象），
服务端报错原文确认其枚举：
```
thinking.type: expected one of `adaptive`, `enabled`, `disabled`
```

实测（每组 6~8 次，判据为服务端上报的 `reasoning_tokens`）：

| 请求 | 结果 |
|---|---|
| 基线（不发参数） | 均值 **222**，6/6 有思考 |
| `extra_body.thinking={type:'disabled'}` | **6/6、8/8 全为 0** →  真关闭 |
| `extra_body.thinking={type:'enabled'}` | 均值 **218** →  与默认等价 |

**`reasoning_effort` 虽然被服务端接受，但实测无效果**：8 轮配对实验（`temperature=0`）

| 档位 | `reasoning_tokens` 均值 |
|---|---|
| `minimal` | 197 |
| `max` | 226 |

逐轮配对差值 `max - minimal`：**正差 4 次 / 负差 4 次**（纯随机）。
且 `none` 均值 301 ≠ `disabled` 的 0，说明**它也不控制思考开关**。

** 无效的写法（都实测过，别照着试）**：

| 写法 | 结果 |
|---|---|
| `extra_body.enable_thinking=false` |  无效 |
| `extra_body.extra_body.enable_thinking=false`（双层） |  无效 |
| `reasoning_effort`（单层/双层/顶层） |  被接受但**无效果** |
| `thinking` 放**顶层**（不在 `extra_body` 内） |  被忽略（非法值也不报错） |
| `thinking.budget_tokens` |  仅被**格式校验**（`max_tokens < budget_tokens` 回 400），1~4096 全接受但思考量无规律 |

客户端注释说 `extra_body` 双层嵌套是 **LiteLLM SDK 的调用约定**
—— 但实测**单层才生效**，故以实测为准。

**故本插件只暴露两态**：
```
RACCOON_EFFORT_ON  = 'on'    → extra_body.thinking = { type: 'enabled' }
RACCOON_EFFORT_OFF = 'off'   → extra_body.thinking = { type: 'disabled' }
展示名：on → '开启'，off → '关闭'
默认档位 = 'on'
```

-  id 用 `on` 而不是 `high`：服务端虽接受 `high` 字样，
 但它走的是 `reasoning_effort` 通道、**实测无效果**
-  展示名用「开启 / 关闭」而非「深度思考 / 关闭思考」—— 理由是**如实**：
 我们能表达的只有「思考开 / 关」这一个布尔维度
-  **所有 6 个可见模型都返回这两档** —— 实测 `extra_body.thinking` 是 **provider 级方言**，
 与模型无关。故不做 per-model 分派（那会是凭空猜测）
- 默认档位 = `on` 的依据：实测「不发参数」与「显式 `{type:'enabled'}`」的思考量**等价**
-  **不传档位时返回 `undefined`**（不发该字段）
-  只有明确的「关闭」才关；未知档位一律按开启处理

### 3.4 特殊约束

**① `max_tokens` 只放行安全正整数**
远端是外部输入：`0` / 负数 / `NaN` 会让 DSH 在 `defaultMaxTokens` 的硬校验上抛
`INVALID_MODEL_MAX_TOKENS`，**整轮对话起不来**（不是降级，是崩）。

**② 图片约束按请求体字节卡（不是 token 预算）**

实测 `HTTP_413: request body exceeds 10MB` —— 一张 2560×1600 的截图
（原图 2.87 MiB → base64 后 ≈3.9 MB）过、四张必爆。

- `imageMaxBytes = 512 * 1024`（base64 膨胀 4/3 → 每张约占 683 KB，10 MB 的配额可放约 **14 张**）
- `imagePixelBudget = 640_000`
-  这是「每张固定预算」路线的固有上限

**③ 401 / 403 时续期一次并重试**

---

## 4. 流式响应（标准 OpenAI 兼容）

`chat.completion.chunk` + `data: [DONE]`，**无加密、无信封、无格式转换**。

思考字段名：标准 `delta.reasoning_content`。

**业务失败也可能以 HTTP 200 + SSE 内嵌错误帧返回**。

空闲超时：首 token / chunk 间隔各 120_000 ms。

---

## 5. 模型目录

### 5.1 拉取

```
GET https://xiaohuanxiong.com/api/web/llm/v2/model_catalog
Accept: application/json
Authorization: Bearer <access_token>
X-Org-Code: <office_identity or "">
X-Raccoon-Language: zh
超时 20_000 ms
→ { code: 0, data: { categories: [ { type, models: [ ... ] } ] } }
```

失败时返回**空数组**：适配器据此回退兜底表。

### 5.2 响应字段名

解析规则：只取 `categories[].type === 'chat'` 的那个分类，过滤 `visible === false`，按 id 去重。

| 远端字段 | 用途 |
|---|---|
| `name` | **模型 id**（ 是 `name` 不是 `id`！） |
| `visible` | `false` 则过滤；**缺省视为可见** |
| `description` | 展示名主体 |
| `billing_effective_multiplier` | **当前生效**倍率 |
| `billing_multiplier` | 原价倍率 |
| `billing_status` | `'discount'` / `'limited_free'` / 其它→`'normal'` |
| `billing_status_note` | 状态角标文案 |
| `params.context_window` 或 `entry.context_window` | 上下文窗口 |
| `params.max_tokens` | 单次输出上限 |
| `tags` | 小写化后判图片能力（见下） |

实测已穷举 9 个条目的**键并集**：顶层 14 个键、`params` **只有** `context_window`
与 `max_tokens`。用模态相关词扫描，**命中 0 个**。⇒ 远端**从未下发**模态字段。

### 5.3  图片能力：`tags` 不是能力契约（真实缺陷，2026-10-03 报障）

**症状**：给 `sn-deepseek-v4-1-flash` 发图，模型回「无法读取图片 / 不支持图片」。

**根因链**：
1. 我们把「远端 `tags` 含 `vision`」当成了服务端能力声明
2. `sn-deepseek-v4-1-flash` 的 `tags` 是 `["general","code","html","analysis","reasoning","auto"]`
  —— **没有** `vision`
3. ⇒ `inputModalities` 播报 `['text']`
4. ⇒ **DSH 在 `LlmRuntime` 里把图片替换成文本占位符** —— **图片根本没发出去**
5. ⇒ 用户看到模型说「读不到图片」，而端点其实完全正常

**决定性证据：带图实测 6/6 全部读对**（同一张「随机 6 位数字」图）：

| 模型 | 远端 tags 含 vision | 实测读图 |
|---|---|---|
| `sn-deepseek-v4-1-flash` |  |  **5/5** |
| `sn-glm-5-3-flash` |  |  1/1 |
| `sn-sensenova-6-8-flash` |  |  2/2 |
| `sn-sensenova-6-8-flash-lite` |  |  1/1 |
| `sn-kimi-k3` |  |  1/1 |
| `sn-glm-5-3` |  |  1/3（provider 侧节点不一致） |

`tags` 的真实用途是**客户端「Raccoon-Auto 选模」的偏好标签** —— 它回答的是
「该模型适不适合处理这类任务」，**不是**「能不能吃图」。

**判定函数**：
```python
def raccoon_supports_image(model_id, tags):
   if model_id in RACCOON_IMAGE_CAPABILITY_OVERRIDES:   # {'sn-deepseek-v4-1-flash', 'sn-glm-5-3-flash'}
       return True
   return any(t in tags for t in ('vision', 'image', 'image-understanding'))
```

用显式白名单而不是「恒 true」：只覆盖**实测确认**的个案。
兜底表路径**不走本函数**：它的真相源是 `RACCOON_FALLBACK_MODELS[].supportsImage`。

**顺带发现：`sn-glm-5-3` 节点不一致（provider 侧缺陷）**
它 3 次里只对 1 次。错误体暴露网关有 3 个 fallback 组
（`raccoon-4eb26a` / `raccoon-0c119c` / `raccoon-ecc5fd`），**部分节点是纯文本的**。

### 5.4 展示名规则（raccoon.ts:243-262）

**1 倍也要显示**（真实缺陷，用户报障：「为什么 Kimi-K3 没有倍率，ide 是 1 倍，
1 倍也要显示倍率」）。早期按「1 倍是默认，显示属噪声」省略它，
结果该模型在列表里**看起来没有计费信息**。

三条规则：
- 生效价为 **0** → 显示「免费」（**不是** `x0`）
- 生效价**严格小于**原价 → 显示 `x原价→x折后价`
- 其余（**含 1 倍**）→ 显示 `x生效价`
-  非有限数 / 负数：不追加后缀
- 倍率格式化：最多 4 位小数并去掉尾随 0

### 5.5 兜底静态模型表（6 个 `visible:true` 模型）

来源：2026-09-26 实测 `GET /api/web/llm/v2/model_catalog`。

| id | name | contextWindow | maxTokens | supportsImage | 原价→生效价 |
|---|---|---|---|---|---|
| `sn-sensenova-6-8-flash` | SenseNova-6.8-Flash · 免费 | 256_000 | 63_999 | true | 0.5→0 |
| `sn-sensenova-6-8-flash-lite` | SenseNova-6.8-Flash-Lite · 免费 | 256_000 | 63_999 | true | 0.5→0 |
| `sn-glm-5-3` | GLM-5-3 · x0.75 | 1_000_000 | 100_000 | true | 0.75→0.75 |
| `sn-kimi-k3` | Kimi-K3 · x1 | 1_000_000 | 100_000 | true | 1→1 |
| `sn-glm-5-3-flash` | GLM-5-3-Flash · x0.2→x0.1 | 1_000_000 | 100_000 | true | 0.2→0.1 |
| `sn-deepseek-v4-1-flash` | DeepSeek-V4.1-Flash · x0.25 | 1_000_000 | 100_000 | true | 0.25→0.25 |

**不含** `Raccoon-Auto`：它是客户端 i18n 条目渲染的「自动选模」入口，
不是远端模型 —— 直接发给 `chat/completions` 会 404。
也不含 3 个 `visible:false` 的 `raccoon-*` 内部模型。

### 5.6 缓存策略

与 Loomy 同构：只缓存**真实远端目录**，兜底表每次现算；
`RemoteCatalogGate` 做并发去重 + 失败/空结果冷却。

---

## 6. 额度查询

### 6.1 三个来源的语义（关键）

| 来源 | 金额 | 触发方式 | 本模块 |
|---|---|---|---|
| 新人注册礼包 | 3000 | 注册时服务端自动发放 | 不涉及 |
| 每日积分发放 | 300 | `GET /api/web/office/v3/setting_info`（按天幂等） | 签到（触发 + 账单核对） |
| 桌面端登录奖励 | 3000 | `POST …/login/points/grant`（幂等一次性） | 导出备用（不与签到混跑） |

**签到 = 触发 + 核对两步**：`setting_info` 只是**触发器**（官方桌面端每次启动都打，
服务端按天幂等发放）；「今天有没有领到」以**账单**为准 —— 存在 `biz_type: 'daily_grant'`
（或任何 `points > 0` 且日期为今天的记录）才算入账。只看触发器会把「服务端没发」
误报成签到成功。

**「今天」按北京时间（UTC+8）**：上游自然日即 UTC+8 零点，跟机器时区走会让海外 /
容器部署把 16 小时的账单认成昨天（参考实现 agent2api 为此专门定了北京时间口径）。

### 6.2 每日积分触发器（签到）

```
GET https://xiaohuanxiong.com/api/web/office/v3/setting_info
（需 Bearer + X-Client-Platform；响应里的 point_grant_popups / point_grant_toast 是发放通知）
```

- 官方桌面端启动即调用；**按天幂等**（重复调用不会重复入账）
- 实测：未授权直接调该端点回 `401 authorization_empty_error`（端点存在性已验证）

### 6.3 查余额（**只读**）

```
GET https://xiaohuanxiong.com/api/web/points/v1/balance
→ { code: 0, message, data: { available_points, reward_points, daily_points,
                             topup_points, monthly_points } }
```

- `available_points` 是**核心字段**：没有它就说明响应形状不对，不编造数字，返回 `null`
- 各池**分开作 package**：`奖励积分`（`reward_points`）/ `每日积分`（`daily_points`）/
 `会员积分`（`monthly_points`，**仅 > 0 时才加**）/ `充值积分`（`topup_points`）
-  在「打开面板」这类高频路径上**绝不**触碰写端点

### 6.4 登录奖励（一次性，幂等）

```
POST https://xiaohuanxiong.com/api/web/desktop/v1/login/points/grant
（无 body）
→ { code: 0, data: { granted: bool, popup: { points } } }
```

-  **需要 `X-Client-Platform` 头**
-  **不是每日签到**：实测该端点是幂等一次性的
-  **幂等判据是 `granted`**，故映射成 `already-claimed` 而**不是** `claimed`
- 默认额度 `RACCOON_LOGIN_REWARD_POINTS = 3000`
- 本函数**不抛错**

### 6.5 查询奖励是否已领

```
GET https://xiaohuanxiong.com/api/web/points/v1/bills?paging.limit=50&paging.offset=0
→ { code: 0, data: { items: [ { biz_type, event_name, points } ] } }
```

判据：存在 `biz_type === 'reward_grant'` **且** `event_name === '桌面端登录奖励'` 的记录。

**不能靠 `balance` 推断** —— 余额是多个来源的合计。
**不能只按 `biz_type === 'reward_grant'` 判定** —— 「新人注册礼包」也是 `reward_grant`。
**服务端没有单独的奖励状态端点**，故只能查账单明细。
查询失败时保守返回 `claimed: false`。

### 6.6 业务信封（cred.ts 的 envelopeMessage）

```python
code = record.code if isinstance(record.code, int) else (status if status >= 400 else 0)
# code === 0 为成功
```

失败可能带 HTTP 400/401，也可能 HTTP 200 + 非 0 code。
错误消息拼接：`message` 与 `details` 用 `: ` 连接。

---

## 7. 特殊机制

- **登录走官方授权码链路，但回调靠用户粘贴**：官方桌面端靠
 `office-raccoon://auth/callback` 自定义协议回调，本插件是宿主侧 Node 进程、注册不了
 该协议 → **提示用户把地址栏里的整条回调 URL 粘贴回来**（与 agent2api 的 Docker 形态
 一致）。浏览器登录页本身用官方同款 `/code/authorize`（见 §2.4）
- **凭据不读客户端任何文件**：凭据存插件自有的 `ctx.credentials`
- **账号昵称修复（cred.ts 的 syncProfile）**：启动时主动补一次：
 读凭据 → 缺 `phone` 就拉一次 `user_info` 补上 → 重算昵称并写回账号池。
 语义约束：**幂等**、**失败不阻塞启动**、**不发写请求**
- **账号池有效期回写（本 provider 是这套逻辑的原产地）**：
 早期它是唯一漏掉回写的实现（用户报障后修好）。实测该账号的 JWT `exp` 已是 15:09（有效），
 账号池却是 12:02（已过期），**相差 3.1 小时**，UI 显示「已过期」但发消息完全正常。
 现 `refreshAll` 在凭据仍有效时也主动比对：**不一致**时以凭据为准回写
- **lead-time 过滤**：raccoon 沿用「**已过期**才刷」（不是共享的 1 小时 lead）
 —— raccoon 的 access_token 寿命约 3 小时
- **`refreshAll` 只按 `refreshable` 过滤，绝不看 `enabled`**
- **`refreshAccountCredential(refName)` 只读写传入的 ref**
