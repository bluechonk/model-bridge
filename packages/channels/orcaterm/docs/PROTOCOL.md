# OrcaTerm 协议规格（实测）

本文件只写**从本机实测/静态提取得到的事实**，每条尽量带证据出处。证据等级见文末。
实现依据以本文件为准。

---

## 1. 登录

### 1.1 三种身份提供方与两条授权路线

桌面端支持三种 OAuth 身份：`wechat`（微信扫码）、`txcloud`（腾讯云）、`github`。
统一入口形如 `https://orcaterm.com/oauth/authorize?provider=<...>&source=<desktop|web>`
（`source=desktop` 为桌面端；不带 `session_id` 时该入口返回 400 `缺少 session_id 参数`
—— `session_id` 由 App 后端建会话后下发）。

三条 provider 走**同一套骨架**（App 建会话 → 平台授权 → 回调换 `ot_session` → 深链回 App），
但授权方与回调路径各不相同。**已实测的两条**如下：

| | 微信（`wechat`） | 腾讯云（`txcloud`） |
| --- | --- | --- |
| 授权方 | 微信开放平台 `open.weixin.qq.com/connect/qrconnect` | 腾讯云开放平台 `cloud.tencent.com/open/authorize` |
| 平台 side id | `appid=wx56e5199ef872dc22` | `app_id=100045893348` |
| 回调 | `orcaterm.com/oauth/wechat/bridge` | `orcaterm.com/oauth/callback` |
| 交互 | 手机扫码 | 网页登录（手机号 / 微信 / QQ） |
| 能否自建链接 | 能：`/oauth/wechat/config` 每次给一套新 `state` | 能：入口接受任意 `session_id` 即 302（`state` 由服务端随会话生成，CLI 不需要它） |

回调完成后统一经深链 `orcaterm://oauth_callback`（国际版 `orcaterm-global://oauth_callback`）
把登录态交回桌面端。

**实现状态**：两路已落进渠道包 `channels/orcaterm/src/cred.ts`
（`mx login orcaterm` 弹二选一菜单）。

- `wechat`：全自动（自建二维码 + 长轮询取 `wx_code` → 桥接换 `ot_session`）。
- `txcloud`：`txcloud` 路同样全自动 —— CLI 自造 `session_id` → 入口 302 到平台授权页，
  用户浏览器登录/授权后 CLI 拿自己的 `sessionId` 轮询换 token（详见 §1.3）。
- `github`：`provider=github&source=desktop` 的入口确认存在（协议事实），但
  **client_id 与授权地址形态尚未实测，未实现**。

独立复现脚本见 [`../research/login-flows.mjs`](../research/login-flows.mjs)
（`wechat` 自建二维码长轮询，`txcloud` 拼授权入口并轮询换 token）。

**token 交换已实测**（txcloud 路经 CLI 真机跑通，证据等级 A，见 FINDINGS #9/#10）：
腾讯云路 `POST /cgi/api {"action":"OAuthExchangeToken","data":{"sessionId":…}}` 换
`AccessToken`。微信路按 App 实测证据实现（登录后桥接下发 `ot_session` cookie，
CSS cookie 落盘可见全值，§1.2/§1.4），CLI 实现读桥接 `Set-Cookie` —— 这条路待
真机点验一次。缓存里另见 `POST /oauth/wechat/exchange` 路径，与桥接下发并存。

### 1.2 微信扫码分支（本次实测走的路径）

1. 桌面端打开微信扫码页（页面标题「微信登录」，即 `open.weixin.qq.com/connect/qrconnect`）。
   页面通过对 `https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=<uuid>` 的长轮询
   获取扫码状态。
2. 用户扫码并确认后，微信返回 `errcode=405`，页面**跳转到 orcaterm 的回调**：

   ```
   https://orcaterm.com/oauth/wechat/bridge?code=<wx_code>&state=<uuid>
   ```

   - `code`：微信一次性授权码
   - `state`：orcaterm 后端下发的防 CSRF 串（实测为 UUID）
   - 实测样本（WebView2 `History`）：

     ```
     https://orcaterm.com/oauth/wechat/bridge?code=<wx_code>&state=<uuid>
     ```

3. `orcaterm.com` 后端用 `code` 换微信用户信息与 access_token，随后**下发 `ot_session`
   cookie**（见 1.4）并跳回桌面端。桌面端从 cookie / Rust 命令拿到登录态。

