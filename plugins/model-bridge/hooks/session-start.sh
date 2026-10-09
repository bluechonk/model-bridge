#!/usr/bin/env bash
# SessionStart：幂等确保本地模型池网关在运行。任何失败都以 0 退出，绝不阻塞会话启动。
# 仓库级网关注册全部渠道，故只需一条命令（--auto 受 ~/.model-bridge/prefs.json 的 auto_start 约束）。

# CLI 多路探测：PATH -> ~/.local/bin -> 本插件所属仓库的构建产物
# （ZCode hook 进程的 PATH 不一定包含 npm 全局 bin，故需兜底到仓库内入口）
CLI_ARGS=()
c="$(command -v model-bridge 2>/dev/null)"
if [ -n "$c" ] && [ -x "$c" ]; then
  CLI_ARGS=("$c")
elif [ -x "$HOME/.local/bin/model-bridge" ]; then
  CLI_ARGS=("$HOME/.local/bin/model-bridge")
else
  # 插件目录 = <repo>/plugins/model-bridge，向上三级即仓库根
  repo="$(cd "$(dirname "$0")/../../.." && pwd)"
  if [ -f "$repo/packages/cli/dist/cli.js" ]; then
    CLI_ARGS=(node "$repo/packages/cli/dist/cli.js")
  fi
fi
[ ${#CLI_ARGS[@]} -gt 0 ] || exit 0

"${CLI_ARGS[@]}" start --auto --quiet --wait 6 >/dev/null 2>&1 || exit 0
exit 0
