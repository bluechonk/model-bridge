# 调研发现：Qoder 渠道（reference/ 五个反代项目的分析）

> **结论先说**：Qoder 可以实现，而且比 `PROTOCOL.md` 原先估计的简单得多。
> 那份规格写「WASM 签名无纯代码替代，只能 wasmtime + 重写 glue 约 200 行」——
> 但社区已经有**至少三个独立项目用纯代码复刻了同一套算法**（Python / Go / Go），
> 彼此交叉验证一致，且**全部不需要 WASM**。算法三件套都是 `node:crypto` 里现成的：
> **RSA-PKCS1v15 包裹会话密钥 + AES-128-CBC 加密身份体 + MD5 签名**。

调研日期 2026-10-09；参考项目 clone 在 `channels/qoder/reference/`（已 gitignore，不入库）。

---

## 1. 参考项目清单

| 项目 | 语言 | ★ | 许可证 | 路线 | 价值 |
| --- | --- | --- | --- | --- | --- |
| **`qoder2api-hub`**（shuishuipingan） | Python | 86 | **MIT** | COSY 纯代码复刻 |  **主参考**：33 个模块、双区、多账号、签到、模型目录动态拉取，注释是逆向笔记级别的详细 |
| `jyao0708/qoder2api` | Go | 31 | **MIT** | COSY 纯代码复刻（`crypto/rsa` + `crypto/aes`） | 佐证算法；`internal/qoder/legacy.go` 结构可对照 |
| `Zhengyuuuui/qoder2api` | Go | 50 | 无 | COSY 纯代码复刻（`internal/cosy/{session,signature,fingerprint}.go`） | 佐证算法；文件切分可借鉴 |
| `cubk1/qoder2api` | Java | 89 | 无 | **旧签名**（`md5("cosy" + "&" + SECRET + "&" + RFC1123日期)`） | 反例：这套已过时，见 §3.1 |
| `fengyinxia/qoder2api` | Python | 30 | 无 | 未细看（`qoder_auth.py`） | — |

>  许可证只对「能否复制代码」有约束。**MIT 的两个**（hub / jyao0708）可以借鉴甚至改写；
> **无 LICENSE 的三个**只能读思路、自己重写实现 —— 我们本来就打算用 TS 重写，不受影响。

---

## 2. COSY 签名（核心，可直接用 TS 复刻）

来源：`qoder2api-hub/qoder_sign.py` 的 `CosySession`（539-623 行），Go 项目同构。

### 2.1 会话建立（每个账号一次，access token 轮换后重建）

```
temp_key  = 16 个十六进制字符（uuid4().hex[:16]）  ← 同时当 AES-128 的 key 与 IV（key == iv）
cosy_key  = base64( RSA_PKCS1v15_encrypt(temp_key) )   ← 官方 1024-bit 公钥，硬编码 PEM
identity  = { name, aid, uid, yx_uid, organization_id, organization_name,
             user_type, security_oauth_token, refresh_token }        ← 9 键，顺序无关
info      = base64( AES-128-CBC-PKCS7( json_sorted_compact(identity), key=temp_key, iv=temp_key ) )
```

- `json_sorted_compact`：**键排序 + 无空白**的 JSON，`null` 值当 `""`。服务端签名字节与此强绑定。
- `user_type` 默认 `"personal_professional_trial"`（实测值）。

### 2.2 每次请求的 Bearer

```
payload     = { cosyVersion: "1.1.64", ideVersion: "", info, requestId: <uuid4>, version: "v1" }
payload_b64 = base64( json_sorted_compact(payload) )
date        = unix 秒（字符串）
path        = URL 的 path，**去掉开头的 "/algo"**
raw         = [payload_b64, cosy_key, date, body, path].join("\n")
sig         = md5_hex(raw)
Authorization = "Bearer COSY." + payload_b64 + "." + sig
```

`body` 是**已编码的请求体**（见 §2.3），不是明文 JSON。
`path` 去 `/algo` 前缀：`/algo/api/v2/model/list` → `/api/v2/model/list`。

