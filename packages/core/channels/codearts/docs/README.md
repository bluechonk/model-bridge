# @modelmux/codearts

CodeArts（华为云）的本地 OpenAI Chat Completion 透明代理网关（**TypeScript** 版）。
**纯无窗口（headless）设计**：没有桌面界面，状态与操作全部走 `mx` CLI（仓库级 modelmux）。

将任何兼容 OpenAI Chat Completion API 的客户端请求，透明转发到 CodeArts 后端。

## 协议规格

实现依据见 [`docs/PROTOCOL.md`](./PROTOCOL.md) —— 从上游实现提取的完整协议规格，
含端点、认证、请求/响应形状与实测踩坑记录。

## 快速开始

```bash
node packages/cli/dist/cli.js login codearts     # 登录（浏览器授权；--json 拿 auth_url）
node packages/cli/dist/cli.js models codearts    # 池内模型（读本地缓存，--refresh 强制重拉）
node packages/cli/dist/cli.js billing codearts   # 额度 / 活动
node packages/cli/dist/cli.js status codearts    # 网关与登录状态
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
实测证据见 [PROTOCOL.md §2.3.1](./PROTOCOL.md)。

渠道侧的兜底：

- `load()` 会把历史遗留的伪 uid（`uid == sha256(自己的 AK)[:16]`）在内存里纠正为稳定身份；
- `pruneLegacyAccounts()` 在登录后清理池内同一人的历史伪账号（按 JWT 身份分组，
  保留当前生效那份；解不出身份的一律各自独立，绝不误删）。

## 状态 API

`serve` 会启动控制台 API（默认 `http://127.0.0.1:8808`，无页面托管）：

| 端点 | 说明 |
| --- | --- |
| `GET /api/state` | 状态快照（`ui_state` / `message` / `auth_url` / `models`） |
| `POST /api/retry-login` | 投递「重试登录」意图 |
| `POST /api/theme` | 空操作（保留端点兼容） |

日常操作走 `mx` 命令（`mx status` / `mx model list` / `mx login <cid>` / `mx billing <cid>`）。

## 鉴权失效识别（APIG.0602）

CodeArts 的 APIG 网关对**过期 token** 回 `HTTP 400 + {"error_code":"APIG.0602"}`，
不是标准的 401/403。本渠道声明了共享层的 `isAuthFailure` 钩子（复用渠道自己的
`isAuthError` 判定），网关收到这类响应会归一成 401，走既有的「刷新 token →
换池内账号」链路。详见 `docs/POOL-ARCHITECTURE.md` §2.4。

## 接入

**接入**：任意 OpenAI 兼容客户端，baseUrl `http://127.0.0.1:8787/v1`（仓库级网关）、
API key 任意非空、模型 `deepseek-v4.1-flash` / `glm-5.3-flash`（不带渠道前缀）。

## 参考实现（reference/）

clone 到 `reference/` 的学习材料（不入库）；结论进 [`PROTOCOL.md`](./PROTOCOL.md)。

| 仓库 | 用途 |
| --- | --- |
| [HITZY2002/codearts2api](https://github.com/HITZY2002/codearts2api) | 主参照（48★）：多账号轮转 + token 自动续期保活 + 并发控制 |
| [Johnsheng1/codearts2api](https://github.com/Johnsheng1/codearts2api) | 订阅服务转 OpenAI 格式的对照样本 |
| [zhuweiyou/codearts2api](https://github.com/zhuweiyou/codearts2api) | Jet Hub 多渠道账号管理 + 本机 OpenAI 网关的组合形态参照 |

## 许可证

MIT
