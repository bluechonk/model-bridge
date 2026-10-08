# Phase 7 · 上游协议（round / event / turn、model-types）

> **实现语言（2026-10-07）**：本阶段现由 Python 实现 —— `src/catpaw_bridge/protocol.py`、
> `sse.py`、`upstream_client.py`、`conversation.py`，命令行入口 `uv run catpaw-list-models`（默认 dry-run）。
> 下文原始输出来自 TS/Node 版脚本（tag `v0.3.0-ts`）；结论与证据等级不变，详见 [../README.md](../PROTOCOL.md)。

> **本阶段已补实测（2026-10-08）**：网关接入 ZCode 后做过真实上游调用，三段式协议
> （round → event → turn）全程跑通，并测出 `systemPromptOverride` 的 65508 字符上限与
> round 的消息序列校验。这些**新实测**见 [API-REFERENCE.md](API-REFERENCE.md) 第 2 节与
> [findings.md](../../../journals/catpaw/findings.md)「上游体积上限与消息序列校验」。下文第 1–12 条结论的
> `[代码]` 等级保持不变（它们仍来自 TS 源码），但"本阶段无出网实测"的说明已过时。

> **凭据声明（本仓库的硬约束）**
>
> 本仓库**不**在文档、代码、示例或提交历史中附带任何**可直接打上游**的凭据。凭据只存在于本机（已 gitignore 的落盘文件 / 环境变量），任何脚本都不携带凭据入库。
>
> `catpaw-list-models` **默认 dry-run**：只报告"将要发生的请求"，不出网；只有显式加上 `--live`（`uv run catpaw-list-models --live`）才会真正带着本机凭据访问 `https://ai.catpaw.meituan.com`。
>
> 出网路径共两条：研究脚本的 `--live`，以及**网关本身**（`catpaw serve` / `start`，按设计访问上游）。
>
> 本文档中的 token 一律为脱敏形态（如 `AgEKJlOd…[152]`），指纹为 sha256 前 16 位十六进制（如 `cd04187a3ce0a820`），二者都不足以还原凭据原文。

## 目标

1. 把妙手上游 agent 协议（对话 turn 的 SSE 流 + 模型目录）从上一代插件的实现里**剥离**出来，固化成不依赖 DSH 的独立模块。
2. 精确记录必需请求头、turn 请求体形状、信封解包规则、SSE 的两条反直觉行为、以及 usage 计数修正。
3. 把必需头、body 形状、解包规则、SSE 行为与 usage 修正逐条写清，避免以后凭记忆重写协议。
4. 本阶段（TS 时代）**未**做真实出网调用（默认 dry-run）；当时的结论可靠性来自「源码 + 上一代插件的真实运行记录」。
   Python 重写后（2026-10-08）已补真实上游实测，见文首说明。

## 方法与命令

| 目的 | 命令 | 入口 |
| --- | --- | --- |
| 拉模型目录（**默认 dry-run**，不出网） | `npm run models` 或 `node scripts/list-models.ts` | `scripts/list-models.ts` |
| 真发上游请求（研究脚本出网路径，需本机已有登录态） | `node scripts/list-models.ts --live` | 同上 |
| 类型检查 | `npm run typecheck` | `tsc --noEmit` |

TS 时代只用了上表第一行的 **dry-run** 形式；`--live` 当时未执行。
（Python 版对位的命令是 `uv run catpaw-list-models` / `--live`。）

## 原始输出（节选）

**诚实说明（TS 时代）**：当时本仓库**没有** Phase 7 的出网实测输出。`.tmp/runlogs/` 下共有 6 份记录（`recon.txt`、`scan-credentials.txt`、`analyze-token-blob.txt`、`locate-crypto.txt`、`derive-key.txt`、`verify-token.txt`），全部属于 Phase 1–6，与 Phase 7 相关的记录为 **0 条**。[实测]（目录现状）

