# 附录：旧版线路与第三方参考实现

本附录记录两条**不属于**当前主结论线、但对理解产品演进有用的材料。
本文出现的记号 `[参考]` 表示"来自第三方参考实现或历史代码，**本机未验证**"。

---

## 1. 旧版 CatPawAI（VSCode 系）线路

现在安装的妙手（`妙手.exe`，`appId com.catx.catpaw`，Electron + `catpaw-moon` userData）
是一条新线。更早的 CatPawAI 是 **VSCode 派生**的客户端：数据目录是
`%APPDATA%\CatPawAI\User\...`，凭据落在 VSCode 的全局状态库 `state.vscdb` 里。

### 1.1 落点与键（本机不存在，来自历史实现） `[参考]`

| 项 | 值 |
| --- | --- |
| 数据库 | `%APPDATA%\CatPawAI\User\globalStorage\state.vscdb`（SQLite） |
| 主键 | `mt-idekit.mt-idekit-code` |
| 主键内的 token | `state.accessTokenprod` |
| 主键内的身份 | `userInfoprod.misId` |
| 兼容旧键 | `catpaw.mt-authentication` → `mt.auth.sessions[0].accessToken` |
| 读取方式 | `SELECT value FROM ItemTable WHERE key = ?`，值是 JSON 字符串 |

本仓库仍保留了这条路径作为**探测项**（`src/catpaw_bridge/paths.py` 的 `catpaw_layout()` 返回的
`legacy_vscdb_candidates`），实测结果为"文件不存在"——即本机只有新线。`[实测]`

### 1.2 该线路的交通加密（与存储加密是两回事） `[参考]`

旧线的 VSCode 扩展 `mt-idekit.mt-idekit-code/out/extension.js` 里嵌了一对 RSA 密钥，
用 **XOR 混淆**藏起来：

```js
const XOR_KEY = 'ThisIsMyXorKey'                      // 硬编码在扩展里
this.key1 = this.xorDecipher("<base64>", this.xorKey) // → PEM BEGIN PUBLIC KEY
this.key2 = this.xorDecipher("<base64>", this.xorKey) // → PEM BEGIN PRIVATE KEY

// 请求加密：每次随机生成 16 字节 AES 密钥
headers['encrypted-key'] = RSA-OAEP(sha1, publicKey, base64(aesKey))
body                     = AES-128-ECB(payload, aesKey) → base64

// 响应解密：用私钥解出 AES 密钥，再 AES-128-ECB 解响应体
```

**这条线路与当前主结论无关**，理由有两条：

1. 它保护的是**网络流量**（请求/响应体），不是本地存储；
2. 它是 VSCode 系客户端的机制，与新版妙手（Electron）不是同一套。

**本机验证**：在妙手安装目录全量检索 `ThisIsMyXorKey` → **零命中**，`[实测]`
说明新版客户端**没有**沿用这套 XOR/RSA 交通加密；Phase 4 找到的
`catpaw-desk-token-v2` 是另一套完全独立的存储加密。

### 1.3 两条线路对照

| | 旧线 CatPawAI（VSCode 系） | 新线 妙手（Electron） |
| --- | --- | --- |
| 应用形态 | VSCode 派生 | Electron（`catpaw-moon`） |
| 数据目录 | `%APPDATA%\CatPawAI\User\` | `%APPDATA%\catpaw-moon\` |
| 存储凭据 | `state.vscdb`（SQLite）里的 JSON 字符串 | `catx-credential.json` → `ssoTokenEnc` |
| 存储加密 | 无（SQLite 明文）`[参考]` | **AES-256-GCM + 机器码派生密钥** `[代码]` |
| 流量加密 | XOR 藏 RSA 密钥 + AES-128-ECB（`encrypted-key` 头）`[参考]` | 未发现（本次分析未观察流量加密） `[实测：关键词零命中]` |
| 本机状态 | 未安装 `[实测]` | 已安装，版本 2026.0923.1905 `[实测]` |

---

## 2. 第三方参考实现（`reference/`）

`reference/` 目录是从 GitHub clone 的第三方妙手反代/桥接实现，**仅作学习参考，
不入库**（已在 `.gitignore` 排除）。它们在方法论上有价值：可以交叉验证
"协议是否被独立复现过"，也能看到不同语言下踩过的坑。

| 目录 | 语言 / 形态 | 与本课题的关系 |
| --- | --- | --- |
| `zhou-gy-catpawai-proxy` | Node.js + 清理过源码（`clean/`） | 含 `catpaw-crypto.js`（本附录 1.2 的来源）与 Anthropic 适配层 |
| `HITZY2002-catpaw2api` | Go，含 `internal/upstream`（SSE 解析、轮询、会话） | 上游协议的独立复现；`docs/reverse-engineering.md` 有过程记录 |
| `icebears111-catpaw2api` | Go（较简版本） | 同上，代码量更小、便于快速对照 |
| `fifasheng-tech-catpaw-bridge` | Python，含 `crypto.py` / `token_manager.py` / `tool_translator.py` | 工具调用翻译与上下文压缩的实现参考 |
| `aimod-cc-agent2api` | Rust + Tauri 桌面壳，`core/providers/catpaw/*` | 最完整的一份：`registry` / `upstream` / `turn_executor` / `image_compress` |

**使用纪律**：`reference/` 里的结论一律标 `[参考]`，不得当作本机的实测事实。
本仓库的主结论（第 3 节之外的）都来自本机实测或本机 `app.asar` 的代码读取，
与这些第三方实现相互独立；两者一致时才算"独立复现"。

---

## 3. 与主结论的交叉印证 `[参考]`

第三方实现中与本仓库结论**方向一致**、可作为旁证的点：

- 妙手/旧线的凭据都来自**本机客户端登录态**，而不是自建 OAuth 流程
  （旧线 `state.vscdb`；新线 `catx-credential.json`）——这一点所有参考实现的做法都相同。
- 上游对话共享同一套网关形状：`/api/agent/...` + `M-APPKEY` / `gray-set` 头 +
  SSE 流；这也解释了旧 DSH 插件为什么能直接用这套头跑通。
- 多家实现都独立踩到了"**SSE 帧是累积式**"这件事，并各自实现了 suffix-diff ——
  说明这是上游的固有行为，而不是某一份实现的 bug。

**结论**：本仓库 Phase 4/5/6（存储加密与机器码派生密钥）**没有**在任何第三方参考实现里
找到对应物，属于本次分析的独立发现；Phase 7（上游协议）则与参考实现相互印证。
