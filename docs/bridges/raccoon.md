# raccoon-bridge

Raccoon（商汤）的本地 OpenAI Chat Completion 透明代理网关（**TypeScript** 版）。
**纯无窗口（headless）设计**：没有桌面界面，状态与操作全部走 API 和
[ZCode 插件](../../plugins/model-bridge/) 的 hooks + skills + commands（仓库级单插件，管全部渠道）。

将任何兼容 OpenAI Chat Completion API 的客户端请求，透明转发到 Raccoon 后端。

## 协议规格

实现依据见 [`docs/protocols/raccoon/PROTOCOL.md`](../protocols/raccoon/PROTOCOL.md) —— 从上游实现提取的完整协议规格，
含端点、认证、请求/响应形状与实测踩坑记录。

## 快速开始

```bash
node channels/raccoon/dist/cli.js login    # 无窗口登录：打印授权链接，粘贴回调 URL 完成
mb raccoon login                           # 仓库级入口等价写法
node channels/raccoon/dist/cli.js serve    # 前台无窗口运行（单渠道）
mb start                                   # 守护式启动（幂等，仓库级网关）
mb status / model list / raccoon credits / raccoon checkin
```

> **登录两步**：打开打印出的 `/code/authorize` 授权页用微信/验证码/密码登录 →
> 把浏览器地址栏里的整条 `office-raccoon://auth/callback?…` URL 粘贴回终端。
> 细节见 [PROTOCOL.md §2.4](../protocols/raccoon/PROTOCOL.md)。

## 状态 API 与 ZCode 插件

`serve` 会启动控制台 API（默认 `http://127.0.0.1:8816`，无页面托管）：

| 端点 | 说明 |
| --- | --- |
| `GET /api/state` | 状态快照（`ui_state` / `message` / `auth_url` / `models`） |
| `POST /api/retry-login` | 投递「重试登录」意图 |
| `POST /api/theme` | 空操作（保留端点兼容） |

日常操作不用直接打这些接口 —— 插件 `raccoon-bridge` 用命令与技能把能力包好了。

## 让 ZCode 走这个网关

在 ZCode 设置里添加 provider：类型 `openai-chat-completions`、
baseUrl `http://127.0.0.1:8815/v1`、API key 任意非空、模型用 `raccoon models` 的输出。
插件注册不了 provider，这一步需手动。

## 许可证

MIT
