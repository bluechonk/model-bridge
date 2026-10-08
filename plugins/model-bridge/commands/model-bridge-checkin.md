---
description: 签到 / 领活动奖励（某个渠道，或所有支持的渠道）
skills: model-bridge-gateway
---

签到这个动作各渠道叫法不同（签到 / signin / 活动领取 / 上游自动发），CLI 统一成 `checkin`。

**先查状态（只读，不领）：**

```bash
model-bridge <cid> checkin --status      # 只看某个渠道
model-bridge checkin --status            # 所有支持签到的渠道
```

**执行领取（写操作，会真的领掉）：**

```bash
model-bridge <cid> checkin               # 某个渠道
model-bridge checkin                     # 所有支持签到的渠道
```

要点（向用户解释时照此说）：

- **`--status` 只读**：查得上就报状态，查不到就说"没有独立状态端点"，不会动额度。
- **不带 `<cid>` 时只处理声明了签到能力的渠道**（当前：codearts / lobsterai / loomy / minimax /
  raccoon / trae），没端点的渠道**不会**出现在输出里 —— 免得刷一堆"没端点"的噪音。
- **确实没有签到端点的渠道**（workbuddyai / catpaw / cline / gemini / qoder）单查时会明确说
  「该渠道没有签到端点」，退出码非零。**不要**把它当成故障 —— 有的是上游自动发（如 raccoon 的
  `daily_grant`、cline 的每日免费额度），压根没有可点的"签到"。
- `raccoon` 的那笔是**一次性登录奖励**，不是每日签到，输出里会点明。
- 领取失败大多是**未登录**（`NotLoggedInError`）—— 先 `<cid> login` 再试。
