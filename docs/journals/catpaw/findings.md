# 研究发现（插件化新增）

协议与逆向结论见 docs/FINDINGS.md（证据分级完整），这里只记插件化工作新增的事实与决策。

## 可直接复用的构件

- `resolve_local_credential()`（`cred.py`）：密文 ssoTokenEnc → CLI 明文 auth.json → 环境变量 CATPAW_COOKIE，三级回退，返回 `Credential(access_token, uid, source)`。
- `CatPawUpstreamClient`（`upstream_client.py`）：`stream_chat()` / `conversation.chat_turn()` 已产出类型化事件（`StreamEvent.type` ∈ delta/reasoning/tool_use/usage/done/error），tool arguments 已做增量差分；`list_models()` 返回归一化 `ModelInfo`（model_type/id/display_name/context_window/reasoning/supports_images）。
- `CatPawUpstreamClient.build_turn_body()`（`upstream_client.py`；高层入口 `conversation.chat_turn()`）：system 走 systemPromptContext.systemPromptOverride，一次 turn 只带一条 user 消息；toolConfigs/availableTools 由 ToolSpec 生成；toolChoice=none 可清空。
- `fingerprint()` / `mask_secret()`（`redact.py`）：输出脱敏铁律的现成工具。

## 上游协议关键事实（决定网关翻译层）

- SSE 每帧是**累积全文**（client 已用 SuffixDiff 转增量），turn 以 TCP 关闭结束，`finishReason` 不可依赖。
- usage 修正：prompt = max(upstream_prompt, total − completion)。
- 必需头/常量全部在 `protocol.py`；BASE_URL=https://ai.catpaw.meituan.com。
- `permissionMode=unsafeBypassPermissions` 是桌面端自身的请求形态（协议事实），网关原样保留。

## 插件化设计决策

- 端口 8790（避开 workbuddy 8787/8788）。
- 模型 id 直接用上游 `id` 字段（不造短名）。
- 多轮对话：system 合并进 systemPromptOverride；其余消息折叠成 transcript（上游单 turn 协议限制）。
- 凭据无独立"登录"动作：妙手桌面端负责登录，网关只读落盘文件（mtime 变化即重新解析）。
- 与 workbuddy 插件同构：零依赖 Node ESM MCP stdio 服务器，工具 status/start/stop/models（无 login）。

## 登录 URL 逆向实测（2026-10-07，阶段5）

无头登录链路三步全部实测打通：

1. `GET https://catx.nocode.cn/api/gateway/passport/login-config`
   → `{"code":0,"data":{"loginEntryUrl":"https://catpaw.meituan.com/api/gateway/passport/login-entry"}}`
2. 拼 auth_url（三个参数缺一不可，只带 sid 会 400「登录失败」）：
   `login-entry?sid=<32hex>&state=<32hex>&redirect=http://127.0.0.1:37890/callback`
   → 302 到 `passport.meituan.com/useraccount/login?...&continue=...settoken...`
   浏览器完成登录后跳 127.0.0.1（无监听，浏览器报错页属预期）
3. `GET https://catx.nocode.cn/api/gateway/passport/poll-token?sid=<sid>` 每 3s 轮询：
   未登录 `{"code":0,"data":null}`；登录后 `data` 即 token 字符串（本机实测 ~90 秒内返回）

### token 形态分析

- **不是 JWT**：单段不透明 token，152 字符，前缀 `AgEKJl`（base64 解出 02 01 0A 开头的
  版本化二进制信封，非可解 JSON）——与桌面端落盘的是同一形态
- **指纹与现有凭据完全一致**（cd04187a3ce0a820）：poll-token 返回的是绑定该账号会话的
  同一个 SSO token，不是每次登录新发——即无头登录与桌面端登录拿到同一身份
- **实测可用于全部业务端点**：model-types 200（9 个模型，比昨天多 1 个）、round 200

### 结论

无头 `login` 子命令完全可行，形态与 workbuddy 的 login 同构：
login-config → 拼 URL 给用户浏览器 → 轮询 poll-token → 落盘凭据。
唯一注意：redirect 参数的 127.0.0.1 端口无监听即可，无需本地回调服务。

## Python 重写可行性调研（2026-10-07）

- 姊妹项目 `zcode-workbuddy-bridge`（Python/uv）是本项目的近 1:1 工程模板：
  `cli/daemon/headless/gateway/sse_stream/paths/cred/auth_flow/portfree` 可直接对位。
- 需要一并移植的 TS 面（网关硬依赖，缺一不可）：`phase7`（protocol/sse/client）、
  `phase6`（AES-GCM + 派生）、`phase5`（机器码）、`phase2`（auth.json/密文读取）、
  `utils`（paths/redact/probe/report）。
- 硬点：Python 标准库无 AES ⇒ 必须有 crypto 依赖（选 `cryptography`）；
  catpaw 的 SSE 是**累积帧 suffix-diff**（与 workbuddy 的透传不同）——`sse.py` 的 `SuffixDiff` 已原样搬自 `sse.ts`。
