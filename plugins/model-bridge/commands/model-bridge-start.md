---
description: 启动模型池网关（守护式，幂等）
skills: model-bridge-gateway
---

跑 `model-bridge start`（幂等：已在跑直接返回；失败默认只报告，`--strict` 才非零退出）。
启动后跑 `model-bridge status` 确认；仍失败看 `model-bridge logs`。
