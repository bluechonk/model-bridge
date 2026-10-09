# ZCode 协议规格（智谱 z.ai）

提取自 `dsh-our-free-model/vendor/channel-pack/src/zcode*.ts`。

---

## 1. 端点

| 用途 | 方法 | 完整 URL | 来源 |
|---|---|---|---|
| 对话（免费额度通道） | POST | `https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages` | zcode-upstream.ts:44 |
| 对话（订阅制通道） | POST | `https://api.z.ai/api/anthropic/v1/messages` | :59 |
| 余额（**需 Authorization**） | GET | `https://zcode.z.ai/api/v1/zcode-plan/billing/balance` | :65 |
| 可领活动预览（**不需 Authorization**） | GET | `https://zcode.z.ai/api/v1/zcode-plan/billing/preview` | :68 |
| 领取（**需 Authorization + captcha**） | POST | `https://zcode.z.ai/api/v1/zcode-plan/billing/claim` | :71 |
| 客户端活跃上报（**不需 Authorization**） | POST | `https://zcode.z.ai/api/v1/event/report` | :74 |
| 客户端配置（模型池 + captcha 配置） | GET | `https://zcode.z.ai/api/v1/client/configs` | :77 |
| 登录页 | GET（浏览器） | `https://bigmodel.cn/login?appId=zcode&redirect=` | zcode-login.ts |
| 授权页 | GET（浏览器） | `https://zcode.z.ai/` | zcode-captcha.ts |

**通道与域名的对应关系（实测 2026-10-03 复核）**：
- **积分制（`start-plan`）无论账号是 bigmodel 还是 zai，都走 `zcode.z.ai`**
 —— 官方分派表（`resources/config/provider/zcode-builtin.json`）规则 2/5 明确如此。
 **不要**因为账号是国际版就改域名。
- 订阅制（`coding-plan`）才走 `api.z.ai`。

---

## 2. 认证

### 2.1 请求头（`buildZcodeHeaders`，zcode-upstream.ts:90-112）

```
User-Agent: ZCode/<appVersion>
HTTP-Referer: https://zcode.z.ai
X-ZCode-App-Version: <appVersion>
X-Release-Channel: stable
X-Client-Language: zh-CN
X-Client-Timezone: Asia/Shanghai
X-Device-Mid: <device_mid>
X-Platform: win32
X-Os-Category: windows
anthropic-version: 2023-06-01
Content-Type: application/json        （json !== false 时）
Authorization: Bearer <jwt>           （显式传入时）
x-aliyun-captcha-verify-param: <param>    （captcha 时）
x-aliyun-captcha-verify-region: <region>  （captcha 时）
```

### 2.2 鉴权要求按端点不同（实测）

| 端点 | 需要 `Authorization: Bearer <jwt>` | 需要 `X-Device-Mid` |
|---|---|---|
| `GET /zcode-plan/billing/balance` | **是**（缺则 401） | **是**（缺则 400 code 3001） |
| `GET /zcode-plan/billing/preview` | 否 | 是 |
| `POST /api/v1/event/report` | 否 | 是 |
| `POST /zcode-plan/billing/claim` | **是** | 是（另需 captcha 头） |
| `GET /api/v1/client/configs` | **是** | 是 |

这两条都踩过：不带 `Authorization` 查额度得 **401**；
不带 `X-Device-Mid` 得 **400 `{"code":3001,"msg":"parameter error"}`**。

### 2.3 凭据结构（zcode.ts:48-77）

| 字段 | 说明 |
|---|---|
| `zcode_jwt` | ZCode JWT（`zcodejwttoken`）—— 免费额度通道的 `Authorization: Bearer` |
| `device_mid` | 设备标识，**必需** |
| `user_id?` | **账号标识**（服务端下发的 `user.user_id`），唯一能判断「两条账号记录是否同一账号」的稳定标识 |
| `bigmodel_access_token?` | 大模型 access token，备用身份 |
| `app_version?` | 客户端版本（用于 `X-ZCode-App-Version`） |

**`device_mid` 由插件自己随机生成**（`generateDeviceMid()`，zcode-login.ts），
**不是**读官方客户端的。实测依据：同一 JWT 换任意随机 UUID，`billing/balance` 都回 200
⇒ 它的**值**不被服务端绑定校验，只需**稳定**（生成后持久化在凭据里）。

**它不是账号标识，别拿它去重 / 认账号**：同一账号**每次重新登录都会得到一个新值**。
账号去重必须用 `user_id`。

### 2.4 登录流程（纯 HTTP，见 zcode-login.ts）

