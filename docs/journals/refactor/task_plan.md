# 任务计划：注释治理 + 日志英文化 + 池策略收窄

## 目标

三件事，一次做完：

1. **池策略收窄**：公共模型从三个减到**两个** —— `deepseek-v4.1-flash` 与 `glm-5.3-flash`；
  **`deepseek-v4-flash` 不再进池**。
2. **日志英文化**：所有运行时 log / console 输出改英文（避免 Git Bash / PowerShell 下的
  UTF-8 编码问题）。
3. **注释治理**：全项目注释**中文、简化**，删掉过时/旧依赖/旧代码注释，更新与现状不符的说明。

## 关键约束（决定怎么改）

### 池策略收窄**不能全局替换** `deepseek-v4-flash`

同一个字符串在不同位置含义不同：

| 位置 | 含义 | 处理 |
| --- | --- | --- |
| `pool-targets.ts` 的 `POOL_MODELS` | **池目标** |  移除 |
| 池匹配/候选测试的期望 | 断言"它进池" |  改成"不进池" |
| **各渠道 `catalog.ts` 里的上游模型名** | 上游**真实存在**的模型 |  保留（只是不进池） |
| 文档里的"候选表" | 描述现状 |  更新 |

### 日志英文化的范围

- `console.log` / `console.error` / `logger()` 的**运行时输出**
- 保留中文的地方：**用户可见的 CLI 报表内容**（`model list` 的表格等）？
 → 按用户要求"日志 log 输出尽量英文"，**CLI 报表属于产品输出**，与运行时日志分开处理：
 只改 `[cid] xxx` 这类**日志行**，报表保持中文。

## 各阶段

### 阶段 1：规划 — **状态：complete**

- [x] 摸清 `deepseek-v4-flash` 的引用分布（~40 文件）与含义分类
- [x] 确认不能机械替换（上游模型名要保留）

### 阶段 2：池策略收窄（两个模型） — **状态：in_progress**

- [ ] `packages/gateway/src/pool-targets.ts`：`POOL_MODELS` 只留两个
- [ ] `channels/qoder` + `qodercn` 的 `POOL_KEY_MAP`：`dfmodel` 不再映射（只留 `gfmodel`）
- [ ] 池相关测试调整（gateway / cli / 各渠道 selftest）
- [ ] 文档同步（POOL-ARCHITECTURE / AGENTS / README / 插件 command / SKILL）

### 阶段 3：日志英文化 — **状态：pending**

- [ ] 共享层（gateway / daemon / headless / console / account-pool …）
- [ ] 11 个渠道的运行时日志行
- [ ] 插件的 hook 脚本输出

### 阶段 4：注释治理 — **状态：pending**

- [ ] 删掉过时注释（旧架构/字符串替换时代/Python 时代残留）
- [ ] 简化过长的"为什么"注释（保留关键的，砍掉重复的）
- [ ] 统一中文

### 阶段 5：验证与交付 — **状态：pending**

- [ ] `npm test` 全绿（含 verify:storage / verify:docs）
- [ ] 重启网关、真机确认只剩两个模型
- [ ] 提交推送

## 遇到的错误

| 错误 | 尝试次数 | 解决方案 |
| --- | --- | --- |
| （待填） | | |
