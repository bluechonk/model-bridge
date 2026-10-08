# 进度日志

## 会话 2026-10-07

- clone 仓库并通读：README / FLOW / FINDINGS / phase5-7 源码 / utils。
- 目录改名 catpaw-bridge；创建规划文件。
- 开始阶段1收尾 + 阶段2网关实现。

- 阶段1完成：package.json 改名/版本 0.2.0、`serve` script。
- 阶段2完成：src/gateway/（token.ts 凭据缓存 / openai.ts 翻译层 / catpaw.ts conversation 协议客户端 /
  server.ts 路由 / main.ts CLI）。typecheck 全绿。
- **协议逆向重大发现**（详见 findings.md）：phase7 固化的旧 turn 直连协议已失效（裸 turn 一律 500 空响应）；
  现役协议为三段式 round → event → turn → event，由 agent host 日志
  （~/.meituan-catpaw/<uid>/logs/api-request.log）证实今早仍在 200 成功运行，再经 icebears111/catpaw2api
  参考实现交叉验证后本机实测打通。
- 网关实测：流式文本（"OK"）、多轮历史（round.messages 收 user/assistant 混排）、
  工具调用（提示词注入 → 上游原生 tool_use 分块 → OpenAI tool_calls，finish_reason=tool_calls）、
  usage 修正、reasoning_content 映射。关键坑：上游错误帧会被旧 decodeFrame 静默吞掉（表现为空输出），
  帧解码器已显式处理；modelType 用 catalog 数字 id（如 deepseek-v4-flash=63）。
- 阶段3完成：workspace 插件壳 catpaw-bridge（MCP 工具 status/start/stop/models/test，
  无 login——登录在妙手桌面端完成），market ID dev-default-6d1575ef，
  插件 ID catpaw-bridge@dev-default-6d1575ef。
- 插件 MCP 冒烟通过：status（识别外部运行的网关）/ start（托管拉起）/
  stop（进程树清理干净，无监听残留）。
- 待用户：ZCode UI 手动添加市场并安装两个插件（zcode-workbuddy-bridge + catpaw-bridge），provider 接线手动完成。
- 新任务（阶段5）：解析妙手登录 URL，用户浏览器登录 + poll-token 轮询，分析返回字段。
- 阶段5完成：登录 URL 实测打通。login-config → login-entry(sid+state+redirect) → 302 passport.meituan.com
  → 用户浏览器登录 → poll-token 返回 152 字符不透明 token（非 JWT，指纹与桌面端凭据一致，
  model-types/round 实测 200）。临时文件已清理（token 原文不留盘）。
- 待决策：是否实现引擎 login 子命令 + 插件 login 工具（与 workbuddy 同构）。
- 阶段6完成：对齐 workbuddy 完成度。catpaw 守护 CLI（start/stop/status/models/login）全流程实测
  （修复 bin 双执行与守护 cwd 路径两个 bug）。
  插件改为命令壳 + SessionStart 钩子 + 技能（对齐用户的 zcw 系列模式），
  仓库即市场（根 marketplace.json），通过官方 fork 的 validate.py + build_dist.py。
  工作区旧 MCP 插件副本已移除（用户已自行清理 workspace/plugins）。
- 待用户：npm install -g . 装 catpaw；Plugin Marketplace 添加本仓库根目录；provider 接线。
- 清理（用户要求）：移除全部测试相关内容 —— 删 `tests/` 与 `vitest.config.ts`、`package.json` 去掉 test/check 的 vitest 环节与 vitest 依赖、`tsconfig` 去掉 tests 收录；引擎删 `catpaw test` 子命令（`runTest` + 用法/帮助/未知子命令文案），插件删 `/catpaw-test` 命令与 SKILL/README 里的相关条目，marketplace 与双 manifest 描述同步去掉「端到端测试」。引擎版本 0.2.0 → 0.3.0、插件版本 0.1.1 → 0.2.0（删除子命令/命令属破坏性变更）。
- 改名（用户要求）：项目更名 zcode-connect-catpaw → catpaw-bridge（`zcode-` 只是「这是 ZCode 插件」的说明，项目本体是 catpaw-bridge）。npm 包名、插件目录与双 manifest/marketplace 条目名（`plugins/catpaw-bridge`）、引擎与文档里的全部引用（含各 `@module` 标签）同步改名；应用数据目录 `~/.zcode-connect-catpaw` → `~/.catpaw-bridge`（`baseDir()` 首次运行时整目录改名，失败则退回旧目录继续用）；GitHub 仓库改名 `bluechonk/catpaw-bridge`。CLI 名 `catpaw` 不变。

## 会话 2026-10-07（Python 重写规划）

