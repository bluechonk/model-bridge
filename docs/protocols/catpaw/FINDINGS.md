# 结论汇总（FINDINGS）

本文把所有实测与代码读取得到的结论集中在一处，逐条标注证据等级。
证据等级定义见 [PROTOCOL.md](PROTOCOL.md#证据等级约定)。

---

## 1. 目标客户端

| 项 | 值 | 等级 |
| --- | --- | --- |
| 产品名 | 妙手（CatPaw，应用目录名即 `妙手`） | `[实测]` |
| Windows 安装目录 | `%LOCALAPPDATA%\妙手` | `[实测]` |
| 版本 | `2026.0923.1905` | `[实测]` |
| commit | `9a497699f6cb7f92f33d64b328846b975578a230` | `[实测]` |
| applicationName | `catpaw-moon`（决定 Electron userData 目录名） | `[实测]` |
| appId | `com.catx.catpaw` | `[实测]` |
| dataFolderName | `.meituan-catpaw`（决定 CLI 落盘目录） | `[实测]` |
| cliCommandName | `paw`（别名 `catdesk`） | `[实测]` |
| win32MutexName | `CatPawAppMutex` | `[实测]` |
| 主程序归档 | `resources\app.asar`，381.1 MiB | `[实测]` |
| 随包 Agent SDK | `resources\app.asar.unpacked\node_modules\@catpaw\agent-sdk`（含 `bin\catpaw-cli.exe`） | `[实测]` |
| 随包 CLI | `resources\cli\catpaw-cli.js`，189.9 KiB | `[实测]` |

技术栈是 Electron；主进程与渲染层代码全部打进 `app.asar`（不压缩），
因此**静态检索就能读到加密实现** —— 这是整个 Phase 4 成立的前提。 `[代码]`

---

## 2. 凭据落点

userData 目录：`%APPDATA%\catpaw-moon`；CLI 目录：`%USERPROFILE%\.meituan-catpaw`

| 文件 | 大小 | 承载凭据 | 加密 | 键 / 角色 | 等级 |
| --- | --- | --- | --- | --- | --- |
| `catx-credential.json` | 326 B | **是** | **是**（AES-256-GCM） | `ssoTokenEnc` —— 本课题主目标 | `[实测]` |
| `.meituan-catpaw\auth.json` | 442 B | **是** | 否（明文） | `auth` / `account` / `scopeSuffix` / `updatedAt` —— 交叉验证来源 | `[实测]` |
| `catx-enterprise-token.json` | 92 B | 是（本机为空） | 复用同一原语 | `epToken` / `entId` / `activeEntId` / `sessions` / `refreshJournal` | `[实测]` |
| `catx-auth-provider.json` | 38 B | 否 | — | `activeProvider`（本机为 `catx-passport…`） | `[实测]` |
| `catx-scope-pointer.json` | 43 B | 否 | — | `lastActiveScopeSegment`：多租户存储 scope 指针 | `[实测]` |
| `catpaw-uuid` | 57 B | 否 | — | 设备 UUID（**不是**密钥材料） | `[实测]` |
| `Local State` | 490 B | 否 | — | `os_crypt`（Electron safeStorage 元数据）——本产品**未**用这条通道存 token | `[实测]` |
| `catpaw-memory-<scope>.db` | 33.2 MiB | 否 | — | SQLite：`conversations` / `sessions` / `memory_chunks_fts` … | `[实测]` |
| `catpaw-memory-anon.db` | 224 KiB | 否 | — | 同上（匿名 scope） | `[实测]` |
| `<roaming>\CatPawAI\User\globalStorage\state.vscdb` | 不存在 | （历史） | 否 | 旧版 VSCode 系线路的凭据表 | `[实测]`（本机不存在） |

**关键判断**：这条产品线**没有**走 Electron `safeStorage`（即没有 DPAPI/Keychain 包裹），
而是自己实现了一套基于机器码的密钥派生 —— 这既降低了提取门槛，也决定了它的强度边界：
**只要知道机器码就能解密**。 `[代码]`

### 明文 auth.json 的结构 `[实测]`

```jsonc
{
  "auth":    { "loginType": "passport", "accessToken": "<152 字符>", "tokenType": "Bearer" },
  "account": { "uid": "<10 位>", "loginName": "<8 字符>", "name": "<8 字符>", "entId": "" },
  "scopeSuffix": "<11 字符>",
  "updatedAt":   1760000000000          // 毫秒时间戳
}
```

---

## 3. 存储加密方案（核心）

从 `app.asar` 里读到的实现（minified 后函数名为 `Ze` / `Oe` / `re`）： `[代码]`

```js
// 密钥派生（带进程内缓存）
function Ze() {
  let t = ''
  try { t = machineIdSync(true) }            // node-machine-id，true = 原始值不哈希
  catch { warn('Failed to read machine id, falling back to salt-only key') }
  return createHash('sha256').update(`${t}:catpaw-desk-token-v2`).digest()
}

// 加密
function Oe(payload) {
  const iv = randomBytes(12)
  const c  = createCipheriv('aes-256-gcm', Ze(), iv)
  const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')
}

// 解密
function re(encoded) {
  const raw = Buffer.from(encoded, 'base64')
  const iv  = raw.subarray(0, 12)            // IV
  const tag = raw.subarray(12, 28)           // auth tag（16 字节）
  const ct  = raw.subarray(28)               // 密文
  const d = createDecipheriv('aes-256-gcm', Ze(), iv)
  d.setAuthTag(tag)
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'))
}
```

归纳：

| 项 | 值 | 等级 |
| --- | --- | --- |
| 对称算法 | `aes-256-gcm`（AEAD，带 16 字节认证标签） | `[代码]` |
| 密钥派生 | `SHA-256( UTF-8( \`${machineId}:catpaw-desk-token-v2\` ) )` → 32 字节 | `[代码]` |
| 密钥材料 | 机器码本身（无迭代、无随机盐、无 KDF 成本参数） | `[代码]` |
| 信封 | `base64( IV[12] ‖ authTag[16] ‖ ciphertext )` | `[代码]` + `[实测]`（长度 227 = 12 + 16 + 199 自洽） |
| 明文 | `{ access_token: string, modified_at: number }` | `[实测]` |
| 落盘 | `catx-credential.json` → `ssoTokenEnc` | `[代码]` |

### 为什么能确认切分是 12 / 16 而不是猜的

1. `re()` 里直接写死 `subarray(0,12)` / `subarray(12,28)` / `subarray(28)` `[代码]`
2. 本机实测字节数 227 = 12 + 16 + 199，其中 199 正好等于明文 JSON 的 UTF-8 字节数
   （`{"access_token":"<152>","modified_at":<13>}` → 199），GCM 无填充，长度可精确对上 `[实测]`

---

## 4. 密钥材料：机器码

`node-machine-id` 的 `machineIdSync(true)`（从 `app.asar` 里读到的该包实现）： `[代码]`

| 平台 | 来源 | 归一化 |
| --- | --- | --- |
| Windows | `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid` | 取 `REG_SZ` 之后的部分 → 去掉所有空白 → **转小写** |
| Linux | machine-id 文件 | 去空白、转小写 |
| macOS | `ioreg -rd1 -c IOPlatformExpertDevice` → `IOPlatformUUID` | 去空白、转小写 |

本机实测：机器码长度 36（8-4-4-4-12 的 UUID 文本），指纹 `d20a9bd137d17584`，
派生出的 32 字节密钥指纹 `9c27a3668e2599d4`。 `[实测]`

**安全含义** `[推断]`：

- 这是一套**确定性**密钥：同一台机器上密钥恒定，不依赖任何进程态或用户态秘密。
- 强度上限 = 机器码的可获得性。机器码不是秘密（本机任意进程可读），
  所以**任何能读到该用户文件系统的进程都能解密 token**。
- 反过来说，换机 / 重装系统 / 改注册表后旧密文即不可解 —— 这也解释了为什么
  桌面端重新登录会直接覆盖 `ssoTokenEnc`。

---

## 5. 解密验证结果

| 项 | 值 | 等级 |
| --- | --- | --- |
| 密文 base64 长度 | 304（→ 227 字节） | `[实测]` |
| 密文熵 | 6.9466 bit/byte（样本仅 199 B，短样本熵估计天然偏低） | `[实测]` |
| 解密结果 | `{ access_token, modified_at }`，明文 token 152 字符 | `[实测]` |
| token 指纹 | `cd04187a3ce0a820` | `[实测]` |
| `modified_at` | 2026-10-03T15:17:17.758Z | `[实测]` |
| 与 CLI 明文 `auth.json` 比对 | 长度一致、**sha256 指纹完全一致** | `[实测]` |
| 加解密往返 | 用自己的实现重新加密再解密，指纹一致 | `[实测]` |

> 交叉验证是这套结论最有力的一环：**两条彼此独立的落点**（加密的 `ssoTokenEnc` 与
> 明文 `auth.json`）解出同一个 token，说明密钥派生与信封切分都还原正确了。

---

## 6. 上游协议要点

| 项 | 值 | 等级 |
| --- | --- | --- |
| Base | `https://ai.catpaw.meituan.com` | `[代码]`（旧实现在宿主中真实跑通的常量） |
| 对话 | **三段式**：`POST /api/agent/conversation/round`（提交全部消息）→ `/event`（回报状态）→ `/turn`（SSE 直出） | `[实测]`（2026-10-08） |
| 模型目录 | `POST /api/agent/maas/model-types` | `[代码]` |
| 必需头 | `M-TRACEID`（32 位无横线 uuid）、`M-APPKEY=fe_com.sankuai.catpaw.external.front`、`gray-set=new-agent-sdk`、`X-Agent-Version=1.0.1`、`Cookie: X-Passport-Token=<token>`、`user-uid` | `[代码]` |
| turn body | `source=CatX`、`action=turn`、`mode=CATX_APP`、`permissionMode=unsafeBypassPermissions`、`toolVersion=2.0.2` | `[代码]` |
| system prompt | 走 `systemPromptContext.systemPromptOverride`，一次 turn 只带一条 user 消息 | `[代码]` |
| system prompt 上限 | **65508 字符**，口径为 JSON 转义后长度（等价 `JSON.stringify(s).length`）；超限回 `HTTP 200` + `success:false` | `[实测]`（2026-10-08，二分 65508 过 / 65509 挂） |
| round 消息序列 | 连续 `user` 允许；**连续 `assistant` 被拒**（「assistant 消息不带 toolCall，后面必须是 user」）；末条必须是 `user` | `[实测]`（2026-10-08） |
| SSE | 每帧是**累积全文**，需 suffix-diff 转增量；turn 以 **TCP 关闭**结束（`finished` 字段不可依赖） | `[代码]` |
| usage | `prompt = max(upstream_prompt, total − completion)` | `[代码]` |
| 工具通道 | 上游**无原生用户工具通道**，网关以提示词注入模拟；模型手写的工具名大小写会被改写（声明 `Bash` → 输出 `bash`） | `[实测]`（2026-10-08） |

~~当前版本本机未做真实上游调用~~ → **已做真实调用（2026-10-08）**：网关接入 ZCode 后全程跑通三段式协议，
上表带 `[实测]` 的行即来自该轮验证；`catpaw-list-models`（`src/catpaw_bridge/scripts/list_models.py`）
仍默认 dry-run，真跑需显式 `--live`。TS 时代的协议事实来自上一代 DSH 插件
`dsh-catpaw-connect` 的真实运行（实现已剥离，备份在 `.bak/`）。 `[实测]`（脚本行为）

---

## 7. 尚未验证 / 留白

| 项 | 状态 |
| --- | --- |
| Linux / macOS 的安装路径与 userData 路径 | `[推断]`：按 `product.json` 字段名（`applicationName` / `dataFolderName`）推得，未在对应平台实测 |
| macOS / Linux 的机器码读取分支 | `[代码]`：从 `node-machine-id` 实现读出，未实测 |
| `catx-enterprise-token.json` 的 `sessions` 结构 | 本机为空，未展开 |
| `catpaw-memory-*.db` 的会话内容语义 | 只列了表名，未做内容分析（与凭据无关，超出本课题范围） |
| 上游 `model-types` 的字段全集 | 只覆盖归一化时用到的字段；真实请求已跑通，字段全集仍未穷举 |
| `round.messages` 总量是否有独立上限 | 未找到：user 单条撑到 10 万字符仍 200 `[实测]`（2026-10-08） |
| `systemPromptOverride` 上限的服务端实现依据 | 边界已二分实测，但"字符 vs 字节"无法从外部区分到更细粒度；按 `escaped_length()` 取保守口径 |
| 旧版 CatPawAI（VSCode 系）线路 | 本机未安装，未做分析；旧线路已不在使用，不再保留第三方参考实现对照 |
