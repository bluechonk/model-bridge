# @modelmux/loomy

Loomy（讯飞）的本地 OpenAI Chat Completion 透明代理网关（**TypeScript** 版）。
**纯无窗口（headless）设计**：没有桌面界面，状态与操作全部走 `mx` CLI（仓库级 modelmux）。

将任何兼容 OpenAI Chat Completion API 的客户端请求，透明转发到 Loomy 后端。

## 协议规格

实现依据见 [`docs/PROTOCOL.md`](./PROTOCOL.md) —— 从上游实现提取的完整协议规格，
含端点、认证、请求/响应形状与实测踩坑记录。

## 快速开始

```bash
node channels/loomy/dist/cli.js login   # 登录：微信扫码（唯一登录方式）
mx login loomy                          # 仓库级入口等价写法
node channels/loomy/dist/cli.js serve   # 前台无窗口运行（单渠道）
mx start                                # 守护式启动（幂等，仓库级网关）
mx status / mx model list / mx billing loomy
```

> **登录方式**：只有微信扫码一条路；未绑手机号时绑定环节需要 `LOOMY_PHONE` /
> `LOOMY_SMS_CODE`（短信验证码登录作为独立方式**已移除**，见 PROTOCOL.md §2.3 说明）。

## 状态 API

`serve` 会启动控制台 API（默认 `http://127.0.0.1:8814`，无页面托管）：

| 端点 | 说明 |
| --- | --- |
| `GET /api/state` | 状态快照（`ui_state` / `message` / `auth_url` / `models`） |
| `POST /api/retry-login` | 投递「重试登录」意图 |
| `POST /api/theme` | 空操作（保留端点兼容） |

日常操作走 `mx` 命令（`mx status` / `mx model list` / `mx login <cid>` / `mx billing <cid>`）。

## 接入

**接入**：任意 OpenAI 兼容客户端，baseUrl `http://127.0.0.1:8787/v1`（仓库级网关）、
API key 任意非空、模型 `deepseek-v4.1-flash` / `glm-5.3-flash`（不带渠道前缀）。

## 参考实现（reference/）

clone 到 `reference/` 的学习材料（不入库）；结论进 [`PROTOCOL.md`](./PROTOCOL.md)。

| 仓库 | 用途 |
| --- | --- |
| [Patrick130306/loomy2api](https://github.com/Patrick130306/loomy2api) | 主参照（31★）：额度转 OpenAI 兼容 API |
| [xingluoyuankong/loomy2api](https://github.com/xingluoyuankong/loomy2api) | 多账号池 + Web 面板 + 防风控；其 `docs/CLIENT-LOGIN.md`（客户端 asar 实抓 + 对照实验）是本渠道微信扫码登录修复的一手依据 |
| [xxhhlk/loomy2api](https://github.com/xxhhlk/loomy2api) | 接口结构参考：端点、鉴权形状、请求/响应结构 |

## 许可证

MIT
