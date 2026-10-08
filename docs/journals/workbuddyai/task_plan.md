# 任务计划：workbuddy-bridge

## 目标

把本地 OpenAI 兼容网关项目 `workbuddyai2api` 改造为 ZCode 插件可驱动的无窗口（headless）引擎，
并产出 ZCode 插件壳 `workbuddy-bridge`（MCP 工具 + skill + command），
通过本地测试 marketplace 安装验证。

## 关键决策（已与用户确认）

| 决策 | 结论 | 原因 |
| --- | --- | --- |
| 插件形态 | B 方案：Python 项目加无头子命令，Node MCP 服务器调用 | 登录/网关逻辑零重复，最干净 |
| exe 打包 | 删除（build.py / packaging/ / pyinstaller 依赖 / frozen 分支） | 用户明确要求，改为无窗口 |
| 项目名 | `workbuddy-bridge` | 用户指定 |
| 凭证存储目录 | 保留 `~/.workbuddyai2api/`（不改名） | 改名会使已有登录凭证失效，需重新登录 |
| MCP 服务器 | 零依赖纯 Node ESM（手写 stdio JSON-RPC） | 不依赖 npm install / 代理网络环境 |
| provider 接线 | 插件只引导（skill 文档），不改 `~/.zcode/v2/provider_config.json` | 插件规范不注册模型 provider，写应用配置超出契约 |
| 桌面 GUI（app.py） | 暂时保留为可选 `gui` 子命令 | 未获删除授权；后续可再议 |
| 插件源码位置 | `<ZCode工作区>/plugins/workbuddy-bridge/` | plugin-creator 默认布局 |

## 阶段

### 阶段1：Python 项目改名与打包链路移除 — **Status:** complete

- [ ] pyproject.toml：name/description 改名，移除 pyinstaller
- [ ] 删除 build.py、packaging/
- [ ] src/__main__.py：去掉 frozen 崩溃兜底
- [ ] src/console.py web_root()、src/catalog.py _candidate_paths()：去掉 frozen 分支
- [ ] 面向用户的名称统一改 `workbuddy-bridge`（CLI prog、日志前缀、README、窗口标题）
- [ ] .gitignore 去掉 dist/ build/

### 阶段2：B 方案无头子命令 — **Status:** complete

- [ ] 新增 src/headless.py：HeadlessLoginUI（LoginUI 协议）、ServiceState（控制台桥）、run_login、run_serve
- [ ] src/cli.py 改子命令：`serve`（默认）、`login`、`gui`；`--json` 事件行输出
- [ ] 语义：login 无窗口完成浏览器授权轮询并保存凭证；serve 启动网关+控制台，不建窗口/托盘
- [ ] 验证：--help、py_compile、ruff、serve 冒烟（起→/health 200→停）

### 阶段3：ZCode 插件壳 — **Status:** complete

- [ ] `<workspace>/plugins/workbuddy-bridge/.zcode-plugin/plugin.json`（mcpServers + userConfig + skills + commands）
- [ ] mcp/server.js：零依赖 MCP stdio 服务器，工具 status/start/stop/login/models
- [ ] skills/workbuddy-gateway/SKILL.md + commands/workbuddy.md
- [ ] 插件 README（provider 接线说明）

### 阶段4：本地测试 marketplace — **Status:** complete

- [ ] `<workspace>/plugins/marketplace.json`（dev- 前缀市场名，中文展示元数据）

### 阶段5：验证与交付 — **Status:** complete

- [ ] ruff check / python -m py_compile 全绿
- [ ] login --json 人工验证（需浏览器授权，交用户）
- [ ] 输出手动安装指引（Plugin Marketplace → Add → 粘贴目录）

## 遇到的错误

| 错误 | 尝试次数 | 解决方案 |
| --- | --- | --- |
| （暂无） | | |

## 备注

- 引擎与插件分离：Python 引擎留在 `Documents/workbuddy-bridge`，插件通过 userConfig 指向它。
- 上游接口事实（登录两步、指纹改写等）记录在 findings.md。

### 阶段6：CLI-first 重构（包化 + 守护式挂载） — **Status:** complete

已拍板：命令名 `workbuddy`；hook 自动挂载默认开（`auto_start` 可关）；开机自启这版不做；
MCP 层直接删除不共存；存储目录改名 `~/.workbuddy-bridge/`（迁移保留凭证）。

#### 6.1 存储迁移 + 引擎包化
- [ ] paths.py：DIR_NAME → `.workbuddy-bridge`，迁移链 `.workbuddyai2api`/`.workbuddyai-gateway` → 新目录
- [ ] src 布局：`src/workbuddy_bridge/` 包 + 相对导入；`__main__.py` 支持模块运行
- [ ] pyproject：`[build-system]` hatchling、`package = true`、`[project.scripts] workbuddy = "...cli:main"`

#### 6.2 CLI 守护化与子命令
- [ ] `workbuddy start --quiet --wait N`：幂等（先 /health）→ detached spawn + pidfile + 日志文件 → 健康等待，超时也不阻塞
- [ ] `workbuddy stop`：pidfile 杀进程树；`workbuddy status --json`：health + /api/state + pidfile + 凭证
- [ ] `workbuddy models --json`
- [ ] prefs：`auto_start` 开关（默认 true），hook 据此短路

#### 6.3 插件改造
- [ ] 删 mcp/server.js、plugin 内 package.json；plugin.json 去 mcpServers/userConfig，版本 0.2.0
- [ ] hooks/hooks.json：SessionStart（幂等 `workbuddy start --quiet`，失败不阻塞会话）
- [ ] skill/command 重写为 workbuddy 用法；插件 README 更新；marketplace 条目刷新

#### 6.4 验证
- [ ] uv sync + `uv run workbuddy` 全子命令冒烟；`uv tool install .` 后验证 PATH
- [ ] 守护链路：start → health → status → stop；迁移后凭证仍有效（/health ok）
- [ ] 插件清单校验 + 规划文件收尾