- 依赖决策：aiohttp（服务端+客户端）+ requests + cryptography，uv 管理（对齐 zcb）。
- 分发：`uv tool install .` 提供 `catpaw` console script；插件 hook 仍按 PATH 找 `catpaw`（与 zcb 同模式）。

## Python 重写实施结果（2026-10-07）

- 全量移植完成并实测通过（见 progress.md 会话记录）。关键等价性验证：
  - AES-256-GCM 解密：本机桌面端密文解出 token，指纹 `cd04187a3ce0a820`，与 CLI 明文
    auth.json 指纹一致，加解密往返自洽 —— 与 TS 版结论逐位吻合。
  - conversation 三段式协议 + 累积帧 suffix-diff：真实上游流式文本、非流式、工具调用
    （`finish_reason=tool_calls`）全部复现。
- 唯一的**行为差异（改进）**：守护健康探测按"服务可达（status 200 + `service` 字段）"判定，
  不再用 `/health` 的 `ok`（`ok` 表示凭据可用性，与进程是否在跑无关）。此举修掉了
  "未登录时 `catpaw start` 误判未启动"的旧问题。
- 未移植项：workbuddy 的 `console`(:8788) 与 `portfree` 端口自愈 —— catpaw 原本就没有控制台，
  端口自愈留作可选后续。

## 上游体积上限与消息序列校验（2026-10-08）

ZCode 接入后出现「工作中 45 秒 / 重新连接中 5/10」并全部 502。逐层排查后定位到
**三个叠加的缺陷**，全部已修并实测通过。

### 事实一：`systemPromptOverride` 有 65508 字符硬上限 `[实测]`

用 round 端点二分，边界极干净：

| 填充 | 边界 |
| --- | --- |
| 纯 ASCII | 65508 通过 / 65509 失败 |
| 纯中文 | 65508 通过 / 65509 失败 |
| 含 `\n` | 转义后 65508 通过 / 65509 失败 |

即度量口径是 **JSON 转义后的长度**（等价 JS `JSON.stringify(s).length`：非 ASCII 原样计 1，
控制字符按转义形态计），不是 UTF-8 字节数——中文 65508 字符（19.6 万字节）照样通过。
常量落在 `protocol.SYSTEM_PROMPT_MAX_LEN`。

超限时上游返回的是 **HTTP 200 + `success:false`**（`unifyCode 1009010003`「系统内部异常」），
不是 4xx/5xx。

### 事实二：round 拒收连续 assistant `[实测]`

```
user,assistant,user                 -> 200 成功
user,assistant,assistant,user       -> 200 + success:false
   「assistant 消息不带 toolCall，后面必须是 user 消息，实际是: assistant」
user,user,assistant,user            -> 200 成功（连续 user 反而允许）
```

ZCode 的 tool 回合形态是 `assistant(tool_calls) → tool → assistant…`，一个任务下来会产出
一长串连续 assistant，直接映射必被拒。

### 三个缺陷与修法

| # | 缺陷 | 后果 | 修法 |
| --- | --- | --- | --- |
| 1 | `_post_json` 只看 HTTP 状态码，不解析 body | 上游 `200 + success:false` 被当成功，继续发 turn → 上游回「round not found」→ 最终误报成 `upstream HTTP 500` | 复用 `unwrap_api_data` 解析 body；业务失败抛 `CatPawProtocolError`，在 `chat_turn` 里转成带原始 msg 的 error 事件 |
| 2 | 工具说明注入无体积控制 | 32 个工具注入 77,859 字符，加上 system 远超 65508 → 静默失败 | `fit_system_prompt`：超限时按档位逐级截断工具描述（2000→1000→600→400→200→80 字符，后两档再去掉参数级 description）；连最紧档仍超（说明用户自己的 system 太大）则抛 `PromptTooLargeError`，网关回明确的 **400 `prompt_too_large`** |
| 3 | 模型输出的工具名未对齐声明名 | 声明 `Bash`，模型稳定输出 `bash`（上游无原生工具通道，名字是手写的）→ 客户端按精确名匹配会失配 | `resolve_tool_name` 做大小写不敏感对齐，`CompletionAccumulator` 与 `extract_tool_calls` 两条路径都过一遍 |

### 修复前后实测对比

同一条 ZCode 真实请求（`LongCat-2.0`、32 工具、73 消息、round body 185.6K）：

| | 结果 |
| --- | --- |
| 修复前 | HTTP 502 `上游请求失败: upstream HTTP 500` |
| 修复后 | HTTP 200，`finish_reason=stop`，SSE 正常流出 |
| 工具调用路径 | HTTP 200，`finish_reason=tool_calls`，名字正确回填为 `Bash` |
| 用户 system 自身超限 | HTTP 400 `prompt_too_large`（明确原因，不再是误导性 502） |

> 注：改完必须 `uv tool install --reinstall <仓库>` 才生效——`uv tool` 装的是**副本**
> （非 editable），只改 `src/` 不会影响正在跑的网关。
