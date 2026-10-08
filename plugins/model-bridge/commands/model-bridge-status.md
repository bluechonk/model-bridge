---
description: 查看模型池网关状态（健康、逐渠道登录、守护 PID）
skills: model-bridge-gateway
---

跑 `model-bridge status --json` 并解读：网关是否可达、各渠道是否已登录、守护 PID、凭证、auto_start。
异常按 model-bridge-gateway 技能排障。只关心一个渠道时加 `--channel <cid>`。