### 2.3 请求体的自定义 Base64 变体

```
std        = base64( 明文 JSON 的 UTF-8 字节 )
n          = len(std);  a = n // 3
rearranged = std[n-a:] + std[a:n-a] + std[:a]        ← 尾/中/首 三段轮转
编码结果   = rearranged 逐字符按自定义字母表映射，'=' → '$'
```

自定义字母表（64 字符，**逐字照抄**）：

```
_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!
```

标准字母表 `A-Za-z0-9+/` 按位置一对一映射；填充符 `$` 对应 `=`。

### 2.4 设备指纹（按账号 UID 稳定派生，防多号关联）

```
machine_id    = md5("machine:{uid}").hexdigest()          → 32 位 hex
machine_type  = md5("machinetype:{uid}").hexdigest()[:18] → 18 位
machine_token = base64url( sha512("machinetoken:{uid}") ).rstrip("=")[:43]
```

三者都**只依赖 uid**，所以同一账号永远来自同一台"虚拟设备"。

### 2.5 请求头全集（签名头）

```
authorization      = Bearer COSY.<payload>.<sig>
cosy-version       = 1.1.64
cosy-key           = <cosy_key>
cosy-date          = <unix 秒>
cosy-user          = <uid>
cosy-machineid     = <machine_id>
cosy-machinetoken  = <machine_token>
cosy-machinetype   = <machine_type>
cosy-clienttype    = 5          ← 推理/模型列表用 CLI 身份
cosy-data-policy   = AGREE
cosy-clientip      = 169.254.198.161
login-version      = v2
content-type       = application/json
accept             = text/event-stream（推理）/ application/json（模型列表）
accept-encoding    = identity
user-agent         = 见下（hub 用 Go-http-client/2.0，我们照抄或仿官方 qoder/1.0.0）
cache-control      = no-cache（SSE 时）
x-model-key        = <模型目录 key>（推理时）
x-model-source     = system
```

> `/sash/`（余额、活动）走**另一套**头：`Authorization: Bearer <access_token>` +
> `Cosy-ClientType: 10`（桌面身份，缺了活动列表恒空）+ 机器头。

### 2.6 校验过的常量

| 常量 | 值 |
| --- | --- |
| `COSY_VERSION` | `1.1.64`（旧值 `1.1.49` / `0.1.43`，实测 1.1.64 可用） |
| RSA 公钥 | 1024-bit，e=65537，PKCS#1 v1.5，硬编码 PEM（在 hub `qoder_sign.py:462`） |
| `DEFAULT_USER_TYPE` | `personal_professional_trial` |
| 固定 base64 串 | `d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==` = `war, war never changes`（旧签名的 SECRET） |

---

## 3. 与既有 `PROTOCOL.md` 的差异（那份规格需要修订）

| 点 | `PROTOCOL.md`（旧） | 实际（reference 实测） |
| --- | --- | --- |
| 签名 | 「无纯 Python 替代，只能 wasmtime 加载 .wasm + 重写 200 行 glue」 | **已被纯代码复刻**（RSA+AES+MD5），三个独立项目一致，零 WASM |
| COSY 版本 | `1.1.49` | `1.1.64` |
| 请求体 | 未提编码 | 需要**自定义 Base64 变体**编码后才发 |
| 模型列表 | 「端点需 WASM 签名，**不实现**，恒用静态兜底表」 | 可用 COSY 签名调 `GET /algo/api/v2/model/list?Encode=1`（**GET 必须带 body**，否则 403） |
| 旧签名 | 提到 `Appcode`/`Signature`/固定 SECRET | 那是**过时方案**（cubk1 用的那套），现行是 COSY bearer |

> 修订 `PROTOCOL.md` 时应保留旧的 WASM 一节作为「历史路线」，并补上本文件的纯代码路线。

### 3.1 为什么旧签名不能用

