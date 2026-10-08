# 调研发现：公共模型池

## 1. 各渠道目录命名形态（实测）

归一化要覆盖的真实写法：

| 渠道 | 原始 exposedId | 归一到 |
| --- | --- | --- |
| catpaw | `deepseek-v4-flash` / `glm-5.3-flash` / `glm-5.3-flashx` | 4.0 / glm / （flashx 不命中） |
| cline | `deepseek/deepseek-v4.1-flash`（远端目录） | 4.1 |
| codearts | `deepseek-v4.1-flash` / `deepseek-v4-flash` / `glm-5.3-flash` | 三个全有 |
| lobsterai | `deepseek-v4-flash` / `glm-5.3-flash` / `deepseek-flash`（无版本） | 4.0 / glm |
| loomy | `deepseek-v4-flash-0731` / `GLM-5.3-Flash` | 4.0 / glm |
| raccoon | `sn-deepseek-v4-1-flash` / `sn-glm-5-3-flash` | 4.1 / glm |
| trae | `DeepSeek-V4-Flash` / `DeepSeek-V4-Flash-Official` | 4.0 |
| workbuddy / workbuddyai | `deepseek-v4.1-flash` | 4.1 |
| qoder | 桩，未实现 | 不贡献 |

## 2. 候选渠道表

| 目标 | 提供它的渠道 |
| --- | --- |
| `deepseek-v4.1-flash` | cline、codearts、raccoon、workbuddy、workbuddyai |
| `deepseek-v4-flash` | catpaw、codearts、lobsterai、loomy、trae |
| `glm-5.3-flash` | catpaw、codearts、lobsterai、loomy、raccoon |

## 3. 归一化规则

1. 按 `/` 切，取最后一段（去 `deepseek/`、`z-ai/` 这类厂商前缀）
2. 全小写
3. 去渠道包装前缀（`sn-`）
4. 数字-数字的连字符转点：`(\d)-(\d)` → `$1.$2`（`v4-1` → `v4.1`，`5-3` → `5.3`）
5. 去尾部修饰：`-official`、`-<4位数字>`（`-0731`）、`-latest`
6. 与三个目标名**精确相等**（保证 4.0 与 4.1 不串）

**不进池**（仍在渠道底层目录，可经渠道 CLI 使用）：`glm-5.3-flashx`、`deepseek-v4-flash-vision-exp`、无版本的 `deepseek-flash`。

## 4. 账单字段现实

各渠道 `billing.fetchCredits()` 返回共享接口 `CreditsResult`：
`total: { remain, size, used, unit, remain_percent }`。

- **没有**任何渠道提供「请求次数」字段 → 「账单请求数」不可得。
- 各家 `unit` 不同（积分 / credits / 美元），跨渠道横比只是近似（用户已确认接受）。
- 排序取 `total.used` 降序；查不到（未登录 / 网络失败 / 接口不支持）→ 当 0。

## 5. 现状代码位置

| 关注点 | 位置 |
| --- | --- |
| `/v1/models` 并集 | `packages/gateway/src/gateway.ts` `handleModels()` |
| `<cid>/` 解析 | `gateway.ts` `resolveTarget()` |
| 池内 id 小写化 | `packages/gateway/src/model-pool.ts` `poolIds()` |
| 账号池失败转移 | `gateway.ts` `callUpstream()`（MAX_ACCOUNT_ATTEMPTS=3） |
| 家族白名单 | `packages/gateway/src/model-family.ts` |
| 原子写 | `packages/gateway/src/secret-file.ts` `writeJsonSecret()` |
| 根级文件 | `packages/gateway/src/paths.ts` `rootFile()` |

## 6. 破坏性影响面

- `/v1/models` 不再返回 `<cid>/<模型>`；客户端里写旧 id 的**必须改**。
- `resolveTarget()` 的前缀分支删除 → `pool.test.ts` 中相关用例要重写。
- 插件 `skills/model-bridge-gateway/SKILL.md`、`commands/model-bridge.md` 里教用户写 `<cid>/<模型>` 的两处必须改。
