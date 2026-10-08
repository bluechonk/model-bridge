# Phase 4 · 加密识别（Encryption Identification）

> **实现语言（2026-10-07）**：本阶段现由 Python 实现 —— `src/catpaw_bridge/locate_crypto.py`，
> 命令行入口 `uv run catpaw-locate-crypto`。下文原始输出来自 TS/Node 版脚本（tag `v0.3.0-ts`）；
> 结论与证据等级不变，详见 [../README.md](../PROTOCOL.md)。

## 目标

Phase 3 只能说明"`ssoTokenEnc` 是高熵密文"，但**给不出算法**。
本阶段要回答三个问题，并且要求答案是"从实现里读出来的"，而不是从熵或长度猜的：

1. 用了什么对称算法、什么工作模式？
2. 密钥从哪来、怎么派生？
3. 信封的字节切分到底是什么（IV 几位、tag 几位）？

## 方法与命令

```powershell
npm run locate-crypto            # = node scripts/locate-crypto.ts
node scripts/locate-crypto.ts --asar <自定义 app.asar 路径>
```

手法：

1. **前提**：妙手是 Electron 应用，主进程/渲染层代码全部打进
   `resources\app.asar`；asar 只是"带索引的拼接包"，**不压缩**，
   JavaScript 以明文（minified 成一行）躺在里面，所以 `Buffer.indexOf` 就能检索。
2. **分块扫描**：文件 381.1 MiB，用 `readSync` 按 8 MiB 分块读，
   每块保留 3 KiB 回看窗口（既作为 needle 的跨块重叠区，也作为证据片段窗口），
   避免把整个文件读进内存。
3. **needle 列表**（`src/phase4-encryption-id/index.ts` 的 `CRYPTO_NEEDLES`）：

   | needle | 想找什么 |
   | --- | --- |
   | `catpaw-desk-token-v2` | 密钥派生盐串 |
   | `aes-256-gcm` | 对称算法 |
   | `Failed to decrypt SSO token` | 解密函数（它的 catch 分支） |
   | `ssoTokenEnc` | 存储键名 |
   | `catx-credential` | 凭据 store 名称 |
   | `machineIdSync` | 机器码来源（`node-machine-id`） |

4. 命中后截取"命中点之前的 3 KiB + 之后 200 B"，并把命中点用 `⟨…⟩` 标出。

## 原始输出（节选）

```text
=== Phase 4 · app.asar 静态加密识别 ===
  文件                C:\Users\bluechonk\AppData\Local\妙手\resources\app.asar
  大小                381.1 MiB
  命中算法            aes-256-gcm
  密钥派生盐          catpaw-desk-token-v2

--- 观察 ---
  - 密钥派生用 sha256，输入为 `${machineId}:catpaw-desk-token-v2`
  - 对称算法为 aes-256-gcm（AEAD，带 16 字节认证标签）
  - 信封切分由实现直接写死：iv=bytes[0,12)、tag=bytes[12,28)、ct=bytes[28,)
  - 密文落盘在 catx-credential store 的 ssoTokenEnc 键（base64）
  - 解密后直接 JSON.parse ⇒ 明文是 JSON 文档
```

决定性证据片段（`needle=Failed to decrypt SSO token`，已折叠为单行）：

```js
var le = T(`StorageService`), Ee = null;
function Ze() {                                   // ← 密钥派生
  if (Ee) return Buffer.from(Ee);
  let t = ``;
  try { t = Lt.machineIdSync(!0) }                // ← node-machine-id(true) 原始值
  catch (n) { le.warn(`Failed to read machine id, falling back to salt-only key:`, n) }
  let s = Qe(`sha256`).update(`${t}:catpaw-desk-token-v2`).digest();
  return t && (Ee = Buffer.from(s)), s
}
function Oe(e) {                                  // ← 加密
  try {
    let t = Rt(12),                               // ← 12 字节 IV
        s = yt(`aes-256-gcm`, Ze(), t),
        n = Buffer.concat([s.update(JSON.stringify(e), `utf8`), s.final()]),
        r = s.getAuthTag();
    return Buffer.concat([t, r, n]).toString(`base64`)     // ← iv ‖ tag ‖ ct
  } catch (t) { return le.warn(`Failed to encrypt SSO token:`, t), null }
}
function re(e) {                                  // ← 解密
  try {
    let t = Buffer.from(e, `base64`),
        s = t.subarray(0, 12),                    // ← IV
        n = t.subarray(12, 28),                   // ← auth tag（16 字节）
        r = t.subarray(28),                       // ← 密文
        o = ze(`aes-256-gcm`, Ze(), s);
    o.setAuthTag(n);
    let i = Buffer.concat([o.update(r), o.final()]).toString(`utf8`);
    return JSON.parse(i)                          // ← 明文是 JSON
  } catch (t) { return le.warn(`Failed to decrypt SSO token (treating as logged out):`, t), null }
}
function bt(e) {                                  // ← 读取路径
  ...
  let s = e.store.get(`auth`), n = s?.⟨ssoTokenEnc⟩;    // ← 存储键
  if (n) return re(n) || (oe(e), null);
  ...
}
```

