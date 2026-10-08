# Phase 5 · 密钥提取（机器码派生密钥）

> **实现语言（2026-10-07）**：本阶段现由 Python 实现 —— `src/catpaw_bridge/machineid.py`
> （配合 `decryption.derive_local_key`），命令行入口 `uv run catpaw-derive-key`。
> 下文原始输出来自 TS/Node 版脚本（tag `v0.3.0-ts`）；结论与证据等级不变，详见 [../README.md](../PROTOCOL.md)。

## 目标

1. 确认妙手桌面端落盘密文（`ssoTokenEnc`）所用 AES 密钥的来源。
2. 证伪"需要 dump 进程内存 / 需要 Electron safeStorage / 需要 DPAPI"这一假设。
3. 离线复现密钥派生，并以"长度 + 指纹"（不打印原文）留下可复验的证据。
4. 说清该方案的安全边界。

## 方法与命令

本阶段全部命令都是仓库内已固化的 npm script（`package.json:22-34`）：

| 目的 | 命令 | 入口 |
| --- | --- | --- |
| 读机器码并派生密钥（本阶段主命令） | `npm run derive-key` | `scripts/derive-key.ts` |
| Phase 4 静态扫描 app.asar，取派生式与盐串的源码证据 | `npm run locate-crypto` | `scripts/locate-crypto.ts` |
| Phase 6 端到端验证（解密 + 与 CLI 明文比对 + 往返） | `npm run verify` | `scripts/verify-token.ts` |
| 类型检查 | `npm run typecheck` | `tsc --noEmit` |

机器码读取路径按平台选择（`src/phase5-key-extraction/index.ts:51-89`）：

- Windows：`reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid` → 取 `REG_SZ` 之后的部分 → 去掉所有空白 → 转小写。
- Linux：`/etc/machine-id` → 回退 `/var/lib/dbus/machine-id`（第一条非空即用）。
- macOS：`ioreg -rd1 -c IOPlatformExpertDevice` → `IOPlatformUUID`。

派生入口为 `deriveSsoTokenKey()`（`src/phase5-key-extraction/index.ts:92-94`）；`scripts/derive-key.ts` 只输出机器码/密钥的**长度与指纹**，不输出原文。

## 原始输出（节选）

节选自 `.tmp/runlogs/derive-key.txt`（由 `npm run derive-key` 产出）：

```text
=== Phase 5 · 机器码与密钥派生 ===
  机器码可用        true
  来源              HKLM\SOFTWARE\Microsoft\Cryptography → MachineGuid（按 node-machine-id 归一化）
  机器码长度        36
  机器码指纹        d20a9bd137d17584
  密钥长度          32 字节
  密钥指纹          9c27a3668e2599d4

--- 派生规则 ---
  - key = SHA-256( UTF-8( `${machineId}:catpaw-desk-token-v2` ) )
  - machineId = node-machine-id 的 machineIdSync(true)（原始值）
  - SHA-256 输出 32 字节 ⇒ AES-256；同一机器上密钥恒定
  - 没有 KDF 迭代/加盐：机器码本身即全部密钥材料
```

节选自 `.tmp/runlogs/locate-crypto.txt`（由 `npm run locate-crypto` 产出，只摘与密钥来源相关的行）：

```text
=== Phase 4 · app.asar 静态加密识别 ===
  文件                C:\Users\bluechonk\AppData\Local\妙手\resources\app.asar
  大小                381.1 MiB
  命中算法            aes-256-gcm
  密钥派生盐          catpaw-desk-token-v2
```

```text
  [密钥派生盐串] needle=catpaw-desk-token-v2
  …let t=``;try{t=Lt.machineIdSync(!0)}catch(n){le.warn(`Failed to read machine id, falling back to salt-only key:`,n)}
  let s=Qe(`sha256`).update(`${t}:catpaw-desk-token-v2`).digest();return t&&(Ee=Buffer.from(s)),s}…
```

```text
  [机器码来源（node-machine-id）] needle=machineIdSync
  …case"win32":return t.toString().split("REG_SZ")[1].replace(/\r+|\n+|\s+/gi,"").toLowerCase();…
```

节选自 `.tmp/runlogs/verify-token.txt`（由 `npm run verify` 产出；用于证明这把密钥真的能解开本地密文）：

```text
=== Phase 6 · 端到端验证 ===
  1) 解密             OK
     access_token     AgEKJlOd…[152]
     token 指纹       cd04187a3ce0a820
     modified_at      2026-10-03T15:17:17.758Z
  2) 与 auth.json 比对  长度=true 指纹=true
  3) 加解密往返          OK

  结论: 全部通过
```

该输出中的 token 为脱敏形态（前 8 字符 + 长度），指纹为 sha256 前 16 位十六进制（`src/utils/redact.ts:21-23`）——两者都不足以还原凭据原文。

## 结论

