---
description: Raccoon（商汤）渠道：登录 / 领取 / 模型 / 额度 / 账号 / 落点
skills: model-bridge-gateway
---

跑 `model-bridge raccoon <动词>`。它的 `checkin` 领的是**一次性**桌面端登录奖励，不是每日签到。

- **登录**：`model-bridge raccoon login`。**微信扫码**：浏览器打开 `xiaohuanxiong.com/login/mp?code=…`
  （`code` 本地随机生成），每 2s 轮询。
- **签到**：上游 `daily_grant` 由服务端**自动**发放；`checkin` 领 `POST …/login/points/grant`
  的一次性奖励，幂等判据是 `granted`。`status` 用 `claimable: null` 表示「不知道」。
- **模型**：`deepseek-v4.1-flash`（id `sn-deepseek-v4-1-flash`）与 `glm-5.3-flash`
  （id `sn-glm-5-3-flash`）—— **id 带渠道前缀 `sn-`**；同系非 flash（`sn-glm-5-3`）被挡。
- **约束**：① 短信里的手机号必须 **AES-128-CFB** 加密（密钥 `senseraccoon2023`，
  输出 `base64(iv + ciphertext)`），否则 `100003`；② `X-Client-Platform: desktop-windows`
  猜错会被拒；③ uid 优先取 JWT `sub`，其次 `phone`；④ `tags` 不是图片能力契约。
- **排障**：① 凭据悄悄过期 → `expires_at` 缺失时回退 JWT `exp`；
  ② HTTP 401 **或** `code===200003` 才算终态。
- 端口：`127.0.0.1:8815`（控制台 8816）。
