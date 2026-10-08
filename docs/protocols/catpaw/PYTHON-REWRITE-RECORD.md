# catpaw-bridge：TypeScript → Python 全量重写（方案 + 实施记录）

**状态：已完成（2026-10-07）** —— 实施见提交 `20a1e5b`；动手前的 TS 快照为提交 `0e65cf4` / tag `v0.3.0-ts`。

已定决策：

| 决策 | 结论 |
| --- | --- |
| 重写范围 | **全量**：产品层（网关/CLI/插件/协议/加解密）+ 研究层（phase1-7 与 scripts） |
| 落地方式 | **同仓库就地替换**，保留 git 历史、插件 ID、marketplace 结构与 `~/.catpaw-bridge` 应用目录 |
| 依赖策略 | **aiohttp + cryptography（对齐 zcode-workbuddy-bridge）**，uv 管理 |

---

## 1. 目标 / 非目标

**目标**：把仓库从 Node/TS 迁为纯 Python（uv），对外行为保持不变：

- 本地 OpenAI 兼容网关 `127.0.0.1:8790`（`/health` `/v1/models` `/v1/chat/completions`，流式 + 非流式）
- `catpaw` CLI：`serve / start / stop / status / models / login`
- ZCode 插件壳：commands + SessionStart hook + skill（本仓库即市场）
- 无头浏览器授权登录（login-config → login-entry → poll-token）
- 凭据三级回退（无头凭据 → 桌面端密文 → CLI 明文，mtime 自动生效）
- conversation 三段式协议（round → event → turn → event）+ 累积帧 suffix-diff
- 工具调用模拟（提示词注入 + `tool_call` 块解析）、`reasoning_content` 映射、usage 修正

**非目标**：不改上游协议/端口/插件 ID；不做功能增强；**不引入 workbuddy 的 console :8788**（catpaw 原本就没有控制台 API，状态全走 CLI）。

**先决动作（防丢）**：动手前给当前 TS 状态打 tag（如 `v0.3.0-ts`）或建分支，便于对照与回滚。**已执行**：tag `v0.3.0-ts` + 提交 `0e65cf4`。

---

## 2. 参考模板

`zcode-workbuddy-bridge`（Python/uv）几乎逐文件对应，直接照搬其工程形态：

| workbuddy | 作用 | catpaw 对应来源（TS） |
| --- | --- | --- |
| `cli.py` | argparse 子命令 | `gateway/main.ts` |
| `daemon.py` | start/stop/status、PID、健康等待 | `gateway/daemon.ts` |
| `headless.py` | serve/login 运行态 + JSON 事件行 | `gateway/main.ts` runServe/runLogin |
| `gateway.py` | aiohttp 网关 | `gateway/server.ts` |
| `sse_stream.py` | 上游流处理 | `phase7/sse.ts`（**不是透传，是 suffix-diff**） |
| `paths.py` | 应用目录 + 旧目录迁移 | `gateway/paths.ts` |
| `cred.py` / `auth_flow.py` | 凭证读写/刷新/登录 | `gateway/token.ts` + `gateway/login.ts` |
| `portfree.py` | 端口自愈 | （catpaw 无，可选加） |
| `catalog.py` | 模型短名映射 | （catpaw 无，直接用上游 id） |

---

## 3. 目标结构（Python 包）

```
catpaw-bridge/
├── pyproject.toml                 # [project] + [project.scripts] catpaw = "catpaw_bridge.cli:main"
│                                  # dependencies: aiohttp, requests, cryptography
├── uv.lock
├── marketplace.json               # ZCode 插件市场清单（市场根 = 仓库根；GitHub 地址与本地目录两种加法都可用）
├── plugins/catpaw-bridge/   # 基本不变（命令文案/安装说明对齐 uv）
├── docs/                          # 保留；RUN-LOG 引用更新
└── src/catpaw_bridge/
    ├── __init__.py  __main__.py
    ├── cli.py                     # serve/start/stop/status/models/login
    ├── daemon.py                  # 守护式启停（PID 文件、健康等待、prefs.auto_start）
    ├── headless.py                # run_serve / run_login + JSON 事件行
    ├── gateway.py                 # aiohttp app：/health /v1/models /v1/chat/completions
    ├── openai.py                  # OpenAI ↔ conversation 翻译 + 工具调用模拟 + 累加器
    ├── conversation.py            # round→event→turn 客户端 + ConversationFrameDecoder
    ├── protocol.py                # 常量 / envelope / types / SuffixDiff
    ├── sse.py                     # SseReader（逐行、TCP 半行）+ SuffixDiff
    ├── upstream_client.py         # listModels + modelinfo 归一化
    ├── cred.py                    # 凭据三级回退 + mtime 缓存 + 脱敏快照
    ├── login.py                   # 无头浏览器授权
    ├── paths.py                   # ~/.catpaw-bridge 布局 + 妙手安装布局 + 旧目录迁移
    ├── redact.py                  # mask_secret / fingerprint
    ├── crypto.py                  # AES-256-GCM 加解密 + 密钥派生
    ├── machineid.py               # 机器码读取（reg/ioreg/machine-id）
    ├── data_collection.py         # 候选落点清单 + readDesktopAuth/readEncryptedSsoToken（phase2）
    ├── recon.py                   # phase1 侦察
    ├── analyze.py                 # phase3 密文格式/熵分析
    ├── locate_crypto.py           # phase4 app.asar 静态检索
    ├── probe.py  report.py        # 研究工具（utils）
    └── scripts/                   # 研究脚本：recon/scan/analyze/locate-crypto/derive-key/decrypt/verify/list-models
```

