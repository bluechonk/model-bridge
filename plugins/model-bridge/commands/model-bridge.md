---
description: 模型池网关总览：渠道与模型、启停、排障入口
skills: model-bridge-gateway
---

先跑这两条只读命令了解现状：`model-bridge channels`（渠道与各自模型）、`model-bridge status --json`（网关健康 + 逐渠道登录）。

对外模型 id 形如 `<cid>/<模型>`（如 `workbuddy/deepseek-flash`），**恒为小写**。

让 ZCode 用上它**必须由用户**在设置里加 provider（插件注册不了 provider）：类型 `openai-chat-completions`、
baseUrl `http://127.0.0.1:8787/v1`、API key 任意非空、模型取自 `channels --json`。

其余命令：`status` / `start` / `stop` / `restart` / `models` / `channels` / `login` / `logs` / `credits` / `paths`。
