# minimax-bridge

MiniMax Code（MiniMax）的本地 OpenAI Chat Completion 透明代理网关（**TypeScript** 版）。
**纯无窗口（headless）设计**：没有桌面界面，状态与操作全部走 API 和
[ZCode 插件](../../plugins/model-bridge/) 的 hooks + skills + commands（仓库级单插件，管全部渠道）。

将任何兼容 OpenAI Chat Completion API 的客户端请求，透明转发到 MiniMax Code 后端。

## 协议规格

实现依据见 [`docs/protocols/minimax/PROTOCOL.md`](../protocols/minimax/PROTOCOL.md) —— 从上游实现提取的完整协议规格，
含端点、认证、请求/响应形状与实测踩坑记录。

## 快速开始

```bash
uv sync
uv run minimax serve --json    # 前台无窗口运行
uv run minimax login --json    # 无窗口登录：输出授权链接
uv tool install .            # 全局安装后用 minimax 直接调用
minimax start                  # 守护式启动（幂等）
minimax status / models / credits / stop
```

## 状态 API 与 ZCode 插件

`serve` 会启动控制台 API（默认 `http://127.0.0.1:8818`，无页面托管）：

| 端点 | 说明 |
| --- | --- |
| `GET /api/state` | 状态快照（`ui_state` / `message` / `auth_url` / `models`） |
| `POST /api/retry-login` | 投递「重试登录」意图 |
| `POST /api/theme` | 空操作（保留端点兼容） |

日常操作不用直接打这些接口 —— 插件 `minimax-bridge` 用命令与技能把能力包好了。

## 让 ZCode 走这个网关

在 ZCode 设置里添加 provider：类型 `openai-chat-completions`、
baseUrl `http://127.0.0.1:8817/v1`、API key 任意非空、模型用 `minimax models` 的输出。
插件注册不了 provider，这一步需手动。

## 许可证

MIT
