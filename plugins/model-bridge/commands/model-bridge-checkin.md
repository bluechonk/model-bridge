---
description: 签到 / 领活动奖励（全渠道；写操作前先 --status 只读确认，并让用户选渠道）
skills: model-bridge-gateway
---

# 签到 / 领奖励（跨渠道）

签到这个动作各渠道叫法不同（签到 / signin / 活动领取 / 上游自动发），CLI 统一成 `checkin`。

## 只读：今天签没签

```bash
mb checkin --status            # 全部渠道，末尾给「今日已签 N/M」摘要
mb <cid> checkin --status      # 单个渠道
```

判定顺序是 **① 上游说的 → ② 本地台账 → ③ 明确说不知道**（不猜）。上游说已签而本地没记录时
会**自动回填**本地台账（`~/.model-bridge/<cid>/state/signin.json`），所以"你在客户端签的"也能覆盖；
离线/未登录时本地台账仍能回答"我们这边今天领过没有"。

## 写操作：执行领取（会真的领掉）

```bash
mb checkin                     # 全部渠道（没端点的渠道输出它自己的一句说明）
mb <cid> checkin               # 单个渠道
mb checkin --daily-only        # 只处理「每日」语义的渠道
mb checkin --fail-if-unclaimed # 今天**明确**没签就非零退出（挂定时任务用）
```

**交互约定**：`checkin`（不带 `--status`）是**写操作** —— 默认先跑 `mb checkin --status`
把「今天谁还没签」列给用户，再用 `ask_user_query` 确认「全部领取 / 只管某几个渠道」，
然后才执行；用户没指明渠道时不要擅自全领。

## 各渠道现状（向用户解释时照此说）

- **有真实端点**：`codearts` / `lobsterai` / `loomy` / `qoder` / `qodercn` / `raccoon` / `trae`
- **没有端点**（额度由服务端按天/按订阅自动发，返回文本说明，**不是故障、退出码仍为 0**）：
  `catpaw` / `cline` / `workbuddy` / `workbuddyai`
- `raccoon`：签到 = 触发 `setting_info`（按天幂等）+ 账单核对今日入账；**「今天」按北京时间**。
- `qoder` / `qodercn`：活动（campaign）平台「每日领取 100 Credits」，**10:00 UTC+8 刷新**。
- `trae`：`9074` 是设备级限流（会轮换签到设备代次）。
- 只有查询/领取**抛错**（未登录、上游拒绝）才非零退出；「没有端点」不算失败。
- 领取失败大多是**未登录**（`NotLoggedInError`）—— 先登录再试。
