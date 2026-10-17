# workbuddyai 协议规格（国际版 WorkBuddy 桌面端）

> 结论来源：`reference/ardeyouxipianyi_workbuddy2api-hub`（1576★）。
> 其中 `wb_identity.py` / `wb_fingerprint.py` 标注为 **2026-10-16 mitmproxy 对官方 5.8.4
> 桌面客户端的实测抓包**；标注「无抓包」的取值维持参考实现原值，不凭猜测改。

## 1. realm 与端点（身分换了，端点也要换）

| realm | chat 上游 | X-Domain |
| --- | --- | --- |
| intl（桌面端） | `https://www.workbuddy.ai` | `www.workbuddy.ai` |
| cn（桌面端） | `https://copilot.tencent.com` | `copilot.tencent.com` |

- `www.codebuddy.ai` 在实测网络里 **DNS 沉洞**（getaddrinfo 返回 0.0.0.1），
 国际版请求不得指向它 —— 凭据 `domain` 与落盘 `baseUrl` 必须同源推导。
- chat 路径为 `/v2/chat/completions`（`/plugin` 前缀实测 404）。

## 2. 官方身分头族（对话请求，缺任一可能触发渠道校验）

| 头 | 值 |
| --- | --- |
| X-Agent-Intent / X-Agent-Purpose / X-Agent-Type | `craft` / `conversation` / `main` |
| X-IDE-Name / X-IDE-Type | `WorkBuddy` / `WorkBuddy` |
| X-IDE-Version | intl `5.8.4`；cn `5.5.6`（无抓包） |
| X-Product / X-Private-Data | `SaaS` / `true` |
| User-Agent | intl `WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0`；cn `WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1`（次段**小写** `workbuddy-ai`：对话由客户端内置 CLI 子进程发出，别照抄 Electron 主进程的 UA） |
| X-User-Id / Authorization | 账号 uid / `Bearer <token>` |
| X-Conversation-ID | 带连字符 UUID；上游不按它存历史，每轮新生成即可 |
| X-Conversation-Request-ID = X-Root-Request-ID | **同一值**：一轮 user send 开始时生成、本轮所有请求复用（后台按它聚合） |
| X-Conversation-Message-ID = X-Request-ID | 32 位无连字符 hex（UUIDv7） |
| 链路族 | `traceparent: 00-<32hex>-<16hex>-01`、`b3: <trace>-<span>-1`、`X-B3-TraceId` / `X-B3-SpanId` / `X-B3-Sampled: 1`（`X-B3-ParentSpanId` 需要真实父子关系，不伪造） |

## 3. 设备指纹（防关联口径）

- 官方客户端「一进程一设备」；网关一进程服务多账号，**machineId / sessionId 必须按
 账号 uid 加盐派生**（幂等、账号间互不相同），照进程维度取值会把账号池串成同源设备。
- 形态按 5.8.4：machineId / sessionId 为带连字符 UUID；请求 id 为 32 位无连字符 hex。

## 4. 错误码 `11128` 的两个独立来源

1. **缺身分头族**（本文件 §2）—— 上游按整组头判定「是否官方客户端」，缺员回
 `400 code=11128 request illegal`；反复触发后可升级 `11140`（账号被限制，需换号）。
2. **请求体指纹串误杀** —— 内容审核对样板文本逐字精确匹配；需把命中文本改写为等价表述
 （实现见 `src/upstream.ts` 的 `rewriteFingerprint`）。

## 5. 测试对照

`tests/selftest.test.ts` 离线锁定：头族存在性、ID 形态、realm 端点推导、
指纹改写行为；不发真实上游请求。