> **补记（2026-10-08）**：真实上游实测已在 Python 版完成 —— 三段式 round/event/turn 全程跑通，
> 边界与序列校验结果记在 [API-REFERENCE.md](API-REFERENCE.md) 第 2 节。下方 dry-run 模板仍然有效，
> 只是"从未真发过请求"不再成立。

因此下面给出的是 `scripts/list-models.ts:18-28` 的**确定性输出模板**（逐字取自源码，**不是**运行记录），用于说明 dry-run 到底会打印什么、不会做什么：

```text
=== Phase 7 · 模型目录 ===
  凭据来源          <catx-credential | auth.json | env | 未获取到>
  凭据              <maskSecret(accessToken)>      # 形如 AgEKJlOd…[152]
  端点              POST https://ai.catpaw.meituan.com/api/agent/maas/model-types
  body              {"tenant":"CatDesk","scene":"CATX_APP","env":"EXTERNAL"}

  [dry-run] 未发请求；加 --live 才会真正访问上游（会用凭据出网）
```

若本机未登录、两条凭据来源都不可用，则打印 `未解析到本机凭据，无法继续（先登录桌面端）` 并把退出码置 1（`scripts/list-models.ts:24-26`）。[代码]

规则一律以源码为准，关键形状如下（`M-TRACEID` 处标占位，真实值由 `crypto.randomUUID()` 现场生成）：

```ts
headers['Cookie'] = `X-Passport-Token=${token}`
headers['M-APPKEY'] = 'fe_com.sankuai.catpaw.external.front'
headers['M-TRACEID'] = <32 位无横线 uuid>
body['mode'] = 'CATX_APP'
body['permissionMode'] = 'unsafeBypassPermissions'
body['toolVersion'] = '2.0.2'
```

[代码]（`constants.ts:31-38`、`client.ts:53-55`、`client.ts:66-105`）

## 结论

1. Base 与端点：`https://ai.catpaw.meituan.com`；对话 turn = `POST /api/agent/conversation/turn`（SSE）；模型目录 = `POST /api/agent/maas/model-types`，body `{"tenant":"CatDesk","scene":"CATX_APP","env":"EXTERNAL"}`。[代码]（`constants.ts:11-17`、`client.ts:252-261`）
   —— **注**：turn 并非入口，现役对话是 round → event → turn 三段式，见下方补测结论第 13 条。
