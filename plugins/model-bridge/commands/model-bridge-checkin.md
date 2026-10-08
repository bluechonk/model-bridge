---
description: 签到 / 领活动奖励（某个渠道，或所有支持的渠道）
skills: model-bridge-gateway
---

签到这个动作各渠道叫法不同（签到 / signin / 活动领取 / 上游自动发），CLI 统一成 `checkin`。

**回答「今天签没签」**（只读）：

```bash
model-bridge <cid> checkin --status    # 单个渠道
model-bridge checkin --status          # 全部渠道，末尾给「今日已签 N/M」摘要
```

判定顺序是 **① 上游说的 → ② 本地台账 → ③ 明确说不知道**（不猜）。上游说已签而本地没记录时会
**自动回填**本地台账（`<root>/<cid>/state/signin.json`），所以"你在客户端签的"这种情况也能覆盖到；
反过来离线/未登录时，本地台账仍能回答"我们这边今天领过没有"。

**先查状态（只读，不领）：**

```bash
model-bridge <cid> checkin --status      # 只看某个渠道
model-bridge checkin --status            # 所有支持签到的渠道
```

**执行领取（写操作，会真的领掉）：**

```bash
model-bridge <cid> checkin               # 某个渠道
model-bridge checkin                     # 全部渠道（没端点的会输出它自己的说明）
model-bridge checkin --daily-only        # 只处理"每日"语义的渠道（跳过 raccoon 那种一次性奖励）
model-bridge checkin --fail-if-unclaimed # 今天**明确**没签就非零退出（挂定时任务用）
```

要点（向用户解释时照此说）：

- **`--status` 只读**：查得上就报状态，查不到就说"没有独立状态端点"，不会动额度。
- **所有渠道口径统一**：不带 `<cid>` 时会把**每个**渠道都过一遍。有端点的报状态/领取结果，
  没端点的渠道返回**它自己的一句说明**（如「Cline 没有签到端点 —— 每日免费额度由服务端自动发放」）。
- **「没有端点」不是故障、退出码仍为 0**：有的是上游自动发（raccoon 的 `daily_grant`、cline 的每日
  免费额度），压根没有可点的"签到"。只有当查询/领取**抛错**（未登录、上游拒绝）时才非零退出。
- 目前有真实端点的是 **codearts / lobsterai / loomy / minimax / raccoon / trae**；
  workbuddyai / catpaw / cline / gemini 没有端点（返回文本说明），qoder 是**桩**（会报"尚未实现"）。
- `raccoon` 的那笔是**一次性登录奖励**，不是每日签到，输出里会点明。
- 领取失败大多是**未登录**（`NotLoggedInError`）—— 先 `<cid> login` 再试。
