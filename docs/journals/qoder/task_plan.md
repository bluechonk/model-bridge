# 任务计划：实现 Qoder 渠道

## 目标

把 `channels/qoder/` 从桩（四个模块全 `todo()`）实现成一个可用渠道：
支持双区（国际 `qoder.com` / 国内 `qoder.com.cn`）OAuth 设备授权登录、COSY 签名推理、
动态模型目录、额度查询与每日签到领取 —— 零第三方运行依赖，遵守工作区 7 文件契约。

## 依据

[`findings.md`](./findings.md)：五个参考反代项目的分析结论。核心是 **COSY 签名可用纯代码复刻**
（RSA-PKCS1v15 包会话密钥 + AES-128-CBC 加密身份体 + MD5 签名 + 自定义 Base64 请求体编码），
`node:crypto` 全都有，不需要 WASM。

## 下一步

实现 `src/upstream.ts` 的 COSY 签名会话与请求体编码，并用固定向量写离线单测。

> ⚠ 渠道包 `src/` **只能有 7 个文件**（契约），所以签名/编码/指纹不单独建模块：
> 设备指纹派生放 `cred.ts`（身份相关），COSY 签名 + 自定义 Base64 + 信封放 `upstream.ts`，
> 两者同包内互相 import。

## 状态：代码实现全部完成（2026-10-09）；**真机验证待用户提供账号**

## 各阶段

### 阶段 1：调研与分析 — **状态：complete**

- [x] clone 五个参考项目到 `channels/qoder/reference/`（已 gitignore）
- [x] 分析签名路线（纯代码复刻 vs WASM vs 旧签名）
- [x] 分析设备指纹 / 双区端点 / 请求体编码 / 流式信封 / 模型目录三源
- [x] 产出 `findings.md`（含许可证与「照抄不改」清单）

### 阶段 2：签名与编码核心 — **状态：complete**

- [x] COSY 会话：`temp_key` → `cosy_key`(RSA) → `info`(AES) → `bearer()`(MD5)
- [x] 自定义 Base64 变体编解码（三段轮转 + 字母表映射）
- [x] 设备指纹稳定派生（md5/sha512 按 uid）
- [x] 固定向量离线单测（`{}`→`$kwm`、指纹向量、签名 path 去 `/algo`）

### 阶段 3：`cred.ts` — **状态：complete**

- [x] PKCE(S256) 设备授权：双区 URL 参数差异 + `deviceToken/poll`（404 = 未授权，继续轮询）
- [x] `userinfo` 补昵称；`refresh` 续期（保留 `machine_id`/`uid`/`nickname`）
- [x] 凭据字段与 `CredModule` 契约对齐（`accessToken` / `uid` / `domain`）
- [x] 「最近身份」记录（供 upstream 填 `session_type` / `aliyun_user_type`）

### 阶段 4：`upstream.ts` — **状态：complete**

- [x] `buildChatBody`：明文请求体 → 自定义 Base64 编码 → **返回字符串**直发
- [x] `buildHeaders`：COSY 头全集 + `x-model-key`（pending 槽传递，同 codearts 解法）
- [x] 自定义 SSE 增量翻译器：剥信封 → 标准 chunk；心跳跳过、业务错误码保真
- [x] 推理主机候选（api1/api2/api3；签名只覆盖 path）

### 阶段 5：`catalog.ts` + `billing.ts` — **状态：complete**

- [x] 动态 `GET /algo/api/v2/model/list?Encode=1`（带 `qoder_encode("{}")` body）+ 缓存 + 兜底表
- [x] 上游短 key → 池内名映射（`dfmodel`→`deepseek-v4-flash`、`gfmodel`→`glm-5.3-flash`）
- [x] 余额 `/sash/api/v2/me/usage`（userQuota + addOnQuota + 专用包合并；企业模式不给数字时报"查不到"）
- [x] 活动 `/sash/api/v1/me/campaigns` + 领取（桌面身份 `Cosy-ClientType: 10`；10:00 UTC+8 刷新的"今天"判定）

### 阶段 6：装配与测试 — **状态：complete**

- [x] 共享层小改：`buildChatBody` 允许返回**字符串**（自编码请求体）
- [x] `tests/selftest.test.ts`：38 项全离线测试（签名向量 / 信封 / 目录 / 请求体 / PKCE / 装配）
- [x] `npm test` 全绿（全仓 12 个包 + verify:storage + verify:docs）

### 阶段 7：**真机验证 — 状态：complete（2026-10-09）**

用一个真实账号（国内版 `cecilia4412`）跑通了全链路：

- [x] `qoder login --realm cn` → 浏览器授权 → 拿到 token 并入池（`状态：已登录 Qoder 国内版（cecilia4412）`）
- [x] `qoder models --refresh` → **COSY 签名被上游接受**，动态目录拉取成功并落盘
- [x] 非流式对话（`deepseek-v4-flash`）→ `content: "通了"`，reasoning 正常
- [x] 流式对话（`glm-5.3-flash`）→ 信封逐帧解包成标准 OpenAI SSE，reasoning 逐 token 流出
- [x] `qoder billing` → 剩余 589/800 credits（已用 211，加油包合并正确）
- [x] `qoder checkin --status` → 「今天未签到（依据：上游）」
- [x] 仓库级网关重启后，账本里 qoder `used=211 credits` / `ok=3`，成为
      `deepseek-v4-flash` 与 `glm-5.3-flash` 的**首选**渠道

**真机踩到的坑（离线测不出来，已修）**：Node 的 `fetch` 禁止 GET 带 body
（`Request with GET/HEAD method cannot have body`），而 Qoder 的模型目录端点正是
「GET + body 参与签名」。参考实现是 Python/Go，都没这个限制。解决：模型目录改走
`node:https` 原生请求（`upstream.ts` 的 `getWithBody`）。

## 关键决策

| 决策 | 结论 | 原因 |
| --- | --- | --- |
| 签名路线 | 纯 TS 复刻（`node:crypto`） | 三个独立项目已验证；符合零依赖契约；不必背 WASM |
| COSY 版本 | `1.1.64` | hub 实测可用；`PROTOCOL.md` 的 1.1.49 偏旧 |
| `temp_key` 熵 | **照抄** 16 hex（不加固） | 服务端按同字节串解包，改了直接失败 |
| 设备指纹 | 按 uid 稳定派生 | 随机机器码会触发上游风控 |
| 模型目录 | 动态 + 静态兜底（跳过本机缓存解密） | 本机缓存是为「无账号也列模型」设计，我们用不上 |
| 双区 | 同仓库同一渠道，按 realm 分支 | 与 hub 一致；端点差异收敛在产品配置 |

## 遇到的错误

| 错误 | 尝试次数 | 解决方案 |
| --- | --- | --- |
| （待填） | | |
