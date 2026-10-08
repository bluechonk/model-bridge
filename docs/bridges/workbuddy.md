# workbuddy-bridge

WorkBuddyAI 的本地 OpenAI Chat Completion 透明代理网关（**TypeScript** 版）。
**纯无窗口（headless）设计**：没有桌面界面，状态与操作全部走 API 和
[ZCode 插件](../../plugins/model-bridge/)（工作区 `plugins/` 下的**仓库级**插件）的
hooks + skills + commands。

将任何兼容 OpenAI Chat Completion API 的客户端请求，透明转发到 WorkBuddyAI 后端。

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

```bash
npm install                # 只装 devDependencies（TypeScript 类型定义 + 编译器）
npm run build              # 编译到 dist/

node dist/cli.js serve --json    # 前台无窗口运行：登录探测 + 网关 + 控制台 API
node dist/cli.js login --json     # 无窗口登录：输出授权链接，浏览器授权后自动保存凭证

npm link                   # 或用 npm i -g . 得到 workbuddy 命令
workbuddy start            # 守护式启动（幂等）：分离后台进程 + PID 文件 + 健康等待
workbuddy status / models / credits / stop
```

`serve` 未登录时默认只报告状态、不弹浏览器（`/api/state` 会给出提示）；
`--ensure-login` / `--force-login` 会打开浏览器走交互授权。

`--json` 让 `login`/`serve` 以 JSON 事件行输出（`event: start/login/ready/done/error/stopped`，
登录事件带 `auth_url`），供插件或脚本解析；解析方应跳过无法解析的行。

可选参数（serve）：`--addr`（监听地址，默认 `127.0.0.1:8787`）、`--ui-port`
（控制台 API 端口，默认 `8788`）、`--verbose`（打印每个请求）、`--no-console`；
`login` 另有 `--force`（忽略已有凭证强制重登）。

`workbuddy credits` 直接请求上游 billing 端点（`/v2/billing/meter/get-user-resource`）查询账号
剩余额度，不经本地网关、只读；`workbuddy status` 聚合网关健康与登录状态。

`workbuddy start` 是守护式入口：幂等（先探测 `/health`）、分离后台进程、写
`~/.model-bridge/workbuddy/gateway.pid`、日志落 `gateway.log`，健康等待后命令退出。
`--auto`（hook 场景）受 prefs 的 `auto_start` 开关约束（默认开）；
`--strict` 时失败以非零码退出。`workbuddy stop` 读 PID 文件杀进程树，不碰第三方进程。

## 状态 API 与 ZCode 插件

`serve` 会启动控制台 API（默认 `http://127.0.0.1:8788`，无页面托管）：

| 端点 | 说明 |
| --- | --- |
| `GET /api/state` | 状态快照：`ui_state`（probing/login/error/running）、`message`、`auth_url`、`models`、`gateway_error` |
| `POST /api/retry-login` | 投递「重试登录」意图 |
| `POST /api/theme` | 空操作（保留端点兼容） |

日常操作不用直接打这些接口 —— ZCode 插件 `workbuddy-bridge`
用命令与技能把这些能力包好了，落到 `workbuddy` CLI 上：

| 插件命令 | 作用 |
| --- | --- |
| `/workbuddyai-status` | 网关/控制台可达性、登录状态、模型、凭证 |
| `/workbuddyai-start` `/workbuddyai-stop` `/workbuddyai-restart` | 守护式启停 |
| `/workbuddyai-login` | 无窗口登录，返回授权链接给用户在浏览器完成授权 |
| `/workbuddyai-models` | 列出模型短名 |
| `/workbuddyai-banner` `/workbuddyai-credits` `/workbuddyai-logs` | 状态一屏 / 剩余额度 / 日志 |

要让 ZCode 真正走这个网关，还需在 ZCode 设置里添加 provider：
类型 `openai-chat-completions`、baseUrl `http://127.0.0.1:8787/v1`、
API key 任意非空、模型 `deepseek-flash`。插件注册不了 provider，这一步需手动。

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
`~/.model-bridge/workbuddy/credentials.json`（权限 0600），不要提交到 git。
历史顶层目录（`~/.workbuddy-bridge/`、`~/.workbuddyai2api/`、`~/.workbuddyai-gateway/` 等）
首次访问时自动收拢进该层，无需重新登录。`MODEL_BRIDGE_HOME` 可把整个存储根指到别处
（旧的 `WORKBUDDY_HOME` / `WBAI2API_HOME` 仍被识别但已弃用），便携/测试用。
`workbuddy paths` 可只读列出全部落点。

## 模型短名映射

- 网关对外暴露短名：**`deepseek-flash`**（`/v1/models`、客户端配置均用短名）
- 内部转发时映射回上游 slug：`deepseek-flash → deepseek-v4.1-flash`
- 映射关系由项目根目录 `models.json` 校验（缺失时用内置默认）；未识别的模型名原样透传

## 测试

```bash
npm test          # = node --test tests/selftest.test.ts
```

测试**完全离线**：所有上游调用指向本机假服务，数据目录用 `WORKBUDDY_HOME`
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
