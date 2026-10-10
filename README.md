# model-bridge

本地多渠道路由网关：一个 OpenAI 兼容端点，对外只暴露两个模型，由 11 个渠道按账单用量自动供给；
仓库本身就是一个 ZCode 插件市场。

## 这是什么

- **一个网关**：监听 `127.0.0.1:8787`，提供 `/v1/chat/completions`、`/v1/models`、`/health`。
- **两个对外模型**：`deepseek-v4.1-flash` 与 `glm-5.3-flash`。客户端只写模型名，
  请求落到哪家渠道由网关按各渠道账单已用量决定（失败的渠道进冷却、当 0 处理）。
- **11 个渠道**：每个渠道是一个池子（模型目录 + 凭据 + 上游协议），注册在 `channels/` 下。
- **仓库即插件**：`plugins/model-bridge/` 是唯一的 ZCode 插件（命令 / 技能 / hook），
  插件按固定路径加载，因此留在原位。

## 目录

```
packages/gateway/    共享层（网关 / 守护 / 路径 / 渠道注册表，不含任何渠道知识）
packages/cli/        仓库级入口（bin model-bridge，注册全部渠道后交给共享 CLI）
channels/<cid>/      一个渠道 = 一个池子（只实现 cred / upstream / catalog / billing）
plugins/model-bridge/  唯一的 ZCode 插件
docs/                全部文档（索引见 docs/README.md）
```

## 快速开始

```bash
npm install          # 装工作区依赖
npm run build        # 全仓编译（tsc -b + cli 单文件 bundle）
npm test             # 校验器 + 全部包的测试

node packages/cli/dist/cli.js start              # 启动网关（守护式，端口 8787）
node packages/cli/dist/cli.js model list         # 池视图：两个模型分别会落到谁
node packages/cli/dist/cli.js channels           # 渠道视角：每个渠道贡献了什么
node packages/cli/dist/cli.js <cid> login        # 登录某个渠道（浏览器授权）
```

### 全局安装 CLI

`packages/cli` 构建后是自包含的单文件 bundle（`dist/cli.bundle.js`，内联 gateway
与全部渠道），可脱离本仓库安装：

```bash
cd packages/cli && npm pack      # 产出 tarball（仅 bundle + package.json）
npm i -g ./model-bridge-cli-*.tgz   # 或 npm i -g <git 地址>/packages/cli
model-bridge model list          # 任意目录直接可用（别名 mb 等价）
```

注意：bundle 形态下陈旧构建检测（`status` 的 stale_build）找不到工作区根，会退化为
不报告——这是已知限制，不影响网关功能。

## 文档

全部文档在 `docs/`，入口是 [docs/README.md](docs/README.md)：

| 想看什么 | 去哪 |
| --- | --- |
| 契约与规范（改代码前必读） | [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) |
| 公共模型池怎么选渠道 | [docs/POOL-ARCHITECTURE.md](docs/POOL-ARCHITECTURE.md) |
| 存储落点规范 | [docs/STORAGE-CONVENTION.md](docs/STORAGE-CONVENTION.md) |
| 某个渠道怎么用 | `plugins/model-bridge/commands/model-bridge-<cid>.md` |
| 某个上游的协议细节 | `docs/protocols/<cid>/PROTOCOL.md` |

## 约定

- 文本文件一律 LF，`.gitattributes` 强制（见根 `.gitattributes`）。
- 代码注释中文、简洁；日志输出英文。
- 文档中文、不使用 emoji。
- 提交前 `npm test` 必须全绿；改完代码要重启网关（否则测到的是旧进程）。
