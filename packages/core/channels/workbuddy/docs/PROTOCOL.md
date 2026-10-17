# workbuddy 协议规格（国内版 CodeBuddy）

> 结论来源：`reference/HanawaBanana_workbuddy2api`（Go）与
> `reference/ardeyouxipianyi_workbuddy2api-hub`（与 `workbuddyai` 共用一套抓包结论，
> 见 [`workbuddyai/docs/PROTOCOL.md`](../../workbuddyai/docs/PROTOCOL.md)）。
> 国内版桌面端**无独立抓包**：版本号与 UA 维持参考实现原值（5.5.6 / CLI 2.137.1），不凭猜测改。

## 1. realm 与端点

| 项 | 值 |
| --- | --- |
| chat 上游 | `https://copilot.tencent.com` |
| X-Domain | `copilot.tencent.com` |
| User-Agent | `WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1` |
| X-IDE-Version | `5.5.6` |

身分头族、会话头族、链路族与设备指纹口径同 `workbuddyai`（见其 PROTOCOL.md §2-§3），
仅端点 / 域 / 版本三元组按上表替换。

## 2. 参考实现补充的两个行为细节（HanawaBanana，Go）

- **用量归属头**（`internal/upstream/headers.go` injectAttribution）：默认伪造官方桌面端指纹
 `X-Agent-Purpose=conversation` + `X-IDE-Name/Type/Product="WorkBuddy"` + `X-IDE-Version`，
 与抓包结论一致；`X-Conversation-ID` **恒发**（上游渠道校验要求，缺头判非官方拒收）。
- **11128 的内容侧缓解**（`internal/prompt/prompt.go`）：上游内容审核按逐字精确匹配误杀
 system 里的指纹样板文本 → 改写为最小中性表述后重试一次；与头族修复互补，不可互替。

## 3. 错误码

`11128`（request illegal / 非官方特征）与 `11140`（账号被限制）语义与
`workbuddyai` 相同，见其 PROTOCOL.md §4。
