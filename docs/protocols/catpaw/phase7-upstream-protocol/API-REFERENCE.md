# 上游接口参考（API-REFERENCE）

妙手客户端与 `ai.catpaw.meituan.com` 之间的接口约定。
来源：上一代 DSH 插件 `dsh-catpaw-connect` 的真实运行实现
（已从工作区移除，备份在 `.bak/`），以及本仓库对它的协议层剥离
（现为 Python：`src/catpaw_bridge/` 的 `protocol.py` / `sse.py` /
`conversation.py` / `upstream_client.py`）。文中形如 `xxx.ts:行号` 的引用均指 TS 版，
见 tag `v0.3.0-ts`。

> 本文件只描述**协议形状**，不含任何凭据。仓库不附带、不生成可直接调用的凭据；
> `catpaw-list-models`（`src/catpaw_bridge/scripts/list_models.py`）默认 dry-run，`--live` 才会真的出网。

---

## 1. 通用

| 项 | 值 |
| --- | --- |
| Origin | `https://ai.catpaw.meituan.com` |
| 认证 | Cookie `X-Passport-Token=<access_token>`（即 Phase 6 解出的 token） |
| 身份附加 | `user-uid: <uid>`（uid 非空时才带） |
| 追踪 | `M-TRACEID: <32 位无横线 uuid>`（每次请求新生成） |
| 应用标识 | `M-APPKEY: fe_com.sankuai.catpaw.external.front` |
| 灰度单元 | `gray-set: new-agent-sdk` |
| 客户端版本 | `X-Agent-Version: 1.0.1` |
| User-Agent | 上一代实现用 `undici`（Node fetch 默认 UA）；本仓库**不发** User-Agent |

`uid` 的来源：加密凭据里**没有** uid 字段（明文只有 `access_token` / `modified_at`），
所以走 `catx-credential` 这条来源时 uid 为空，请求就不带 `user-uid`；
需要 uid 时应回落到 CLI 明文 `auth.json` 的 `account.uid`。

---

## 2. 对话（三段式：round → event → turn）

现役协议是三段式，**不能只调 turn**：

```
1. POST /api/agent/conversation/round    提交本轮全部消息（含历史）
2. POST /api/agent/conversation/event    回报轮次状态（running / completed / failed / canceled）
3. POST /api/agent/conversation/turn     执行轮次，SSE 直出
```

[实测] 2026-10-08：直接调 turn（不先 round）一律 500 空响应。

### round 请求体

```jsonc
{
  "conversationId": "<uuid v4>",
  "source": "CatX",
  "messages": [ { "type": "user", "role": "user", "messageId": "<uuid>",
                  "content": [ { "type": "text", "text": "…" } ] } ],
  "modelType": 63,
  "mode": "CATX_APP",
  "toolVersion": "2.0.2",
  "requestContext": { "modelParams": { "declarativeParams": { "effort": "high", "context": "1024000" } } },
  "systemPromptContext": { "systemPromptOverride": "<system prompt>" }
}
```

消息形状要点：

- 每条消息必须带 `messageId`（uuid），缺了上游报 JSON 解析错误。
- `type` 标角色（`user` / `assistant`），最后一条必须是 `user`。
- **连续 `user` 允许，连续 `assistant` 不允许** [实测]：

  | 序列 | 结果 |
  | --- | --- |
  | `user, assistant, user` | 200 成功 |
  | `user, assistant, assistant, user` | 200 + `success:false`「assistant 消息不带 toolCall，后面必须是 user 消息，实际是: assistant」 |
  | `user, user, assistant, user` | 200 成功 |

- `systemPromptOverride` 有 **65508 字符硬上限**，度量口径是 JSON 转义后的长度
  （等价 JS `JSON.stringify(s).length`：非 ASCII 原样计 1、控制字符按转义形态计）。
  [实测] 二分结果：65508 通过 / 65509 失败，纯 ASCII、纯中文、含 `\n` 三种填充都收敛到同一边界；
  中文 65508 字符（19.6 万字节）照样通过，所以**不是** UTF-8 字节数。
  超限时上游返回 **HTTP 200 + `success:false`**（`unifyCode 1009010003`「系统内部异常」），
  不是 4xx/5xx —— 只看状态码会把失败当成功。
  常量见 `protocol.SYSTEM_PROMPT_MAX_LEN`。

### 响应信封

成功与业务失败都是 **HTTP 200**，靠 body 区分：

```jsonc
// 成功
{ "unifyCode": 0, "code": 0, "msg": "成功",
  "data": { "conversationId": "…", "round": 1, "roundId": "…", "messageId": "…", "createTime": 1791392100396 },
  "success": true }

// 业务失败（HTTP 仍是 200）
{ "unifyCode": 1009010003, "code": 9999, "msg": "系统内部异常", "success": false }
```

`protocol.unwrap_api_data()` 负责这条判定；`conversation._post_json()` 必须调它，
否则失败会漏到 turn 阶段、以上游「round not found」的形式被误报成 500。

---

## 3. 对话 turn（旧版直连路径，现由 round 前置）

> 注：现役实现走上面的三段式；本节描述 turn 自身的请求/响应形状，仍适用。

```
POST /api/agent/conversation/turn
Accept: text/event-stream
Content-Type: application/json
enableHeartBeat: true
```

### 请求体

