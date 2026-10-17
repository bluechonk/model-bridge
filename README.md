# modelmux

本地多渠道路由网关 CLI：把多个渠道汇成**一个 OpenAI 兼容端点**，对外暴露各渠道目录里的真实模型，
由全部渠道按账单用量自动供给。专注做一件事：`npx modelmux` 起网关，任何
OpenAI 兼容客户端指过来就能用。

## 这是什么

- **一个网关**：监听 `127.0.0.1:4412`，提供 `/v1/chat/completions`、`/v1/models`、`/health`。
- **动态模型池**：对外模型是全部渠道 `catalog` 的归一化并集（`/v1/models` 实时汇总）。
  客户端只写模型名，请求落到哪家渠道由网关按各渠道账单已用量决定（失败的渠道进冷却、当 0 处理）。
- **11 个渠道**：每个渠道是一个池子（模型目录 + 凭据 + 上游协议），注册在 `packages/core/channels/` 下。
- **自动化兜底**：签到、死凭据清理、账单/目录刷新、失败转移全部由网关自动完成。

## 目录

```
packages/
├── cli/                      CLI 入口（bin modelmux / mx，注册全部渠道后交给共享 CLI）
├── ui/                       Web 管理看板（React 19 SPA，`mx web` 托管）
└── core/                     服务端运行时
    ├── gateway/              共享层（网关 / 守护 / 路径 / 渠道注册表，不含任何渠道知识）
    └── channels/<cid>/       一个渠道 = 一个池子（只实现 cred / upstream / catalog / billing）
docs/                         契约与规范（渠道文档在各包 packages/core/channels/<cid>/docs/）
```

## 快速开始

```bash
npm install          # 装工作区依赖
npm run build        # 全仓编译（tsc -b + cli 单文件 bundle）
npm test             # build + 校验器 + 全部包的测试

node packages/cli/dist/cli.js start              # 启动网关（守护式，端口 4412）
node packages/cli/dist/cli.js model list         # 池视图：两个模型分别会落到谁
node packages/cli/dist/cli.js login <cid>        # 登录某个渠道（浏览器授权）
```

### 全局安装 / npx

`packages/cli` 构建后是自包含的单文件 bundle（`dist/cli.bundle.js`，内联 gateway
与全部渠道），可脱离本仓库安装；发布到 npm 后支持 `npx modelmux`：

```bash
npm i -g modelmux    # 或：cd packages/cli && npm pack && npm i -g ./modelmux-*.tgz
mx start                     # 任意目录直接可用（全名 modelmux 等价）
mx model list
```

注意：bundle 形态下陈旧构建检测（`status` 的 stale_build）找不到工作区根，会退化为
不报告——这是已知限制，不影响网关功能。

## 接入任意客户端

网关不绑定任何宿主工具：任何 OpenAI 兼容客户端（CLI、IDE、桌面应用）把 base url
指到 `http://127.0.0.1:4412/v1`，模型填 `deepseek-v4.1-flash` 或 `glm-5.3-flash`
（API key 任意非空）即可。

## 文档

契约与规范在 `docs/`（入口 [docs/README.md](docs/README.md)），**渠道文档跟包走**，在各包 `packages/core/channels/<cid>/docs/`：

| 想看什么 | 去哪 |
| --- | --- |
| 契约与规范（改代码前必读） | [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) |
| 公共模型池怎么选渠道 | [docs/POOL-ARCHITECTURE.md](docs/POOL-ARCHITECTURE.md) |
| 存储落点规范 | [docs/STORAGE-CONVENTION.md](docs/STORAGE-CONVENTION.md) |
| 某个渠道怎么用 | `packages/core/channels/<cid>/docs/README.md`（如 [packages/core/channels/qodercn/docs/README.md](packages/core/channels/qodercn/docs/README.md)） |
| 某个上游的协议细节 | `packages/core/channels/<cid>/docs/PROTOCOL.md` |

## 约定

- 文本文件一律 LF，`.gitattributes` 强制（见根 `.gitattributes`）。
- 代码注释中文、简洁；日志输出英文。
- 文档中文、不使用 emoji。
- 提交前 `npm test` 必须全绿；改完代码要重启网关（否则测到的是旧进程）。
