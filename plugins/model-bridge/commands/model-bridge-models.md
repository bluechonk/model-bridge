---
description: 模型一览（池视图 / 单渠道贡献；用户没指明渠道时 ask_user_query 让用户选）
skills: model-bridge-gateway
---

# 模型一览（四种视角，按需选）

| 命令 | 看什么 | 需要网关吗 |
| --- | --- | --- |
| `mb model list` | **池视图**：两个对外模型各自会落到哪些渠道（含已用量与冷却）—— 最常用 | 否 |
| `mb channels` | **渠道视角**：每个渠道贡献了池内哪些模型 | 否 |
| `mb model show <cid>` | **单渠道**的模型清单 | 否 |
| `mb models` | 运行中网关的 `/v1/models`（客户端实际看到的） | **是** |

- 对外模型 id **只有两个**（不带渠道前缀）：`deepseek-v4.1-flash` / `glm-5.3-flash`；
  旧的 `<cid>/<模型>` 形态已移除。
- **交互约定**：用户问「某个渠道有哪些模型」而没指明渠道时，先 `mb channels` 拿清单，
  再用 `ask_user_query` 让用户选渠道，然后 `mb model show <cid>`；
  问「现在能用什么」就直接 `mb model list`（不必先问）。