```jsonc
{
  "conversationId": "<uuid v4>",
  "turnRequestId":  "<uuid v4>",
  "source": "CatX",
  "action": "turn",
  "message": { "type": "user", "content": [{ "type": "text", "text": "<本回合用户输入>" }] },
  "modelType": 100001,                       // 整数，来自 model-types 目录
  "mode": "CATX_APP",
  "permissionMode": "unsafeBypassPermissions",
  "toolVersion": "2.0.2",
  "toolConfigs": [ { "name": "…", "description": "…", "inputSchema": { } } ],
  "availableTools": [ "…" ],
  "systemPromptContext": { "systemPromptOverride": "<system prompt>" }   // 有 system 时才带
}
```

要点：

- **一次 turn 只带一条 user 消息**（取消息列表里最后一条 user），
  system prompt 走 `systemPromptContext.systemPromptOverride`，不放在 `message` 里。
- `tool_choice='none'` 时置 `availableTools: []` 并**删除** `toolConfigs`。
- `modelType` 是整数（模型目录里的 `modelType` 字段），不是模型名字符串。

### 响应：SSE

数据行形如 `data: {json}`；`data: [DONE]` 与空行忽略。
解信封规则（`protocol.py` 的 `unwrap_api_data()`）：

1. 有 `code` 且 ∉ `{0, 200}` ⇒ 业务错误，抛 `CatPawProtocolError`（带 `msg`/`message`/`unifyCode`）。
2. 有 `data` 键 ⇒ 取 `data`。
3. 否则整个对象即负载。

帧内业务结构（相对常见形状）：

```jsonc
{ "response_message": {
    "content": [ { "type": "text", "text": "<累积全文>" } ],
    "reasoningContent": "<累积全文>",
    "toolCalls": [ { "toolCallId": "…", "toolName": "…", "toolParams": "<累积 JSON 串>" } ]
  },
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

**两个反直觉点（必须处理，否则输出会重复或截断）：**

1. **帧是累积式的**：每帧给的是"到目前为止的全文"，不是增量。
   要按"当前串是否以已发送串为前缀"做 suffix-diff；若不以旧串为前缀（回退/重写），
   整段重发。实现见 `sse.py` 的 `SuffixDiff`。
2. **没有结束标志**：`finished` 字段存在但语义不保证，**不能**当终止信号；
   turn 以 **TCP 连接关闭**结束。实现里 `conversation.chat_turn()` 在读取循环结束后
   主动产出一帧 `StreamEvent(type='done', finish_reason='stop')`。

### usage 修正

上游的 `prompt_tokens` 有时偏低，用总数兜底：

```
prompt = max(upstream_prompt_tokens, upstream_total_tokens − completion_tokens)
total  = prompt + completion
```

---

## 4. 模型目录

```
POST /api/agent/maas/model-types
Content-Type: application/json

{ "tenant": "CatDesk", "scene": "CATX_APP", "env": "EXTERNAL" }
```

响应经信封解包后是数组（或 `{ models: [...] }`）。每行归一化时兼容的历史字段名：

| 目标字段 | 可接受的来源字段 |
| --- | --- |
| `modelType` | `modelType` / `modelTypeId` |
| `id` | `id` / `modelId` / `modelTypeName` |
| `displayName` | `displayName` / `name`（缺省回落 `id`） |
| `contextWindow` | `contextWindow` / `maxContextLength` |
| `reasoning` | `reasoning === true` / 存在 `parameterDefinitions` / `supportsReasoning === true` |
| `supportsImages` | `supportsImages === true` |

归一化后过滤掉 `modelType <= 0` 或 `id === ''` 的行。

---

## 5. 调用示例（手动，需自备凭据）

```bash
# 只打印将要发出的请求（默认 dry-run）
uv run catpaw-list-models

# 真正请求模型目录（装成 uv tool 后可直接用 catpaw-list-models）
uv run catpaw-list-models --live
```

```python
import asyncio

from catpaw_bridge.conversation import ChatTurnOptions, chat_turn, new_upstream_message
from catpaw_bridge.cred import resolve_local_credential
from catpaw_bridge.upstream_client import CatPawUpstreamClient


async def main() -> None:
    credential = resolve_local_credential()      # catx-credential → auth.json → env
    if credential is None:
        return
    client = CatPawUpstreamClient()
    models = await client.list_models(credential)

    options = ChatTurnOptions(
        credential=credential,
        messages=[new_upstream_message("user", "你好")],
        system_prompt="你是助手",
        model_type=models[0].model_type,
    )
    async for event in chat_turn(options):
        if event.type == "delta":
            print(event.text, end="", flush=True)
        elif event.type == "usage":
            print("\nusage", event.usage)


asyncio.run(main())
```

---

## 6. 未验证项

| 项 | 状态 |
| --- | --- |
| ~~本版本（2026.0923.1905）下的真实响应~~ | **已实测**（2026-10-08）：三段式 round/event/turn 全通，见第 2 节 |
| `model-types` 的完整字段集 | 只覆盖归一化时用到的字段 |
| 企业版通道（`catpaw-enterprise` / `epToken`）的端点 | 未分析（本机该文件为空） |
| ~~工具调用的完整回环（发送 tool 结果）~~ | **已实现**：网关以提示词注入模拟工具，回传时把 `tool` 结果折进 assistant 文本（`openai.to_round_messages`）；上游无原生工具通道 |
| `systemPromptOverride` 上限是"转义后长度"的**服务端实现依据** | 边界已二分实测，但上游是字符计数还是字节计数无法从外部区分到更细粒度；口径按 `escaped_length()` 取保守值 |
| 上游是否对 `round.messages` 总量另设上限 | 未测出：user 消息撑到 100K 字符仍 200（见第 2 节表） |
