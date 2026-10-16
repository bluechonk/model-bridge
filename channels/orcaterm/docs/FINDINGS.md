# OrcaTerm 逆向结论（含方法论与证据）

本文记录**怎么查的、查到什么、还差什么**。协议事实以 [PROTOCOL.md](./PROTOCOL.md) 为准，
这里补方法论与过程证据。

## 1. 分析方法（可复现）

目标程序是一个 Tauri v2 单文件 exe，前端内嵌且压缩，**明文里搜不到前端 JS**。
因此走「定位数据目录 → 挖落盘证据 → 挖 WebView2 缓存字符串」三步，
再用一个脚本把证据一次性提取出来（`../research/extract-evidence.mjs`）。

| 步骤 | 命令要点 | 拿到什么 |
| --- | --- | --- |
| 解析快捷方式 | `WScript.Shell` COM 读 `.lnk` | `TargetPath` = `...\OrcaTerm\OrcaTerm.exe`，`WorkingDirectory` 同目录 |
| 判运行时 | exe 内 `strings` 数 `tauri`/`Tauri`/`WebView2`/`wry` | Tauri v2 + WebView2；前端 bundle 在 exe 内压缩 |
| 找数据目录 | `find %APPDATA% %LOCALAPPDATA% -iname '*orca*'` | `com.orcaterm-desktop.app`（Bundle ID 命名的两处目录） |
| 登录态 | 读 `.cookies` + `data.bin`（JSON）+ `logs/` | `ot_session` JWT、`oauth_access_token`、`auth_identity`、AuthStore 状态机 |
| 端点 | 扫 `EBWebView\Default\Code Cache` 的字符串字面量 | `/cgi/*`、`/messages*`、供应商预置、OAuth URL |
| 登录页 | 解 `Cache\Cache_Data\f_*`（gzip） | 微信扫码页 HTML（含 `redirect_uri` 与 `state`） |

关键认识：**WebView2 的 Code Cache 保存 V8 字节码，字符串字面量仍可读** ——
前端虽压缩内嵌，但它跑过一次后，端点/常量就留在这份缓存里，成为最省力的情报源。

两条登录路径的可运行复现见 `../research/login-flows.mjs`
（`wechat` 自建二维码、`txcloud` 拼登录链接），它把下面的结论从「读到」变成「跑得通」。

## 2. 逐条结论与证据等级

等级：**A 实测** / **B 静态提取** / **C 推断**。

