# workbuddyai-bridge

WorkBuddyAI 的本地 OpenAI Chat Completion 透明代理网关（**TypeScript** 版）。
**纯无窗口（headless）设计**：没有桌面界面，状态与操作全部走 `mb` CLI（仓库级 `model-bridge-cli`）。

将任何兼容 OpenAI Chat Completion API 的客户端请求，透明转发到 WorkBuddyAI 后端。

> **国际版 / 国内版是两条渠道**：本文件是**国际版**（`workbuddy.ai`，cid `workbuddyai`）。
> 国内版（腾讯 CodeBuddy，`codebuddy.ai`）是**独立渠道** `workbuddy`，见
> [`workbuddy.md`](workbuddy.md)。两者共用同一套网关，但账号、
> 凭证落点、模型池各自独立 —— 账号在哪个域就用哪个渠道登录。
> 早期版本用一个 `--realm intl|cn` 参数在两者间切换，现已**移除**：域是渠道身份的一部分。

> 本仓库原为 Python 实现，已重构为 TypeScript（Node ≥ 22.6）。
> 旧实现保留在 git 历史里：`git show <commit>:src/workbuddy_bridge/gateway.py`。

## 特性

- **纯代理**：不修改请求/响应，只添加认证头（唯一例外见「模型短名映射」）
- **OpenAI 兼容**：提供 `/v1/chat/completions` 与 `/v1/models`
- **零运行依赖**：HTTP 服务用 `node:http`，HTTP 客户端用原生 `fetch`，
 SSE 解析手写 —— 装完即用，不需要额外运行时
- **无窗口运行**：不创建任何窗口/托盘，适合后台常驻与自动化驱动
- **无窗口登录**：`login` 子命令走浏览器设备授权（申请链接 → 打开浏览器 → 轮询令牌），
 全程只有「在浏览器点一下授权」需要人工
- **端口自愈**：默认端口被自身残留实例占用时自动接管；第三方进程需确认。
 健康探测**核对服务身份**，端口上跑着别的服务时如实报告而不是误报 OK
- **SSE 事件块转发**：按事件块转发并剥离注释行，思考流不再碎片化

## 快速开始

## 快速开始

```bash
npm install && npm run build              # 工作区根：装依赖 + 编译全部包
mb workbuddyai login                            # 仓库级 CLI：登录
mb workbuddyai status / models / billing        # 状态 / 模型 / 账单
node channels/workbuddyai/dist/cli.js --help    # 单渠道 CLI（调试 / 回归）
```

日常使用走**仓库级网关**：`mb start` 后把任意 OpenAI 兼容客户端指到
`http://127.0.0.1:8787/v1`（唯一端口，全部渠道从它后面供给池内模型）。
单渠道独立运行（`node channels/workbuddyai/dist/cli.js serve`）仅在调试该渠道时用。

## 状态 API

`serve` 会启动控制台 API（默认 `http://127.0.0.1:8788`，无页面托管）：

| 端点 | 说明 |
| --- | --- |
| `GET /api/state` | 状态快照：`ui_state`（probing/login/error/running）、`message`、`auth_url`、`models`、`gateway_error` |
| `POST /api/retry-login` | 投递「重试登录」意图 |
| `POST /api/theme` | 空操作（保留端点兼容） |

日常操作走 `mb` 命令（`mb status` / `mb start|stop|restart` / `mb login -c workbuddyai` /
`mb model list` / `mb workbuddyai billing`），控制台 API 只是给程序化调用留的口子：

| 端点 | 说明 |
| --- | --- |
| `GET /api/state` | 状态快照：`ui_state`、`message`、`auth_url`、`models`、`gateway_error` |
| `POST /api/retry-login` | 投递「重试登录」意图 |

**接入**：任意 OpenAI 兼容客户端，类型 `openai-chat-completions`、
baseUrl `http://127.0.0.1:8787/v1`、API key 任意非空、模型 `deepseek-v4.1-flash` /
`glm-5.3-flash`（不带渠道前缀）。

## 源码结构

