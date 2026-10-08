# model-bridge（ZCode 插件）

把本仓库的**多渠道路由网关**接到 ZCode：一个本地 OpenAI 兼容端点 + 12 个渠道（**模型池**）。

## 装

插件只带命令/技能/hook；引擎（`model-bridge` CLI）来自 [`packages/cli`](../../packages/cli)：

```bash
npm install                 # 仓库根：装工作区依赖
npm run build               # 编译全部包
npm link @model-bridge/cli  # 让 model-bridge 命令进 PATH
```

然后在 ZCode 里添加本仓库为插件市场（仓库地址或本地目录），安装 `model-bridge` 插件。

## 用

- `model-bridge channels` —— 渠道与模型（配 provider 的清单）
- `model-bridge status` / `start` / `stop` / `restart` / `logs`
- `model-bridge login --channel <cid>` —— 浏览器授权（唯一需要人工的步骤）
- `model-bridge models` / `credits` / `paths --all`
- `model-bridge accounts` —— 账号池（`add` / `use <key>` / `remove <key>`，用 `--channel <cid>` 指定渠道）

ZCode 里的 provider（**必须用户手配**）：类型 `openai-chat-completions`、
baseUrl `http://127.0.0.1:8787/v1`、API key 任意非空、模型填 `<cid>/<模型>`。

## 其它客户端（Hermes / 任意 OpenAI 客户端）

网关不依赖 ZCode：任何 OpenAI 兼容客户端把 base url 指到 `http://127.0.0.1:8787/v1`
就能用，模型 id 用 `model-bridge channels` 列出的 `<cid>/<模型>`。

这类客户端**不需要**各自的插件层（曾经给 Hermes 做过 `.hermes-plugin/`，已移除）——
只要 ZCode 侧把网关跑起来，其它客户端直接共享同一个端点，凭据与账号池由网关统一管理。

## 排障

- 网关起不来：`model-bridge logs`（`~/.model-bridge/gateway.log`）
- 池子是空的：该渠道未登录或上游目录拉取失败
- `400 unknown_channel`：cid 前缀写错；`503 not_authenticated`：该渠道没登录
- 落点与迁移：`model-bridge paths --all`；规范见 [docs/STORAGE-CONVENTION.md](../../docs/STORAGE-CONVENTION.md)