---

## 4. 文件级映射表

| TS（现状） | Python（目标） | 说明 |
| --- | --- | --- |
| `src/gateway/main.ts` | `cli.py` + `headless.py` | argparse；`--json` 事件行 |
| `src/gateway/server.ts` | `gateway.py` | aiohttp 三路由，`web.StreamResponse` 流式 |
| `src/gateway/openai.ts` | `openai.py` | 请求/响应翻译、`buildToolsPrompt`、`extractToolCalls`、`CompletionAccumulator` |
| `src/gateway/catpaw.ts` | `conversation.py` | 三段式协议 + 帧解码器（累积帧 → 增量） |
| `src/gateway/token.ts` | `cred.py` | 三级回退（headless→密文→auth.json→env）+ mtime 缓存 |
| `src/gateway/login.ts` | `login.py` | login-config → 拼 auth_url → poll-token 轮询 |
| `src/gateway/daemon.ts` | `daemon.py` | 幂等 start、僵尸清理、PID、健康等待、`taskkill /T /F` |
| `src/gateway/paths.ts` | `paths.py` | 应用目录 + 旧目录改名迁移 |
| `src/utils/paths.ts` | `paths.py`（合并） | 妙手安装/userData 布局（含 env 覆盖） |
| `src/utils/redact.ts` | `redact.py` | `mask_secret` / `fingerprint` |
| `src/utils/probe.ts` / `report.ts` | `probe.py` / `report.py` | 研究工具 |
| `src/phase7/{constants,types,envelope}.ts` | `protocol.py` | 常量/信封/类型 |
| `src/phase7/sse.ts` | `sse.py` | `SseReader` + `SuffixDiff` |
| `src/phase7/client.ts` | `upstream_client.py` | `listModels` + `to_model_info` |
| `src/phase7/index.ts` | `cred.py`（`resolveLocalCredential`） | 凭据桥接 |
| `src/phase6/tokenCrypto.ts` + `index.ts` | `crypto.py` | AES-256-GCM + 派生 + 交叉验证 |
| `src/phase5/index.ts` | `machineid.py` | 机器码读取（归一化同 node-machine-id） |
| `src/phase2/index.ts` | `data_collection.py` | 候选清单 + readDesktopAuth/readEncryptedSsoToken |
| `src/phase1/index.ts` | `recon.py` | 侦察报告 |
| `src/phase3/index.ts` | `analyze.py` | 长度/熵/可打印占比 |
| `src/phase4/index.ts` | `locate_crypto.py` | app.asar 逐块检索 |
| `scripts/*.ts` | `src/catpaw_bridge/scripts/*.py` | recon/scan/analyze/locate-crypto/derive-key/decrypt/verify/list-models |
| `bin/zcc.mjs` | **删除** | 改 uv console script `catpaw` |
| `plugins/**` | 基本不变 | 命令里 `catpaw ...` 调用不变 |
| `package.json` / `package-lock.json` / `tsconfig.json` / `node_modules` | **删除** | 换 `pyproject.toml` / `uv.lock` |
| `src/**/*.ts` | **删除**（逻辑已移植） | — |

---

## 5. 移植要点与硬点

1. **加解密（cryptography）**
   `key = sha256(f"{machine_id}:catpaw-desk-token-v2").digest()`；`envelope = base64(iv[12] ‖ tag[16] ‖ ct)`；
   用 `cryptography.hazmat.primitives.ciphers.aead.AESGCM`，解密 `decrypt(iv, ct+tag, None)`。
