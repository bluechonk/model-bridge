---
description: Cline 渠道：登录 / 状态 / 模型 / 额度 / 账号 / 落点
skills: model-bridge-gateway
---

跑 `model-bridge cline <动词>`。**没有签到端点**（对 sidecar 全串扫描无 `checkin/daily/campaign`
命中），每日免费额度由服务端自动发放。

- **登录**：`model-bridge cline login`。WorkOS **设备码**授权 → 浏览器开 `verification_uri_complete`
  → 轮询 authenticate → 用 WorkOS 令牌换 Cline 令牌。
- **模型**：池内贡献 `deepseek-v4.1-flash` 与 `glm-5.3-flash`（远端目录里命中白名单的是
  `deepseek/deepseek-v4.1-flash` 这类 flash 条目）；`cline-free/*`（mimo）与 `z-ai/glm-4.7`
  被池策略挡在池外，4.0 的 `deepseek-v4-flash` 也已随收窄出池。渠道**有别名层**
  （`models.json` 的 `alias`/`short`/`exposed_id`），未命中时原样返回。
- **约束**：① 令牌**必须保留 `workos:` 前缀** —— 剥掉回 401，且文案会误导成「客户端版本过旧」；
  ② 余额端点的 `userId` 要用凭据里的 `account_id`（`usr-…`），**不是** JWT 的 `sub`（`user_…`）。
- **排障**：看到 401 + “latest version” 提示，先查 `workos:` 前缀。
- 端口：`127.0.0.1:8811`（控制台 8812）。
