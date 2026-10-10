# loomy-bridge

Loomy（讯飞）的本地 OpenAI Chat Completion 透明代理网关（**TypeScript** 版）。
**纯无窗口（headless）设计**：没有桌面界面，状态与操作全部走 API 和
[ZCode 插件](../../plugins/model-bridge/) 的 hooks + skills + commands（仓库级单插件，管全部渠道）。

将任何兼容 OpenAI Chat Completion API 的客户端请求，透明转发到 Loomy 后端。

## 协议规格

实现依据见 [`docs/protocols/loomy/PROTOCOL.md`](../protocols/loomy/PROTOCOL.md) —— 从上游实现提取的完整协议规格，
含端点、认证、请求/响应形状与实测踩坑记录。

## 快速开始

```bash
node channels/loomy/dist/cli.js login   # 交互式登录：菜单选 1) SMS code / 2) WeChat QR code
mb loomy login                          # 仓库级入口等价写法
node channels/loomy/dist/cli.js serve   # 前台无窗口运行（单渠道）
mb start                                # 守护式启动（幂等，仓库级网关）
mb status / model list / loomy credits / loomy checkin
```

> **登录菜单**（交互终端里弹出，英文）：`1) SMS code` 需环境变量 `LOOMY_PHONE` /
> `LOOMY_SMS_CODE`；`2) WeChat QR code` 扫码授权（未绑手机号时绑定环节仍需上述两个环境变量）。
> 非交互场景（脚本 / 网关「重试登录」）不弹菜单，按环境变量自动选：两个都设了走短信，
> 否则走扫码；`mb loomy login --wechat` 也可直接指定扫码。

## 状态 API 与 ZCode 插件

`serve` 会启动控制台 API（默认 `http://127.0.0.1:8814`，无页面托管）：

| 端点 | 说明 |
| --- | --- |
| `GET /api/state` | 状态快照（`ui_state` / `message` / `auth_url` / `models`） |
| `POST /api/retry-login` | 投递「重试登录」意图 |
| `POST /api/theme` | 空操作（保留端点兼容） |

日常操作不用直接打这些接口 —— 插件 `loomy-bridge` 用命令与技能把能力包好了。

## 让 ZCode 走这个网关

在 ZCode 设置里添加 provider：类型 `openai-chat-completions`、
baseUrl `http://127.0.0.1:8813/v1`、API key 任意非空、模型用 `loomy models` 的输出。
插件注册不了 provider，这一步需手动。

## 许可证

MIT
