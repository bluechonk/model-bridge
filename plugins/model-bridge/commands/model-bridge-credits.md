---
description: 查额度 / 账单（全渠道；用户没指明渠道时 ask_user_query 让用户选）
skills: model-bridge-gateway
---

# 额度 / 账单

跑 `mb credits` —— 直接查上游 billing，**只读、不经本地网关、不消耗额度**。

- 不带 `--channel` = **全部渠道**逐渠道列出；某渠道没有额度端点或未登录只影响它自己。
- **交互约定**：用户只说「查账单 / 看额度」而没指明渠道时，直接跑 `mb credits`
  （全渠道一览）；只有用户想看单个渠道、或结果太杂需要收敛时，才用 `ask_user_query`
  让用户从 `mb channels` 的清单里选一个，再跑 `mb credits --channel <cid>`。
- 单渠道等价写法：`mb <cid> billing`（别名 `credits`）。
- 各渠道单位不同（`credits` / `USD` / `积分`），按输出里的标注向用户解释；
  `mb model list` 里的 `used=` 是**池账本**里的已用量（挑渠道的依据），与这里查的
  剩余额度是两回事。
