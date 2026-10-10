---
name: model-bridge-gateway
description: Manage and troubleshoot the local multi-channel model-pool gateway with the mb CLI (channels, status, start, stop, login, models, credits, paths).
---

# 模型池网关管理

当用户想启动/登录/检查/排障本地模型池网关，或问"模型走的是哪个后端""凭证放哪了""池子里有哪些模型"时
使用本技能。所有操作通过 `mb` 命令行完成（会话启动时插件 hook 通常已自动挂载网关）。

## 背景事实

- **一个网关 + N 个池子**：本仓库注册 11 个渠道（`catpaw` `cline` `codearts` `lobsterai`
  `loomy` `qoder` `qodercn` `raccoon` `trae` `workbuddy` `workbuddyai`）。每个渠道是一个**模型池**：
  自己的一套模型目录 + 凭证 + 上游协议。
- **对外只有两个模型 id**（**不带渠道前缀**）：
  `deepseek-v4.1-flash`、`glm-5.3-flash`。
  客户端只写模型名，**请求落到哪家渠道由网关按各渠道账单已用量自己决定**（用得多的先走，
  失败的当 0 并进入冷却）；匹配大小写不敏感，上游 slug 仍用渠道目录里的原始写法。
  旧的 `<cid>/<模型>` 形态（如 `workbuddyai/deepseek-v4.1-flash`）**已移除**，现在会 400。
- **这两个模型各自对应多家渠道**（例如 `glm-5.3-flash` 可由 catpaw / cline / codearts /
  lobsterai / loomy / qoder / qodercn / raccoon 提供）。所以「某渠道未登录」通常**不影响**
  模型可用性 —— 网关会走别家。`trae` 不再贡献任何池内模型（它的 DeepSeek-V4-Flash 已随
  `deepseek-v4-flash` 出池）。
- **只放行 `(deepseek | glm)` 家族的 flash 模型**（网关级白名单，判据在共享层）。
  某渠道池子为空通常是未登录或上游目录拉取失败，不是插件坏了；
  但**没有 deepseek/glm 产品的渠道不会贡献任何池内模型**（这是策略有意为之）。
- **不只服务 ZCode**：网关是普通 HTTP 端点，其它客户端（Hermes、任意 OpenAI 客户端）直接把 base url
  指到 `http://127.0.0.1:8787/v1` 即可 —— **不需要**各自的插件层，凭据与账号池由网关统一管理。
- **网关默认地址** `http://127.0.0.1:8787`（`/v1/chat/completions`、`/v1/models`、`/health`）。
  仓库级网关注册全部渠道；单渠道 CLI 也走同一套池（只是候选只有一个渠道）。
- **存储落点**：统一根 `~/.model-bridge/`，按 cid 分层 `~/.model-bridge/<cid>/`（`credentials.json`
  `upstream.json` `prefs.json` `gateway.pid` `gateway.log`）。仓库级网关的 PID/日志、以及
  模型池的渠道账本 `pool-usage.json` 都在**根**上。
- **登录是唯一需要用户动手的步骤**（浏览器授权，工具无法代办）。
- **账号池**（一个渠道下多个账号）：保存在 `~/.model-bridge/<cid>/` ——
  `credentials.json`（当前生效账号的副本）、`accounts.json`（索引：列表 + 当前选中 + 元信息）、
  `accounts/<key>.json`（单账号凭证）。`key = sha256(domain+uid)[:16]`，重登不变。
  **登录即入池**；切换账号 = `accounts use <key>`（换 `credentials.json`，不用再授权）。
  **同一时间只用一个账号**（轮询/失败转移属后续策略层）。删生效账号 = 同时登出。
- 让 ZCode 用上这个网关需要**用户**在设置里加 provider（插件注册不了 provider）：类型
  `openai-chat-completions`、baseUrl `http://127.0.0.1:8787/v1`、API key 任意非空、模型名从
  `/v1/models`（或 `mb model list`）里取那两个池 id。不要替用户改
  `~/.zcode/v2/provider_config.json`。

## 命令速查