2. 必需头：`M-TRACEID`（32 位无横线 uuid，由 `crypto.randomUUID().replace(/-/gu,'')` 生成）、`M-APPKEY: fe_com.sankuai.catpaw.external.front`、`gray-set: new-agent-sdk`、`X-Agent-Version: 1.0.1`、`Cookie: X-Passport-Token=<token>`；uid 非空时追加 `user-uid`。[代码]（`client.ts:53-55, 108-117`）
3. turn 额外要求：`Accept: text/event-stream`、`Content-Type: application/json`、`enableHeartBeat: true`；模型目录只要求 `Accept: application/json`。[代码]（`client.ts:194-204`、`client.ts:252-261`）
4. turn body：`source=CatX`、`action=turn`、`mode=CATX_APP`、`permissionMode=unsafeBypassPermissions`、`toolVersion=2.0.2`，并携带 `conversationId` 与 `turnRequestId`（各一个 uuid）；一次 turn **只带一条** user 消息（取 messages 里最后一条 user），system 走 `systemPromptContext.systemPromptOverride`。[代码]（`client.ts:66-105`）
5. 工具声明：`toolConfigs[] = {name, description, inputSchema}` 与 `availableTools[] = name` 同源（都来自入参 tools）；`toolChoice='none'` 时清空 `availableTools` 并删除 `toolConfigs`，给具体名字时写 `toolChoice: <name>`。[代码]（`client.ts:87-103`）
6. 信封解包规则：有 `code` 且 ∉ {0, 200} ⇒ 抛 `CatPawProtocolError`（message 依次取 `msg` → `message` → `upstream error code=<code>`，并带 `unifyCode`）；有 `data` 键 ⇒ 取 `data`；否则整个对象即业务负载。[代码]（`envelope.ts:29-45`）
7. SSE 反直觉点 ①：每帧给的是**累积全文** —— 文本、`reasoningContent`、以及同一 `toolCallId` 的 `toolParams` 都是累积串；必须按"当前串是否以已发送串为前缀"做 suffix-diff 转增量，新串不以旧串为前缀（重写/回退）时**整段重发**。[代码]（`sse.ts:82-113`）
8. SSE 反直觉点 ②：**没有结束标志**。`finished` 字段存在但语义不保证，不能当终止信号；turn 以 **TCP 关闭**结束 —— `streamChat` 在读取循环 `done` 后用 `reader.finish()` 处理无换行结尾的残行，随后无条件 `yield { type:'done', finishReason:'stop' }`。[代码]（`sse.ts:1-12`、`client.ts:223-247`）
9. usage 修正：`prompt = max(upstream_prompt, upstream_total − completion)`，`total_tokens` 重算为 `prompt + completion`，`cache_read_tokens` 固定为 0。[代码]（`client.ts:166-178`）
10. 本机凭据解析顺序：Phase 6 解出的 `catx-credential` 密文 → CLI 明文 `auth.json` → 环境变量 `CATPAW_COOKIE` / `CATPAW_USER_UID`；三者都不可用返回 `null`。解出的 credential 对象只在进程内存中传递，不落盘、不进日志。[代码]（`index.ts:21-48`）
11. 错误处理纪律：HTTP 非 2xx 只产出分类化文案 `upstream HTTP <status>` 并附数字 code，**上游原始响应体不再拼进错误消息**；业务错误码在 SSE 里变成 `__error` 帧而非抛出中断。[代码]（`client.ts:210-213`、`sse.ts:62-74`）
12. ~~本阶段无出网实测~~ → **TS 时代**无出网实测：当时未执行 `--live`；`git ls-files` 里没有任何凭据类文件（无 `auth.json` / `.env` / credential 文件，跟踪的 `.json` 只有 `package.json`、`tsconfig.json`、`tsconfig.client.json`），`git grep -E 'AgEK[A-Za-z0-9]{20,}'` 无命中。[实测]（工作区检查 + `.tmp/runlogs/` 无 Phase 7 记录）+ [代码]（`scripts/list-models.ts:15, 27-28` 默认 dry-run）

### 补测结论（2026-10-08，Python 版真实上游调用）

13. **对话是三段式，不是单发 turn**：`POST /api/agent/conversation/round`（提交本轮全部消息含历史）→ `POST /api/agent/conversation/event`（回报 running/completed/failed/canceled）→ `POST /api/agent/conversation/turn`（SSE 直出）。**直接调 turn（不先 round）一律 500 空响应**。[实测]
14. **round 消息形状**：每条必须带 `messageId`（缺了报 JSON 解析错误）、`type` 标角色、最后一条必须是 `user`。[实测]
15. **round 拒收连续 assistant**：`user,assistant,user` 通过；`user,assistant,assistant,user` 回 `success:false`「assistant 消息不带 toolCall，后面必须是 user 消息，实际是: assistant」；而连续 `user` **反而允许**。[实测]
16. **`systemPromptOverride` 上限 65508 字符**，口径是 JSON 转义后长度（等价 JS `JSON.stringify(s).length`）：二分得 65508 通过 / 65509 失败，纯 ASCII、纯中文、含 `\n` 三种填充收敛到同一边界；中文 65508 字符（19.6 万字节）照样通过，故**不是**字节数。[实测]
17. **业务失败藏在 HTTP 200 里**：超限时上游回 `HTTP 200` + `{"unifyCode":1009010003,"code":9999,"msg":"系统内部异常","success":false}`。只看状态码会把失败当成功，继而在 turn 阶段拿到「conversationRound not found」而误判。[实测]
18. **工具名由模型手写、大小写会被改写**：声明 `Bash` 时模型稳定输出 `bash`（上游无原生工具通道，工具经提示词注入模拟）。客户端按精确名匹配会失配。[实测]