- 用户要求：把项目重写为 Python 版 zcode plugin（与 zcode-workbuddy-bridge 同构）。
- 通读两侧源码（catpaw gateway/phase1-7/utils/plugins + workbuddy 全部 Python 包与插件）。
- 定案：全量重写（产品层+研究层）｜同仓库就地替换｜依赖 aiohttp+requests+cryptography（uv）。
- 产出 [docs/protocols/catpaw/PYTHON-REWRITE-RECORD.md](../../protocols/catpaw/PYTHON-REWRITE-RECORD.md)：文件级映射、移植要点、P7.1–P7.7 分阶段、验证与风险。
- **未动任何 TS 代码**；等待批准后再进入 P7.1。

## 会话 2026-10-07（Python 全量重写实施）

- 安全快照：commit 0e65cf4 + tag `v0.3.0-ts`（TS 版可回滚）。
- 包：`src/catpaw_bridge/` —— protocol / sse / crypto / machineid / data_collection /
  decryption / upstream_client / cred / conversation / openai / gateway / headless / cli /
  daemon / login / paths / redact / probe / report / recon / analyze / locate_crypto + scripts/。
- 依赖 aiohttp / requests / cryptography（uv，hatchling 打包）；`[project.scripts]` 提供
  `catpaw` 与研究脚本入口（catpaw-recon/catpaw-scan/catpaw-analyze/catpaw-locate-crypto/catpaw-derive-key/
  catpaw-decrypt/catpaw-verify/catpaw-list-models）。
- **实测**：
  - `catpaw status` 离线解出桌面端密文，指纹 `cd04187a3ce0a820` 与 findings 完全一致；
  - 守护启停 + `/health` + `/v1/models`（真实上游返回 8 个模型）通过；
  - 真实上游端到端：流式文本 `OK`、非流式 `OK`、工具调用 `finish_reason=tool_calls`（参数正确）；
  - 研究脚本 `catpaw-verify`（解密+交叉比对+往返 True）、`catpaw-scan`、`catpaw-analyze`、`catpaw-recon`、
    `catpaw-locate-crypto`（命中 `Ze/Oe/re` 实现片段）全通过。
- 测试：`tests/` 28 项 pytest 全绿；`ruff check src tests` 全绿。
- 清理：删除 TS 资产（package*.json / tsconfig.json / node_modules / bin / scripts /
  src 下 phase1-7 + utils + gateway 的 .ts）。
- 文档/插件：README / AGENTS / .gitignore / 双 plugin.json / marketplace 同步为 Python/uv；
  插件与 marketplace 版本 0.3.0（安装方式由 npm 改为 uv，属用户可见变更），引擎版本 0.4.0；
  各 `docs/phaseN-*/RUN-LOG.md` 顶部补 Python 实现入口说明。
- 排障记录：开发机 shell 沙箱只允许写工作区，守护进程无法写 `~/.catpaw-bridge`
  （PermissionError）——用 `CATPAW_HOME` 指到工作区内完成端到端验证；另有一次残留网关
  持有 `gateway.log` 句柄导致新建同名文件被拒，杀掉残留进程即恢复。
- 市场布局（2026-10-07）：清单先移到 `plugins/`（官方本地 dev 布局），随后移回**仓库根**
  —— GitHub 地址 / Git URL 来源的市场根必然是克隆下来的仓库根，加载器只在
  `<根>/marketplace.json` 或 `<根>/.claude-plugin/marketplace.json` 找清单，
  `plugins/marketplace.json` 在仓库来源下读不到（只适用把 `plugins/` 目录本身当本地目录市场）。
  同时加入 `.claude-plugin/marketplace.json` 逐字镜像（跨工具惯例，实测 17 个生态克隆里 14 个为双份）。
  插件包内容未变，引擎 0.4.0 / 插件 0.3.0 不动。
- Hermes 插件层（新增）：`.hermes-plugin/plugin.yaml` + `__init__.py`，version 0.1.0（独立于引擎/插件版本）。
  作用只有一件：把插件自带的 `skills/catpaw-gateway` 注册给 Hermes 原生技能加载器
  （`ctx.register_skill(name, Path)`），装法 `hermes plugins install bluechonk/catpaw-bridge`，
  加载名 `skill_view("catpaw-bridge:catpaw-gateway")`；技能目录按三种布局解析
  （`<repo>/plugins/<插件名>/skills` → `<repo>/skills` → `<插件目录>/skills`），找不到就报错而不是静默跳过。
  无 hook、无 tool、无副作用；ZCode/Claude 那层不受影响。

## 会话 2026-10-08（上游体积上限与消息序列校验修复）

- 触发：ZCode 走 catpaw provider 时「工作中 45 秒 / 重新连接中 5/10」，11 次重试全 502；
  日志原文 `statusCode=502 statusMessage=上游请求失败: upstream HTTP 500`。
