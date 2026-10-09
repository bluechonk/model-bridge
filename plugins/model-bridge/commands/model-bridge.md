---
description: 模型池网关总览：渠道与模型、启停、排障入口
skills: model-bridge-gateway
---

先跑这两条只读命令了解现状：`model-bridge model list`（池视图：两个模型分别会落到谁）、`model-bridge status --json`（网关健康 + 逐渠道登录）。

对外模型 id **只有两个**（不带渠道前缀）：`deepseek-v4.1-flash`、
`glm-5.3-flash`。客户端只写模型名，落到哪家渠道由网关按账单已用量自己决定。
旧的 `<cid>/<模型>` 形态已移除。

让 ZCode 用上它**必须由用户**在设置里加 provider（插件注册不了 provider）：类型 `openai-chat-completions`、
baseUrl `http://127.0.0.1:8787/v1`、API key 任意非空、模型名填上面那两个。

其余命令：`model list` / `model usage` / `model show <cid>` / `channels` / `status` / `start` / `stop` /
`restart` / `models` / `login` / `logs` / `credits` / `paths`。

**每个渠道都有各自的速查命令**：`/model-bridge-<cid>`（如 `/model-bridge-qoder`、
`/model-bridge-codearts`）—— 里面是该渠道的登录方式、模型映射、特有约束与排障提示。
渠道清单：`catpaw` `cline` `codearts` `lobsterai` `loomy` `qoder` `qodercn` `raccoon` `trae`
`workbuddy` `workbuddyai`。
