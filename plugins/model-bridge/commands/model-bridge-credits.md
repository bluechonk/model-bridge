---
description: 查询账号剩余额度（只读）
skills: model-bridge-gateway
---

跑 `model-bridge credits`。直接查上游 billing，**不经本地网关、不消耗额度**。
仓库级逐渠道查询；某渠道没有额度端点或未登录只影响它自己。只关心一个渠道时加 `--channel <cid>`。
