# 进度日志

## 会话 2026-10-07

- 完成项目调研：登录流程（cred.py 纯 HTTP）、网关/控制台桥（无 GUI 依赖）、ZCode 插件机制（android-emulator 实测）。详见 findings.md。
- 用户决策：B 方案（Python 加无头子命令 + Node MCP 调用）、删 exe 打包、项目改名 workbuddy-bridge、无窗口。
- 创建规划文件（task_plan.md / findings.md / progress.md）。
- 阶段1完成：pyproject 改名 workbuddy-bridge（版本 0.2.0）、删除 build.py/packaging/pyinstaller、
  去掉 frozen 分支（console/catalog/__main__）、CLI prog/日志前缀/窗口标题统一改名；
  `~/.workbuddyai2api` 存储目录保留（凭证不动）。
- 阶段2完成：新增 src/headless.py（StdoutLoginUI / ServiceState / run_login / run_serve）；
  auth_flow.ensure_login 增加 interactive 参数（无窗口被动模式不弹浏览器）；
  cli.py 改为 serve/login/gui 子命令（无参数默认 serve）；
  app.AppState 重构为 headless.ServiceState 的子类（主题/托盘留在 GUI 层）。
- 冒烟验证通过：serve --json 起 → /health ok → /v1/models 列出 deepseek-flash →
  /api/state ui_state=running → 真实 chat 请求上游返回 "OK"（注意：Git Bash 终端发中文会变 GBK，
  网关按设计拒绝；改用 UTF-8 文件体）。
- 开始阶段3：ZCode 插件壳。
- 阶段3完成：插件壳（workspace/plugins/workbuddy-bridge/）：
  manifest（mcpServers 名 workbuddy + userConfig project_path/launcher/addr/console_port）、
  零依赖 Node ESM MCP 服务器（mcp/server.js + package.json type:module，工具 status/start/stop/login/models）、
  skill workbuddy-gateway、命令 /workbuddy、插件 README（含 provider 接线说明）。
- 阶段4完成：官方 helper 生成 plugins/marketplace.json，市场 dev-default-6d1575ef，
  插件 ID workbuddy-bridge@dev-default-6d1575ef。
- 插件冒烟通过：initialize（协议版本回显）/tools/list/status/models（网关关闭时正确 isError）；
  生命周期 start→gateway reachable→models→stop，taskkill /T 进程树确认清理干净（无监听残留）。
- 收尾：README 重写（无窗口/插件/provider 接线）、.gitignore 去掉 dist/ build/、ruff 全绿。
- 待用户：在 ZCode UI 手动添加市场并安装插件；provider 接线手动完成。
- 追加（用户要求）：GitHub 仓库改名为 bluechonk/workbuddy-bridge（gh repo rename，旧地址自动重定向），
  本地目录 Documents/workbuddyai2api → Documents/workbuddy-bridge，origin URL 已更新；
  插件 userConfig 默认 project_path、插件 README、前端（package.json/lock/index.html/App.tsx）、
  paths.py docstring 同步改名。`~/.workbuddyai2api` 凭证存储目录名保持不变（迁移成本 > 收益）。
- 追加（用户决策）：移除前端与 GUI 层。登录状态与模型列表本就由 MCP 工具覆盖（status / login / models），
  前端页面与桌面窗口不再必要。删除：frontend/、docs/screenshots、src/app.py、cli 的 gui 子命令、
  pystray/pillow/pywebview 依赖；console.py 收缩为纯 API（/api/state、/api/retry-login、
  /api/theme 空操作），README 重写为 headless 叙事。uv sync 后 ruff 全绿；
  回归验证：/health ok、/api/state running、控制台 "/" 404、JSON 事件行正常。
- 新一轮规划（用户方向）：CLI-first 重构——引擎包化（[project.scripts] 暴露 workbuddy），
  status/models 从 MCP 下沉为 CLI 子命令，插件删 MCP 层改纯 skill/command，
  gateway 挂载采用守护式常驻 + SessionStart hook（幂等 ensure-start）候选方案。
- 阶段6 挂载方案探讨进行中，待用户拍板：进程模型 / hook 开关 / 开机自启 / 命令名。
- 用户拍板阶段6：命令名 workbuddy、auto_start 默认开、不做开机自启、MCP 直接删除；
  存储目录一并改名 ~/.workbuddy-bridge（一次性迁移保留凭证）。
