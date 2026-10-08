---
description: 列出渠道（模型池）与各自可用模型
skills: model-bridge-gateway
---

跑 `model-bridge channels`（`--json` 亦然）并展示：每个渠道的 cid、展示名、池内模型。

这是**用户配 provider 时该填的模型清单**（多渠道路由下 = `<cid>/<模型>`，全小写）。
某渠道没有可用模型通常是未登录或上游目录拉取失败，不是插件坏了（池子是 flash 白名单，网关级策略）。
