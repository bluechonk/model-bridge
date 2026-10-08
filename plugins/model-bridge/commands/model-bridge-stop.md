---
description: 停止模型池网关（只停守护实例）
skills: model-bridge-gateway
---

先 `model-bridge status` 确认是自己起的网关，再 `model-bridge stop`。
它只停有 PID 文件的守护实例，**不碰第三方进程**；端口被别的程序占用时如实报告，让用户自行处理。