登录后组装凭据时生成自用的 `device_mid`。

---

## 3. 对话请求（Anthropic Messages 形状）

### 3.1  3012 风控与官方身份块（**本渠道最大的坑**）

上游对 `/zcode-plan/anthropic` 通道做**请求体内容检查**：`system` 字段缺少官方的身份块结构时，
直接返回 `{"code":3012,"msg":"request has been blocked due to unusual activity."}`。

**实测矩阵**（同账号、同 captcha 来源）：

| system 内容 | 字符数 | 结果 |
|---|---|---|
| 无 system | 0 | ✗ 405 + `3012` |
| 仅 cliPrefix | 42 | ✗ 405 + `3012` |
| **cliPrefix + stable（全部三段）** | **约 2898** | **✓ 200** |
| 完整四块（含 dynamic 段） | 7599 | ✓ 200 |

⇒ **判据是「身份块是否存在」**，不是「块数多少」或「字符数够不够」，
也与 HTTP 头、运行时（Electron / curl / Node）无关。

**2026-10-03 复测修正的两条旧说法**（issue IKJI0Y 驱动，三个账号、17 次请求）：
1. **HTTP 状态码是 `405`**，不是 `403`。排查时别按 403 找。
2. **日期块在这个窗口不是判据**（`withContextPrefix` 去掉照样 200）。
  它仍照发（官方如此、零成本），但它与身份块是**必要非充分**的关系。

本次逐项排除的**非判据**还有：HTTP 头、版本头（`3.14.3`/`3.14.4`/`4.0.0`）、
请求频率（单账号无间隔连发 6 发）、多轮历史（`tool_use`/`tool_result`）、
`tools` 声明、账号池中的其它账号。

**3012 有账号冷却惩罚**（30 分钟；24h 内第 3 次起 24h；**5 次停用**）。
**不要为了调试反复触发。**

**身份块内容**（本项目用 `tools/extract-zcode-identity.mjs` 程序化提取，避免手抄偏差）：

- **第一块 cliPrefix（42 字符）**：`You are ZCode, an interactive coding agent`
- **第二至四块 stable（三段，合计约 2852 字符）**：
 1. `# Harness` 段（1211 字符）—— 含 ZCode 的 agent 行为指令
 2. `# ZCode Desktop Context` 段（1100 字符）—— 含 Files & URLs / Inline Code Comments 说明
 3. `# Working style` 段（541 字符）

只发**准入必需**的部分。官方完整身份块还含约 5KB 的 dynamic 段
（`# Communicating with the user` / `# Context management`），那些是**给 ZCode 内
coding agent 的行为指令**，与准入无关 —— 且它们会被放在 system 开头，
**压过调用方自己的 prompt**，表现为「啰嗦、慢」。故**不含** dynamic 段。

**维护警告**：上游策略与此结构**强耦合**。官方客户端升级后若改变身份块结构，
需要同步更新，否则会重新出现 3012。

### 3.2 请求体（Anthropic Messages）

```
{
 model: "<模型 id>",
 system: [ {type:"text", text:<cliPrefix>}, {type:"text", text:<stable1>}, ... ],
 messages: [ {role:"user"|"assistant", content:[{type:"text", text:...}]} ],
 max_tokens: <number>,
 stream: true,
 temperature?: <number>,
 stop_sequences?: [...],
 tools?: [{name, description, input_schema}],
 output_config?: { effort: <档位> }
}
```

- 身份块必须**在 system 开头**（判据要求）
- 调用方的 system 拼在身份块**之后**
- 消息 content 是块数组（`[{type:"text",text}]`）
- 工具用 Anthropic 形状（`input_schema` 而非 `parameters`）

---

## 4. 流式响应（Anthropic SSE）

事件映射（zcode-anthropic.ts:436-444）：

| Anthropic 事件 | 产出 |
|---|---|
| `message_start` | 收 `message.usage.input_tokens` |
| `content_block_start`（`text`） | 文本块开始 |
| `content_block_start`（`thinking`） | 思考块开始 |
| `content_block_start`（`tool_use`） | 记录 id/name（等 `input_json_delta`） |
| `content_block_delta`（`text_delta`） | 文本增量（字段 `delta.text`） |
| `content_block_delta`（`thinking_delta`） | 思考增量（字段 `delta.thinking`） |
| `content_block_delta`（`input_json_delta`） | 工具参数增量（字段 `delta.partial_json`） |
| `content_block_stop` | 块结束 |
| `message_delta` | `delta.stop_reason` + `usage.output_tokens` |
| `message_stop` | 结束 |
| `error` | **必须抛错** |