```
src/
 cli.ts           命令行入口（node:util parseArgs，零依赖）
 cli-consts.ts    默认地址与版本（单独一个模块，避免 cli ↔ daemon 循环导入）
 headless.ts      serve / login 的无窗口实现
 gateway.ts       HTTP 网关（node:http）+ 上游约束与指纹改写
 sse-stream.ts    SSE 规范化转发与聚合
 daemon.ts        守护进程管理（start/stop/restart/status/models/credits/logs）
 console.ts       控制台 API
 auth-flow.ts     登录编排（与界面解耦，只经 LoginUi 接口交互）
 cred.ts          凭据：设备码登录、刷新、落盘
 upstream.ts      上游端点、配置、鉴权头
 catalog.ts       模型短名 ↔ 上游 slug
 billing.ts       额度查询
 portfree.ts      端口自愈与服务身份
tests/
 selftest.test.ts node:test 自检（离线，不出网）
```

构建产物 `dist/` 与依赖 `node_modules/` 已在 `.gitignore` 中。

## 存储与配置

全部落点在统一存储根 `~/.model-bridge/` 下按渠道分层：凭证在
`~/.model-bridge/workbuddyai/credentials.json`（权限 0600），不要提交到 git。
历史顶层目录（`~/.workbuddyai2api/`、`~/.workbuddyai-gateway/` 等）首次访问时自动收拢进该层，
无需重新登录。`MODEL_BRIDGE_HOME` 可把整个存储根指到别处（旧的 `ZCB_HOME` / `WBAI2API_HOME`
仍被识别但已弃用），便携/测试用。
`mb paths --all` 可只读列出全部落点。

拆分成两条渠道后，**裸 `workbuddy` 名字**（`~/.workbuddy-bridge/`、`WORKBUDDY_HOME`、
`WORKBUDDY_DEBUG_DUMP`）**两条渠道都不再认领**：那个目录里是国际版旧凭证，而 `workbuddy`
这个 cid 现在属于国内版 —— 认领会把国际数据迁进国内渠道（跨产品串号）。旧数据早已迁入
`~/.model-bridge/workbuddyai/`，无需再迁。

## 模型短名映射

- 网关对外暴露短名：**`deepseek-v4.1-flash`**（`/v1/models`、客户端配置均用短名）
- 内部转发时映射回上游 slug：`deepseek-v4.1-flash → deepseek-v4.1-flash`
- 映射关系由项目根目录 `models.json` 校验（缺失时用内置默认）；未识别的模型名原样透传

## 测试

```bash
npm test          # = node --test tests/selftest.test.ts
```

测试**完全离线**：所有上游调用指向本机假服务，数据目录用 `MODEL_BRIDGE_HOME`
指向临时目录，不需要真实凭据，也不会碰真实账号。

覆盖：路径与目录迁移、模型别名映射、凭据落盘/损坏容忍、上游 URL 与鉴权头、
SSE 规范化与聚合、端到端网关（system 注入 / 强制流式 / 指纹改写 / 非流式聚合 /
错误信封 / 上游错误不回传原文）。

## 上游约束（改代码前必读）

转发层要满足三条上游硬约束，它们都在 `gateway.ts` 里有对应实现与注释：

1. **首条消息必须是 system** —— 否则 400 `first message is not system prompt`
2. **只支持流式** —— 否则 400 `Non-stream chat request is currently not supported`；
  客户端要非流式时也向上游要流式，由本层聚合成普通 JSON
3. **系统提示词指纹拦截** —— 命中时整条会话被 400 `code=11128` 拒绝，
  需把样板文本改写为等价表述（`FINGERPRINT_REWRITES`）

另外两条实测结论：

- **chat 路径不用 `prefixPath`**：模型载荷声明了 `/plugin` 前缀，
 但 `POST /plugin/v2/chat/completions` 返回 404，`/v2/chat/completions` 才是 200
- **SSE 里空的 `tool_calls: []` 必须剔除**：上游每个 delta 都带它，
 而 ZCode 的解析器判定 `tool_calls != null` 就结束思考块 ——
 不剔除会让每个 reasoning token 被切成独立的「思考」块

## 许可证

MIT