2. **机器码**（`machineid.py`）：Windows `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid`（取 `REG_SZ` 之后、去空白、转小写）；macOS `ioreg -rd1 -c IOPlatformExpertDevice` 取 `IOPlatformUUID`；Linux `/etc/machine-id` → `/var/lib/dbus/machine-id`。归一化必须与 `node-machine-id` 一致，否则派生出错误密钥。
3. **SSE suffix-diff**（`sse.py`）：逐行缓冲（TCP 可能切半行）+ `finish()` 处理残余；`SuffixDiff` 对 text/reasoning/toolArgs 各自做"新串以旧串为前缀则取差"。
4. **aiohttp 网关**（`gateway.py`）：上游流式用 aiohttp client，超时 15 分钟；客户端流式用 `web.StreamResponse` 逐块 `write`；工具场景强制缓冲后一次性补发文本 + tool_calls；错误帧 `{conversationId,error:{...}}` 必须显式识别（否则表现为空输出）。
5. **守护进程**（`daemon.py`）：`subprocess.Popen([sys.executable, "-m", "catpaw_bridge", "serve", "--json", ...])`；Windows 用 `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`（workbuddy 已验证：避免 uv 跳板弹出可见控制台）；PID 文件 + 健康等待 + 僵尸清理。
6. **登录**（`login.py`）：`login-config` → `login-entry?sid=&state=&redirect=`（三参数缺一不可）→ 浏览器 → 每 3s `poll-token`；`webbrowser.open`。
7. **凭据铁律不变**：只输出指纹/脱敏（`redact.py`），token 原文只在内存。
8. **研究层**：`node:sqlite` → Python `sqlite3`（只读模式）；app.asar 检索 → Python 分块 `bytes.find`。
9. **路径迁移**：`~/.zcode-connect-catpaw` → `~/.catpaw-bridge` 首次整目录改名（沿用 TS 逻辑）。

---

## 6. 分阶段任务

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **P7.1 骨架** | 打 tag；`pyproject.toml`（uv、aiohttp/requests/cryptography、`catpaw` 入口）；包目录；`paths.py`/`redact.py`；删除 TS 构建链与 `src/**/*.ts` | **完成** |
| **P7.2 协议与加解密** | `protocol.py` `sse.py` `conversation.py` `upstream_client.py` `crypto.py` `machineid.py` `cred.py` | **完成** |
| **P7.3 网关** | `openai.py` `gateway.py` `headless.py` | **完成** |
| **P7.4 CLI 与守护** | `cli.py` `daemon.py` `login.py` `__main__.py` | **完成** |
| **P7.5 研究脚本** | `recon.py` `analyze.py` `locate_crypto.py` `data_collection.py` + `scripts/` | **完成** |
| **P7.6 插件与文档** | 插件命令/hook/skill 安装说明改 uv；README/AGENTS 重写；marketplace 描述同步 | **完成** |
| **P7.7 验证** | ruff + 真实机器端到端 + 与 TS 版逐项对照 | **完成** |

---

## 7. 验证清单

- 静态：`uv run ruff check`（对齐 zcb 的 ruff 配置）；可选 `pyright`。
- CLI：`catpaw status/start/stop/models` 可用；`catpaw login` 打通。
- 端到端（真实机器、真实账号）：
  1. `catpaw login` → `catpaw status` 指纹与桌面端凭据一致
  2. `catpaw start` → `curl /health` `/v1/models`
  3. 一次流式 chat（"OK"）→ 文本增量正确
  4. 一次工具调用（提示词注入 → `finish_reason=tool_calls`）
  5. reasoning_content 映射 + usage 修正
- 对照：同机同凭据，Python 版与 TS 版输出结构逐项比对。

---

## 8. 风险与开放问题

| 风险 | 说明 / 缓解 |
| --- | --- |
| 就地删除 TS 不可逆 | 动手前打 tag/分支；逻辑已全部移植并逐项对照后再删 |
| 行为漂移 | 错误码、`finish_reason`、`reasoning_content`、usage 修正需与 TS 版对齐 |
| cryptography 安装 | win/mac/linux 均有 wheel，`uv` 自动处理 |
| hook 依赖 PATH 上的 `catpaw` | 与 workbuddy 同模式（`uv tool install .`），已可行 |
| 端口 8790 占用 | 可选移植 workbuddy 的 `portfree.py` 端口自愈 |
| 研究层 SQLite/asar | Python `sqlite3`（只读）+ 分块检索，等价复刻 |

**决策结果（实施时确定）**：

1. CLI 名沿用 `catpaw`，包名 `catpaw-bridge`，应用目录 `~/.catpaw-bridge`（含旧目录 `.zcode-connect-catpaw` 迁移链）—— 全部不变，零迁移成本。
2. `portfree.py` 端口自愈**未移植**：catpaw 没有控制台/端口回退需求，8790 被占用时 `catpaw start` 会直接报错。
3. 测试**已恢复**：`tests/` 下 4 个 pytest 文件、28 个用例（协议帧解码 / 加解密 / SSE / OpenAI 翻译 / 网关离线），`uv run pytest` 全绿。

> **后续补记（2026-10-08）**：用例数 28 → **41**（新增上游体积收敛、消息序列校验、
> 工具名对齐三组，见 [findings.md](../../journals/catpaw/findings.md)「上游体积上限与消息序列校验」）。
> 另：`uv tool install` 装的是副本（非 editable），改完 `src/` 必须
> `uv tool install --reinstall <仓库>` 再 `catpaw restart` 才生效。