1. 密钥**不**来自 Electron safeStorage / DPAPI，也**不**需要从进程内存提取：它完全由机器码确定性派生。[代码]（`src/phase5-key-extraction/index.ts:92-94`；asar 内 `Ze()` 实现同形）
2. 派生式唯一确定：`key = SHA-256( UTF-8( `${machineId}:catpaw-desk-token-v2` ) )`，输出 32 字节 ⇒ AES-256。[代码] + [实测]（`密钥长度 32 字节`）
3. `machineId` 取 npm 包 `node-machine-id` 的 `machineIdSync(true)`（`true` = 取原始值不哈希）；本机来源为 Windows 注册表 `HKLM\SOFTWARE\Microsoft\Cryptography` 的 `MachineGuid`。[代码] + [实测]（`来源 HKLM\SOFTWARE\Microsoft\Cryptography → MachineGuid`）
4. 归一化是必需步骤：Windows 分支取 `REG_SZ` 之后的部分、去掉所有空白、**转小写**，与 `node-machine-id` 的 `c()` 完全一致。[代码]（`index.ts:60-66`）
5. 本机机器码长度 36（形如 `8-4-4-4-12` 的 UUID 文本），指纹 `d20a9bd137d17584`；派生出的 32 字节密钥指纹 `9c27a3668e2599d4`。[实测]
6. 该密钥确实能解开本机落盘的密文：解密成功，且解密结果与 CLI 明文 `auth.json` 的 accessToken **长度与指纹都一致**，加解密往返也 OK。[实测]（Phase 6 输出）
7. 密文信封为 `base64( iv[12] ‖ authTag[16] ‖ ciphertext )`，算法 aes-256-gcm（AEAD，带 16 字节认证标签），明文是可直接 `JSON.parse` 的 JSON 文档。[代码]（asar 片段：`s=t.subarray(0,12)`、`n=t.subarray(12,28)`、`r=t.subarray(28)`）
8. 同一台机器上密钥恒定：无随机盐、无 KDF 迭代、无 per-install secret，因此密文在任何时间都能离线解开。[代码]
9. 安全边界：机器码一变（换机 / 重装系统 / 改注册表），旧密文即不可解 —— 这是该方案的全部强度来源。[推断]
10. 该强度的实际含义：机器码对本机任何进程都可读，所以它只挡"把密文文件拷到别的机器上去解"，**不**挡本机上任何能读注册表的进程自己派生出密钥。[推断]

## 踩坑与修正

1. **Windows 机器码解析未归一化（主坑）**：最初只取 `reg query` 输出行的最后一个空白分隔字段，且没有做小写归一化。当 `MachineGuid` 含大写字母或值前后有多余空白时，会派生出一把**错误的密钥**，解密随即落到 `Failed to decrypt SSO token` 分支（表现为"看起来像未登录"）。[代码]（`src/phase5-key-extraction/index.ts:60-62` 的注释即这个坑的留痕）
   - 修正：改为与 `node-machine-id` 的 `c()` 完全一致的归一化 —— `split('REG_SZ')[1]` → `replace(/[\r\n\s]+/gu,'')` → `toLowerCase()`。[代码]（`index.ts:63-66`）
2. **上游有一条静默回落分支，本仓库刻意不复刻**：asar 里的 `Ze()` 在 `machineIdSync` 抛错时把机器码当成空串继续派生 `${''}:catpaw-desk-token-v2`，且只在成功读到机器码时才缓存密钥（`return t&&(Ee=Buffer.from(s)),s`）。也就是说读取失败时它会安静地用一把永远解不开的密钥去解密，把"读不到机器码"伪装成"凭据失效"。[代码] + [推断]（后者为后果推断）
   - 修正：本仓库把失败显式化 —— `readMachineId()` 返回 `available=false` + `error`，`scripts/derive-key.ts:21-23` 据此置退出码 1，而不是继续派生。[代码]
3. **Linux 分支不能假设固定路径**：实现按候选列表 `/etc/machine-id` → `/var/lib/dbus/machine-id` 依次尝试，第一条非空即用，全部失败才报不可用。[代码]（`index.ts:77-85`）
4. **打印纪律**：机器码与密钥都不打印原文，只给长度 + 指纹（`src/utils/redact.ts`）。本 RUN-LOG 中出现的所有值均为脱敏形态、长度或指纹。[代码]

## 下一步

- 待补：非 Windows 平台分支只有静态代码检查，**没有真机实测**（本机是 Windows，Linux/macOS 分支未在真实系统上跑过）。[代码]
- 待补：机器码变更导致旧密文不可解的端到端复现（需要改注册表 `MachineGuid`，风险高，本阶段未做）。[推断]
- 待补：token 的过期与刷新路径 —— 本次只验证了"能解开"，未验证"何时失效"。
- 留白：本次任务的范围只有 Phase 5 与 Phase 7 两份 RUN-LOG；`docs/` 下的其余文档（`README.md`、`FINDINGS.md`、`FLOW.md`、`APPENDIX-legacy-lines.md` 与各阶段 RUN-LOG）由并行任务编写，本文件不与它们互相覆盖。`.tmp/runlogs/` 下的 `recon.txt`、`scan-credentials.txt`、`analyze-token-blob.txt`、`locate-crypto.txt`、`verify-token.txt` 是各阶段的原始输出底稿。
