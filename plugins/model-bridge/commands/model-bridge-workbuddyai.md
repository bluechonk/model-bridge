---
description: WorkBuddyAI（国际版，workbuddy.ai）渠道：登录 / 模型 / 额度 / 账号 / 落点
skills: model-bridge-gateway
---

跑 `model-bridge workbuddyai <动词>`。⚠ 与国内版 `workbuddy`（`codebuddy.ai`）是**两个独立渠道**。
**没有签到端点**（额度按订阅周期发放）。

- **登录**：`model-bridge workbuddyai login`。协议与国内版**完全一致**（同一套 `/v2/plugin/auth/*`，
  浏览器 + 每 5s 轮询）；`--realm` 被忽略（保留仅为兼容）。
- **模型**：贡献 `deepseek-v4.1-flash`（无短名映射）；历史短名 `deepseek-flash` 仅输入兼容。
- **约束**：与国内版三条硬约束**完全一致** —— 首条必须 system / 只支持流式 / 指纹拦截 `code=11128`；
  chat 路径不用 `prefixPath`；SSE 里空的 `tool_calls: []` 必须剔除。
- **排障**：① **它的默认端口就是 8787/8788**，与仓库级网关同端口 —— 单渠道独立运行时要留意冲突；
  ② 旧顶层目录首次访问自动收拢进 `~/.model-bridge/workbuddyai/`，无需重登。
- 端口：`127.0.0.1:8787`（控制台 8788），仅单渠道独立运行时生效。
