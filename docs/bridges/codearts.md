# codearts-bridge

CodeArts（华为云）的本地 OpenAI Chat Completion 透明代理网关（**TypeScript** 版）。
**纯无窗口（headless）设计**：没有桌面界面，状态与操作全部走 API 和
[ZCode 插件](../../plugins/model-bridge/) 的 hooks + skills + commands（仓库级单插件，管全部渠道）。

将任何兼容 OpenAI Chat Completion API 的客户端请求，透明转发到 CodeArts 后端。

## 协议规格

实现依据见 [`docs/protocols/codearts/PROTOCOL.md`](../protocols/codearts/PROTOCOL.md) —— 从上游实现提取的完整协议规格，
含端点、认证、请求/响应形状与实测踩坑记录。

## 快速开始

```bash
node packages/cli/dist/cli.js codearts login     # 登录（浏览器授权；--json 拿 auth_url）
node packages/cli/dist/cli.js codearts models    # 池内模型（读本地缓存，--refresh 强制重拉）
node packages/cli/dist/cli.js codearts billing   # 额度 / 活动
node packages/cli/dist/cli.js codearts status    # 网关与登录状态
node packages/cli/dist/cli.js start              # 起仓库级网关（一个端口服务全部渠道）
```

单渠道独立运行（调试用）：`node channels/codearts/dist/cli.js start|serve`。

## 账号身份（**不要按 AK 认人**）

CodeArts 的 STS 信封**只给 `credentials` + `refresh_token`**，从不给 `user_id`；
而华为每次签发都换一套新 AK。所以「用 AK 派生 uid」会让**同一个人每次登录
都变成池内一个新账号** —— 实测一个用户躺了 3 条，且它们共享同一个 refresh token
家族，一个被消费就全体作废（`STS5.1806`），池子的故障转移反而把一次失败
放大成多次无效重试。

稳定身份在 `refresh_token` 的 JWT 里（`user_profile.account_id`）。取值优先级与
实测证据见 [PROTOCOL.md §2.3.1](../protocols/codearts/PROTOCOL.md)。

渠道侧的兜底：

- `load()` 会把历史遗留的伪 uid（`uid == sha256(自己的 AK)[:16]`）在内存里纠正为稳定身份；
- `pruneLegacyAccounts()` 在登录后清理池内同一人的历史伪账号（按 JWT 身份分组，
  保留当前生效那份；解不出身份的一律各自独立，绝不误删）。

## 状态 API 与 ZCode 插件

`serve` 会启动控制台 API（默认 `http://127.0.0.1:8808`，无页面托管）：

| 端点 | 说明 |
| --- | --- |
| `GET /api/state` | 状态快照（`ui_state` / `message` / `auth_url` / `models`） |
| `POST /api/retry-login` | 投递「重试登录」意图 |
| `POST /api/theme` | 空操作（保留端点兼容） |

日常操作不用直接打这些接口 —— 插件 `codearts-bridge` 用命令与技能把能力包好了。

## 鉴权失效识别（APIG.0602）

CodeArts 的 APIG 网关对**过期 token** 回 `HTTP 400 + {"error_code":"APIG.0602"}`，
不是标准的 401/403。本渠道声明了共享层的 `isAuthFailure` 钩子（复用渠道自己的
`isAuthError` 判定），网关收到这类响应会归一成 401，走既有的「刷新 token →
换池内账号」链路。详见 `docs/POOL-ARCHITECTURE.md` §2.4。

## 让 ZCode 走这个网关

在 ZCode 设置里添加 provider：类型 `openai-chat-completions`、
baseUrl `http://127.0.0.1:8807/v1`、API key 任意非空、模型用 `codearts models` 的输出。
插件注册不了 provider，这一步需手动。

## 许可证

MIT
