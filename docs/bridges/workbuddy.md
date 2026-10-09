# workbuddy-bridge（国内版 CodeBuddy）

WorkBuddy **国内版**（腾讯 CodeBuddy，`codebuddy.ai`）的本地 OpenAI Chat Completion
透明代理网关。**无窗口（headless）**：状态与操作全部走 HTTP API 和仓库级
[ZCode 插件](../../plugins/model-bridge/) 的命令/技能。

> **国际版是另一条渠道**：`workbuddyai`（`workbuddy.ai`），见 [`workbuddyai.md`](workbuddyai.md)。
> 两者的登录协议、上游约束、SSE 处理**完全一致**（代码有意重复，见下），差别只有域名、
> 模型目录与凭证落点。

## 为什么拆成两条渠道

早期只有一个 `workbuddyai` 渠道，用 `--realm intl|cn` 在同一渠道内切换国际/国内域。这带来三个问题：

1. **登录链路随参数漂移**：同一个 cid 下，`login --realm cn` 与 `--realm intl` 写同一份
  `credentials.json`，凭证与域的关系只存在于「用户当时传了什么」里。
2. **模型池混装**：两条产品线的模型目录被并进一个池子，`/v1/models` 里分不清来源。
3. **口径不清**：账单/额度是**按域**查的，池子却只有一个。

现在把**域当作渠道身份**：`workbuddy`（codebuddy.ai）与 `workbuddyai`（workbuddy.ai）
各自独立，`--realm` 参数在两条渠道上都被忽略（保留仅为兼容共享层 CLI 的签名）。

代价是 `cred.ts` / `upstream.ts` / `catalog.ts` / `billing.ts` 与 `workbuddyai` 高度相似。
**这是有意的**：两个产品的端点、模型目录、账单口径都可能各自演进，抽象成共享模块会把
「一个改了两边都变」变成默认行为。

## 快速开始

```bash
npm install && npm run build            # 工作区根
node channels/workbuddy/dist/cli.js status
node channels/workbuddy/dist/cli.js login      # 浏览器授权（输出授权链接）
```

仓库级 CLI（推荐，一次拿到全部渠道）：

```bash
node packages/cli/dist/cli.js model list        # 看池子与模型
node packages/cli/dist/cli.js workbuddy login   # 登录国内版
node packages/cli/dist/cli.js workbuddy billing # 剩余额度 / 账单
node packages/cli/dist/cli.js workbuddy checkin # 签到（本渠道无签到端点，返回说明）
```

`bin` 名是 `workbuddy`（`npm link` 后可直接用）。网关端口默认 `127.0.0.1:8803`，
控制台 API `8804`（工作区内每渠道独占一组端口，互不冲突）。

## 存储

统一存储根 `~/.model-bridge/` 下按 cid 分层，本渠道全部落在 `~/.model-bridge/workbuddy/`：
`credentials.json`（0600）、`upstream.json`、`prefs.json`、`gateway.pid`、`gateway.log`，
外加 `cache/`、`state/`、`debug/`。

本渠道是拆分后**新建**的，**没有历史目录**：`legacyDirs` / `legacyEnvVars` /
`legacyDebugDumpEnv` 全为空。特别地**不认领** `~/.workbuddy-bridge/`、`WORKBUDDY_HOME`、
`WORKBUDDY_DEBUG_DUMP` —— 那些是国际版（`workbuddyai`）的旧名字，认领会把国际凭证
迁进国内渠道。详见 [`workbuddyai.md`](workbuddyai.md) 与
[`../STORAGE-CONVENTION.md`](../STORAGE-CONVENTION.md)。

## 模型 id

对外名 = 上游 slug（如 `deepseek-v4.1-flash`），不做短名映射。多渠道路由下完整 id 是
`workbuddy/<模型>`，**恒为小写**。历史短名 `deepseek-flash` 仍能解析（老配置不断），
但不出现在 `/v1/models` 里。目录来自渠道根 `models.json`（可用 `WB_MODELS_FILE` 覆盖），
缺失时用内置兜底、不阻塞启动。

## 上游约束（改代码前必读）

与国际版同源，三条硬约束都在 `upstream.ts` 的 `buildChatBody()` 里：

1. **首条消息必须是 system** —— 否则 400 `first message is not system prompt`
2. **只支持流式** —— 否则 400 `Non-stream chat request is currently not supported`；
  客户端要非流式时也向上游要流式，由网关层聚合成普通 JSON
3. **系统提示词指纹拦截** —— 命中时整条会话被 400 `code=11128` 拒绝，需改写样板文本

另：chat 路径**不用** `prefixPath`（`/v2/chat/completions` 才是 200）；SSE 里空的
`tool_calls: []` 必须剔除，否则思考块会被逐 token 切碎。

## 测试

```bash
npm test                                  # 本渠道（离线，不出网）
node --test channels/workbuddy/tests/*.test.ts
```

数据目录用 `MODEL_BRIDGE_HOME` 指向临时目录，不碰真实凭据。

## 许可证

MIT