## 踩坑与修正

1. **把"累积帧"当增量帧**是最容易踩的坑：直接转发每帧文本会把已发过的内容重复输出 N 遍。正确做法是 suffix-diff，并额外处理"新串不以旧串为前缀"的回退情形（整段重发，而不是发空串）。[代码]（`sse.ts:82-95`）
2. **把 `finished` 当结束信号**：上游会给该字段但语义不保证。旧实现的注释把它直接标成硬约束 —— `// finished flag is informational — do *not* act on it (hard constraint #2)`（`.bak/20261006-103318-dsh-plugin-before-research-refactor/src/catpawClient.ts:383-384`）；本仓库把"以 TCP 关闭结束"写进 `sse.ts` 的模块文档，并落实为 `streamChat` 的收尾逻辑。[代码]（新旧实现交叉印证）
3. **TCP 会把一行 SSE 切成两半，也会在 UTF-8 多字节字符中间切开**：`SseReader` 必须同时做行缓冲（`tail` + 按 `\n` 切分）与流式解码（`TextDecoder('utf-8', { fatal:false })` + `{ stream: true }`），并在流末尾用 `finish()` 处理没有换行结尾的残行。[代码]（`sse.ts:20-46`）
4. **信封不是所有端点都包**：`model-types` 可能裸返回数组，turn 的帧是 `{ response_message: … }`，所以解包必须"能解就解、不能解就原样用"，且 `listModels` 要同时接受顶层数组与 `{ models: [...] }` 两种负载。[代码]（`envelope.ts:1-13`、`client.ts:267-272`）
5. **usage 可能早于终止帧到达**，单帧里也可能同时出现 `usage` 与 `response_message`：解帧时 usage 要与文本/推理/工具调用分开处理，而不是"只在最后一帧读 usage"。[代码]（`client.ts:166-178`；旧实现同一处注释：`// usage (only on the terminal frame, but CatPaw may send it earlier)`）
6. **`source` 与 `mode` 是两套写法、不能互替**：`source='CatX'` 对应 `mode='CATX_APP'`。`mode='CATX_APP'` 与常量 `CATPAW_SOURCE='CatX'` 必须成对出现。[代码]（`constants.ts:31-35`）
7. **模型行字段名有多种历史写法**：`modelType`/`modelTypeId`、`id`/`modelId`/`modelTypeName`、`displayName`/`name`、`contextWindow`/`maxContextLength`；其中 `modelType` 是上行 body 里真正使用的**整数** id，必须按优先级回落，并过滤掉 `modelType<=0 || id===''` 的脏行。`parameterDefinitions` 或 `supportsReasoning` 存在即视为推理模型。[代码]（`client.ts:282-308`）
8. **脱敏是硬要求**：dry-run 打印凭据一律走 `maskSecret()`（前 8 字符 + 长度，`src/utils/redact.ts:14-18`），不打印原文也能确认"读到的是哪个 token"。[代码]

## 与旧实现的关系