微信扫码页 HTML 已缓存在 `EBWebView\Default\Cache\Cache_Data\f_00000c`（gzip，内含上述
`redirect_uri` 拼接逻辑与 `state` 值），是本节最直接的证据。

### 1.3 腾讯云分支（开放平台授权 + sessionId 换 token）

**入口可自建**：带**任意** `session_id` 即 302 到腾讯云授权页，`state` 由服务端生成
（每次调用都不同）：

```
GET https://orcaterm.com/oauth/authorize?provider=txcloud&source=desktop&session_id=<任意UUID>
 → 302 https://cloud.tencent.com/open/authorize?scope=login&app_id=100045893348
       &redirect_url=https%3A%2F%2Forcaterm.com%2Foauth%2Fcallback%3Fprovider%3Dtxcloud
       &state=<服务端生成>
```

流程（CLI 实测跑通）：

1. CLI 生成 `sessionId` → 取授权入口的 302 → 把直达 URL 交给用户；
2. 用户在浏览器登录腾讯云并授权，浏览器落到
   `https://orcaterm.com/oauth/callback?provider=txcloud&code=…&signature=…&state=…`
   （**会话在此被消费**，`state` 随即失效）；
3. CLI **拿自己那个 `sessionId`** 轮询换 token：

   ```
   POST https://orcaterm.com/cgi/api
   {"action":"OAuthExchangeToken","data":{"sessionId":"<CLI 生成的那个>"}}
   → {"data":{"Response":{"Code":0,"AccessToken":"<HS256 JWT>","RefreshToken":"jti-based-refresh",
                          "ExpiresIn":7200,"User":{…}}}}
   ```

   （与桌面 App 的 `TokenManager` 同一条路；App 是经深链 `orcaterm://oauth_callback?sessionId=…`
   拿到 `sessionId` 再换，CLI 则本就持有它。）

**三条被实测推翻的早期假设**（留档，避免重复踩）：

| 假设 | 实测结果 |
| --- | --- |
| 读回调的 `Set-Cookie: ot_session` | ✗ 回调只返回 JSON 错误包，不写 cookie |
| `return_url` 指向 `127.0.0.1` 可收 token | ✗ 入口接受该参数，但登录后**不跳转**（Chrome 历史无回环访问） |
| 事后回放回调 URL 换 token | ✗ `code` 一次性、`state` 被浏览器消费 → `STATE_EXPIRED` |

**约束**：`state` 无法自造（伪造会 `INVALID_CALLBACK`/`STATE_EXPIRED`），必须用服务端下发的那条；
但 `sessionId` 归 CLI 所有，故整条链路可自动化，**无需用户复制任何内容**。

### 1.4 登录态：`ot_session`（HS256 JWT）

登录成功后 `orcaterm.com` 下发：

```
Set-Cookie: ot_session=<JWT>; SameSite=Lax; Secure; Path=/
```

JWT 解码（实测样本）：

```json
// header
{ "alg": "HS256", "typ": "JWT" }
// payload
{
  "userId": <用户 id（数字）>,
  "provider": "wechat",
  "providerId": "<微信 openid，已脱敏>",
  "providerUsername": "<微信昵称，已脱敏>",
  "displayName": null,
  "avatar": "https://thirdwx.qlogo.cn/...",
  "providerAccessToken": "<微信 access_token:openid 形式>",
  "jti": "<UUID（登录会话 id），已脱敏>",
  "iat": <签发时戳>,
  "exp": <签发时戳 + 7200>
}
```

- 有效期固定 **2 小时**（`exp - iat = 7200`）。
- 签名算法 HS256（密钥在服务端，客户端不可伪造）。

### 1.5 登录态的本地落盘（Tauri store / KV）

`%APPDATA%\com.orcaterm-desktop.app\data.bin`（JSON 文本，键值对）：

| key | 值 |
| --- | --- |
| `oauth_access_token` | 与 `ot_session` **同值**的 JWT |
| `oauth_expires_at` | 过期时间（毫秒） |
| `auth_identity` | `{"userId","uin","ownerUin","nickName","avatar","userAccountLoginMethod":"oauth","userAccountType":"wechat"}` |
| `auth_identity_updated_at` | 更新时刻（毫秒） |
| `userId` / `userAccountType` / `userAccountLoginMethod` | `<用户 id（数字）>` / `wechat` / `oauth` |

Rust 侧 store 还有 `oauth_refresh_token`（日志可见 `store_get`，样本中未落值）。
读取/写入会打日志：`orcaterm_desktop_lib::util::store: store.rs:37 =>store_get, key: ...`。