`cubk1` 的 `Signature.java`：`md5("cosy" + "&" + base64("war, war never changes") + "&" + RFC1123日期)`
—— 这是本地签名，没有 `cosy-key` / `info` / 账号身份参与，**无法通过服务端对账号的校验**。
它那个仓库更新停在 2026-10-02，而 hub 是 2026-10-08 且明确写「COSY 签名推理链路」，
以 hub 为准。

---

## 4. 端点与双区

| 用途 | 路径 | 主机 |
| --- | --- | --- |
| 授权页 | `GET {authBase}/device/selectAccounts?...` | 国际 `qoder.com` / 国内 `qoder.com.cn` |
| 轮询取 token | `GET {openApiBase}/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256` | 国际 `openapi.qoder.sh` / 国内 `openapi.qoder.com.cn` |
| 续期 | `POST {openApiBase}/api/v1/deviceToken/refresh` body `{refresh_token, machine_id}` | 同上 |
| 用户信息 | `GET {openApiBase}/api/v1/userinfo` | 同上 |
| **推理** | `POST {inferHost}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1` | 国际 `api1/api2/api3.qoder.sh`（候选轮换）/ 国内 `gateway.qoder.com.cn` |
| **模型列表** | `GET {inferHost}/algo/api/v2/model/list?Encode=1` | 同上 |
| 余额 | `GET {openApiBase}/sash/api/v2/me/usage` | 同上 |
| 活动列表 | `GET {openApiBase}/sash/api/v1/me/campaigns` | 同上 |
| 领取 | `POST {openApiBase}/sash/api/v1/me/campaigns/{id}/claim`（body 空串） | 同上 |

**双区差异**（`qoder_accounts.py:3102`）：

- 国际：授权 URL 带 `client_id` + `machine_id`，`nonce` 是 32 位 hex
- 国内：额外带 `redirect_uri`，`nonce` **带横线**（UUID 形态）

**签名只覆盖 path**，所以换推理主机（api1→api2→api3 故障切换）不影响签名有效性 —— 这点很有用。

---

## 5. 请求与响应

### 5.1 推理请求体（明文，之后要 qoder_encode）

字段见 `PROTOCOL.md` §3.1（`chat_context` / `business` / `tools` / `parameters` / `model_config` …），
本文件不重复。两点补充：

- `aliyun_user_type` **要用真实账号的 user_type 填**（不是常量）。
- `business: {type:"agent"}` 必填，缺了会被路由到故障节点。

### 5.2 流式信封（响应侧）

```
data:{"headers":{...},"body":"<内层 OpenAI chunk 的 JSON 字符串>","statusCodeValue":200}
```

- 内层 `body` 未加密，剥一层就是标准 OpenAI SSE
- `statusCodeValue != 200` → 抛上游错误
- `body` 为 `null` / `{}` / 空 → 心跳帧，**跳过**（不能当错误）
- 内层带 `code`/`message`/`error` → 业务错误（`10605` 排队、`110` 额度、`105` 鉴权）

### 5.3 模型目录

三源优先级（hub `qoder_catalog.py`）：

1. **动态** `GET /algo/api/v2/model/list?Encode=1`（COSY 签名，带 `qoder_encode("{}")` 作 body）
2. 本机官方客户端缓存 `~/.qoder*/.models/<uid>/catalog-v6`（QMC = HKDF-SHA256 + AES-256-GCM 解密）
3. 静态快照 `qoder_catalog_intl.json` / `qoder_catalog_cn.json`

动态接口返回 `payload.chat[]`，每条以 `key` 为模型 id（如 `qfmodel`），带
`display_name` / `context_config` / `thinking_config` / 峰谷价 / `is_free` 等。

> 我们的 `catalog.ts` 可以采用 **①动态 + ③静态兜底**（跳过 ②本机缓存解密，那是为「无账号也能列模型」的场景，我们用不上）。

---

## 6. 实现路线（映射到本仓库的 7 文件契约）