**`error` 事件必须抛错**（AGENTS.md 记过 Qoder 的同型缺陷：
错误被静默当成「正常结束、无内容」，UI 表现为「干净地停止、无任何报错」）。

`signature_delta` 必须忽略（当成文本会往回答里注入一串十六进制）。

`stop_reason` 映射：`end_turn` → stop、`max_tokens` → length、`tool_use` → tool_calls。

**业务错误码**：
- `3012` = 风控拦截（**不要重试**：有账号冷却惩罚，重复触发会升级封禁）
- `401` / `1002` = 凭据失效

---

## 5. 模型目录

从 `GET /api/v1/client/configs` 取：
- `offPeak.allowed_models`（积分制）
- `startPlanPreview.entitlements`
- `builtinModels[].reasoning.levels`（档位，**键序即展示顺序**）

上游清单里有 4 个（`GLM-5-Turbo` / `GLM-5.2` / `GLM-5.3` / `GLM-5.3-Flash`），
但**前两个在 Start Plan 下返回空响应**（实测 0/3 正确，而 GLM-5.3 是 3/3），
故**只暴露后两个** —— 列一个用不了的模型比不列更糟。

---

## 6. 额度与签到

### 6.1 余额（`billing/balance`）

**计量单位**：上游明确下发 `unit_type: "token"`（实测），
桶字段为 `{meter:"model_usage", unit_type:"token", total_units, used_units, remaining_units}`。

真实缺陷记录：早期把它当泛化的「积分」渲染，于是界面显示 `94539275`（无单位、量级像积分），
而正确形态是 **`94.54M` tokens**。

### 6.2 签到为什么要「补激活上报」（zcode-upstream.ts:23-40）

服务端**不会主动推送**活动。`preview` 的内容依赖**客户端活跃信号**：

```
补 POST /api/v1/event/report {app_launch, app_daily_active} 之前：
 preview → {"code":0,"data":{"plans":[]}}          ← 空
补之后：
 preview → {"code":0,"data":{"plans":[{plan_id:"zcode-v3-start-plan-trust-…"}]}}
```

**⇒ 「每日随机派发」不是随机推送，而是「服务端按活跃信号决定要不要给」。**
所以要领额度必须**先补两条事件**，再查 preview，再 claim。

### 6.3 captcha（阿里云）

**谁还要 captcha**（2026-10-01 直连上游实测）：

| 端点 | 不带验证头 | 结论 |
|---|---|---|
| `/api/v1/zcode-plan/anthropic`（**模型请求**） | **HTTP 200**（6 个采样点） | **自 3.14.4（2026-09-29）起不再索要** |
| `/api/v1/zcode-plan/billing/claim`（**领取**） | `400 {"code":3007}` | **始终索要**，且校验**前置于** plan 校验 |

⇒ 模型请求这条路现在**恒不产** param；仍在产的是**领取**（每日一次 / 手动点「一键领取」，
**每个 plan 独立一个**，一次性，复用必 `3007`）。

模型请求侧的 `3007` 防御分支**故意保留**：万一上游回滚再开校验，推理请求仍能自愈。

**captcha 载体**：
- captcha 是**网页 SDK**（`https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`），
 不是 Electron 专有 API
- 配置：`window.AliyunCaptchaConfig = { region, prefix }`
- 调用：`initAliyunCaptcha({ SceneId, mode, element, button, getInstance, success, … })`
- 取参：`getInstance` 里调 `instance.startTracelessVerification()`（无感验证）→ `success(param)` 回调给出 param

**两个实测约束**：
1. ~~同一个页面不能重复 mint~~ → **已推翻**（当时页面停在 `about:blank`，
  origin 为字符串 `"null"`）。换到真实 `https://zcode.z.ai/` 后同一页面可**连续 mint 5/5**，
  中位 426ms。现行实现**复用常驻页面 + 每次重置 DOM**。
2. **`--headless=new` 过不了，必须 headful**（阿里云风控看这个差异）。
  headful 在 Windows 上可以**不打扰用户**（`--window-position=-32000,-32000` 移出屏幕）。

**captcha 有效期**（captcha-pool.ts:1-20，吸收自 `dsh-free-glm`）：

| 生成后经过 | 使用结果 |
|---|---|
| 0 / 10 / 30 / 60 秒 |  可用 |
| 120 秒 |  3007 |

⇒ **有效期在 60-120 秒之间**；「一次性」只指「用一次就作废」，**不指「必须立刻用」**。
故可以提前产好、放在池里等下一次请求（本项目取 TTL 30 秒，双倍余量）。
