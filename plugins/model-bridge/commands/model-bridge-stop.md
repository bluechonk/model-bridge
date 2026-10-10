---
description: 停止模型池网关（只停守护实例）
skills: model-bridge-gateway
---

先 `mb status` 确认是自己起的网关，再 `mb stop`。
它只停有 PID 文件的守护实例，**不碰第三方进程**；端口被别的程序占用时如实报告，让用户自行处理。
成功停止后会往网关日志追加一行 `{"event":"stop","pid":…}`，时间线上留下“下线”痕迹
（`logs -f` 可实时看到；手动停与崩溃由此可区分）。
