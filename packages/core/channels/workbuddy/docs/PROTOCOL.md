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

## 3. 每日签到（`[参考]`，CN 与 global 同形）

> 来源：`reference/HanawaBanana_workbuddy2api` 的 `internal/upstream/checkin_activity.go`
> 与 `client.go`（实测 2026-09-28）。早期「国内版没有签到端点」的结论有误，已修正。

| 端点（billing/meter 域，billingBase + path） | 方法 | 说明 |
| --- | --- | --- |
| `/v2/billing/meter/daily-checkin` | POST（body `{}`） | 每日签到；已签时业务码非 0（幂等，按成功回报） |
| `/v2/billing/meter/checkin-activity-status` | POST（body `{}`） | 签到活动状态（只读）：`today_checked_in` / `streak_days` / `end_time` 等 |

- CN 走 `/v2` 前缀；global 首选无 `/v2`、404 再回落（`/billing/meter/*`）—— 本渠道是
  国内版，恒用 `/v2`。
- 活动起止时间非 RFC3339（形如 `2026-09-29 23:59:59`，按 CST 解释）。
- `GET` 同路径返回 404（上游只挂 POST），不要改方法。

## 4. 错误码

`11128`（request illegal / 非官方特征）与 `11140`（账号被限制）语义与
`workbuddyai` 相同，见其 PROTOCOL.md §4。
