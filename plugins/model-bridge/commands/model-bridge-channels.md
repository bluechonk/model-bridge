---
description: 列出渠道与各自贡献的池内模型；可强制刷新上游目录
skills: model-bridge-gateway
---

跑 `model-bridge channels`（`--json` 亦然）并展示：每个渠道的 cid、展示名、贡献的池内模型。

⚠ **对外可用的模型 id 只有两个**（不带渠道前缀）：`deepseek-v4.1-flash`、
`glm-5.3-flash` —— 配 provider 时填的就是这两个，与「哪个渠道提供它」
无关（网关按账单已用量自己挑渠道）。想看「两个模型分别会落到谁」用
`model-bridge model list`（池视图）。

某渠道没有贡献任何池内模型通常是未登录、上游目录拉取失败，或它根本没有这两族产品
（池策略是 **`(deepseek | glm)` 家族的 flash 模型**，网关级白名单）—— 后者是策略有意为之。

**数据来源**：默认读本地记录（`<root>/<cid>/cache/models.json`）—— 第一次会拉一次上游
并把结果记下来，之后一直用这个文件，所以离线/未登录也能列出真实目录。
用户说「模型不全 / 上游加了新模型」时，加 `--refresh` 强制重拉：

```
model-bridge model refresh             # 刷新全部渠道的模型目录
model-bridge model refresh trae        # 只刷 trae
model-bridge trae models --refresh     # 同上（按渠道的写法）
```

> 注意区分两件事：`model refresh` 刷的是**上游目录**；`model usage --refresh` 刷的是
> **账单额度**（模型池的排序依据）。

`--refresh` 失败会**非零退出并报原因**（不会拿旧表冒充刷新成功）；不加 `--refresh` 的
自动路径失败时静默回落内置表，只在 stderr 说明一句。