| # | 结论 | 等级 | 证据 |
| --- | --- | --- | --- |
| 1 | 安装于 `%LOCALAPPDATA%\OrcaTerm\OrcaTerm.exe`（58 MB 单文件） | A | 解析 lnk + `ls` |
| 2 | Tauri v2 + WebView2；crate `orcaterm_desktop_lib` | A | exe `strings`（125×`tauri`）+ 日志模块名 |
| 3 | 数据落点 `%APPDATA%\|%LOCALAPPDATA%\com.orcaterm-desktop.app\` | A | `find` + 目录内容 |
| 4 | 登录 provider：`wechat` / `txcloud` / `github`；统一入口 `https://orcaterm.com/oauth/authorize?provider=…&source=desktop`（缺 `session_id` 报 400） | B | Code Cache + curl 实测 400 |
| 5 | 微信回调 `https://orcaterm.com/oauth/wechat/bridge?code=…&state=…` | A | WebView2 `History` 实测条目 |
| 6 | 微信扫码页走 `long.open.weixin.qq.com/connect/l/qrconnect`，405 后跳回调 | B | 缓存登录页 HTML |
| 7 | 微信分支**可自建**：`/oauth/wechat/config` 每次返回新的 `appid`/`redirect_uri`/`scope`/`state` | A | curl 实测（HTTP 200 JSON） |
| 8 | 腾讯云分支入口**可自建**：`/oauth/authorize?provider=txcloud&session_id=<任意>` → 302 到 `cloud.tencent.com/open/authorize`（`app_id=100045893348`），`state` 由服务端生成 | A | curl 实测 302 |
| 9 | token 用 **`sessionId` 换取**：`POST /cgi/api {"action":"OAuthExchangeToken","data":{"sessionId":"<CLI 自己生成的那个>"}}` → `AccessToken`（HS256 JWT，2h） | A | `mx login orcaterm` 实测登录成功 |
| 9b | 三条早期假设被证伪：回调不写 cookie；`return_url=http://127.0.0.1` 登录后不跳转；回调 URL 回放报 `STATE_EXPIRED`（一次性） | A | Chrome 历史 + curl 实测 |
| 10 | 桌面 App 侧用深链 `orcaterm://oauth_callback?sessionId=…` 拿到 `sessionId` 再换取；**CLI 本就持有 sessionId，故无需深链** | A | App 日志 `[login-handleUrl]` + `[TokenManager]` |
| 11 | 登录态 = `ot_session` cookie（HS256 JWT，2 小时有效） | A | `.cookies` + JWT 解码 |
| 12 | KV 落 `oauth_access_token` / `oauth_expires_at` / `auth_identity`(+`_updated_at`)；Rust 另有 `oauth_refresh_token` | A | `data.bin` + 日志 `store_get` |
| 13 | API 未授权时 Rust 侧 `[handleLoginInvalid]` 统一触发重登 | A | `logs/orcaterm.log` |
| 14 | 自有 API 走 CAPI：`/cgi/api?action=`、`/cgi/v2/{getRegion,buy/index,user/getInfo}` | B | Code Cache |
| 15 | 更新检查 `orcaterm.com/cgi/api?action=CheckDesktopUpdateManifest&…` | A | exe 内 tauri.conf updater 串 |
| 16 | Agent 对话路径 `/messages`、`/messages/single-turn`、`/message/add-symbol` | B | Code Cache |
| 17 | 对话流式走 SSE（`text/event-stream`） | B | Code Cache |
| 18 | Agent 支持多家「编码套餐」供应商（Anthropic/OpenAI 兼容基址，Bearer key） | B | Code Cache URL 清单 |
| 19 | 对话后端候选含 `lightai.cloud.tencent.com`、`api.orcaterm.cloud.tencent.com`、`api.orcaterm.ai` | B/C | HTTP/2 server 记录 + CSP |
| 20 | 自有对话的准确 host + 请求体、鉴权是 Cookie 还是 Bearer | **未确认** | 见下节 |

## 3. 还差什么 / 怎么补

前端 bundle 压缩内嵌，静态只能拿到路径与常量。**自有对话的完整请求需要运行时抓包**：

1. 给 WebView2 挂代理：以环境变量 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--proxy-server=127.0.0.1:<port>"`
   启动 `OrcaTerm.exe`，代理侧（如 mitmproxy / Fiddler）抓 HTTPS。
2. 因 WebView2 校验证书，需让代理根证书进入 Windows 受信任根，或加 `--ignore-certificate-errors`
   （自测环境限定，不要在生产机器上开）。
3. 登录后在 Agent 里发一句话，过滤 `/messages` 观察：
   - 请求方法/路径/完整 URL（host 是 `orcaterm.com` 还是 `api.orcaterm.cloud.tencent.com`）
   - 鉴权头（`Cookie: ot_session=…` 还是 `Authorization: Bearer …`）
   - 请求体（`messages` 结构、模型字段、`stream` 开关）
   - 响应（SSE 分片格式）

补齐后把结果回填到 [PROTOCOL.md](./PROTOCOL.md) §3，并把对应行升级为 A 级。

## 4. 安全提示

本目录的结论来自**本机已安装客户端**的落盘数据与缓存，仅用于协议研究。
`.cookies` / `data.bin` 含**真实登录凭据**，严禁复制进仓库或任何提交
（`.gitignore` 已排除 `research/` 之外的临时产物；抓包日志同样不得入库）。
