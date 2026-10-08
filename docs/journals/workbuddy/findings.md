# 研究发现

## 项目结构（改造前）

- Python 3.11 + uv；`[tool.uv] package = false`，无入口点，靠 `python src/__main__.py`（src 平铺 import）。
- 组件：gateway（:8787 透明代理）/ console（:8788 状态页）/ app（WebView2+托盘 GUI）/ auth_flow / cred / upstream / catalog / paths / portfree / sse_stream。
- 打包：build.py → PyInstaller onedir + Inno Setup（本任务要删）。

## 登录流程（cred.py，纯 HTTP，无 GUI 依赖）

1. `POST {base}/v2/plugin/auth/state?platform=workbuddy`（匿名头 X-No-*）→ `{state, authUrl}`
2. 浏览器打开 authUrl，人工授权（唯一人工步骤）
3. `GET {base}/v2/plugin/auth/token?state=...` 每 5s 轮询，≤5 分钟 → accessToken/refreshToken 等
4. `cred.login()` 写 `~/.workbuddyai2api/credentials.json`（Go 风格字段名 accessToken/refreshToken/...，uid 取 JWT sub）
5. `cred.refresh()`：`POST /v2/plugin/auth/refresh`，纯 HTTP

- `auth_flow.ensure_login(win)` 只需 LoginUI 协议：`set_state(state, message, url="")`。有凭证先 fetch_models 探测，401/403 先 refresh，刷新失败删凭证引导重登。
- 授权成功后还会 `upstream.fetch_models` + `save_config`（解析 endpoint/tokenHeader 等）。

## 网关与控制台

- gateway 路由：`/v1/chat/completions`、`/v1/models`、`/health`、`/`；`start_background(addr, verbose, on_error)` 返回 stop()，与 GUI 无关。
- gateway 每请求自行 load 凭证；未登录返回 503 not_authenticated → serve 模式可以"先起网关后登录"。
- console `ControlBridge`：provider()/set_theme/retry_login 三个可注入回调；`/api/state` 快照含 auth_url、ui_state(probing/login/error/running)、models。
- `AppState`（app.py）是 LoginUI + 控制台桥的实现，无 GUI 依赖，主题/托盘才是 GUI 部分 → headless 需要一个精简等价物。

## ZCode 插件机制（实测官方 android-emulator 插件）

- manifest `.zcode-plugin/plugin.json`：name/version/skills/commands/mcpServers/userConfig（userConfig 值以 `${user_config.<key>}` 注入 MCP env）。
- MCP 官方形态：`ZCode.exe resources/glm/zcode.cjs __zcode-plugin-host <abs server.js>` + `ELECTRON_RUN_AS_NODE=1`（本机两路径已验证存在）；.mcp.json 形态为 `node ${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js`。
- MCP SDK：`@modelcontextprotocol/server` 2.0.0 + zod，esbuild 打成单文件；`server.registerTool(name, {title,description,inputSchema}, cb)`。
- 市场文件：客户端在市场根下先找 `marketplace.json`，再找 `.claude-plugin/marketplace.json`（`findMarketplaceManifestPath`）；条目含 name/source/version/displayName/displayName_i18n。条目 `source` 相对市场根且不得越界（`../` 被拒）。
- 本地 dev 布局（官方 plugin-creator）：市场根是 `plugins/`，清单 `plugins/marketplace.json`，插件源 `plugins/<插件名>/`，条目 `source` 为 `./<插件名>`。安装 = 把插件**源目录**整个复制到 `~/.zcode/cli/plugins/cache/<市场>/<插件>/<版本>/`（实测只有 manifest/commands/hooks/skills/README，41 KB）。
- **但该 dev 布局只适用于"本地目录"来源**：用 GitHub 仓库 / Git URL 添加市场时，市场根就是克隆下来的仓库根，加载器只在 `<仓库根>/marketplace.json` 或 `<仓库根>/.claude-plugin/marketplace.json` 找清单（`findMarketplaceManifestPath` 是包里唯一的清单查找逻辑；`marketplace.json` 字面量全包仅 4 处，无一处拼接 `plugins/` 子路径），`plugins/marketplace.json` 在仓库来源下读不到。故要支持仓库地址分发，清单必须放回仓库根（本仓库 2026-10-07 已按此回退）。
- 生态惯例（实测 `~/.zcode/cli/plugins/marketplaces/`）：17 个市场克隆里 **14 个是「根清单 + `.claude-plugin/marketplace.json`」双份**、3 个只有根清单、0 个只有 `.claude-plugin`。双份**不要求逐字一致**（agent-browser / addy-agent-skills / claude-plugins-official 两份字节不同但顶层键与 `source` 集合一致；taste-skill 双份逐字相同）——本仓库取逐字镜像，便于校验。
- 市场 id 就是清单 `name`（`known_marketplaces.json` 里 `id == name`），同名不同源会被官方 helper 拒绝（`Marketplace source conflict`）：所以"仓库地址"与"本地 `plugins/` 目录"两条路线**同名只能注册一个**。
- `${CLAUDE_PLUGIN_ROOT}`、`${ZCODE_PLUGIN_DATA}`、`${ZCODE_PROJECT_DIR}` 为可用占位符。

