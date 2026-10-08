# 任务计划：catpaw-bridge

## 目标

把 CatPaw（美团妙手）凭据逆向研究仓库改造为 zcode-*-bridge 形态（与 zcode-workbuddy-bridge 同构）：
在保留研究层（phase1~7）的基础上，补一个 **OpenAI 兼容本地网关**，
并产出 ZCode 插件壳 `catpaw-bridge`（MCP 工具 + skill + command）接入本地测试市场。

## 与 zcode-workbuddy-bridge 项目的结构差异（决定工作项）

| | zcode-workbuddy-bridge | catpaw-bridge |
| --- | --- | --- |
| 引擎形态 | 本来就是网关（Python） | 纯研究工具（TS），需**新写网关层** |
| 语言 | Python + uv | Node ≥22.18 原生 TS（零依赖，无构建） |
| 登录 | 浏览器设备授权（login 子命令） | **无独立登录**：读本机妙手桌面端落盘的登录态（桌面端负责登录） |
| 插件工具 | status/start/stop/login/models | status/start/stop/models（无 login） |

## 关键决策

| 决策 | 结论 | 原因 |
| --- | --- | --- |
| 项目改名 | 目录、package.json name → `catpaw-bridge` | 用户指定；仓库刚 clone，改目录无副作用 |
| 研究层保留 | phase1~7 与 docs 不动，只新增 `src/gateway/` | 逆向结论是网关的依据，也是仓库既有价值 |
| 网关端口 | 默认 `127.0.0.1:8790` | 避开 workbuddy 的 8787/8788 |
| 模型暴露 | 直接用上游 `model-types` 的 `id` 字段 | 不引入短名映射，减少一层维护 |
| 多轮对话 | 非系统消息折叠为带角色标注的 transcript，系统消息进 systemPromptOverride | 上游一次 turn 只吃一条 user 消息（协议事实，见 docs/FINDINGS.md §6） |
| 凭据 | `resolveLocalCredential()`（密文优先，auth.json 回退）+ mtime 缓存 | 复用 phase6/7 结论；铁律：任何输出只给指纹不给原文 |
| MCP 服务器 | 与 workbuddy 插件同构（零依赖 Node ESM stdio） | 已验证的模式直接复用 |

## 阶段

> **说明（2026-10-07）**：阶段 1–6 是 TS 版的历史记录（文件名即当时的 `.ts` / `.mjs`）；
> 阶段 7 已把这些实现全量换为 Python，新文件名对照见
> [docs/protocols/catpaw/PYTHON-REWRITE-RECORD.md](../../protocols/catpaw/PYTHON-REWRITE-RECORD.md)。

### 阶段1：改名与规划 — **Status:** complete

- [x] 目录改名 catpaw-bridge
- [x] package.json：name/version/description、新增 `serve` script

### 阶段2：OpenAI 兼容网关（src/gateway/） — **Status:** complete

- [x] token.ts：凭据加载（密文→auth.json 回退）+ mtime 缓存，只出指纹
- [x] openai.ts：请求翻译（messages→system+单 turn、tools 透传）；事件翻译（累积帧→OpenAI delta 流 / 聚合）
- [x] server.ts：node:http 路由 /health /v1/models /v1/chat/completions；模型目录 5 分钟缓存
- [x] main.ts：子命令 serve（默认）/ status；--json 事件行（start/ready/error/stopped）
- [x] 验证：typecheck + /health /v1/models + 一次最小真实请求

### 阶段3：ZCode 插件壳 — **Status:** complete

- [x] workspace/plugins/catpaw-bridge/：manifest、mcp/server.js、skill catpaw-gateway、命令 /catpaw、README
- [x] 加入现有 dev 市场（upsert helper），插件 ID 记录到 progress.md

### 阶段4：验证与交付 — **Status:** complete

- [x] 插件 MCP 冒烟（握手 / tools/list / status / start→models→stop）
- [x] 交付说明：手动安装 + provider 接线（baseUrl http://127.0.0.1:8790/v1）
      —— 落在 `plugins/catpaw-bridge/README.md` / `README_CN.md` 的「让 ZCode 走这个网关」一节

### 阶段5：登录 URL 逆向（无头登录可行性验证） — **Status:** complete

