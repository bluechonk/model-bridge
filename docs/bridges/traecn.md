# traecn-bridge

TRAE（字节跳动）的本地 OpenAI Chat Completion 透明代理网关（**TypeScript** 版）。
**纯无窗口（headless）设计**：没有桌面界面，状态与操作全部走 `mb` CLI（仓库级 `model-bridge-cli`）。

将任何兼容 OpenAI Chat Completion API 的客户端请求，透明转发到 TRAE 后端。

## 协议规格

实现依据见 [`docs/protocols/traecn/PROTOCOL.md`](../protocols/trae/PROTOCOL.md) —— 从上游实现提取的完整协议规格，
含端点、认证、请求/响应形状与实测踩坑记录。

## 快速开始

## 快速开始

```bash
npm install && npm run build              # 工作区根：装依赖 + 编译全部包
mb traecn login                            # 仓库级 CLI：登录
mb traecn status / models / billing        # 状态 / 模型 / 账单
node channels/traecn/dist/cli.js --help    # 单渠道 CLI（调试 / 回归）
```

日常使用走**仓库级网关**：`mb start` 后把任意 OpenAI 兼容客户端指到
`http://127.0.0.1:8787/v1`（唯一端口，全部渠道从它后面供给池内模型）。
单渠道独立运行（`node channels/traecn/dist/cli.js serve`）仅在调试该渠道时用。

## 许可证

MIT