- 阶段6完成（CLI-first 重构）：
  6.1 包化：src/workbuddy_bridge/ 包 + 相对导入；hatchling + [project.scripts] workbuddy；
      存储目录改名 ~/.workbuddy-bridge，迁移链 .workbuddyai2api/.workbuddyai-gateway → 新目录
      （实测迁移后凭证有效，无需重新登录）；catalog 的 models.json 路径适配新布局。
  6.2 守护化：daemon.py 幂等 start（health 探测 → 僵尸实例清理 → detached spawn + gateway.pid/gateway.log
      → 健康等待，超时不阻塞）、stop（PID 杀树）、status/models/credits 聚合命令；
      prefs.auto_start 开关（默认开）实测生效。
  6.3 插件：删 mcp/server.js 与 package.json；plugin.json 0.2.0（skills/commands/hooks）；
      SessionStart hook（幂等 workbuddy start --auto --quiet，timeout 10s，失败不阻塞会话）；
      skill/command 重写为 workbuddy 用法；marketplace 条目刷新。
  6.4 验证：uv tool install 全局可用（~/.local/bin/workbuddy，bash 解析 OK）；守护链路 start→status→models→stop；
      重复 start 幂等；hook 命令实测挂载成功且二次运行幂等；插件文件一致性校验无错误
      （validate-plugin.mjs 的 zcode CLI 步骤本机不可用，属预期）。
- 当前状态：网关由守护进程常驻运行中；插件待用户在 UI 里更新安装（市场 dev-default-6d1575ef）。
- 阶段7+8（用户反馈）：
  1) 版本号纠正：此前仓库无任何 tag、0.1.0 从未发布，我却自行升到 0.2.0/0.2.1。
     现统一重置为 0.1.0（引擎 pyproject/cli + 插件双 manifest + 市场条目），作为首个正式版本打 tag。
  2) 新增额度查询：billing.py 走上游 POST /v2/billing/meter/get-user-resource
     （参考社区实现 workbuddy2api-hub；仅只读）。实测返回真实余额：剩余 223.37/440 credits（50.8%）。
     CLI 加 `workbuddy credits [--json]`。
  3) 命令补齐：zcw（总入口）、zcw-banner（状态+额度一屏）、zcw-status、zcw-credits、
     zcw-start、zcw-login。
- 阶段9（用户反馈：start 会弹出可见控制台窗口）：
  诊断：EnumWindows 实测监听 8787 的进程 visible=True；进程链为 uv 工具 venv python.exe（跳板）→
  基础解释器。A/B 实验证实：DETACHED_PROCESS 下跳板无控制台可继承，真解释器被分配可见窗口；
  CREATE_NO_WINDOW 下跳板持有不可见控制台（conhost），孙进程继承 → 全程无窗口。
  修复：daemon.start 的 creationflags 由 DETACHED_PROCESS 改为 CREATE_NO_WINDOW（注释记录原理）。
  注意：运行中的旧网关要重启（workbuddy stop && workbuddy start）才生效；会话模型可能正走网关，不在回合中自动重启。
- 阶段10（用户反馈：缺 stop 命令）：补齐 workbuddy restart/logs 与插件命令 zcw-stop/restart/models/logs；
  版本 0.1.0 -> 0.1.1（v0.1.0 tag 后首轮补丁），引擎与插件同步。发现并提示：
  网关上游请求跟随系统代理环境变量（trust_env），代理 127.0.0.1:7897 不可达期间上游会失败。
  另：已安装插件仍为 0.2.0（旧命令名），因版本重置后 0.1.x < 0.2.0，ZCode 不会视为可升级，
  需用户卸载后重装一次。
- 阶段11（用户反馈：技能名错误 + 双版本登录）：
  1) skill 改名 workbuddy-gateway -> workbuddyai-gateway（目录/frontmatter/全部命令引用）。
  2) 事实核查：凭证 domain=www.workbuddy.ai；两个域（workbuddy.ai / codebuddy.ai）的
     /v2/plugin/auth/state 均返回 200 且服务同一账号体系。
  3) 双域登录：cred.py 增加 REALMS + resolve_base_url（auto=凭证域 > prefs.realm > 国际版）；
     ensure_login/run_login/run_serve 透传 base_url；workbuddy login/serve 加 --realm {auto,intl,cn}。
     修复了"国内版新用户首次登录会打到国际域"的隐性 bug。
  4) /zcw-login 命令与 skill 更新：首次登录先问用户账号属于哪个域。
  5) 版本 0.1.1 -> 0.2.0（v0.1.x 已是真实 tag，双域登录属功能版本）。
