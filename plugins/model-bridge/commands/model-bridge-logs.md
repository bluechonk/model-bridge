---
description: 查看网关日志尾部（排障第一步；看单渠道日志时先让用户选渠道）
skills: model-bridge-gateway
---

跑 `mb logs`（`--lines N`）；`-f` / `--follow` 持续输出新日志（等价 `tail -f`，Ctrl+C 退出，
`--lines 0 -f` = 只看新产生的内容）。仓库级日志在 `~/.model-bridge/gateway.log`；
单渠道在 `~/.model-bridge/<cid>/gateway.log`（`mb <cid> logs`）。

**交互约定**：默认看**仓库级**（全部渠道混在一份）——排障先看它，不用问用户；
只有用户明确说「看某渠道的日志」而没说哪个时，才用 `ask_user_query` 让用户从
`mb channels` 的清单里选。

日志可能含上游原始错误体（只落本地），按需脱敏后再展示。
