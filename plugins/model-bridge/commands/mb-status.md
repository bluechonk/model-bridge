---
description: 查看模型池网关状态与日志（诊断第一步：status → logs）
skills: model-bridge-gateway
---

# 状态与日志（诊断第一步）

1. `mb status --json` 并解读：网关是否可达、各渠道是否已登录、守护 PID、凭证、auto_start、
   `stale_build`（在跑旧代码时会明说）。
2. 需要看原因时 `mb logs`（`--lines N`；`-f` 持续跟随，`--lines 0 -f` 只看新增）。
   仓库级日志在 `~/.model-bridge/gateway.log`；单渠道在 `~/.model-bridge/<cid>/gateway.log`
   （`mb <cid> logs`）。日志可能含上游原始错误体（只落本地），按需脱敏后再展示。

**交互约定**：默认看**仓库级**（全部渠道混在一份）——排障先看它，不用问用户；
只有用户明确说「看某渠道的日志/状态」而没说哪个时，才用 `ask_user_query` 让用户从
`mb model list` 的清单里选。异常按 model-bridge-gateway 技能排障。
