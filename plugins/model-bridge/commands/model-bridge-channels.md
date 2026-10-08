---
description: 列出渠道（模型池）与各自可用模型；可强制刷新上游目录
skills: model-bridge-gateway
---

跑 `model-bridge channels`（`--json` 亦然）并展示：每个渠道的 cid、展示名、池内模型。

这是**用户配 provider 时该填的模型清单**（多渠道路由下 = `<cid>/<模型>`，全小写）。
某渠道没有可用模型通常是未登录或上游目录拉取失败，不是插件坏了（池子是 flash 白名单，网关级策略）。

**数据来源**：默认读本地记录（`<root>/<cid>/cache/models.json`）—— 第一次会拉一次上游
并把结果记下来，之后一直用这个文件，所以离线/未登录也能列出真实目录。
用户说「模型不全 / 上游加了新模型」时，加 `--refresh` 强制重拉：

```
model-bridge model list --refresh      # 刷新全部渠道
model-bridge trae models --refresh     # 只刷 trae
model-bridge model refresh [cid]       # 同上（子命令写法）
```

`--refresh` 失败会**非零退出并报原因**（不会拿旧表冒充刷新成功）；不加 `--refresh` 的
自动路径失败时静默回落内置表，只在 stderr 说明一句。
