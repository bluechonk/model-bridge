# 网关监督进程与自动重生（Daemon Supervisor）

本文是网关**进程生命周期**的契约与设计说明：监督者如何拉起 worker、worker 意外死亡如何
被自动拉回、以及哪些操作会**作废**重生。机制学习自 CCR
（`@musistudio/claude-code-router` 3.1.3，本机反读 `dist/main/cli.js` 实证），
参数照抄其已实测行为，不造新参数。

## 1. 进程模型

```
mx start（短命命令，spawn 后退出，落 PID 文件）
  └─ supervise  监督进程（detached + unref + windowsHide，常驻）
       └─ serve  网关 worker（stdio: [ignore, logFd, logFd, ipc]，stdout/stderr 进 gateway.log）
                 ↕ IPC：父进程断开 → worker 优雅自退
```

- **监督者**只做生命周期管理：spawn worker、维护 worker PID 文件、监听 worker 退出、
  按退避策略重生。不碰业务。
- **worker**（`headless.runServe`）就是网关本体，与无监督直跑 `mx serve` 完全同一份代码——
  差别只在于 spawn 时多开了一个 IPC fd，并因此获得「监督者死了就自退」的行为。
- 全部 spawn 带 `windowsHide`：不会出现 CCR 那样的控制台黑窗口。

## 2. 自动重生（学 CCR `scheduleCoreRestart`）

worker 触发 exit 事件后，监督者按以下规则决定是否重生与何时重生：

| 规则 | 参数 | 依据 |
| --- | --- | --- |
| 何时重生 | worker 死前已进入 running（健康探测曾通过）才重生 | CCR 仅 `state==="running"` 重生；启动未就绪即死 → 记 error、监督者退出，不无限循环 |
| 退避曲线 | `min(30_000, 1_000 × 2^min(attempts, 5))`，即 1s→2→4→8→16→32→封顶 30s | CCR 同款；连续快速死亡逐级放慢 |
| 计数清零 | worker 稳定运行 ≥60s 后 attempts 清零 | CCR 同款——长期健康 worker 第一次被杀只等 1s |
| 重试上限 | 无上限，`mx stop` 是唯一终止路径 | CCR 同款 |
| 重启失败 | 再走一次退避调度（catch 内 schedule） | CCR 同款 |

成功重生后监督者更新 `gateway-worker.pid`，并继续等健康探测通过。

## 3. 代际计数（学 CCR `cancelCoreRestart`）

监督者维护**重生代次**：每次「_reset_重生意图」递增，迟到的退出事件按提交时的代次核对，
不匹配即作废。modelmux 的具体形态比 CCR 更简单：

- CCR 是常驻监督者内的进程内 API（stop 先调 cancel 再杀 worker）；
- modelmux 的监督者是独立进程，**杀掉监督者本身即 cancel**——`mx stop` 先 killTree 监督者，
  之后 worker 退出（无论什么原因）都不会再被拉起。

`mx start` 幂等探测会把旧的 PID 僵尸实例清掉再拉新监督者，同效于 CCR 的 start 前置 cancel。

## 4. 停止语义（谁生谁灭）

| 操作 | 结果 |
| --- | --- |
| `mx stop` | 杀监督者（=作废重生）→ 等 worker IPC 自退（≤3s）→ 兜底杀 worker → 健康探测确认端口空 |
| 杀监督者（taskkill） | worker 因 IPC 断开自退（reason=`supervisor-gone`），无人拉回 |
| 杀 worker | 监督者按 §2 重生——这就是「关了又活」的来源，属设计行为 |
| `mx serve` 直跑 | 裸 worker，无监督、无自退钩子（调试路径，SIGINT/SIGTERM 照旧优雅停机） |
| `mx restart` | stop + start，天然兼容 |

worker 的 IPC 断开走既有 `shutdown()` 优雅停机（资源关闭 + `{"event":"stopped",
"reason":"supervisor-gone"}` 日志），比 CCR 的裸 `exit(0)` 保留更多可观测性。

## 5. PID 文件

| 文件 | 内容 | 写入者 |
| --- | --- | --- |
| `gateway.pid` | **监督者** pid（纯数字单行，格式不变） | `mx start`（一次） |
| `gateway-worker.pid` | 当前 worker pid | 监督者（spawn/重生时更新） |

- `readPid` 的唯一读者不需要感知语义微调；`stale-build` 只读 `gateway.pid` 的 mtime
  （= start 时刻），worker 重生不更新它——陈旧构建判定仍指本批监督者/worker 的构建时间。
- 渠道级在 `<root>/<cid>/`，仓库级在 `<root>/`（与日志同层，见 STORAGE-CONVENTION）。

## 6. 与 CCR 的差异清单（如实记录）

| 维度 | CCR | modelmux |
| --- | --- | --- |
| 重生判定 | state==="running" | 同（健康探测曾通过） |
| 退避 | 1s×2^n 封顶 30s，60s 清零 | 同 |
| cancel | 进程内 API（stop 先 cancel） | 杀监督者即 cancel |
| worker 父死 | 裸 exit(0) | shutdown() 优雅停机 |
| 黑窗口 | worker 链路可弹 | 全 windowsHide，无窗口 |
| 附属体系 | profiles / Electron / runtimeId | 不引入 |

## 7. 实现落点

| 文件 | 职责 |
| --- | --- |
| `packages/gateway/src/supervisor.ts` | 监督进程：spawn worker、退避重生、维护 worker pid 文件 |
| `packages/gateway/src/headless.ts` | worker 自退钩子（IPC disconnect → shutdown） |
| `packages/gateway/src/daemon.ts` | start 改 spawn `supervise`；stop 三步流 |
| `packages/gateway/src/paths.ts` | `workerPidPath` / `FILES.workerPid` |
| `packages/gateway/src/cli.ts` | 隐藏内部命令 `supervise`（同 `serve` 待遇） |
