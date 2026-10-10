---
description: 登录渠道（全渠道；先列未登录渠道 → ask_user_query 让用户选 → 浏览器授权）
skills: model-bridge-gateway
---

# 登录（跨渠道）

`mb login` 作用于**全部渠道**。按下面的顺序做，不要跳步：

1. **只读摸底**：`mb login list` —— 一次列出 11 个渠道与登录状态（已登录/未登录 + uid）；
   需要更多细节（网关健康、凭证落点）再 `mb status --json`。
2. **让用户选**：用 `ask_user_query` 把渠道列给用户勾选（**重点列出未登录的**，已登录的
   标注「已登录」；给一个「全部未登录渠道」选项）。**不要替用户决定**，也不要一次登多个。
3. **执行**：`mb <cid> login`（等价 `mb login --channel <cid>`）。把输出里的授权链接
   （`--json` 时在 `auth_url`）**原样展示给用户**，请其在浏览器里完成授权；命令会阻塞到
   授权完成或超时，**不要并发重复跑**。

## 各渠道登录方式（选渠道时向用户提示）

| 渠道 | 方式 | 交互要点 |
| --- | --- | --- |
| workbuddy | 浏览器授权 + 每 5s 轮询 `/v2/plugin/auth/token` | 国内版（账号在 `codebuddy.ai`） |
| workbuddyai | 同上（**同一套协议**） | 国际版（`workbuddy.ai`）；**两条渠道别选错，选错会一直等授权超时** |
| qoder | OAuth 设备授权（PKCE S256）→ 浏览器 → `deviceToken/poll` | 国际版 `qoder.com`；**轮询期 HTTP 404 是正常中间态**（用户还没点同意） |
| qodercn | 同上 | 国内版 `qoder.com.cn`（阿里云账号）；别与 `qoder` 互换 |
| loomy | 交互菜单：`1) SMS code`（手机号与验证码**当场输入**）/ `2) WeChat QR code` | 终端里会继续提示输入；`--wechat` 可直接指定扫码 |
| raccoon | 浏览器打开官方授权页 → **把回跳的 `office-raccoon://auth/callback?…` 整条 URL 粘贴回终端** | 别用 `/login/mp` 那条（只给官方手机 App 扫码，网页端是死链） |
| catpaw | 浏览器点一下（`login-config` 拼 `auth_url`）→ `poll-token?sid=` 每 1s 轮询（≤10 分钟） | **无本地回调服务器**，也不读桌面端本地文件 |
| cline | WorkOS **设备码**授权 | 浏览器开 `verification_uri_complete` → 轮询 → WorkOS 令牌换 Cline 令牌 |
| codearts | 华为 IAM OAuth（**PKCE + DPoP(ES256)**） | 带本地回调，**回调端口须 ≥10000** |
| lobsterai | 浏览器门户 + 本地回调（`/auth/callback`） | state 严格相等 |
| trae | 浏览器授权页 + 本地回调（端口 **18080**，被占用则回退随机端口） | 回调**直接回传 token**（不是 `?code=`）；仅 CN 域 |

- `--force` 强制重登；`--wechat` 仅 loomy 支持。
- 登录是**唯一需要用户动手**的步骤；登录成功后账号自动入池（`mb accounts` 可见，
  切换账号用 `mb accounts use <key> --channel <cid>`，不需要再授权）。
- 单渠道的存储落点 / 特有约束 / 排障：`docs/bridges/<cid>.md`。
