---
description: Loomy（讯飞）渠道：登录 / 领取 / 模型 / 额度 / 账号 / 落点
skills: model-bridge-gateway
---

跑 `model-bridge loomy <动词>`。它的 `checkin` 不是每日签到，而是**新手任务一键领取**。

- **登录**：`model-bridge loomy login`，**短信登录走环境变量**（`LOOMY_PHONE` + `LOOMY_SMS_CODE`，
  无窗口无输入框）；另有微信扫码路径。登录后自动触发 `points/first-login`。
- **签到**：没有独立签到状态端点（`status` 回 `claimable: null`）；`checkin` 做 `claimAll()`
  —— 8 个任务纯 API 直领，跳过已完成的。
- **模型**：池内只贡献 `glm-5.3-flash`（上游目录里的 `deepseek-v4-flash-0731` 已随收窄出池）。
  无别名层；倍率写在展示名里（`· x0.8`）。
- **约束**：① HMAC-SHA1 签名是 9 段反斜杠-n 连接、**以两个换行结尾**，空 body 的 Content-MD5
  段为空串，认证头前缀是 `account {ak}:{sig}` 而非 `Bearer`；② **没有 refresh 端点** ——
  session 声明 14 天，`refresh()` 只做有效性探测，**不假装续期**；
  ③ 微信长轮询 `405=已确认`、`404=已扫码待确认`。
- **排障**：签名不匹配多半是 body 被二次序列化或尾随换行丢了。
- 端口：`127.0.0.1:8813`（控制台 8814）。
