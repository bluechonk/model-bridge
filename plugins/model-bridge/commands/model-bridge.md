---
description: 模型池网关总览：渠道与模型、启停、登录/账单/签到的选渠道约定
skills: model-bridge-gateway
---

先跑这两条只读命令了解现状：`mb model list`（池视图：两个模型分别会落到谁）、`mb status --json`（网关健康 + 逐渠道登录）。

对外模型 id **只有两个**（不带渠道前缀）：`deepseek-v4.1-flash`、
`glm-5.3-flash`。客户端只写模型名，落到哪家渠道由网关按账单已用量自己决定。
旧的 `<cid>/<模型>` 形态已移除。

让 ZCode 用上它**必须由用户**在设置里加 provider（插件注册不了 provider）：类型 `openai-chat-completions`、
baseUrl `http://127.0.0.1:8787/v1`、API key 任意非空、模型名填上面那两个。

命令一览：`model list` / `model usage` / `model show <cid>` / `channels` / `status` / `start` / `stop` /
`restart` / `models` / `login` / `logs` / `credits` / `checkin` / `accounts` / `paths`。

## 选渠道的交互约定（**重要**）

命令都是**跨渠道**的；**没有 per-channel 命令**了。凡是要落到某个渠道的动作
（`login` / `credits` / `checkin` / `model show` / `logs` 的单渠道形态 / `accounts add|use|remove`）：

1. 先跑只读命令拿渠道清单与现状：`mb status --json` / `mb channels` / `mb checkin --status`；
2. 用 `ask_user_query` 让用户选（列出渠道，标注已登录/未登录；给「全部」选项）；
3. **不要替用户决定**；写操作（`checkin`、`accounts remove`）执行前必须确认。

渠道清单（11 个）：`catpaw` `cline` `codearts` `lobsterai` `loomy` `qoder` `qodercn` `raccoon`
`trae` `workbuddy` `workbuddyai`。各渠道的登录方式见 `/model-bridge-login`；
单渠道细节（存储落点、约束、排障）见仓库 `docs/bridges/<cid>.md`。
