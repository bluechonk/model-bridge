---
description: CodeArts（华为云）渠道：登录 / 签到 / 模型 / 额度 / 账号 / 落点
skills: model-bridge-gateway
---

跑 `model-bridge codearts <动词>`。这个渠道**有真实签到端点**（`codearts checkin` 会真领）。

- **登录**：`model-bridge codearts login`。华为 IAM OAuth，**PKCE + DPoP(ES256) + 本地回调**
  （回调端口须 ≥10000）。
- **签到**：`GET /v1/ops/delivery?channel=IDE` 列活动 → `POST /v1/ops/claim`（必要时 `confirm`）。
  每日活动 `type=USER_LOGIN`；可领积分字段是 `benefitAmount`（不是 `amount`）。
- **模型**：三个公共模型**都贡献**（`deepseek-v4.1-flash` / `deepseek-v4-flash` / `glm-5.3-flash`）。
  上游 id 去末尾 `-NNNN` 后缀归一化；`glm-5.3-flash` 与 `deepseek-v4.1-flash` 属 benefit 集合，
  chat 时必须带 `maas_type: benefit` 且参与签名。
- **约束**：① **不要按 AK 认人** —— 华为每次签发换新 AK，身份取 `refresh_token` JWT 里的
  `user_profile.account_id`；② `refresh_token` 一次性轮换，续期走进程内串行队列；
  ③ `Agent-Type` 头**必须在签名之后追加**，进签名会回 401 `APIG.0301`。
- **排障**：`STS5.1806 the refresh token has been used` = 身份/续期并发；积分查不到 ≠ 0。
- 端口：`127.0.0.1:8807`（控制台 8808）。