零第三方依赖完全可行：`node:crypto` 有 `createHash("md5")`、`createCipheriv("aes-128-cbc")`、
`publicEncrypt`（RSA PKCS1 v1.5），加 `Buffer` 的 base64 即可。

| 渠道文件 | 内容 |
| --- | --- |
| `src/cred.ts` | PKCE(S256) 设备授权登录（双区 URL 差异）+ `deviceToken/poll` 轮询 + `refresh` + `userinfo` 补昵称；凭据字段 `{ access_token, refresh_token, machine_id, uid, nickname, user_type, realm }` |
| `src/upstream.ts` | **COSY 会话**（temp_key/cosy_key/info + `bearer()`）、自定义 base64 编码、`buildChatBody`（构造 §5.1 明文）、`buildHeaders`、SSE 信封解包（增量）、`chatUrl`/`modelsUrl` |
| `src/catalog.ts` | 动态 `/algo/api/v2/model/list`（COSY 签名）+ 静态兜底表（从 hub 的快照提取）；`exposedIds()` 走**共享白名单**（`(deepseek|glm) × flash`） |
| `src/billing.ts` | `usage` 余额 + `campaigns` 活动与领取（`Cosy-ClientType: 10`）；`signin` 映射到活动的 `CLAIM_BENEFIT/CLAIMABLE` |
| `src/channel.ts` / `cli.ts` / `index.ts` | 按既有渠道模板（cid `qoder`、`defaultAddr`、legacyDirs 等） |
| `tests/selftest.test.ts` | 离线：签名向量自测（固定输入 → 固定 md5）、编码往返、信封解包、模型白名单、PKCE URL 构造 |

**必须照抄、不要"顺手加固"的点**（hub 明确写了风险但选择兼容）：

1. `temp_key` 是 16 个 hex 字符（≈64 bit 熵），且同时当 key 与 IV —— 服务端按同一字节串解包，
  改成纯随机 16 字节会**直接失败**，除非端到端验证过。
2. RSA 公钥只用 1024 位（官方如此）—— 我们无法改。
3. 设备指纹必须**按 uid 稳定派生**，随机机器码会触发上游风控。

---

## 7. 实现结果与真机验证（2026-10-09）

按本文路线实现并**用真实账号跑通全链路**（国内版，账号 `cecilia4412`）：

- `cred.ts`：双区 PKCE 设备授权 + 续期 + 设备指纹派生
- `upstream.ts`：COSY 会话与签名、自定义 Base64 编解码、请求体构造、SSE 信封增量翻译器
- `catalog.ts`：上游短 key → 池内名映射（`dfmodel`→`deepseek-v4-flash`、`gfmodel`→`glm-5.3-flash`）+ 动态拉取 + 缓存 + 兜底
- `billing.ts`：余额 + 活动领取（桌面身份头）
- 共享层顺带支持 `buildChatBody` 返回**字符串**（自编码请求体直发）

真机结果：登录  → 动态模型目录  → 非流式对话 `content: "通了"`  →
流式（信封逐帧解包） → 额度 `589/800 credits`  → 签到状态 。

### 7.1 真机踩到、离线测不出的一个坑

**Node 的 `fetch` 不允许 GET 带 body**：

```
Request with GET/HEAD method cannot have body.
```

而 Qoder 的模型目录端点恰恰是「`GET` + body 参与签名」（裸 GET 会 403）。
参考实现是 Python（`urllib`）与 Go（`net/http`），两者都允许 GET 带 body，所以照抄算法
也复现不出这个限制。**解决**：模型目录请求改走 `node:https` 原生模块
（`upstream.ts` 的 `getWithBody`），手动设置 `content-length` 并 `req.write(body)`。

> 推论：以后凡是「签名覆盖 body 的 GET 端点」，在 Node 里都不能用 `fetch`。

## 8. 两渠道拆分（2026-10-09）

**一个渠道兼做国际/国内是错的**：域是渠道身份的一部分。已按 `workbuddy` / `workbuddyai`
的先例拆成两个独立渠道：

