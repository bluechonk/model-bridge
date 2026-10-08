---
name: model-bridge-gateway
description: Manage and troubleshoot the local multi-channel model-pool gateway with the model-bridge CLI (channels, status, start, stop, login, models, credits, paths).
---

# 模型池网关管理

当用户想启动/登录/检查/排障本地模型池网关，或问"模型走的是哪个后端""凭证放哪了""池子里有哪些模型"时
使用本技能。所有操作通过 `model-bridge` 命令行完成（会话启动时插件 hook 通常已自动挂载网关）。

## 背景事实

- **一个网关 + N 个池子**：本仓库注册 11 个渠道（`catpaw` `cline` `codearts` `gemini` `lobsterai`
  `loomy` `minimax` `qoder` `raccoon` `trae` `workbuddyai`）。每个渠道是一个**模型池**：
  自己的一套模型目录 + 凭证 + 上游协议。
- **对外模型 id**：`<cid>/<模型>`，**恒为小写**（`workbuddyai/deepseek-v4.1-flash`、`trae/deepseek-v4-flash`）。
  解析大小写不敏感；上游 slug 仍用目录里的原始写法。
- **只放行 flash 家族**（网关级白名单）。某渠道池子为空通常是未登录或上游目录拉取失败，不是插件坏了。
- **不只服务 ZCode**：网关是普通 HTTP 端点，其它客户端（Hermes、任意 OpenAI 客户端）直接把 base url
  指到 `http://127.0.0.1:8787/v1` 即可 —— **不需要**各自的插件层，凭据与账号池由网关统一管理。
- **网关默认地址** `http://127.0.0.1:8787`（`/v1/chat/completions`、`/v1/models`、`/health`）。
  仓库级网关注册全部渠道；单渠道 CLI 仍暴露裸短名（如 `deepseek-flash`）。
- **存储落点**：统一根 `~/.model-bridge/`，按 cid 分层 `~/.model-bridge/<cid>/`（`credentials.json`
  `upstream.json` `prefs.json` `gateway.pid` `gateway.log`）。仓库级网关的 PID/日志在**根**上。
- **登录是唯一需要用户动手的步骤**（浏览器授权，工具无法代办）。
- **账号池**（一个渠道下多个账号）：保存在 `~/.model-bridge/<cid>/` ——
  `credentials.json`（当前生效账号的副本）、`accounts.json`（索引：列表 + 当前选中 + 元信息）、
  `accounts/<key>.json`（单账号凭证）。`key = sha256(domain+uid)[:16]`，重登不变。
  **登录即入池**；切换账号 = `accounts use <key>`（换 `credentials.json`，不用再授权）。
  **同一时间只用一个账号**（轮询/失败转移属后续策略层）。删生效账号 = 同时登出。
- 让 ZCode 用上这个网关需要**用户**在设置里加 provider（插件注册不了 provider）：类型
  `openai-chat-completions`、baseUrl `http://127.0.0.1:8787/v1`、API key 任意非空、模型取自
  `model-bridge channels --json`。不要替用户改 `~/.zcode/v2/provider_config.json`。

## 命令速查

| 命令 | 作用 |
| --- | --- |
| `model-bridge channels` | **渠道（池子）与各自模型** —— 配 provider 时的模型清单 |
| `model-bridge status`（`--json`） | 网关健康、逐渠道登录状态、守护 PID、凭证、auto_start |
| `model-bridge start` | 守护式启动（幂等；失败默认只报告，`--strict` 才非零退出） |
| `model-bridge stop` / `restart` | 停 / 重启守护实例（不碰第三方进程） |
| `model-bridge models` | 查**运行中的网关**暴露的模型 id（网关没起会失败） |
| `model-bridge login --channel <cid>` | 无窗口登录：stdout 给出授权链接，用户浏览器授权后自动保存 |
| `model-bridge logs`（`--lines N`） | 网关日志尾部（排障第一步） |
| `model-bridge credits` | 账号剩余额度（只读，不经网关，不消耗额度） |
| `model-bridge paths`（`--all`） | 存储落点与文件（只读） |
| `model-bridge accounts`（`--channel`） | **账号池**：列出账号 / `use <key>` / `add` / `remove <key>` |

几乎所有子命令都支持 `--channel <cid>`（只操作某个渠道）与 `--json`。

## 标准流程

1. 先 `model-bridge status --json` 判断现状。
2. 网关不可达：`model-bridge start` → 再 `status`；仍失败看 `model-bridge logs`。
3. 某渠道未登录：`model-bridge login --channel <cid>`，把授权链接原样展示给用户并请其授权；
   不要并发重复跑。workbuddyai 注意域：`--realm intl|cn`。
4. 「有哪些模型可用」→ `model-bridge channels`（不需要网关）。
5. 「凭证/配置放哪」→ `model-bridge paths --all`；「有几个账号 / 换账号」→ `model-bridge accounts`。
6. 用户要求停掉 → `model-bridge stop`；端口被第三方占用时如实报告，让用户自行处理。

## 排障要点

- 启动失败先看日志尾部；常见原因是端口被占用（8787 上可能有旧实例或别的程序）。
- 上游 502 / `code=11128`：多为 token 失效 → 重新登录该渠道；提示词指纹由引擎自动改写。
- 池子为空：未登录、或该渠道上游目录拉取失败（以 `status` 的逐渠道提示为准）。
- `400 unknown_channel`：模型 id 的 `<cid>` 前缀没写对（对照 `channels` 输出）；
  `503 not_authenticated`：前缀对了、但该渠道没登录。
- `auto_start` 在 `~/.model-bridge/prefs.json`（仓库级；单渠道在 `~/.model-bridge/<cid>/prefs.json`）。
