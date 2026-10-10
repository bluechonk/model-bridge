# qodercn-bridge

Qoder **国内版**（`qoder.com.cn`）的本地网关 —— 本工作区的一个**渠道（= 模型池）**。

> 与国际版 `qoder`（`qoder.com`）是**两个独立渠道**：账号在哪个域就用哪个渠道登录。
> 两个渠道不能互相代登（会串区），也不共用凭据文件。

文档已统一到工作区 `docs/`：

| 内容 | 位置 |
| --- | --- |
| 渠道说明（用法 / 存储 / 测试） | [`docs/bridges/qoder.md`](../../docs/bridges/qoder.md)（两区共用一份） |
| 协议规格（实现依据） | [`docs/protocols/qoder/PROTOCOL.md`](../../docs/protocols/qoder/PROTOCOL.md) |
| 调研与实现记录 | [`docs/journals/qoder/`](../../docs/journals/qoder/findings.md) |

> 文档总索引：[`docs/README.md`](../../docs/README.md) ·
> 契约与规范：[`docs/CONTRACT-TS.md`](../../docs/CONTRACT-TS.md) ·
> 插件：[`plugins/model-bridge/`](../../plugins/model-bridge/)
