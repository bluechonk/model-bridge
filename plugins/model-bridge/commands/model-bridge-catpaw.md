---
description: CatPaw（美团妙手）渠道：登录 / 状态 / 模型 / 额度 / 账号 / 落点
skills: model-bridge-gateway
---

跑 `model-bridge catpaw <动词>`（`--json` 亦然）。这个渠道**没有签到端点**。

- **登录**：`model-bridge catpaw login`。真实 URL 链路 —— `login-config` → 拼 `auth_url`
  （`sid` / `state` / `redirect` 三参必填）→ 浏览器点一下 → `poll-token?sid=` 每 1s 轮询
  （≤10 分钟）→ 另取 `current-user` 拿 uid。**无本地回调服务器**，也不读桌面端任何本地文件。
- **模型**：池内只贡献 `glm-5.3-flash`（上游 id 即对外 id，无短名映射）；
  兜底目录里的 `deepseek-v4-flash`（4.0）已随收窄出池，不再对外。
- **约束**：① 上游对 `systemPromptOverride` 有 **65508 字符硬上限**，超限回 400 `prompt_too_large`
  （不静默截断）；② token 是不透明 SSO token，放在 `Cookie: X-Passport-Token`；
  ③ uid 必须单独取 —— 账号池靠它认同一账号，而 token 每次都变。
- **排障**：账号池重复记条 = uid 没取到；轮询 10 分钟超时 = 浏览器没完成授权，重跑 login。
- 端口：`127.0.0.1:8790`（控制台 8791），仅在单渠道独立运行时生效。