- 阶段12（用户反馈：命令族按产品命名）：
  zcw-* 全部改回 workbuddyai-*（国际版族，workbuddy.ai，产品名 WorkBuddy AI）；
  新增 workbuddy-login（国内版族入口，codebuddy.ai，产品名 WorkBuddy/腾讯）。
  命名依据：社区实现里两版桌面应用分别为 workbuddy-desktop-ai.info（国际）与
  workbuddy-desktop.info（国内）。版本 0.2.0 -> 0.2.1。
  未做（待用户确认是否需要）：双账号配置档（per-realm credentials 并存与切换）——
  当前网关同一时间只服务一个账号，切换域=重新登录。
- 清理（用户要求）：移除全部测试相关内容 —— 删插件命令 `workbuddyai-test`；引擎删 `workbuddy test` 子命令（`cli.py` 的子解析器与分派、`daemon.test()`）、`POST /api/test-model` 端点与 `ControlBridge.test_model` / `ServiceState.test_model`，以及只被它复用的 `auth_flow.model_chat_probe()`；SKILL/README/marketplace/双 manifest 描述同步去掉「端到端测试」。引擎与插件版本 0.2.1 → 0.3.0（删除 CLI 子命令属破坏性变更）。
- 改名（用户要求）：项目更名 zcode-connect-workbuddyai → workbuddy-bridge（`zcode-` 只是「这是 ZCode 插件」的说明，项目本体是 workbuddy-bridge）。Python 包 `zcode_connect_workbuddyai` → `workbuddy_bridge`（pyproject 的 `[project.scripts]` 入口与 wheel packages 同步）、插件目录与双 manifest/marketplace 条目名 → `plugins/workbuddy-bridge`；应用数据目录 `~/.zcode-connect-workbuddyai` → `~/.workbuddy-bridge`（已加入 `_LEGACY_DIR_NAMES` 迁移链，凭证不丢）；GitHub 仓库改名 `bluechonk/workbuddy-bridge`。CLI 名 `workbuddy` 不变。
- 布局（用户要求）：ZCode 插件市场根由仓库根移到 `plugins/`（官方 plugin-creator 的本地 dev 布局）—— `git mv marketplace.json plugins/marketplace.json`，条目 `source` 由 `./plugins/workbuddy-bridge` 改为 `./workbuddy-bridge`；仓库根保持纯项目根（Python 包与文档不再算市场内容）。README、插件 README 与 `findings.md` 同步措辞。插件包内容未变，故引擎/插件版本不动（引擎 0.3.0 / 插件 0.3.0）；marketplace 条目与双 manifest 的 name/version/description 仍一致。ZCode 侧需把市场条目重新指向本仓库的 `plugins/` 目录。
- 布局回退（用户要求）：市场清单移回仓库根 —— `git mv plugins/marketplace.json marketplace.json`，条目 `source` 恢复为 `./plugins/workbuddy-bridge`。原因：仓库来源（GitHub 地址 / Git URL）的市场根就是克隆下来的仓库根，加载器只在 `<仓库根>/marketplace.json` 或 `<仓库根>/.claude-plugin/marketplace.json` 找清单，`plugins/marketplace.json` 对仓库来源读不到——即"市场根 = `plugins/`"只适用把 `plugins/` 目录本身粘贴给客户端的本地来源。README、插件 README、结构树与 `findings.md` 同步；顺带修正 README 两处过时说法（插件不在"本仓库之外的工作区"；本插件没有 MCP 工具，能力走命令 + 技能 + `workbuddy`）。插件包内容未变，引擎/插件版本不动（0.3.0）。ZCode 侧：市场改填仓库地址或粘贴仓库根目录。
- 双份清单：加入 `.claude-plugin/marketplace.json`（与根清单**逐字相同**的镜像；跨工具惯例，实测 17 个生态市场克隆里 14 个如此）。Hermes 侧校验脚本 `verify-layout.mjs`（技能 `software-development/zcode-plugin-development`）已升级为自动识别两种布局，并在两份不一致时直接报错。插件包内容未变，引擎/插件版本不动（0.3.0）。
- Hermes 插件层（新增）：`.hermes-plugin/plugin.yaml` + `__init__.py`，version 0.1.0（独立于引擎/插件版本）。
  作用只有一件：把插件自带的 `skills/workbuddyai-gateway` 注册给 Hermes 原生技能加载器
  （`ctx.register_skill(name, Path)`），装法 `hermes plugins install bluechonk/workbuddy-bridge`，
  加载名 `skill_view("workbuddy-bridge:workbuddyai-gateway")`。无 hook、无 tool、无副作用。
