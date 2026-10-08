---
description: 登录某个渠道（浏览器授权，无窗口）
skills: model-bridge-gateway
---

登录某个渠道：`model-bridge login --channel <cid>`（可选 `--json`）。

- 把输出里的授权链接（`--json` 时在 `auth_url`）**原样展示给用户**，请其在浏览器授权；不要并发重复跑。
- 命令会阻塞轮询到授权完成或超时。**国内版与国际版是两条渠道**：账号在 `codebuddy.ai` 用
  `workbuddy`，在 `workbuddy.ai` 用 `workbuddyai` —— 选错渠道会一直等授权超时。
  （`--realm` 仅为兼容保留，两条渠道都忽略它。）
- 强制重登加 `--force`。登录是唯一需要用户动手的步骤。
