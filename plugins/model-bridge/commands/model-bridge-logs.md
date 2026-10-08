---
description: 查看网关日志尾部（排障第一步）
skills: model-bridge-gateway
---

跑 `model-bridge logs`（`--lines N`）。仓库级日志在 `~/.model-bridge/gateway.log`；
单渠道在 `~/.model-bridge/<cid>/gateway.log`。日志可能含上游原始错误体（只落本地），按需脱敏后再展示。
