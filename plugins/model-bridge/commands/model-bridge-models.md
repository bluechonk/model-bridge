---
description: 列出网关当前暴露的模型 id
skills: model-bridge-gateway
---

跑 `model-bridge models`。它查的是**运行中的网关**的 `/v1/models`，网关没起会失败 ——
那种情况用 `model-bridge channels`（直接读本地目录，不需要网关）。