| 命令 | 作用 |
| --- | --- |
| `mb model list` | **池视图**：两个模型 → 候选渠道 + 账单已用量 + 冷却（顺序即路由顺序） |
| `mb model usage [--refresh]` | 池账本；`--refresh` 立刻重查各渠道账单额度 |
| `mb channels` | **渠道视角**：每个渠道各自贡献了池内哪些模型 |
| `mb status`（`--json`） | 网关健康、逐渠道登录状态、守护 PID、凭证、auto_start |
| `mb start` | 守护式启动（幂等；失败默认只报告，`--strict` 才非零退出） |
| `mb stop` / `restart` | 停 / 重启守护实例（不碰第三方进程；成功停止会在日志留 `stop` 记录） |
| `mb models` | 查**运行中的网关**暴露的模型 id（网关没起会失败；恒为那两个） |
| `mb login --channel <cid>` | 无窗口登录：stdout 给出授权链接，用户浏览器授权后自动保存 |
| `mb login list` | **列出可登录的渠道与登录状态**（已登录/未登录 + uid；只读，不需要网关） |
| `mb logs`（`--lines N`，`-f` 跟随） | 网关日志尾部（排障第一步）；`-f` 持续输出新日志 |
| `mb credits` | 账号剩余额度（只读，不经网关，不消耗额度） |
| `mb paths`（`--all`） | 存储落点与文件（只读） |
| `mb accounts`（`--channel`） | **账号池**：列出账号 / `use <key>` / `add` / `remove <key>` |
| `mb model show <cid>` | 该渠道贡献了池内哪些模型 |
| `mb <cid> login` | 登录该渠道（等价 `login --channel <cid>`） |
| `mb <cid> billing` | 该渠道额度 / 账单（别名 `credits`） |
| `mb <cid> checkin` | 该渠道签到 / 领奖励（`--status` 只查不领、`--daily-only` 跳过一次性） |
| `mb checkin --status` | **今天签没签**（上游 → 本地台账 → 未知；末尾给 N/M 摘要） |

**命令形态**：网关生命周期（`start/stop/restart/status/logs`）是**仓库级**的，不带渠道；
「对某个渠道做点什么」写成 `<cid> <动词>`（如 `mb trae login`、`mb trae billing`、
`mb trae checkin`）。两种写法等价：`<cid> 动词` 与 `动词 --channel <cid>`，都支持 `--json`。

**没有 per-channel command**：命令都是跨渠道的（`/model-bridge-login`、`/model-bridge-credits`、
`/model-bridge-checkin`、`/model-bridge-models` 等）。凡动作要落到某个渠道、而用户没指明时：
先跑只读命令（`mb status --json` / `mb channels` / `mb checkin --status`）拿渠道清单与现状 →
用 **`ask_user_query`** 让用户选（标注已登录/未登录，给「全部」选项）→ 再执行；
**不要替用户决定**，写操作（`checkin`、`accounts remove`）执行前必须确认。

`checkin` 对**所有**渠道口径统一：有端点的真查真领（codearts / lobsterai / loomy / raccoon / trae / qoder / qodercn），没端点的返回渠道自己的一句说明（workbuddy / workbuddyai / catpaw / cline —— 上游自动发奖励）。
「没有端点」不是故障、退出码仍为 0；只有查询/领取**抛错**（未登录等）才非零。

## 标准流程

1. 先 `mb status --json` 判断现状。
2. 网关不可达：`mb start` → 再 `status`；仍失败看 `mb logs`。
3. 某渠道未登录：`mb login list` 看谁没登录 → 用 `ask_user_query` 让用户选渠道（列未登录的，
   别替他决定）→ `mb login --channel <cid>`，把授权链接原样展示给用户并请其授权；
   不要并发重复跑。国内版与国际版是**两个渠道**：账号在 `codebuddy.ai` 用 `workbuddy`，
   在 `workbuddy.ai` 用 `workbuddyai` —— 选错渠道会一直等授权超时。
4. 「有哪些模型可用」→ `mb model list`（池视图）；`mb channels`（渠道视角，不需要网关）。
5. 「凭证/配置放哪」→ `mb paths --all`；「有几个账号 / 换账号」→ `mb accounts`。
6. 用户要求停掉 → `mb stop`；端口被第三方占用时如实报告，让用户自行处理。

## 排障要点

- 启动失败先看日志尾部；常见原因是端口被占用（8787 上可能有旧实例或别的程序）。
- 上游 502 / `code=11128`：多为 token 失效 → 重新登录该渠道；提示词指纹由引擎自动改写。
- 池子为空：未登录、或该渠道上游目录拉取失败（以 `status` 的逐渠道提示为准）。
- `400 unknown_model`：模型名不是池内两个字面量（旧的 `<cid>/<模型>` 形态已移除，对照
  `mb model list`）；`503 not_authenticated`：候选渠道都没登录。
- `auto_start` 在 `~/.model-bridge/prefs.json`（仓库级；单渠道在 `~/.model-bridge/<cid>/prefs.json`）。
