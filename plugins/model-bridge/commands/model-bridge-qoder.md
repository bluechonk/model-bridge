---
description: Qoder **国际版**（qoder.com，GitHub/Google 登录）渠道：登录 / 签到 / 模型 / 额度 / 落点
skills: model-bridge-gateway
---

跑 `model-bridge qoder <动词>`。⚠ 本渠道**固定绑定国际版域 `qoder.com`**；国内版是**另一个渠道**
`qodercn`（`qoder.com.cn`，阿里云账号）—— 账号在哪个域就用哪个渠道登录，选错会一直等授权超时。
`--realm` 参数被刻意忽略。

- **登录**：`model-bridge qoder login`。OAuth 设备授权（PKCE S256）→ 浏览器开
  `qoder.com/device/selectAccounts` → 轮询 `deviceToken/poll`。**轮询期 HTTP 404 是正常中间态**
  （用户还没点同意），不是错误。
- **签到**：`qoder checkin` 走 campaign 平台（「每日领取 100 Credits」）。只有
  `actionType=CLAIM_BENEFIT` 且 `claimStatus=CLAIMABLE` 才算可领；活动**每日 10:00（UTC+8）刷新**
  （刷新前看到的 CLAIMED 属昨天）。上游顶层 `claimable` 是权威判据。
- **模型**：池内只贡献 `glm-5.3-flash`（上游 key `gfmodel`）；`dfmodel`（DeepSeek-Flash）已随
  `deepseek-v4-flash` 收窄出池。**池内名 ≠ 上游 key**，三种输入都认（池内名 / key / 展示名）；
  `dmodel`/`gmodel`/`qmodel*` 不进池。
- **约束**：① `/sash/**`（额度、活动）用**桌面身份** `Cosy-ClientType: 10`，推理信封用 **CLI 身份
  `client_type=5`**，两者**不可混用**（用 5 查活动会拿到空列表而不是报错）；② 机器头
  `Cosy-MachineToken` 与 `Cosy-MachineType` **必须成对**；③ 设备指纹按 uid **稳定派生**
  （随机机器码会触发上游风控）；④ 余额 = `userQuota` + `addOnQuota` **合并**。
- **排障**：① 推理 403 → 换推理主机候选（`api1/api2/api3.qoder.sh`，被接受的主机会记进凭据）；
  ② 「今天已领」判错 → 活动日以 10:00 UTC+8 为界。
- 端口：`127.0.0.1:8801`（控制台 8802）。
