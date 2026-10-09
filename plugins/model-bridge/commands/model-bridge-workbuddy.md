---
description: WorkBuddy（国内版 CodeBuddy，codebuddy.ai）渠道：登录 / 模型 / 额度 / 账号 / 落点
skills: model-bridge-gateway
---

跑 `model-bridge workbuddy <动词>`。⚠ 与国际版 `workbuddyai`（`workbuddy.ai`）是**两个独立渠道**：
账号在哪个域就用哪个渠道登录。**没有签到端点**（额度按订阅周期发放）。

- **登录**：`model-bridge workbuddy login`。`/v2/plugin/auth/state?platform=workbuddy` → 浏览器授权
  → `/v2/plugin/auth/token?state=` 每 5s 轮询（≤5 分钟）。
- **模型**：贡献 `deepseek-v4.1-flash`（对外名 = 上游 slug，无短名映射）；历史短名 `deepseek-flash`
  仅输入兼容、不出现在 `/v1/models`。目录来自渠道根 `models.json`。
- **约束**：① **首条消息必须是 system**，否则 400；② **只支持流式**（非流式客户端由网关层聚合）；
  ③ **系统提示词指纹拦截**（400 `code=11128`），需改写样板文本；④ chat 路径**不用** `prefixPath`。
- **排障**：本渠道 `legacyDirs` 全空，**不认领** `~/.workbuddy-bridge/`、`WORKBUDDY_HOME`
  —— 别把国际版凭证迁进来。
- 端口：`127.0.0.1:8803`（控制台 8804）。
