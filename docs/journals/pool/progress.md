# 进度日志

## 会话 2026-10-08

- 需求：仓库级网关对外只暴露三个模型（`deepseek-v4.1-flash` / `deepseek-v4-flash` / `glm-5.3-flash`），
  请求落到哪家渠道由网关自己决定，客户端不参与；渠道选择按账单已用量降序，失败当 0。
- 调研：读遍 10 个渠道的 `catalog.ts` / `billing.ts`，确认「账单请求数」不存在，
  只有 `total.used`（额度已用量，单位各不相同）。用户确认改用已用额度口径 + 落盘缓存（TTL 8h）。
- 用户决定：**去掉兼容性，破坏性更新** —— 移除 `<cid>/<模型>` 前缀路由。
- 定稿归一化规则与候选渠道表（见 findings.md §1–§3）。
- 创建本规划文件。

### 实现（同一会话）

- 新增 `pool-targets.ts`（三个目标 + 归一化 + 候选收集）、`pool-usage.ts`（账本 + TTL 刷新）、
  `paths.poolUsagePath()`。
- 改写 `gateway.ts`：`/v1/models` 恒三条；`handleChat` 走池路由（排序 → 依次尝试 → 失败冷却），
  抽出 `relayUpstream`；删除 `resolveTarget`（前缀路由）。
- CLI：`model list` 改池视图、新增 `model usage [--refresh]`、`channels` 改渠道视角、
  `model show <cid>` 看单渠道贡献；`usage()` 帮助文本同步。
- 测试：新增 `pool-routing.test.ts`；重写 `pool.test.ts`；更新仓库级 CLI 测试 + 5 个渠道 selftest。
  **`npm test` 全绿：12 个包 519 项 + verify:storage + verify:docs。**
- 顺带修掉：`POOL-ARCHITECTURE.md` 里嵌的字面 NUL（Read 工具因此把它当二进制拒读）。

### 真机验证（2026-10-08）

- `npm run build` 后重启网关：发现原先的进程是插件 hook 起的 `serve`（无 PID 文件，
  陈旧构建检测对它静默失效）→ 停掉后改用守护式 `start`（PID 18296），此后可被 `restart` 管理。
- `/v1/models` → 恰好三条（`owned_by: model-bridge`）。
- `model list` → 池视图正常：4.1 有 5 家候选、4.0 有 6 家、glm 有 6 家（含 cline 的缓存目录）。
- `model usage --refresh` → 真的联网查账单：**成功 2 家**（workbuddyai `used=216.63 credits`
  因此排到首位、lobsterai `remain=973.32`），失败 8 家（未登录 / 无端点 / token 过期），
  账本落盘 `~/.model-bridge/pool-usage.json`。
- 一次真实对话（`deepseek-v4.1-flash`）→ 502，但**路由行为完全正确**：
  日志 `池内候选都失败了（deepseek-v4.1-flash，试过 workbuddyai、cline、codearts）`，
  workbuddyai 因凭据刷新 404 进冷却（账本 `fail=1`）。失败原因在环境（唯一有额度的渠道凭据失效、
  其余未登录），不是路由代码 —— 需要用户重新登录对应渠道。
