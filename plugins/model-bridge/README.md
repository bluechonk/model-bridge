# model-bridge（ZCode 插件）

把本仓库的**多渠道路由网关**接到 ZCode：一个本地 OpenAI 兼容端点 + 11 个渠道（**模型池**），
对外只暴露两个模型（`deepseek-v4.1-flash` / `glm-5.3-flash`）——
请求落到哪家渠道由网关按各渠道账单用量自动决定（见 [docs/POOL-ARCHITECTURE.md](../../docs/POOL-ARCHITECTURE.md) §2）。

## 装

插件只带命令/技能/hook；引擎（`mb` CLI）来自 [`packages/cli`](../../packages/cli)：

```bash
npm install                  # 仓库根：装工作区依赖
npm run build                # 编译全部包（含单文件 bundle）
cd packages/cli && npm pack  # 产出 tarball
npm i -g ./model-bridge-cli-*.tgz   # 全局安装 mb / model-bridge 命令
```

然后在 ZCode 里添加本仓库为插件市场（仓库地址或本地目录），安装 `model-bridge` 插件。

## 用

命令都是**跨渠道**的（没有 per-channel 命令）；需要落到某个渠道而用户没指明时，
先用只读命令拿渠道清单，再用提问工具（`ask_user_query`）让用户选。

- `mb channels` —— 渠道与模型（配 provider 的清单）
- `mb status` / `start` / `stop` / `restart` / `logs`
- `mb login --channel <cid>` —— 浏览器授权（唯一需要人工的步骤）；先让用户选渠道
- `mb models` / `credits` / `checkin` / `paths --all`
- `mb accounts` —— 账号池（`add` / `use <key>` / `remove <key>`，用 `--channel <cid>` 指定渠道）

ZCode 里的 provider（**必须用户手配**）：类型 `openai-chat-completions`、
baseUrl `http://127.0.0.1:8787/v1`、API key 任意非空、模型填池内 id
（`deepseek-v4.1-flash` 或 `glm-5.3-flash`，不带渠道前缀）。

## 其它客户端（Hermes / 任意 OpenAI 客户端）

网关不依赖 ZCode：任何 OpenAI 兼容客户端把 base url 指到 `http://127.0.0.1:8787/v1`
就能用，模型 id 用 `mb model list` 列出的两个池 id
（`deepseek-v4.1-flash` / `glm-5.3-flash`，不带渠道前缀）。

这类客户端**不需要**各自的插件层（曾经给 Hermes 做过 `.hermes-plugin/`，已移除）——
只要 ZCode 侧把网关跑起来，其它客户端直接共享同一个端点，凭据与账号池由网关统一管理。

## 排障

- 网关起不来：`mb logs`（`~/.model-bridge/gateway.log`）
- 池子是空的：该渠道未登录或上游目录拉取失败
- `400 unknown_model`：模型名不是池内两个字面量（旧的 `<cid>/<模型>` 形态已移除）；
  `503 not_authenticated`：候选渠道都没登录
- 落点与迁移：`mb paths --all`；规范见 [docs/STORAGE-CONVENTION.md](../../docs/STORAGE-CONVENTION.md)
