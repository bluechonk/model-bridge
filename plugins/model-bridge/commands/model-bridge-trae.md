---
description: TRAE（字节）渠道：登录 / 签到 / 模型 / 额度 / 账号 / 落点
skills: model-bridge-gateway
---

跑 `model-bridge trae <动词>`。**有真实签到端点**（`trae checkin` 会真领）。

- **登录**：`model-bridge trae login`。浏览器授权页 + **本地回调端口 18080**（被占用则回退随机端口，
  URL 用实际端口重算）；回调**直接回传 token**（不是 OAuth 的 `?code=`）。仅 CN 域。
- **签到**：`/trae/api/v2/ug/checkin_credits/status` 查、`.../claim` 领（claim 响应不含积分，
  须补查 status）；`9074` 是设备级限流（会轮换签到设备代次）。
- **模型**：兜底暴露 `DeepSeek-V4-Flash-Official` / `DeepSeek-V4-Flash` 等（非 flash 被挡）；
  目录有**通道白名单**（15 个通道，顺序即优先级，白名单外整组丢弃）。
- **约束**：① 登录页参数名必须是 `auth_callback_url`（写错永远停在授权中）；
  ② `machine_id` / `device_id` 都是 32 位 hex，且 **`device_id` 每账号不同**（共用会被
  「该设备已签到」拦）；③ `ideVersion` 是模型准入条件（版本低时新模型报 4001）。
- **排障**：报 4001 → 查通道白名单 / 自定义模型 / 版本。
- 端口：`127.0.0.1:8805`（控制台 8806）。
