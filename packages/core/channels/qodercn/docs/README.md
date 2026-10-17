# @modelmux/qodercn

Qoder **国内版**（`qoder.com.cn`）的本地网关 —— 本工作区的一个**渠道（= 模型池）**。

> 与国际版 `qoder`（`qoder.com`）是**两个独立渠道**：账号在哪个域就用哪个渠道登录。
> 两个渠道不能互相代登（会串区），也不共用凭据文件。

## 文档

| 内容 | 位置 |
| --- | --- |
| 渠道说明（用法 / 存储 / 测试） | [`qoder/docs/README.md`](../../qoder/docs/README.md)（两区共用一份） |
| 协议规格（实现依据，含签名算法修订记录） | [`qoder/docs/PROTOCOL.md`](../../qoder/docs/PROTOCOL.md) |

> 契约与规范：[`docs/CONTRACT-TS.md`](../../../docs/CONTRACT-TS.md) ·
> 文档总索引：[`docs/README.md`](../../../docs/README.md)

## 参考实现（reference/）

clone 到 `reference/` 的学习材料（不入库）；协议结论与 [`qoder/docs/PROTOCOL.md`](../../qoder/docs/PROTOCOL.md) 共用。

| 仓库 | 用途 |
| --- | --- |
| [shuishuipingan/qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub) | 主参照（191★）：**国际国内双区**多账号网关中枢 —— COSY 签名、设备指纹防风控、OAuth 设备授权，国内版（qoder.com.cn）行为包含其中 |
| [Zhengyuuuui/qoder2api](https://github.com/Zhengyuuuui/qoder2api) | OpenAI / Claude / Codex 三格式兼容，含每日签到领 credit（72★） |
| [EchoPing07/Qoder-2API-Go](https://github.com/EchoPing07/Qoder-2API-Go) | Go 实现的对照样本（60★） |
