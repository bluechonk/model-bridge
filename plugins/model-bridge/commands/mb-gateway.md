---
description: 模型池网关启停（start/stop/restart 三合一；用 ask_user_query 确认动作）
skills: model-bridge-gateway
---

# 网关启停（三合一）

按用户意图选一个动作执行；**用户没说清要哪个动作时，用 `ask_user_query` 让用户选**：

| 动作 | 命令 | 要点 |
| --- | --- | --- |
| 启动 | `mb start` | 幂等（已在跑直接返回）；失败默认只报告，`--strict` 才非零退出；启动后 `mb status` 确认 |
| 停止 | `mb stop` | 只停有 PID 文件的守护实例，**不碰第三方进程**；成功后日志留 `{"event":"stop",…}` |
| 重启 | `mb restart` | = stop + start；短暂中断在途请求，有会话在用时先提醒 |

排障顺序：动作失败 → `mb status` 看健康与逐渠道登录 → `mb logs`（`-f` 跟随）看原因；
`mb status` 报「网关在跑旧代码」时直接 `mb restart`。
