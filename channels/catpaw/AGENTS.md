# AGENTS.md

本仓库是 **本地网关 + 逆向研究** 项目：不提供任何对外运行时能力，只服务本机、本账号。
当前实现为 **TypeScript**（Node ≥ 22.6），是 `model-bridge` 工作区的一个渠道包。

## 不可协商的约束

- **凭据零入库、零回显**：不得把任何真实 token / 机器码 / 密钥写进代码、文档、
  日志或 commit。对外输出只允许脱敏形态（`前缀…[长度]`）与 sha256 指纹。
- **只读为本**：所有研究脚本默认不得写入妙手的安装目录与 userData 目录；
  唯一允许的写操作是仓库自己的目录与 `~/.catpaw-bridge/`。
- **唯一出网口**：`catpaw` CLI 与网关按设计访问上游；新增任何出网代码前先问用户。
- **证据等级不可省**：任何结论必须带 `[实测]` / `[代码]` / `[推断]` / `[参考]` 标记
  （定义见 `docs/protocols/catpaw/PROTOCOL.md`）。禁止把推断写成实测。
- **算法结论以代码为准**：不得靠长度/熵"猜"算法；必须给出 `app.asar` 里的实现片段。

## 机制约束

- TypeScript ≥ 5.9，严格模式，Node ≥ 22.6；零第三方运行依赖。
- `src/` 只有 7 个文件（`channel.ts` / `cli.ts` / `index.ts` / `cred.ts` /
  `upstream.ts` / `catalog.ts` / `billing.ts`），其余一律复用 `@model-bridge/gateway`。
- 文本文件一律 **LF**（`.gitattributes` 已锁定）。
- 文档与代码同 commit 更新：改了阶段实现就要改对应文档。

## 改动前的检查

```bash
npm run build        # 编译到 dist/（tsc 严格模式）
npm run typecheck    # 类型检查
npm test             # node --test tests/selftest.test.ts，必须全绿
```

全仓验证（在工作区根）：

```bash
npm run build && npm run test --workspaces --if-present
```

涉及登录链路、上游协议翻译的改动，必须额外跑一次真实机器验证：
`catpaw login` → `catpaw status` → 一次真实流式 chat。