| | `channels/qoder/`（国际版） | `channels/qodercn/`（国内版） |
| --- | --- | --- |
| 域名 | `qoder.com` / `openapi.qoder.sh` | `qoder.com.cn` / `openapi.qoder.com.cn` |
| 授权 | GitHub / Google 账号 | 阿里云账号 |
| `CHANNEL_REALM` | 写死 `intl` | 写死 `cn` |
| 端口 | 8801 / 8802 | 8817 / 8818 |
| 凭据 | `<root>/qoder/credentials.json` | `<root>/qodercn/credentials.json` |
| legacyDirs | 保留（它是"原"渠道） | **刻意不声明**（历史目录里的凭据血统不明，声明了会串区） |

`normalizeRealm()` / `productOf()` / `resolveBaseUrl()` **恒定返回本渠道的区域**，
`--realm` 参数被刻意忽略 —— 不再可能"用国内渠道登国际账号"。
两渠道的 `cred` / `upstream` / `catalog` / `billing` 除 `CHANNEL_REALM` 一个常量外完全相同
（重复代码是刻意的，同 workbuddy 的取舍）。

## 9. 签到验证（2026-10-09）

- 两区 `checkin --status` 都正常：`? [qoder] 上游今天没有可领的奖励（当前没有可领取的签到活动）`
- **一键签到**（`model-bridge checkin`，不带 `<cid>`）覆盖全部 11 个渠道，三类状态分得很清楚：
 有端点（`·`）、无端点（`?` + 渠道自己的说明）、查询失败（`?` 如实报未知）
- 直接 dump 上游表明**结论正确**：`{"showCampaign":true,"claimable":false,"campaigns":[{...,"actionType":"VIEW_DETAILS","claimStatus":"CLAIMED"}]}`
 —— 该账号此刻唯一的活动是 Pro 推广（`VIEW_DETAILS`），没有 `CLAIM_BENEFIT` 可领项
- 因此把措辞改准：没有签到活动时 `claimedToday` 返回 `null`（**不适用**）而不是 `false`（未签），
 并补上「上游顶层 `claimable` 是权威判据」的短路，避免 campaigns 结构演进时漏领

## 10. 遗留：国际版推理未通（诊断已定位到「上游不响应」）

**现象**：国际版 `qoder` 的模型目录、额度、签到都成功，唯独推理不通。

**已排除的因素**（都有对照实验）：

| 假设 | 实验 | 结论 |
| --- | --- | --- |
| 签名错 | 同一套签名 GET 模型目录 → 成功 |  签名没问题 |
| 主机错 | 逐台 `api1/api2/api3.qoder.sh` 试推理 POST |  三台全部 45s 超时（都是无响应，不是拒绝） |
| 网络/连通性 | 无签名 GET/POST 同一路径 → `403`/`400` **秒回**（0.5~0.8s） |  主机连得通、不挑方法 |
| 编码错 | 国内版 `qodercn` 用**逐字节相同**的实现推理成功 |  编码与请求体构造正确 |

**剩下的解释**：上游**接受了请求但不返回响应** —— `agent_chat_generation` 是 SSE 长连接，
服务端可能正在**排队**（参考实现为此实现了专门的排队重试：内层 `code="10605"`、
`retryAfterSeconds` 指数退避、最多 180 次 / 总时长 30 分钟）。本渠道**没有实现排队重试**，
共享层的读超时是 120 秒，超时后按上游失败处理。

**要做的事**（明确的工作项，不在本轮范围）：实现 `10605` 排队处理 ——
在翻译器里识别内层排队帧、按 `retryAfterSeconds`（封顶 10s）退避重发、设总时长上限。
参考 `qoder2api-hub/qoder_proxy.py` 的 `model-queue.ts` 对应逻辑。

**同时**：国际版推理若在**无排队的模型**（如非免费的 `dmodel`）上也超时，则需要另行排查
（那时要考虑 `aliyun_user_type` 是否该取真实身份类型，而不是默认的 `personal_professional_trial`）。