## ZCode 侧事实

- 本机 provider 配置：`~/.zcode/v2/provider_config.json`，providerId deepseek-2，baseUrl api.commandcode.ai（非本地网关），modelOrder 已含 `deepseek-flash`（禁用）。
- 插件注册不了 provider：接线必须用户在设置里做（openai-chat-completions + baseUrl http://127.0.0.1:8787/v1 + 任意 apiKey + model deepseek-flash）。
- 本机：Node v24.21.0、uv 0.12.17、Python 3.11.15、ruff 0.16.7 均可用；无 zcode CLI（无法跑 `zcode plugins validate`）。
- 前端 `frontend/dist` 未构建 → console 静态资源缺失时 /api/* 仍可用（api_state 不依赖前端）。

## 上游兼容性（README + gateway.py）

- 上游只支持流式；首条 message 必须 system；按系统提示词指纹拦截（11128），网关改写 "Main branch (you will usually use this for PRs)" → 等价表述。
- 上游每个 delta 带空 `tool_calls: []`，网关剥离，否则 ZCode 思考流碎块。
- 模型短名 `deepseek-flash` → `deepseek-v4.1-flash`（models.json / catalog.py）。

## Gateway 挂载方案研究（2026-10-07，第二轮）

### ZCode hook 能力（实测已装插件）

- hooks.json 支持事件：`SessionStart`（matcher `startup|resume|clear|compact`）、`UserPromptSubmit`、
  `UserPromptExpansion`、`PreToolUse`、`PostToolUse`、`Stop`、`PreCompact`。
- 条目字段：`type: command`、`command`/`args`、`shell`（superpowers 用了 bash）、`async`、
  `timeout`（秒）、`statusMessage`、`matcher`。两个官方系插件都用 SessionStart 做会话级注入。
- 插件的 hooks 是全局的：所有项目的所有会话都会触发 → 自动挂载需要开关。

### 进程模型对比

- gateway 是共享本地服务：ZCode provider 直连 127.0.0.1:8787，消费者不止一个会话
  （多工作区、浏览器测试、脚本）。会话绑定生命周期（SessionStart 拉、Stop 停）会打断其他消费者。
- 引擎已具备常驻条件：portfree 端口自愈（残留实例自动接管）、凭证运行期自动刷新、
  serve 本身无窗口。缺的只是守护式启动（detached + pidfile）。
- 结论：守护式常驻（`workbuddy start` detached + `~/.workbuddyai2api/gateway.pid` + health 等待），
  hook 只负责"确保在跑"（幂等），不做会话级回收；`workbuddy stop` 显式停。
