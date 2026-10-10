# CatPaw 凭据逆向：结论与索引

本目录是妙手（CatPaw / catpaw-moon）桌面客户端凭据逆向的**结论层**：结论速览、方法论、
证据等级约定。逐阶段的过程记录（原始输出与复现步骤）已完成使命、随旧实现清理，
需要时从 git 历史取。

> **现行实现是 TypeScript**（`channels/catpaw/src/`，7 文件契约）；
> 逆向过程记录里的脚本输出为 TS/Node 版。结论与证据等级不随实现语言变化。

## 阅读顺序

| 顺序 | 文档 | 一句话 |
| --- | --- | --- |
| 0 | [FINDINGS.md](FINDINGS.md) | **先看这个**：全部结论汇总 + 证据等级 |
| 0 | [FLOW.md](FLOW.md) | 端到端数据流：登录态怎么落盘、怎么加密、怎么被解出来 |
| 1 | [phase7-upstream-protocol/API-REFERENCE.md](phase7-upstream-protocol/API-REFERENCE.md) | 上游接口速查（含体积上限与消息序列校验） |

## 方法论

逆向一条"凭据存储"链路，按下面的顺序推进可以保证每一步都可证伪、可回退：

1. **先只读侦察，不碰任何内容。** 把"东西在哪"和"东西是什么"彻底分开。只 stat、只读非敏感的
   `product.json`、列进程。此时不读任何凭据文件。
2. **枚举落点，按承载能力分类。** 把 userData 与 home 目录下所有可疑文件列出来，
   标注"是否承载凭据 / 明文还是密文 / 谁写的"。**只看键名和表名，不看值。**
3. **把密文当黑盒量。** 长度、熵、可打印占比、首字节。这一步只能提出假设，
   不能给出算法 —— 但能立刻判断"这个字段到底有没有加密"。
4. **静态读实现。** Electron 的 `app.asar` 不压缩，JS 是明文；只要知道存储键名
   （如 `ssoTokenEnc`）或盐串，就能反查到加密函数。**算法与常量以代码为准，不从熵猜。**
5. **追密钥材料。** 加密密钥从哪来，决定了这套方案的强度边界：
   内核密钥（DPAPI/Keychain）、进程内存、还是可离线复现的机器指纹。
6. **端到端验证 + 交叉比对。** 解出来的东西必须能用**另一条独立来源**验证
   （本项目：CLI 侧明文 `auth.json` 的指纹比对），并且加解密往返自洽。
7. **协议阶段只在有凭据的前提下描述，不用于批量访问。**

## 证据等级约定

所有结论都标注来源，避免把推断当成实测：

| 标记 | 含义 |
| --- | --- |
| `[实测]` | 由本仓库研究脚本（`channels/catpaw/research/`）在真实机器上跑出来的输出 |
| `[代码]` | 从磁盘上的实现（`app.asar` 内的 JS、随包 JS、DLL 元数据）直接读到的常量/逻辑 |
| `[推断]` | 由 `[实测]` + `[代码]` 推导，但未直接验证（例如非 Windows 平台分支） |
| `[参考]` | 来自第三方参考实现或历史代码（`reference/` 目录），**本机未验证** |

## 关键结论速览

- 凭据落在 `%APPDATA%\catpaw-moon\catx-credential.json` 的 `ssoTokenEnc`，**不是** Electron safeStorage，**不是** DPAPI。
- 密钥 = `SHA-256("${machineId}:catpaw-desk-token-v2")`，机器码取自注册表 `MachineGuid`（Windows）——**可离线复现**。
- 同一 token 另有一份**明文**副本在 `~/.meituan-catpaw/auth.json`（CLI 侧落盘），用于交叉验证。
- 上游对话是**三段式**：`POST /api/agent/conversation/round`（提交全部消息）→ `/event`（回报状态）
  → `/turn`（SSE 直出）；只调 turn 会 500。SSE 帧是**累积式**的，turn 以 TCP 关闭结束。
- `systemPromptContext.systemPromptOverride` 有 **65508 字符**硬上限（JSON 转义后长度口径），
  超限回 `HTTP 200` + `success:false`；round 还拒收连续 `assistant` 消息。

## 边界与伦理

- 分析对象是**本机、本人账号**的登录态文件；仓库不包含、也不生成任何可用凭据。
- 结论中的协议知识仅用于理解客户端行为；请不要用它做绕开授权或对外提供服务的事。
- 仓库的凭据处理有全历史审计记录（见 [security/findings.md](../../journals/security/findings.md)）：
  文档只保留协议结论，不含真实凭据；密钥派生知识仅用于解析本机登录态。