同时 `%LOCALAPPDATA%\com.orcaterm-desktop.app\.cookies` 落一份**明文 cookie JSON**，
包含 `ot_session` 全值，以及腾讯云系站点 cookie：

| domain | cookie |
| --- | --- |
| `orcaterm.com`（host-only） | `ot_session` |
| `dnspod.cloud.tencent.com` | `sid`、`language` |
| `cloud.tencent.com` | `language`、`intl_language` |
| `lightai.cloud.tencent.com` | `sid` |

### 1.6 登录状态机

日志（`logs\orcaterm.log`）里可见 Rust 侧的状态机：

- `[AuthStore] bootSync: no token, → UNAUTHED` / `→ AUTHED`
- `[AuthStore] reconcile(boot|manual)` 协调登录态
- `[handleLoginInvalid] ... (source: orcaApiRequest)` —— **任一 API 请求返回未授权即在
  Rust 侧触发重新登录流程**，前端不必各自处理

---

## 2. 自有 API（CAPI 框架）

OrcaTerm 自有接口走一套「CAPI」框架，前缀 `/cgi/`：

```
https://orcaterm.com/cgi/api?action=<Action>&<参数>
```

- 更新检查（tauri.conf 里的 updater endpoint，实测）：
  `https://orcaterm.com/cgi/api?action=CheckDesktopUpdateManifest&target={{target}}&arch={{arch}}&current_version=...`
- v2 路径（Code Cache 提取）：`/cgi/v2/getRegion`、`/cgi/v2/buy/index`、`/cgi/v2/user/getInfo`
- 客户端内部符号：`cgiName`、`CAPI Call: `、`withClientIP`（说明请求会带客户端 IP）

自有站点：`https://orcaterm.com`、`https://orcaterm.ai`、
`https://api.orcaterm.cloud.tencent.com`、`https://api.orcaterm.ai`。

### 2.1 鉴权形态（实测）

| 面 | 鉴权 | 说明 |
| --- | --- | --- |
| `orcaterm.com/cgi/api`（`action` 走 POST body） | **`Cookie: ot_session=<token>`** | 唯一可用的形态；`Authorization: Bearer` / `token:` / `AccessToken:` 头一律 `VERIFY_USER_FAILED: NEED_UIN_AND_SKEY` |
| `api.orcaterm.cloud.tencent.com`、`api.orcaterm.ai` | 同上（CAPI 包层一致） | 但**按路径路由**（body 里的 `action` 无效，回 `api-action-not-found`） |
| `lightai.cloud.tencent.com` | 需 **uin + skey**（腾讯云凭据对） | 用 oauth token / 桌面端 `sid` 均不通，未取得 |

鉴权确认样本：`POST https://orcaterm.com/cgi/api` + `Cookie: ot_session=<token>`，
body `{"action":"GetUserInfo"}` → 返回 `{nickName, username, userId, userAccountType, uin}`。

### 2.2 已确认存在的 CAPI 动作

| action | 用途 | 备注 |
| --- | --- | --- |
| `CheckDesktopUpdateManifest` | 桌面端更新检查 | 无需登录 |
| `GetUserInfo` | 当前账号信息 | 需 `ot_session` |
| `OAuthExchangeToken` | **`sessionId` → token** | 见 §1.3；`data.sessionId`（camelCase） |

> 探测技巧：动作名猜错回 `ACTION_INVALID "<name> not match"`，猜对则进入业务校验 ——
> **错误码变化即"该动作存在"的信号**，无需任何文档。

---

## 3. 对话 / 模型请求

### 3.1 Agent 对话路径（实测提取）

前端 bundle（`packages/orcaterm/features/ai_chat/...`）中提取到的对话相关路径：

| 路径 | 含义（推断） |
| --- | --- |
| `/messages` | 会话消息拉取/提交（主对话通道） |
| `/messages/single-turn` | 单轮对话 |
| `/message/add-symbol` | 消息附加符号（"@" 引用上下文） |

- **流式**：走 SSE，出现 `Accept: text/event-stream`、`event-stream` 字样（`sse` 相关
  字面量 287 处）。
- 前端状态键：`conversationId` / `currentConversationRawId` / `assistant_conversation` /
  `orcaterm-agent-conversation-targets:v1:<userId>` 等，说明是「会话（conversation）」模型。

### 3.2 鉴权形态（待运行时确认）

两种可能，静态证据都指向（**需抓包二选一确认**）：

