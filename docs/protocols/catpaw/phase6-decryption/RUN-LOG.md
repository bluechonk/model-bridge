# Phase 6 · 解密验证（Decryption）

> **实现语言（2026-10-07）**：本阶段现由 Python 实现 —— `src/catpaw_bridge/crypto.py`
> 与 `decryption.py`，命令行入口 `uv run catpaw-decrypt`（`catpaw-verify` 另做交叉比对与加解密往返）。
> 下文原始输出来自 TS/Node 版脚本（tag `v0.3.0-ts`）；结论与证据等级不变，详见 [../README.md](../PROTOCOL.md)。

## 目标

把 Phase 2~5 的结论串成一条可执行的链路并**证伪自己**：

1. 用派生出的密钥把 `ssoTokenEnc` 解开，明文形状是否与 `re()` 的 `JSON.parse` 预期一致？
2. 解出的 token 能否被**另一条独立来源**证实（CLI 侧明文 `auth.json`）？
3. 自己的加解密实现是否自洽（往返一致）？

第 2 点是本阶段最重要的：只有"两条互不相干的落点解出同一个 token"，
才能排除"密钥碰巧能过 GCM 校验"这种极小概率的巧合。

## 方法与命令

```powershell
npm run decrypt     # = node scripts/decrypt-token.ts   只解密 + 展示结构
npm run verify      # = node scripts/verify-token.ts    解密 + 交叉比对 + 往返，失败退 1
```

实现位置：

- `src/phase6-decryption/tokenCrypto.ts`：加解密原语（`decryptSsoToken` / `encryptSsoToken`）
- `src/phase6-decryption/index.ts`：端到端流程 + 与 `auth.json` 的交叉验证

## 原始输出（节选）

```text
=== Phase 6 · 端到端验证 ===
  1) 解密             OK
     access_token     AgEKJlOd…[152]
     token 指纹       cd04187a3ce0a820
     modified_at      2026-10-03T15:17:17.758Z
  2) 与 auth.json 比对  长度=true 指纹=true
     解密结果与 CLI 明文登录态完全一致（同一 access_token）
  3) 加解密往返          OK

  结论: 全部通过
```

Phase 3 对同一段密文的度量（用于印证长度自洽）：

```text
=== Phase 3 · 密文结构分析 ===
  base64 长度         304
  解码字节数          227
  切分                IV 12 + tag 16 + 密文 199
  IV (hex)            5007e731cea21e102988f0ef
  auth tag 前 8 字节  a5d92fb1fb9774ca
  密文熵              6.9466 bit/byte
  密文指纹            426ad1043b8f8e73
```

## 结论

1. 解密成功，明文为 `{ access_token: string, modified_at: number }`，
   token 长度 152 字符。`[实测]`
2. 解出的 token 与 `~/.meituan-catpaw/auth.json` 里的 `accessToken`
   **长度一致且 sha256 指纹完全一致**（`cd04187a3ce0a820`）——
   两条独立落点交叉验证通过。`[实测]`
3. 加解密往返一致，说明本项目对该原语的还原（IV/tag 切分、GCM 参数、base64 信封）
   是完整的，而不是"能解但说不清为什么"。`[实测]`
4. 长度自洽：227 字节 = 12 (IV) + 16 (tag) + 199 (密文)，而 199 正好是明文 JSON
   的 UTF-8 字节数（GCM 不填充）。`[实测]`
5. `modified_at` = 2026-10-03T15:17:17.758Z，与 `catx-credential.json` 的文件
   mtime（2026-10-03 15:17:18）吻合，即"登录后写入、此后未再刷新"。`[实测]` + `[推断]`

## 踩坑与修正

1. **不要用"能不能解密成功"当唯一判据。** GCM 有 128 bit 认证标签，错误密钥
   几乎必然抛错，所以"解开了"确实是很强的证据；但真正的完备证据是**交叉来源比对**
   —— 本阶段把它做成了脚本里的第 2 步，而不是可选项。
2. **`access_token` 与 `auth.json` 的 `accessToken` 可能不同步。** 桌面端与 CLI
   各自维护登录态，若中途在某一侧重新登录，两份会不一致。脚本因此区分三种结论：
   指纹一致 / 长度一致但指纹不同（本机轮换过）/ 两者都不同（不同账号或 scope），
   而不是简单地报"失败"。
3. **解密结果只在内存里。** 脚本全程只打印 `前缀…[长度]` 与指纹，
   不写解密产物到磁盘，避免把"明文凭据副本"留成新的泄露面。

## 下一步

凭据链路到此闭环。若要把这份知识用于理解客户端行为，
见 [Phase 7 · 上游协议](../phase7-upstream-protocol/RUN-LOG.md) 与
[API 参考](../phase7-upstream-protocol/API-REFERENCE.md)。
