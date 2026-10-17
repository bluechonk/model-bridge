# @modelmux/lobsterai

LobsterAI（有道）的本地 OpenAI Chat Completion 透明代理网关（**TypeScript** 版）。
**纯无窗口（headless）设计**：没有桌面界面，状态与操作全部走 `mx` CLI（仓库级 `modelmux`）。

将任何兼容 OpenAI Chat Completion API 的客户端请求，透明转发到 LobsterAI 后端。

## 协议规格

实现依据见 [`docs/PROTOCOL.md`](./PROTOCOL.md) —— 从上游实现提取的完整协议规格，
含端点、认证、请求/响应形状与实测踩坑记录。

## 快速开始

## 快速开始

```bash
npm install && npm run build              # 工作区根：装依赖 + 编译全部包
mx login lobsterai                            # 仓库级 CLI：登录
mx status lobsterai（models / billing 同法）        # 状态 / 模型 / 账单
node channels/lobsterai/dist/cli.js --help    # 单渠道 CLI（调试 / 回归）
```

日常使用走**仓库级网关**：`mx start` 后把任意 OpenAI 兼容客户端指到
`http://127.0.0.1:8787/v1`（唯一端口，全部渠道从它后面供给池内模型）。
单渠道独立运行（`node channels/lobsterai/dist/cli.js serve`）仅在调试该渠道时用。

## 参考实现（reference/）

clone 到 `reference/` 的学习材料（不入库）；结论进 [`PROTOCOL.md`](./PROTOCOL.md)。

| 仓库 | 用途 |
| --- | --- |
| [xinxinshuhao-create/lobsterai2api](https://github.com/xinxinshuhao-create/lobsterai2api) | 主参照（86★）：有道 LobsterAI 的 OpenAI 兼容桥接（多账号） |
| [greatleo31/lobsterAi2api](https://github.com/greatleo31/lobsterAi2api) | Go 多账号实现的对照样本 |
| [skyletter/lobsterai2api-docker](https://github.com/skyletter/lobsterai2api-docker) | Docker 化发行形态参照（GHCR 自动构建） |

## 许可证

MIT
