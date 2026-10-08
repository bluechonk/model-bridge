#!/usr/bin/env bash
# SessionStart：幂等确保本地模型池网关在运行。任何失败都以 0 退出，绝不阻塞会话启动。
# 仓库级网关注册全部渠道，故只需一条命令（--auto 受 ~/.model-bridge/prefs.json 的 auto_start 约束）。
Z="$(command -v model-bridge || echo "$HOME/.local/bin/model-bridge")"
[ -x "$Z" ] || exit 0
"$Z" start --auto --quiet --wait 6 >/dev/null 2>&1 || exit 0
exit 0
