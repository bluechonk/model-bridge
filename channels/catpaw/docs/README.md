# @modelmux/catpaw

美团妙手（CatPaw）的本地 OpenAI Chat Completion 兼容网关（**TypeScript** 版）。
**纯无窗口（headless）设计**：没有桌面界面，状态与操作全部走 `mx` CLI（仓库级 modelmux）。

将任何兼容 OpenAI Chat Completion API 的客户端请求，翻译成妙手的 conversation 协议
（round → event → turn 三段式）转发到上游。

> 本仓库原为 Python 实现（uv + aiohttp + cryptography），已重构为 TypeScript
> （Node ≥ 22.6，零第三方运行依赖），并纳入 `modelmux` 工作区的
> `packages/gateway` 共享层。旧实现与逆向研究结论保留在 git 历史与 `docs/` 里。

## 特性

- **OpenAI 兼容**：`/v1/chat/completions` 与 `/v1/models`，流式/非流式
- **零运行依赖**：HTTP 服务用 `node:http`，HTTP 客户端用原生 `fetch`，
  SSE 解析手写 —— 装完即用，不需要额外运行时
- **无窗口运行**：守护式启动（PID 文件 + 健康等待 + 幂等），适合后台常驻与自动化驱动
- **真实 URL 登录**：`catpaw login` 走 login-config → 拼 auth_url → 浏览器点一下
  → poll-token 轮询，全程只有一次人工点击；**不读取任何其它应用的本地文件**
- **思考与工具**：思考内容映射 `reasoning_content`；工具调用经提示词注入模拟
  （上游无原生用户工具通道），`finish_reason=tool_calls`
- **工具规模自适应**：上游对 `systemPromptOverride` 有 65508 字符硬上限，
  超限时明确回 400 `prompt_too_large`（不静默截断）
- **凭据只来自登录**：`~/.modelmux/catpaw/credentials.json`，由 `catpaw login` 落盘；
  不读桌面端密文 / auth.json（遵守「禁止从本地文件获取」规则）

## 快速开始

## 快速开始

```bash
npm install && npm run build              # 工作区根：装依赖 + 编译全部包
mx catpaw login                            # 仓库级 CLI：登录
mx catpaw status / models / billing        # 状态 / 模型 / 账单
node channels/catpaw/dist/cli.js --help    # 单渠道 CLI（调试 / 回归）
```

日常使用走**仓库级网关**：`mx start` 后把任意 OpenAI 客户端指到
`http://127.0.0.1:8787/v1`（唯一端口，全部渠道从它后面供给池内模型）。
单渠道独立运行（`node channels/catpaw/dist/cli.js serve`）仅在调试该渠道时用。

## 状态 API

`serve` 提供本地网关（`/health` `/v1/models` `/v1/chat/completions`）；
客户端把 baseUrl 指到仓库级网关 `http://127.0.0.1:8787/v1` 即可。

## 与共享 gateway 层的关系

本仓库只实现 4 个渠道特有模块，其余一律复用 `@modelmux/gateway`：

| 模块 | 职责 |
|------|------|
| `src/cred.ts` | 真实 URL 登录（login-config → poll-token）+ 凭据落盘 |
| `src/upstream.ts` | conversation 三段式协议翻译 + SSE 累积帧 → OpenAI delta |
| `src/catalog.ts` | 模型目录（池策略：`(deepseek\|glm)` × flash） |
| `src/billing.ts` | 额度（无端点，如实报错） |

渠道差异通过 `src/channel.ts` 的 `setChannel()` 注册到共享层。

## 约束（AGENTS.md）

- 凭据零入库、零回显：token 原文只存在于进程内存，对外只给指纹与脱敏形态
- 登录必须是真实 URL 链路，不得读其它应用的本地文件
- 模型池只放 **deepseek / glm 家族的 flash 模型**（判据在共享层 `isAllowedFamily()`）
- 文档与代码同 commit 更新：改了实现就要同步 `docs/` 与本文档

## 许可证

MIT