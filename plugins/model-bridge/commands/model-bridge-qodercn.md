---
description: Qoder **国内版**（qoder.com.cn，阿里云账号登录）渠道：登录 / 签到 / 模型 / 额度 / 落点
skills: model-bridge-gateway
---

跑 `model-bridge qodercn <动词>`。⚠ 本渠道**固定绑定国内域 `qoder.com.cn`**；国际版是**另一个渠道**
`qoder`（`qoder.com`，GitHub/Google）—— 账号在哪个域就用哪个渠道登录。`--realm` 被刻意忽略。

- **登录**：`model-bridge qodercn login`。协议与 `qoder` 完全相同（PKCE 设备授权 + `deviceToken/poll`），
  但授权页是 `qoder.com.cn/device/selectAccounts`、用**阿里云账号**、`redirect_uri=qoder-work-cn://`、
  UA `QoderWork/1.1.64`。同样是浏览器授权，404 轮询中间态照旧。
- **签到 · 模型**：与 `qoder` **逐字节相同** —— campaign 领取（10:00 UTC+8 刷新）、
  `dfmodel → deepseek-v4-flash`、`gfmodel → glm-5.3-flash`。
- **约束**：① 与 `qoder` 同一套签名与头（`Cosy-ClientType 10 vs 5` 不可混用、机器头成对）；
  ② 续期响应不含 `machine_id`，丢了会破坏设备绑定。
- **排障**：① 登录串区 → 确认用的是**国内域**授权页（`.cn`）；② 本渠道**刻意不声明** `legacyDirs`
  —— 历史目录里的凭据血统不明（可能属国际版），不会被迁进来。
- 端口：`127.0.0.1:8817`（控制台 8818）。
