# 任务计划：公共模型池（三个跨渠道模型 + 账单额度排序）

## 目标

仓库级网关对外只暴露**三个模型**——`deepseek-v4.1-flash`、`deepseek-v4-flash`、`glm-5.3-flash`；
客户端不关心请求落到哪家渠道，网关按各渠道**账单已用量**（降序，失败当 0）挑候选，
账单额度缓存落盘、每天只查两三次。

## 状态：**全部完成**（2026-10-08）

## 关键决策

| 决策 | 结论 | 原因 |
| --- | --- | --- |
| 对外 id | 三个**具体版本**名，恒小写，匹配大小写不敏感 | 用户指定；不再合并成 `deepseek-flash` |
| 4.1 vs 4.0 | 两个独立模型，**没有**优先级关系 | 拆成具体版本后该规则自然消失 |
| 匹配方式 | 归一化后**精确相等**；客户端请求名不剥路径段 | 4.0 与 4.1 不能互串；带 `/` 的旧形态一律 400 |
| `<cid>/<模型>` 前缀 | **移除**（破坏性） | 用户明确「兼容性去掉」 |
| 排序键 | 渠道账单 `used`（已用量）降序 | 上游没有「请求次数」字段，已用量是唯一可得口径 |
| 失败处理 | 进冷却（60s），冷却期内得分当 0 | 用户原话「请求失败的直接当为 0」 |
| 账单缓存 | `<root>/pool-usage.json`，TTL 8h，后台异步刷新 | 一天两三次即可，不能每次请求联网 |
| 账号池 401/403 | 不变，仍在渠道内部先跑完 | 池层只在「渠道整体不可用」时接管 |

## 各阶段

### 阶段 1：方案与规划 — **状态：complete**

- [x] 调研十渠道目录命名形态、billing 字段、池路由现状
- [x] 确认「账单请求数」不可得 → 改用已用额度（`CreditsResult.total.used`）
- [x] 归一化规则与候选表定稿（见 findings.md）

### 阶段 2：共享层实现 — **状态：complete**

- [x] `pool-targets.ts`：三个目标 + 归一化（目录/请求两条路径）+ 候选收集
- [x] `pool-usage.ts`：账本读写、得分、冷却、TTL 判定、后台刷新
- [x] `paths.poolUsagePath()`

### 阶段 3：网关改造 — **状态：complete**

- [x] `/v1/models` 恒三条；`handleChat` 池路由尝试循环；前缀路由删除
- [x] 失败转移只在「上游响应头之前」；`relayUpstream` 单独抽出
- [x] 账单刷新触发（`maybeRefreshBilling`，fire-and-forget）

### 阶段 4：CLI — **状态：complete**

- [x] `model list` 池视图（三条 + 候选渠道 + used + 冷却）
- [x] `model usage [--refresh]` 手动刷账单
- [x] `channels` 改为渠道视角；`model show <cid>` 看单渠道贡献

### 阶段 5：测试 — **状态：complete**

- [x] 新增 `packages/gateway/tests/pool-routing.test.ts`（归一化表 / 候选 / 账本落盘）
- [x] 重写 `pool.test.ts`（端到端池路由、失败转移、冷却、破坏性行为）
- [x] 更新 8 个旧测试文件（仓库级 CLI、5 个渠道 selftest）
- [x] `npm test` 全绿：12 个包 / 519 项 + `verify:storage` + `verify:docs`

### 阶段 6：文档与交付 — **状态：complete**

- [x] POOL-ARCHITECTURE §2 重写（新增 §2 全节）+ §0/§1/§4/§5 同步
- [x] STORAGE-CONVENTION（根级文件 + `pool-usage.json`）；CONTRACT-TS §4 拆成 4.1/4.2
- [x] docs/README.md（索引、池架构一行、客户端接法）
- [x] 插件 `SKILL.md` + `commands/model-bridge*.md`
- [x] `npm run build`；重启网关（杀掉插件 hook 起的旧 `serve`，改用守护式）；真机验证

## 遇到的错误

| 错误 | 尝试次数 | 解决方案 |
| --- | --- | --- |
| `asPoolModel("alpha/deepseek-v4-flash")` 误命中池内 id | 1 | 把归一化拆成两条路径：目录 id 剥厂商路径段，客户端请求名不剥 |
| `poolCandidates` 返回小写化的 id，丢了目录原始大小写 | 1 | 改用 `catalog.exposedIds()` 原始列表匹配（上游 slug 可能大小写敏感） |
| POOL-ARCHITECTURE.md 被判为二进制，Read 工具拒读 | 1 | 文件里嵌了一个字面 NUL（描述 `sha256(domain\0uid)`）→ 改成 `\0` 转义 |
| 8 个旧测试断言 `<cid>/<模型>` 形态 | 逐文件 | 改成三个池 id + 原始 slug 断言（trae 的 `function` 通道也随之变 `solo_agent`） |
| 网关由插件 hook 以 `serve` 启动 → 无 PID 文件 → 陈旧构建检测静默失效 | 1 | 杀掉后改用守护式 `start`（写 PID），此后 `restart`/stale 检测才有效 |
