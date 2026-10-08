# 端到端数据流

本文用一张图把"登录态从哪来、怎么加密落盘、怎么被解出来、又怎么被用于上游调用"讲清楚。
所有路径均来自 [phase1](phase1-reconnaissance/RUN-LOG.md) / [phase2](phase2-data-collection/RUN-LOG.md) 的实测。

---

## 1. 全局视图

```text
                    ┌──────────────────────── 妙手桌面端（Electron, catpaw-moon） ────────────────────────┐
                    │                                                                                    │
   用户扫码/登录 ──▶ │  passport 登录 → 拿到 SSO access_token（152 字符）                                  │
                    │        │                                                                           │
                    │        ├─▶ StorageService.Oe(payload)  ← key = SHA256(machineId + 盐)              │
                    │        │        └─▶ %APPDATA%\catpaw-moon\catx-credential.json                     │
                    │        │                 { "ssoTokenEnc": "<base64(iv‖tag‖ct)>" }   ← 加密            │
                    │        │                                                                           │
                    │        └─▶ catx-auth-provider.json / catx-scope-pointer.json / catpaw-uuid         │
                    │                 （通道名、存储 scope、设备 UUID —— 都不是秘密）                      │
                    └────────────────────────────────────────────────────────────────────────────────────┘
                                                     │
            同一台机器上，同一条 token 还有一条明文出口（CLI 侧）
                                                     ▼
                    ┌──────────────── CLI（paw / catdesk, dataFolderName=.meituan-catpaw） ─────────────┐
                    │  %USERPROFILE%\.meituan-catpaw\auth.json                                          │
                    │    { auth:{loginType,accessToken,tokenType}, account:{uid,…}, scopeSuffix, … }     │
                    │    ← 明文，用于交叉验证                                                            │
                    └────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 解密路径（本仓库做的事）

```text
catx-credential.json
   │  readFileSync + JSON.parse
   ▼
ssoTokenEnc : string                       ← 304 字符 base64
   │  Buffer.from(b64)
   ▼
raw : 227 字节
   ├─ raw[0..12)   → IV
   ├─ raw[12..28)  → authTag (16 B)
   └─ raw[28..)    → ciphertext (199 B)
                       ▲
machineId ──▶ SHA-256(`${machineId}:catpaw-desk-token-v2`) ──▶ key (32 B)
                       │
                       ▼
        createDecipheriv('aes-256-gcm', key, IV).setAuthTag(authTag)
                       │  update(ct) + final()      ← 认证失败会在这里抛错
                       ▼
                JSON.parse(...)
                       ▼
        { access_token: "<152 字符>", modified_at: <毫秒时间戳> }
                       │
                       │  交叉验证：与 auth.json 的 accessToken 比对 sha256 指纹
                       ▼
              fingerprint = cd04187a3ce0a820   ← 两条来源一致
```

对应实现：`src/catpaw_bridge/crypto.py`（原语 + 密钥派生 `derive_sso_token_key`）、
`src/catpaw_bridge/scripts/verify_token.py`（端到端 + 与 auth.json 交叉验证）。

---

## 3. 上游调用路径

现役对话协议是**三段式**（round → event → turn）；只调 turn 会 500。

```text
{ access_token, uid? }
   │
   ▼ ①  POST .../api/agent/conversation/round          提交本轮全部消息（含历史）
      body: { conversationId, source:"CatX",
              messages:[{type:"user"|"assistant", role, messageId, content:[{type:"text",text}]}],
              modelType, mode:"CATX_APP", toolVersion:"2.0.2",
              requestContext:{modelParams:{declarativeParams:{effort,context}}},
              systemPromptContext:{systemPromptOverride} }
      校验：末条必须是 user；连续 assistant 被拒（连续 user 允许）
      上限：systemPromptOverride ≤ 65508 字符（JSON 转义后长度）
      响应：HTTP 200，靠 body 的 success/code 区分成败（失败也回 200！）
   │
   ▼ ②  POST .../api/agent/conversation/event          回报轮次状态 running
   │
   ▼ ③  POST .../api/agent/conversation/turn           执行轮次
      headers: M-TRACEID / M-APPKEY / gray-set / X-Agent-Version
               Cookie: X-Passport-Token=<access_token>   user-uid: <uid>
      body:    { conversationId, turnRequestId, source:"CatX", action:"turn",
                 message:{type:"user",content:[{type:"text",text}]},
                 modelType, mode:"CATX_APP", permissionMode:"default",
                 toolVersion:"2.0.2" }
   │
   ▼  text/event-stream
data: {"message":{"content":[…]},"contextInfo":{"usage":{…}}}   ← 每帧是累积全文
   │  SseReader 切行 → unwrapApiData 解信封 → SuffixDiff 转增量
   ▼
{ type:'delta' | 'reasoning' | 'tool_use' | 'usage' | 'done' }
   │
   └─ 流结束条件：TCP 关闭（无 finished 标志）
```

对应实现：`src/catpaw_bridge/` —— `conversation.py`（三段式协议 + `ConversationFrameDecoder`）、
`sse.py`（`SseReader` + `SuffixDiff`）、`protocol.py`（`unwrap_api_data` + 常量）、
`openai.py`（工具说明注入与体积收敛、消息序列合并）。

> 工具调用：上游**无原生用户工具通道**，网关把工具说明注入 system prompt，模型以
> ` ```tool_call ` 块输出，网关解析后转回 OpenAI `tool_calls`（`finish_reason=tool_calls`）。
> 工具说明也占用 65508 的预算，故 `openai.fit_system_prompt()` 会按需截断工具描述。

---

## 4. 存储 scope 机制（读代码得到的旁支结论）

`app.asar` 里还有一层"多租户 scope"逻辑，影响凭据落在哪个文件名前缀下： `[代码]`

- scope 段默认 `anon`；登录后由 `uid` + `entId` 派生（`catx-scope-pointer.json` 记住上次的段）。
- 通道名：`catx-passport`（个人 passport）、`catpaw-enterprise`、`catx-cloud`、`catx-cloud-enterprise`。
- 每个 scope 有独立的 store 文件；这就是为什么 userData 里能看到
  `catpaw-memory-<scope>.db` 与 `catpaw-memory-anon.db` 两个会话库。
- **凭据本身不随 scope 分文件**：`catx-credential.json` 始终是同一个文件、
  同一个 `ssoTokenEnc` 键 —— 换 scope 只是覆盖内容。

---

## 5. 敏感面小结

| 数据 | 是否秘密 | 说明 |
| --- | --- | --- |
| `ssoTokenEnc` | 是（密文） | 但密钥可从机器码离线派生 ⇒ 实际保护强度取决于机器码的不可得性，而非保密性 |
| `auth.json` 的 `accessToken` | 是（**明文**） | 同一 token 的明文副本，本课题正是用它做交叉验证 |
| `machineId`（MachineGuid） | 否 | 本机任意进程可读；它是这套方案的**唯一**密钥材料 |
| 派生 `key` | 是（等于秘密） | 但完全由 machineId 决定，可重算 |
| IV / authTag | 否 | IV 随密文落盘，authTag 用于完整性校验 |
| `catpaw-uuid` | 否 | 设备标识，不参与密钥派生 |
| `catx-scope-pointer` / `auth-provider` | 否 | 只是路由信息 |

因此本仓库的全部输出（日志、文档）只使用脱敏形态与指纹，
**不解密到磁盘、不回显 token 原文**。
