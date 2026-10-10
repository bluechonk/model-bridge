# WorkBuddyAI 协议与上游事实

该渠道没有独立 `PROTOCOL.md`，协议事实记在这里（`docs/README.md` §2 指向本文）。
来源：2026-10-07 对旧实现与实测请求的整理；现行实现为 TypeScript
（`channels/workbuddyai/src/`），本文事实与代码逐条对应。

## 登录流程（纯 HTTP，无 GUI 依赖）

1. `POST {base}/v2/plugin/auth/state?platform=workbuddy`（匿名头 `X-No-*`）→ `{state, authUrl}`
2. 浏览器打开 authUrl，人工授权（唯一人工步骤）
3. `GET {base}/v2/plugin/auth/token?state=...` 每 5s 轮询，≤5 分钟 → accessToken / refreshToken 等
4. 凭据落盘 `~/.model-bridge/workbuddyai/credentials.json`（字段名与 Go 版一致，camelCase；uid 取 JWT sub）
5. 续期：`POST /v2/plugin/auth/refresh`，纯 HTTP

有凭证时先 `fetch_models` 探测；401/403 先 refresh，刷新失败删凭证引导重登。
授权成功后还会拉一次模型目录并落上游配置（解析 endpoint / tokenHeader 等）。

## 上游硬约束（网关实现的三条）

- 上游只支持流式；首条 message 必须 system；
- 按系统提示词指纹拦截：命中回 400 `code=11128`，网关按映射表改写
  （如 `Main branch (you will usually use this for PRs)` → 等价表述）；
- 每个 delta 带空 `tool_calls: []`，网关剥离，否则 ZCode 思考流出现碎块。

模型短名映射：`deepseek-flash` → `deepseek-v4.1-flash`（内置表）。

## ZCode 插件与市场机制（实测结论，影响本仓库布局的部分）

- 插件清单在 `.zcode-plugin/plugin.json`；hook 事件含 `SessionStart`
  （matcher `startup|resume|clear|compact`）等；
- 市场清单只在**市场根**查找（`marketplace.json` / `.claude-plugin/marketplace.json`）：
  用 GitHub 仓库作市场时根就是仓库根，`plugins/marketplace.json` 读不到
  → 本仓库的清单因此放在仓库根；
- 市场 id = 清单 `name`，同名不同源只能注册一个；安装 = 把插件源目录复制到
  `~/.zcode/cli/plugins/cache/<市场>/<插件>/<版本>/`；
- 插件的 hooks 是全局的（所有项目的所有会话都触发）→ 自动挂载需要开关
  （本仓库用 prefs 的 `auto_start`）。
