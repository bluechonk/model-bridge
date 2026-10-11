---
description: 账号池：一个渠道下多个账号的查看、切换、新增、删除
skills: model-bridge-gateway
---

账号池按渠道分文件保存，用 `mb accounts` 管理。

- `mb accounts`（可加 `--channel <cid>` / `--json`）—— 列出各渠道池子：key、备注、健康度、uid、到期
- `mb accounts add --channel <cid>` —— **走该渠道的登录流程**（浏览器授权），成功后自动入池并设为生效
- `mb accounts use <key> --channel <cid>` —— 切换生效账号（把池内那份复制回 `credentials.json`）
- `mb accounts remove <key> [--channel <cid>]` —— 从池子删除；**删的是生效账号时会同时登出**

**交互约定**：`add` / `use` / `remove` 都必须指定渠道与账号 —— 用户没给全时，先 `mb accounts`
看有哪些渠道与账号，再用 `ask_user_query` 让用户选（`remove` 是破坏性操作，执行前必须确认）。

要点（向用户解释时照此说）：

- 文件结构：`~/.model-bridge/<cid>/{credentials.json, accounts.json, accounts/<key>.json}`；
  `credentials.json` 始终是「当前生效账号」的副本，渠道的读写语义不变。
- `key` = `sha256(domain + uid)` 前 16 位，稳定（重登不变）；点开 `accounts.json` 可以看到元信息。
- 登录即入池：已经登录过的渠道第一次 `accounts` 就会看到它（会把现有凭证收进池子）。
- 池子只记「登录过的账号」，不含密码；切账号 = 换 `credentials.json`，不涉及再授权。
- 当前**一个渠道同一时间只用一个账号**（没有轮询/失败转移——那是后续策略层）。
- 健康度 `unauthorized` 表示网关最近一次刷新该账号 token 失败，需要重新登录。
