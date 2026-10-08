---
description: 登录某个渠道（浏览器授权，无窗口）
skills: model-bridge-gateway
---

登录某个渠道：`model-bridge login --channel <cid>`（可选 `--json`）。

- 把输出里的授权链接（`--json` 时在 `auth_url`）**原样展示给用户**，请其在浏览器授权；不要并发重复跑。
- 命令会阻塞轮询到授权完成或超时。workbuddyai 渠道有国际版/国内版两个域：`--realm intl|cn`；
  已有凭证不确定就保持默认 `auto`。**账号在哪个域就必须在哪个域授权**。
- 强制重登加 `--force`。登录是唯一需要用户动手的步骤。