- **协议事实的来源**：本文档与 `src/phase7-upstream-protocol/` 里的协议事实，最初都来自上一代 DSH 插件 `dsh-catpaw-connect` 的**真实运行** —— 该插件曾实际请求过 `ai.catpaw.meituan.com` 的 turn 与 model-types，必需头、body 形状、"帧是累积的"、"turn 以 TCP 关闭结束"这几条结论都是那时实测得到的。该插件在本次研究重构前已被移除，只留下备份副本 `.bak/20261006-103318-dsh-plugin-before-research-refactor/src/catpawClient.ts`（555 行）与其 `constants.ts`（50 行）。[代码]（备份文件存在）+ [参考]（历史实测：上一代插件的真实运行，**本仓库未复现**；按 `docs/README.md` 的证据等级约定，凡本仓库未复现的历史/外部来源记为 `[参考]`）
- **本仓库做了什么**：把协议层从插件里**剥离**出来独立固化 —— 去掉了 DSH 插件特有的部分（OpenAI 兼容转换、provider 注册、`StreamHandler` 翻译层、`getWorkspaceState` 桩），只保留"构造请求 / 发送 / 解码事件"三件事，并把它固化成独立模块。[代码]（对照：旧文件有 `getWorkspaceState` 桩，见 `catpawClient.ts:469-474`；本仓库 `client.ts:1-17` 明确声明"不做 OpenAI 兼容转换、不做 provider 注册"）
- **重写时改掉的两点**（有意为之，非疏漏）：
  1. **上游原始错误不再回传**：旧实现把响应体截断 200 字符拼进错误消息（`catpawClient.ts:421-428`：`upstream HTTP ${response.status}${text ? ': ' + text.slice(0, 200) : ''}`）；本仓库只给 `upstream HTTP <status>` + 数字 code（`client.ts:210-213`），符合本仓库"上游原文只进服务端日志、不回传客户端"的约束。[代码]
  2. **`User-Agent` 不再发送 / 常量收拢**：旧实现两个请求都带 `User-Agent: UA`，`UA = 'undici'`（旧 `constants.ts:34-35`）；本仓库的 `constants.ts` 未定义 UA，`client.ts` 也不发送 `User-Agent`。同时常量集中到 `src/phase7-upstream-protocol/constants.ts`（`BASE_URL`/`TURN_PATH`/`MODEL_LIST_PATH`/`M_APPKEY`/`GRAY_SET`/`X_AGENT_VERSION`/`CATPAW_MODE`/`CATPAW_SOURCE`/`TOOL_VERSION`/`TURN_TIMEOUT_MS`/`FETCH_TIMEOUT_MS`），取值与旧实现一致（旧 `constants.ts:8-32, 47-50`；两处超时同为 15 分钟与 30 秒）。[代码]
  3. 旧实现把 `toolVersion` 写成字面量 `'2.0.2'`（`catpawClient.ts:261`），本仓库提为常量 `TOOL_VERSION`（`constants.ts:38`）。[代码]

## 下一步

- ~~待补：Phase 7 目前没有本仓库自己的上游实测输出~~ → **已补齐（2026-10-08）**：Python 版网关做过真实上游调用，
  三段式协议跑通，边界数据见上方第 13–18 条与 [API-REFERENCE.md](API-REFERENCE.md) 第 2 节。
  第 1–11 条的 `[代码]` 等级不变（它们仍以 TS 源码为依据），但已由新实测交叉印证：必需头、body 形状、
  累积帧 suffix-diff、usage 修正、信封解包规则都在真实请求中复现。
- ~~待补：`constants.ts` 里有未被引用的常量~~ → **已收敛**：`PASSPORT_COOKIE` 现在被 `client.ts` 的 `authHeaders()` 用于拼 `Cookie`，`TURN_TIMEOUT_MS` 现在是 `streamChat` 的默认超时（`req.signal ?? AbortSignal.timeout(TURN_TIMEOUT_MS)`），不再有"定义了却没人用"的常量。`[代码]`
- 待补：`turn` 的 `finished` 字段语义、心跳帧的具体形状（`enableHeartBeat: true` 之后上游怎么发）都还没有记录 —— 本阶段只知道"不能依赖 finished 结束"。[推断]
- 待补：`round.messages` 总量是否有独立上限。已测 user 单条撑到 10 万字符仍 200，未找到上限。[实测]（2026-10-08）
- 分工：源码注释引用的 `docs/phase7-upstream-protocol/API-REFERENCE.md`（见 `constants.ts:5`、`client.ts:7`）已存在，与本文档同目录，由并行任务编写、负责**字段级速查**；本 RUN-LOG 只固化**协议行为与踩坑**。两者如有冲突，一律以 `src/catpaw_bridge/` 的源码为准。