- [x] 从参考项目拿到 login-config / poll-token 具体端点与参数拼装方式
- [x] 实测 login-config 拿 loginEntryUrl，拼出 auth_url 交给用户在浏览器完成登录
- [x] 轮询 poll-token，记录返回的原始字段结构
- [x] 分析返回字段（JWT? 有效期? 与桌面端落盘 token 的关系），验证可用于模型请求
- [ ] 若 login-config 不可用：退路 1 查 app.asar；退路 2 agent-browser + mitm 抓包

### 阶段6：对齐 workbuddy 完成度 + zcode-plugins 规范 — **Status:** complete

- [x] 研究参照：zcode-workbuddy-bridge（zcb 守护 CLI / 仓库即市场 / 命令壳插件）与
      bluechonk/zcode-plugins fork（官方市场规范、validate.py/build_dist.py）
- [x] 引擎新增 catpaw CLI：bin/zcc.mjs + start/stop（守护式，PID 文件/prefs/僵尸清理）/
      status/models/login；serve 保留为前台模式
- [x] login 子命令实现（阶段5 验证的三步链路），凭据落盘 ~/.catpaw-bridge/credentials.json
      并作为凭据解析最高优先级来源
- [x] 插件重构：plugins/catpaw-bridge/（双 manifest + commands catpaw-*/hooks/session-start
      + skills/catpaw-gateway + README/README_CN），根 marketplace.json（仓库即市场）
- [x] fork 校验：scripts/validate.py 27 plugins validated；build_dist.py 产出 plugin.zip
- [x] 清理：工作区旧 MCP 版插件副本移除（用户已删 workspace/plugins）

## 遇到的错误

| 错误 | 尝试次数 | 解决方案 |
| --- | --- | --- |
| （暂无） | | |

## 备注

- 合规边界沿用仓库免责声明：只读本机自己账号的登录态；不提供绕过授权机制，不对外代理。
- token 铁律：日志/插件输出只允许指纹与脱敏形态。

---

## 阶段 7：TypeScript → Python 全量重写 — **Status:** complete

详细方案见 [docs/protocols/catpaw/PYTHON-REWRITE-RECORD.md](../../protocols/catpaw/PYTHON-REWRITE-RECORD.md)。

| 决策 | 结论 |
| --- | --- |
| 范围 | 全量：产品层 + 研究层（phase1-7 与 scripts） |
| 落地 | 同仓库就地替换，保留 git 历史 / 插件 ID / marketplace / 应用目录 |
| 依赖 | aiohttp + requests + cryptography（对齐 zcode-workbuddy-bridge），uv 管理 |

| 子阶段 | 内容 | 状态 |
| --- | --- | --- |
| P7.1 骨架 | 打 tag（v0.3.0-ts）；pyproject.toml + 包目录 + paths/redact/probe/report | complete |
| P7.2 协议与加解密 | protocol/sse/machineid/crypto/data_collection/decryption/upstream_client/cred/conversation | complete |
| P7.3 网关 | openai/gateway/headless | complete |
| P7.4 CLI 与守护 | cli/daemon/login/__main__ | complete |
| P7.5 研究脚本 | recon/analyze/locate_crypto + scripts | complete |
| P7.6 插件与文档 | README/AGENTS/.gitignore/双 plugin.json/marketplace 改 uv | complete |
| P7.7 验证 | ruff + pytest(28) + 真实机器端到端（流式/非流式/工具调用） | complete |
| P7.8 清理 | 删除 TS 资产与构建链 | complete |
| P7.9 上游上限与序列校验修复 | 业务失败识别（200+success:false）/ 65508 体积收敛 / 连续 assistant 合并 / 工具名对齐；pytest 41 | complete |

**开放问题（已决）**：CLI 名与包名沿用 `catpaw` / `catpaw-bridge`、应用目录不变；未加 portfree；
已恢复 pytest 测试（协议/加解密/SSE/翻译/网关离线）。

**排障记录**：开发机 shell 沙箱只允许写工作区 → 用 `CATPAW_HOME` 覆盖应用目录完成端到端；
残留网关持有 `gateway.log` 句柄导致新建同名文件 PermissionError → 杀残留进程后恢复。
（2026-10-08）ZCode 接入后 502：三个叠加缺陷，详见 [findings.md](findings.md)
「上游体积上限与消息序列校验」。
