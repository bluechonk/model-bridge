---
description: LobsterAI（有道）渠道：登录 / 签到 / 模型 / 额度 / 账号 / 落点
skills: model-bridge-gateway
---

跑 `model-bridge lobsterai <动词>`。**有真实签到端点**（三步签到，`lobsterai checkin` 会真领）。

- **登录**：`model-bridge lobsterai login`。浏览器门户 + **本地回调**（`/auth/callback`，state 严格相等）。
- **签到**：`slot` → `{code}/context` → `POST .../actions/check_in`。幂等是**客户端**保证
  （UUID4 `idempotencyKey` + 预检 `claimedToday`）。
- **模型**：`deepseek-v4-flash`、`glm-5.3-flash` 等（MiniMax/qwen/kimi/doubao 被挡）。无别名层；
  推理档位有 wire 换算（`max → xhigh`）。
- **约束**：① 续期 body 需要登录那一刻的 `firstKeyfrom`/`latestKeyfrom`/`uuid` —— 丢了**只能重新登录**；
  ② 签到 query 里 `platform=win32` 是**伪装客户端形态**，不是运行环境，改了可能拿不到活动；
  ③ 余额取 `profile-summary` 的 `totalCreditsRemaining`，不是 `/api/user/quota`。
- **排障**：信封 `code:0` 但 `data:null` = accessToken 已失效。
- 端口：`127.0.0.1:8809`（控制台 8810）。