- `Cookie: ot_session=<JWT>`（登录即下发，最简单）
- `Authorization: Bearer <oauth_access_token>`（与第三方供应商统一走 Bearer）

### 3.3 Agent 的第三方「编码套餐」供应商预置

OrcaTerm Agent 可挂多家供应商（用户自填 key）。Code Cache 中提取到的预置清单
（均带 `.../anthropic` 或 OpenAI 兼容基址）：

| 供应商基址 | 说明 |
| --- | --- |
| `https://open.bigmodel.cn/api/anthropic` | 智谱 GLM（GLM-5.1 / GLM-5-Turbo，界面默认 GLM-5.3） |
| `https://qianfan.baidubce.com/anthropic/coding` | 百度千帆（DeepSeek-V3.2） |
| `https://token-plan-cn.xiaomimimo.com/anthropic` | 小米 MiMo（MiMo-V2-Pro） |
| `https://api.deepseek.com` | DeepSeek |
| `https://api.hunyuan.cloud.tencent.com/v1` | 腾讯混元 |
| `https://api.lkeap.cloud.tencent.com/coding/v3`、`/plan/v3` | 腾讯云 LKEAP |
| `https://api.moonshot.cn/v1` / `https://api.kimi.com/coding/v1` | 月之暗面 / Kimi |
| `https://api.minimaxi.com/v1` | MiniMax |
| `https://ark.cn-beijing.volces.com/api/v3`（及 `/api/coding/v3`） | 火山方舟 |
| `https://coding.dashscope.aliyuncs.com/v1` | 阿里云百炼（通义） |

模型 id 样本：`deepseek-v3` / `deepseek-reasoner` / `deepseek-chat`、`kimi-k2.5`、
`qwen3-max`、`minimax-m2.5`、`moonshot-v1-128k`、`glm-4.7`、`hunyuan-*` 等。
第三方请求头为 `Authorization: Bearer <用户自填 key>`。

> 这条与「网关把上游翻译成 OpenAI 兼容」的既有渠道一致：若做 orcaterm 渠道，
> **真正要对接的是自有 Agent 通道（`/messages*`）**，第三方预置只是 Agent 的可选项。

### 3.4 对话端点与鉴权（真机实测）

对话端点由 App 自身报错泄露（发消息失败时弹的提示）：

```
POST https://lightai.cloud.tencent.com/assistant/chat?name=orcaterm&mode=0&csrfCode=&sseresume=true
```

- **鉴权是 cookie `uin` + `skey`**（不是 `ot_session`）：只给 `skey` 报
  `NEED_UIN_AND_SKEY`；两个都给但 uin 不对报 `VERIFY_SKEY_UIN_FAILED`。
- `uin` 形如 **`o<数字>`**（实测 `o100043052332`，带 `o` 前缀；少了前缀即校验失败）。
- 该请求由 **Rust 侧（reqwest）** 发出：用 mitmproxy 抓包时它拒绝中间人证书
  （自带根证书库、不读 Windows 受信任根），故**报文未取到**。
- 界面当前模型：`Kimi-K3`（模型由 App 侧选择，属用户配置的供应商）。

**唯一未拿到的是 `skey` 的值**。已排除的出处：`data.bin`、
WebView2 的 cookies（仅 1 条）与 Local Storage（只有 cookie 镜像，含 `uin`）、
App 日志。系统浏览器(Chrome)里确实有 `.dnspod.cn` 的 `skey`/`uin`，
但 Chrome 已是 **v20 应用绑定加密**（密文前缀 `v20`），DPAPI 解不开。

> 结论：**OrcaTerm 渠道可完成登录，但无法自行发起模型请求** —— 缺 `skey`
> 这一腾讯云会话凭据，它由 App 在云登录环节持有、不落在可读位置。


---

## 4. 证据等级

| 标记 | 含义 |
| --- | --- |
| **A 实测** | 直接从本机落盘文件/日志读到（cookie 值、JWT 解码、日志行） |
| **B 静态提取** | 从 WebView2 缓存（Code Cache / HTTP Cache）里的字符串字面量提取 |
| **C 推断** | 由 A/B 推论，尚未直接验证（如请求体形状、"含义"列） |

本文中：1.2–1.6、`.cookies` 内容为 **A**；URL 清单、`/cgi/*` 路径、供应商预置、
对话路径 `/messages*` 为 **B**；3.1 的「含义」列与 3.2、3.4 的缺口为 **C**。