- 排查：网关/代理/上游三层健康，简单请求全 200；用 ZCode 真实请求体（32 工具、73 消息）
  复现失败，定位到**三个叠加缺陷**（详见 [findings.md](findings.md) 同名小节）。
- 修 1（`conversation.py`）：`_post_json` 只看 HTTP 状态码，上游 `200 + success:false`
  被当成功 → 继续发 turn → 误报成 500。改为解析 body（复用 `unwrap_api_data`），
  业务失败抛 `CatPawProtocolError` 并在 `chat_turn` 转成带原始 msg 的 error 事件。
- 修 2（`protocol.py` + `openai.py` + `gateway.py`）：上游对 `systemPromptOverride` 有
  **65508 字符**硬上限（JSON 转义后长度口径，二分实测 65508 过 / 65509 挂），而工具说明
  注入正好走这里（32 工具 = 77,859 字符）。新增 `fit_system_prompt` 逐级截断工具描述；
  用户自己的 system 就超限时回 400 `prompt_too_large`。
- 修 3（`openai.py` + `gateway.py`）：上游拒收连续 assistant（`assistant 消息不带 toolCall，
  后面必须是 user`），而 ZCode 的 tool 回合必然产出连续 assistant。改为把 assistant +
  tool 调用标记 + tool 结果合并成单条 assistant 文本；同时 `resolve_tool_name` 把模型
  手写的工具名（`bash`）大小写对齐回声明名（`Bash`）。
- 验证：同一条真实请求修复前 502 → 修复后 200（`finish_reason=stop`）；工具调用路径
  `finish_reason=tool_calls` 且名字正确回填 `Bash`；超限 prompt 得明确 400。
- 测试：`tests/` 28 → 41 项全绿；`ruff check src tests` 全绿。
- 运维提醒（已写入 findings.md）：`uv tool install` 装的是**副本**（非 editable），
  改 `src/` 后必须 `uv tool install --reinstall <仓库>` 才生效。

## 会话 2026-10-08（TypeScript 回归迁移）

- 用户规则：① 模型只放 flash 家族，大小写不敏感；② 必须重构成 TypeScript 项目；
  ③ docs 文档必须及时更新；④ 登录必须走真实 URL 方案，禁止从本地文件获取；
  ⑤ 可复用代码放到 model-bridge 共享层，禁止重复造轮子。
- 现状：catpaw 是最后一个 Python 渠道，且登录已实现真实 URL 方案（login-config →
  poll-token），满足规则 ④，无需排队。
- 新建 `package.json` + `tsconfig.json`（严格模式、NodeNext、只依赖
  `@model-bridge/gateway`），加入根 workspaces。
- 新建 7 个 TS 源文件（`src/` 严格符合 CONTRACT-TS.md §1.1）：
  - `channel.ts`：BridgeConfig（cid=catpaw，8790，`.catpaw-bridge`，兼容旧目录迁移）
  - `cred.ts`：**真实 URL 登录**（login-config → login-entry → poll-token），
    `load()` 只读 `~/.catpaw-bridge/credentials.json`；`refresh()` 抛错（无刷新端点）
  - `upstream.ts`：WIRE="custom"，conversation 三段式（round → event → turn），
    SSE 累积帧 suffix-diff → OpenAI delta；system 65508 上限校验；
    `buildChatBody` fire-and-forget 预发 round/event 后返回 turn body
  - `catalog.ts`：flash-only 白名单（共享 `isAllowedFamily`），兜底表 + 上游回填
  - `billing.ts`：无额度端点 → 抛 `CreditsError`（不伪造数字）
  - `cli.ts` / `index.ts`：入口与导出
- 构建：`npm run build` 通过（tsc 严格模式，0 错误）。
- 测试：`tests/selftest.test.ts` 23 用例全绿（路径/凭据/请求头/请求体/翻译器/
  目录/额度/端到端网关）。
- 清理：删除 `pyproject.toml` / `uv.lock` / `src/catpaw_bridge/`（Python 产品层）/
  `tests/test_*.py` / `.venv` / 缓存目录。
- 研究层保留：`recon.py` / `analyze.py` / `locate_crypto.py` / `decryption.py` /
  `crypto.py` / `machineid.py` / `data_collection.py` / `probe.py` / `report.py` /
  `scripts/` 迁到 `research/`（逆向结论是网关依据，保留其证据价值）。
- 文档同步：`README.md` / `AGENTS.md` 重写为 TypeScript 版。
- 待验证：真实机器端到端（catpaw login → start → 一次流式 chat），
  重点确认 fire-and-forget round/event 预发的时序无竞态。