存储侧的 store 定义（`needle=catx-credential`）：

```js
function _e() {
  return me ||= ce({ name: `⟨catx-credential⟩`, defaults: { ssoTokenEnc: `` }, cwd: B(k()) })
}
var Yt = {
  getEncryptedToken: () => { try { return _e().get(`ssoTokenEnc`) || null } catch (e) { … } },
  setEncryptedToken: (e) => { … },
  clearEncryptedToken: () => { … }
}
```

机器码来源（`needle=machineIdSync`，命中的是 `node-machine-id` 自身的实现）：

```js
function c(t) {
  switch (h) {
    case "darwin": return t.split("IOPlatformUUID")[1].split("\n")[0].replace(/\=|\s+|\"/gi, "").toLowerCase();
    case "win32":  return t.toString().split("REG_SZ")[1].replace(/\r+|\n+|\s+/gi, "").toLowerCase();
    case "linux":  return t.toString().replace(/\r+|\n+|\s+/gi, "").toLowerCase();
    …
  }
}
function u(t) { var n = c(execSync(y[h]).toString()); return t ? n : i(n) }   // i() = sha256
```

## 结论

1. 对称算法是 **AES-256-GCM**（AEAD，16 字节认证标签）。`[代码]`
2. 密钥派生式是 **`SHA-256(\`${machineId}:catpaw-desk-token-v2\`)`**，输出 32 字节。`[代码]`
3. 信封切分是 **`base64( IV[12] ‖ authTag[16] ‖ ciphertext )`**，由 `subarray(0,12)` /
   `subarray(12,28)` / `subarray(28)` 直接写死。`[代码]`
4. 密文落盘键是 `catx-credential` store 的 **`ssoTokenEnc`**，store 文件即
   `%APPDATA%\catpaw-moon\catx-credential.json`。`[代码]`
5. 明文是 JSON（解密后直接 `JSON.parse`），实际形状由 Phase 6 实测确认为
   `{ access_token, modified_at }`。`[代码]` + `[实测]`
6. 旁证：`node-machine-id` 的 `machineIdSync(true)` 是**原始值**（`t ? n : i(n)` 里
   `t=true` 走 `n`），不是哈希后的值；这解释了 Phase 5 为什么能直接用注册表里的
   `MachineGuid` 复现密钥。`[代码]`

## 踩坑与修正

1. **片段打印位置反了。** 第一版把 3 KiB 窗口按"从头截 900 字符"打印，
   结果每段都是命中点**前面**无关的 `startService` 调度代码 —— 因为 minified 代码
   一行到底、证据恰好落在窗口尾部。改为打印**片段尾部**后，`Ze()/Oe()/re()` 三个函数
   才完整暴露出来。
2. **`aes-256-gcm` 的首个命中点不是妙手凭据模块。** 那个字面量在 asar 里出现多次，
   首次命中属于另一个子系统（一个 `openclaw-feishu-uat` 的凭据存储，用同样的算法
   + `master.key` 文件）。因此工具里把该 needle 的标签改成"首次出现"，
   并在观察里明确写：**方案判定以 `Ze()/Oe()/re()` 那段片段为准**，不能只看"命中算法"。
3. **没有 needle 的负面结果同样有用**：`catpaw-desk-token-v2` 全文只命中一次，
   说明这套派生逻辑在客户端里只有一条实现，不存在新旧两套并存的情况。

## 下一步

拿到算法、盐串与切分之后，剩下的唯一未知量是 `machineId` ——
这正是 [Phase 5](../phase5-key-extraction/RUN-LOG.md) 要解决的。
