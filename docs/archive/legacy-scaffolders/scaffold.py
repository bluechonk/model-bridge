"""bridge 项目生成器：从 workbuddy-bridge 的规范批量生成 <name>-bridge 骨架。

用法：
    python scaffold.py            # 生成全部
    python scaffold.py zcode      # 只生成一个

设计：**共享模块复制而非引用**。用户要求「项目不再合并、每个都分开」，
故每个项目自带完整副本（改一个项目的 daemon.py 不影响别的）。
参数化替换见 `SUBS`。

渠道特有的协议模块（cred / upstream / gateway / catalog）**不由本脚本生成**
—— 那些必须按各渠道的实际协议手写。本脚本只产出「所有项目都一样」的部分。
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TEMPLATE_SRC = ROOT / "workbuddy-bridge" / "src" / "workbuddy_bridge"
TEMPLATE_PLUGINS = ROOT / "workbuddy-bridge" / "plugins" / "workbuddy-bridge"

# ── 渠道定义 ────────────────────────────────────────────────────────────────
#
# 字段：id（目录名/包名/CLI 名）、display（展示名）、port（网关端口）、
#       ui_port（控制台端口）、env（HOME 覆盖变量）、vendor（厂商，README 用）、
#       realms（是否有国内/国际双版本）、keywords（插件市场关键词）

CHANNELS: list[dict[str, object]] = [
    {
        "id": "qoder",
        "display": "Qoder",
        "port": 8801,
        "ui_port": 8802,
        "env": "QODER_HOME",
        "vendor": "阿里系",
        "realms": True,
        "keywords": ["qoder", "gateway", "openai", "proxy", "cli"],
    },
    {
        "id": "zcode",
        "display": "ZCode",
        "port": 8803,
        "ui_port": 8804,
        "env": "ZCODE_HOME",
        "vendor": "智谱 z.ai",
        "realms": False,
        "keywords": ["zcode", "zai", "glm", "gateway", "openai", "proxy", "cli"],
    },
    {
        "id": "trae",
        "display": "TRAE",
        "port": 8805,
        "ui_port": 8806,
        "env": "TRAE_HOME",
        "vendor": "字节跳动",
        "realms": False,
        "keywords": ["trae", "gateway", "openai", "proxy", "cli"],
    },
    {
        "id": "codearts",
        "display": "CodeArts",
        "port": 8807,
        "ui_port": 8808,
        "env": "CODEARTS_HOME",
        "vendor": "华为云",
        "realms": False,
        "keywords": ["codearts", "huawei", "gateway", "openai", "proxy", "cli"],
    },
    {
        "id": "lobsterai",
        "display": "LobsterAI",
        "port": 8809,
        "ui_port": 8810,
        "env": "LOBSTERAI_HOME",
        "vendor": "有道",
        "realms": False,
        "keywords": ["lobsterai", "youdao", "gateway", "openai", "proxy", "cli"],
    },
    {
        "id": "cline",
        "display": "Cline",
        "port": 8811,
        "ui_port": 8812,
        "env": "CLINE_HOME",
        "vendor": "Cline",
        "realms": False,
        "keywords": ["cline", "workos", "gateway", "openai", "proxy", "cli"],
    },
    {
        "id": "loomy",
        "display": "Loomy",
        "port": 8813,
        "ui_port": 8814,
        "env": "LOOMY_HOME",
        "vendor": "讯飞",
        "realms": False,
        "keywords": ["loomy", "xunfei", "gateway", "openai", "proxy", "cli"],
    },
    {
        "id": "raccoon",
        "display": "Raccoon",
        "port": 8815,
        "ui_port": 8816,
        "env": "RACCOON_HOME",
        "vendor": "商汤",
        "realms": False,
        "keywords": ["raccoon", "sensenova", "gateway", "openai", "proxy", "cli"],
    },
    {
        "id": "minimax",
        "display": "MiniMax Code",
        "port": 8817,
        "ui_port": 8818,
        "env": "MINIMAX_HOME",
        "vendor": "MiniMax",
        "realms": False,
        "keywords": ["minimax", "gateway", "anthropic", "proxy", "cli"],
    },
    {
        "id": "gemini",
        "display": "Gemini Code Assist",
        "port": 8819,
        "ui_port": 8820,
        "env": "GEMINI_HOME",
        "vendor": "Google",
        "realms": False,
        "keywords": ["gemini", "google", "gateway", "openai", "proxy", "cli"],
    },
]

# 从 workbuddy-bridge 复制并按渠道参数化的共享模块。
#
# 这些模块在**所有渠道**里逻辑一致（只差名称/端口/环境变量），故从模板复制。
SHARED_MODULES = (
    "portfree.py",
    "console.py",
    "daemon.py",
    "paths.py",
    "sse_stream.py",
    "cli.py",
    "headless.py",
    "auth_flow.py",
)

# 渠道特有模块 —— 必须按 docs/PROTOCOL.md 手写，**不由生成器产出**。
# 生成器会在这些文件缺失时写入一个会大声报错的占位实现，避免"能导入但静默出错"。
CHANNEL_MODULES = ("cred.py", "upstream.py", "gateway.py", "catalog.py", "billing.py")


def subs_for(channel: dict[str, object]) -> list[tuple[str, str]]:
    """构造替换表。

    顺序重要：长串先替换，避免 `workbuddy_bridge` 被 `workbuddy` 的规则先吃掉一半。
    """
    cid = str(channel["id"])
    return [
        # 包名与项目名（长→短）
        ("workbuddy_bridge", f"{cid}_bridge"),
        ("workbuddy-bridge", f"{cid}-bridge"),
        # 数据目录名（.workbuddy-bridge → .<id>-bridge）
        (".workbuddy-bridge", f".{cid}-bridge"),
        # 环境变量（先长后短，且旧名一律映射到新名 —— 见下方 _fix_env_block）
        ("WORKBUDDY_HOME", str(channel["env"])),
        ("ZCB_HOME", str(channel["env"])),
        ("WBAI2API_HOME", str(channel["env"])),
        # CLI 名（仅用于打印前缀与文档）
        ("[workbuddy]", f"[{cid}]"),
        ("`workbuddy ", f"`{cid} "),
        ("workbuddy --version", f"{cid} --version"),
        ("workbuddy status", f"{cid} status"),
        ("workbuddy start", f"{cid} start"),
        ("workbuddy stop", f"{cid} stop"),
        ("workbuddy restart", f"{cid} restart"),
        ("workbuddy logs", f"{cid} logs"),
        ("workbuddy login", f"{cid} login"),
        ("workbuddy models", f"{cid} models"),
        ("workbuddy credits", f"{cid} credits"),
        ("workbuddy serve", f"{cid} serve"),
        ("workbuddyai", cid),
        ("WorkBuddyAI", str(channel["display"])),
        ("workbuddy-bridge 的", f"{cid}-bridge 的"),
        # 端口
        ("127.0.0.1:8787", f"127.0.0.1:{channel['port']}"),
        ("DEFAULT_UI_PORT = 8788", f"DEFAULT_UI_PORT = {channel['ui_port']}"),
        ("127.0.0.1:8788", f"127.0.0.1:{channel['ui_port']}"),
        # logger 名
        ('logging.getLogger("workbuddy-bridge")', f'logging.getLogger("{cid}-bridge")'),
    ]


def substitute(text: str, subs: list[tuple[str, str]]) -> str:
    for old, new in subs:
        text = text.replace(old, new)
    return text


# ── paths.py 的定点修正 ──────────────────────────────────────────────────────
#
# 纯字符串替换在 paths.py 上有两处会出错，必须定点修：
#
# 1. **历史目录名被误改**：`_LEGACY_DIR_NAMES` 里是 workbuddy 的历史目录
#    （`.zcode-workbuddy-bridge` 等），它们对**别的渠道毫无意义** ——
#    替换后变成 `.zcode-zcode-bridge` 这种既不是本渠道历史、也不存在的名字。
#    新渠道没有历史目录，应**清空该列表**。
# 2. **三个环境变量塌缩成同一个**：原代码是
#    `WORKBUDDY_HOME or ZCB_HOME or WBAI2API_HOME` 三级回退，替换后三个都变成
#    `ZCODE_HOME`，读起来像笔误。应精简为单级。

_LEGACY_BLOCK_RE = re.compile(
    r"_LEGACY_DIR_NAMES = \(\n(?:.*\n)*?\)\n", re.MULTILINE
)
_ENV_BLOCK_RE = re.compile(
    r"    override = \(\n(?:.*\n)*?    \)\n", re.MULTILINE
)


def fix_paths(text: str, channel: dict[str, object]) -> str:
    """对 paths.py 做定点修正（清空历史目录、精简环境变量回退）。"""
    cid = str(channel["id"])
    env = str(channel["env"])

    # 1. 历史目录名清空（新渠道无历史）
    legacy_replacement = (
        "_LEGACY_DIR_NAMES: tuple[str, ...] = ()\n"
        f"# 本渠道是新建项目，没有历史目录名需要迁移。\n"
        f"# （workbuddy-bridge 的列表里是**它自己的**旧名，对 {cid} 无意义，\n"
        "#   照抄会让 base_dir() 去找一批不存在的目录。）\n"
    )
    text = _LEGACY_BLOCK_RE.sub(legacy_replacement, text, count=1)

    # 2. 环境变量回退精简为单级
    env_replacement = (
        f'    override = os.environ.get("{env}")\n'
    )
    text = _ENV_BLOCK_RE.sub(env_replacement, text, count=1)

    # 3. 修正 docstring 里被重复替换的环境变量说明
    text = text.replace(
        f"{env}（旧名 {env} / {env}）", f"{env} 可覆盖"
    ).replace(f"{env}可覆盖", f"{env} 可覆盖")
    return text


def generate_channel(channel: dict[str, object]) -> None:
    cid = str(channel["id"])
    project = ROOT / f"{cid}-bridge"
    pkg_dir = project / "src" / f"{cid}_bridge"
    subs = subs_for(channel)

    print(f"\n=== {cid}-bridge ===")
    pkg_dir.mkdir(parents=True, exist_ok=True)

    # 1. 共享模块（从 workbuddy-bridge 复制 + 参数化）
    for name in SHARED_MODULES:
        src = TEMPLATE_SRC / name
        if not src.is_file():
            print(f"  [skip] {name}（模板里没有）")
            continue
        text = substitute(src.read_text(encoding="utf-8"), subs)
        if name == "paths.py":
            text = fix_paths(text, channel)
        (pkg_dir / name).write_text(text, encoding="utf-8")
        print(f"  [ok] src/{cid}_bridge/{name}")

    # 2. 包初始化（渠道特有不导出，故保持最小）
    (pkg_dir / "__init__.py").write_text(
        f'"""{cid}-bridge：{channel["display"]} 本地 OpenAI 兼容网关（无窗口引擎）。"""\n',
        encoding="utf-8",
    )
    (pkg_dir / "__main__.py").write_text(
        "# `python -m " + f"{cid}_bridge" + "` 直接运行；真正的参数解析在 cli.py。\n"
        "\n"
        "from .cli import main\n"
        "\n"
        'if __name__ == "__main__":\n'
        "    raise SystemExit(main())\n",
        encoding="utf-8",
    )
    print(f"  [ok] src/{cid}_bridge/__init__.py + __main__.py")

    # 3. 插件载荷目录
    plugin = project / "plugins" / f"{cid}-bridge"
    for sub in (".claude-plugin", ".zcode-plugin", "commands", "hooks", "skills"):
        (plugin / sub).mkdir(parents=True, exist_ok=True)
    print(f"  [ok] plugins/{cid}-bridge/ 目录结构")

    # 4. docs（PROTOCOL.md 已由协议提取阶段写入，此处只确保目录存在）
    (project / "docs").mkdir(exist_ok=True)

    # 5. 项目文件
    write_project_files(project, channel)
    print("  [ok] pyproject.toml / README.md / models.json / .gitignore / .gitattributes")

    # 6. 插件清单与载荷
    write_plugin_payload(plugin, project, channel)
    print("  [ok] plugins/ 清单 + commands + hooks + skills")

    # 7. 渠道特有模块占位（若不存在）——大声报错的实现，避免静默出错
    for name in CHANNEL_MODULES:
        target = pkg_dir / name
        if not target.exists():
            target.write_text(placeholder_module(name, channel), encoding="utf-8")
    print(f"  [ok] 渠道模块占位（{', '.join(CHANNEL_MODULES)}）")


def write_project_files(project: Path, channel: dict[str, object]) -> None:
    """写 pyproject.toml / README.md / models.json / .gitignore / .gitattributes。"""
    cid = str(channel["id"])
    display = str(channel["display"])
    vendor = str(channel["vendor"])

    (project / "pyproject.toml").write_text(
        f"""[project]
name = "{cid}-bridge"
version = "0.1.0"
description = "{display}（{vendor}）的本地 OpenAI Chat Completion 透明代理网关（ZCode 插件引擎，无窗口）"
requires-python = ">=3.11"
dependencies = [
    "aiohttp>=3.10",
    "requests>=2.32",
]

[dependency-groups]
dev = [
    "ruff>=0.8",
]

[project.scripts]
{cid} = "{cid}_bridge.cli:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/{cid}_bridge"]

[tool.uv]
package = true

[tool.ruff]
line-length = 100
target-version = "py311"
src = ["src"]

[tool.ruff.lint]
select = ["E", "F", "W", "I", "UP", "B", "SIM"]
""",
        encoding="utf-8",
    )

    (project / "README.md").write_text(
        f"""# {cid}-bridge

{display}（{vendor}）的本地 OpenAI Chat Completion 透明代理网关（Python 版）。
**纯无窗口（headless）设计**：没有桌面界面，状态与操作全部走 API 和
[ZCode 插件](plugins/{cid}-bridge/) 的 hooks + skills + commands。

将任何兼容 OpenAI Chat Completion API 的客户端请求，透明转发到 {display} 后端。

## 协议规格

实现依据见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md) —— 从上游实现提取的完整协议规格，
含端点、认证、请求/响应形状与实测踩坑记录。

## 快速开始

```bash
uv sync
uv run {cid} serve --json    # 前台无窗口运行
uv run {cid} login --json    # 无窗口登录：输出授权链接
uv tool install .            # 全局安装后用 {cid} 直接调用
{cid} start                  # 守护式启动（幂等）
{cid} status / models / credits / stop
```

## 状态 API 与 ZCode 插件

`serve` 会启动控制台 API（默认 `http://127.0.0.1:{channel["ui_port"]}`，无页面托管）：

| 端点 | 说明 |
| --- | --- |
| `GET /api/state` | 状态快照（`ui_state` / `message` / `auth_url` / `models`） |
| `POST /api/retry-login` | 投递「重试登录」意图 |
| `POST /api/theme` | 空操作（保留端点兼容） |

日常操作不用直接打这些接口 —— 插件 `{cid}-bridge` 用命令与技能把能力包好了。

## 让 ZCode 走这个网关

在 ZCode 设置里添加 provider：类型 `openai-chat-completions`、
baseUrl `http://127.0.0.1:{channel["port"]}/v1`、API key 任意非空、模型用 `{cid} models` 的输出。
插件注册不了 provider，这一步需手动。

## 许可证

MIT
""",
        encoding="utf-8",
    )

    (project / "models.json").write_text(
        '{\n  "models": []\n}\n', encoding="utf-8"
    )
    (project / ".gitignore").write_text(
        "__pycache__/\n*.pyc\n.venv/\n.tmp/\n.planning/\n.ruff_cache/\n.commandcode/\n",
        encoding="utf-8",
    )
    (project / ".gitattributes").write_text("* text=auto eol=lf\n", encoding="utf-8")


def write_plugin_payload(plugin: Path, project: Path, channel: dict[str, object]) -> None:
    """写 ZCode/Claude 清单、commands、hooks、SKILL.md、marketplace.json。"""
    cid = str(channel["id"])
    display = str(channel["display"])
    desc = (
        f"Manage the local {display} OpenAI-compatible gateway ({cid} CLI) from ZCode: "
        "session-start auto-mount, login, start/stop and status."
    )
    desc_zh = (
        f"通过 {cid} 命令行管理本地 {display} OpenAI 兼容网关："
        "会话启动自动挂载、浏览器登录、启动/停止与状态查看。"
    )

    manifest = (
        "{\n"
        f'  "name": "{cid}-bridge",\n'
        f'  "description": "{desc}",\n'
        '  "description_i18n": {\n'
        f'    "en": "{desc}",\n'
        f'    "zh-CN": "{desc_zh}"\n'
        "  },\n"
        '  "version": "0.1.0",\n'
        '  "author": {\n    "name": "bluechonk"\n  },\n'
        '  "keywords": ' + json.dumps(channel["keywords"], ensure_ascii=False) + "\n"
        "}\n"
    )
    # Claude 与 ZCode 清单格式逐字相同（ZCode 继承 Claude 规范），两份镜像
    (plugin / ".claude-plugin" / "plugin.json").write_text(manifest, encoding="utf-8")
    (plugin / ".zcode-plugin" / "plugin.json").write_text(manifest, encoding="utf-8")

    (plugin / "hooks" / "hooks.json").write_text(
        "{\n"
        f'  "description": "Session start: idempotently ensure the local {display} '
        f'gateway is running (respects the auto_start preference in ~/.{cid}-bridge/prefs.json).",\n'
        '  "hooks": {\n'
        '    "SessionStart": [\n'
        "      {\n"
        '        "matcher": "startup|resume|clear|compact",\n'
        '        "hooks": [\n'
        "          {\n"
        '            "type": "process",\n'
        '            "command": "bash",\n'
        f'            "args": ["${{ZCODE_PLUGIN_ROOT}}/hooks/session-start.sh"],\n'
        '            "timeoutMs": 10000,\n'
        f'            "statusMessage": "确保 {display} 网关在运行"\n'
        "          }\n"
        "        ]\n"
        "      }\n"
        "    ]\n"
        "  }\n"
        "}\n",
        encoding="utf-8",
    )

    (plugin / "hooks" / "session-start.sh").write_text(
        "#!/usr/bin/env bash\n"
        "# SessionStart：幂等确保本地网关在运行。任何失败都以 0 退出，绝不阻塞会话启动。\n"
        f'Z="$(command -v {cid} || echo "$HOME/.local/bin/{cid}")"\n'
        '[ -x "$Z" ] || exit 0\n'
        '"$Z" start --auto --quiet --wait 6 >/dev/null 2>&1 || exit 0\n'
        "exit 0\n",
        encoding="utf-8",
    )

    (plugin / "commands" / f"{cid}.md").write_text(
        "---\n"
        f"description: 管理 {display} 网关\n"
        'argument-hint: "[status|start|stop|restart|models|credits|login] 或自由描述"\n'
        f"skills: {cid}-gateway\n"
        "---\n\n"
        f"按 `{cid}-gateway` 技能处理这个请求：$ARGUMENTS\n\n"
        f"先跑 `{cid} status --json` 了解现状；需要时可用的命令：\n"
        f"`{cid} login --json`（无头登录，把 `auth_url` 原样展示给用户）、"
        f"`{cid} start`、`{cid} stop`、`{cid} restart`、\n"
        f"`{cid} models --json`、`{cid} credits --json`。\n\n"
        "凭据不可用时优先引导登录；不要并发重复跑 login。\n",
        encoding="utf-8",
    )

    (plugin / "commands" / f"{cid}-status.md").write_text(
        "---\n"
        f"description: 查看 {display} 网关状态（健康、登录、守护进程、凭证）\n"
        f"skills: {cid}-gateway\n"
        "---\n\n"
        f"跑 `{cid} status --json` 并把结果解读给用户：网关是否可达、登录状态（ui_state）、\n"
        f"守护 PID、凭证是否存在、auto_start 开关。发现异常时按 {cid}-gateway 技能排障。\n",
        encoding="utf-8",
    )

    (plugin / "commands" / f"{cid}-login.md").write_text(
        "---\n"
        f"description: 登录 {display}\n"
        'argument-hint: "[--force 强制重登]"\n'
        f"skills: {cid}-gateway\n"
        "---\n\n"
        f"跑 `{cid} login --json` $ARGUMENTS，从输出取 `auth_url` 原样展示给用户"
        "（提示在浏览器打开并完成授权），\n"
        f"授权完成后跑 `{cid} status` 确认登录态。\n",
        encoding="utf-8",
    )

    skill_dir = plugin / "skills" / f"{cid}-gateway"
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        f"name: {cid}-gateway\n"
        f"description: Manage and troubleshoot the local {display} OpenAI-compatible "
        f"gateway with the {cid} CLI (status, start, stop, login, models, credits).\n"
        "---\n\n"
        f"# {display} 网关管理\n\n"
        f"当用户想启动/登录/检查/排障 {display} 本地网关，或问「模型走的是哪个后端」时使用本技能。\n"
        f"所有操作通过 `{cid}` 命令行完成（宿主会话启动时插件 hook 通常已自动挂载网关）。\n\n"
        "## 背景事实\n\n"
        f"- 引擎是本地 Python 包，把 OpenAI Chat Completion 请求透明转发到 {display} 后端。\n"
        f"  - 网关地址默认 `http://127.0.0.1:{channel['port']}`"
        "（`/v1/chat/completions`、`/v1/models`、`/health`）。\n"
        f"  - 守护进程 PID/日志在 `~/.{cid}-bridge/`。\n"
        "- 登录需要用户在浏览器完成一次授权（工具无法代办）。\n\n"
        "## 命令速查\n\n"
        "| 命令 | 作用 |\n| --- | --- |\n"
        f"| `{cid} status`（`--json`） | 网关健康、登录状态、守护 PID、凭证、auto_start |\n"
        f"| `{cid} start` | 守护式启动（幂等，已在跑直接返回） |\n"
        f"| `{cid} stop` | 停止守护实例（不碰第三方进程） |\n"
        f"| `{cid} restart` | 重启守护实例 |\n"
        f"| `{cid} logs`（`--lines N`） | 查看网关日志尾部（排障第一步） |\n"
        f"| `{cid} login`（`--force`） | 无窗口登录：输出授权链接（`--json` 时在 `auth_url` 字段） |\n"
        f"| `{cid} models`（`--json`） | 列出模型 |\n"
        f"| `{cid} credits`（`--json`） | 账号剩余额度（只读） |\n\n"
        "## 标准流程\n\n"
        f"1. 先跑 `{cid} status`（需要结构化数据加 `--json`）判断现状。\n"
        f"2. 网关不可达：跑 `{cid} start`，再 `{cid} status` 确认；"
        f"仍失败看 `~/.{cid}-bridge/gateway.log`。\n"
        f"3. 未登录：跑 `{cid} login --json`，从输出取 `auth_url` 原样展示给用户。\n"
        "   该命令会阻塞轮询直到授权完成或超时；不要并发重复跑。\n"
        f"4. 用户想看额度时跑 `{cid} credits`（只读，不消耗额度）。\n"
        f"5. 用户要求停掉时跑 `{cid} stop`。\n\n"
        "## 排障要点\n\n"
        "- 启动失败先看 `gateway.log` 尾部；常见原因是端口被占用。\n"
        f"- 上游拒绝（502）：凭据失效 → `{cid} login --force`。\n"
        "- 模型列表为空但网关可达：多为未登录或上游探测失败。\n"
        f"- `auto_start` 开关在 `~/.{cid}-bridge/prefs.json`。\n\n"
        "## 让宿主真正走这个网关\n\n"
        "插件注册不了 provider，需在宿主设置里手动添加：\n\n"
        "- 类型：`openai-chat-completions`\n"
        f"- baseUrl：`http://127.0.0.1:{channel['port']}/v1`\n"
        "- API key：任意非空（网关不校验）\n"
        f"- 模型：`{cid} models` 里的 id\n",
        encoding="utf-8",
    )

    # 市场清单：仓库根 + .claude-plugin/ 双份（ZCode 只在这两处找）
    marketplace = (
        "{\n"
        f'  "name": "{cid}-bridge",\n'
        f'  "description": "bluechonk\'s ZCode plugin marketplace: local {display} '
        'gateway connector and future community plugins.",\n'
        '  "description_i18n": {\n'
        f'    "en": "bluechonk\'s ZCode plugin marketplace: local {display} gateway connector.",\n'
        f'    "zh-CN": "bluechonk 的 ZCode 插件市场：本地 {display} 网关连接器。"\n'
        "  },\n"
        '  "owner": {\n    "name": "bluechonk",\n    "url": "https://github.com/bluechonk"\n  },\n'
        '  "plugins": [\n    {\n'
        f'      "name": "{cid}-bridge",\n'
        f'      "source": "./plugins/{cid}-bridge",\n'
        f'      "description": "{desc}",\n'
        '      "description_i18n": {\n'
        f'        "en": "{desc}",\n'
        f'        "zh-CN": "{desc_zh}"\n'
        "      },\n"
        '      "version": "0.1.0",\n'
        '      "author": {\n        "name": "bluechonk"\n      },\n'
        '      "category": "developer-tools",\n'
        '      "keywords": ' + json.dumps(channel["keywords"], ensure_ascii=False) + "\n"
        "    }\n  ]\n"
        "}\n"
    )
    (project / "marketplace.json").write_text(marketplace, encoding="utf-8")
    claude_dir = project / ".claude-plugin"
    claude_dir.mkdir(exist_ok=True)
    (claude_dir / "marketplace.json").write_text(marketplace, encoding="utf-8")


def placeholder_module(name: str, channel: dict[str, object]) -> str:
    """渠道特有模块的占位：能导入，但任何实际使用都会大声报错。

    刻意**不返回空值** —— 那会让网关"看起来在工作"但静默给出错误结果
    （例如模型列表恒为空、请求恒失败但错误信息含糊）。
    """
    cid = str(channel["id"])
    display = str(channel["display"])
    return f'''"""{display} 渠道的 {name}（**待实现**）。

本文件是脚手架占位。实现依据见 `docs/PROTOCOL.md`。

⚠️ 占位实现刻意让调用**立即失败并说明原因**，而不是返回空值 ——
返回空值会让网关看起来在工作（模型列表恒为空、请求静默失败），
比直接报错更难排查。
"""

from __future__ import annotations


_NOT_IMPLEMENTED = (
    "{cid}-bridge 的 {name} 尚未实现。"
    "请按 docs/PROTOCOL.md 实现本模块；当前项目处于脚手架阶段。"
)


def __getattr__(name: str):
    """任何属性访问都抛错（含 `from .{name.replace('.py','')} import X`）。"""
    raise NotImplementedError(f"{{_NOT_IMPLEMENTED}}（访问了 {{name!r}}）")
'''


def main() -> int:
    targets = sys.argv[1:] or [str(c["id"]) for c in CHANNELS]
    unknown = [t for t in targets if t not in {str(c["id"]) for c in CHANNELS}]
    if unknown:
        print(f"未知渠道：{unknown}")
        print(f"可选：{[c['id'] for c in CHANNELS]}")
        return 2

    for channel in CHANNELS:
        if str(channel["id"]) in targets:
            generate_channel(channel)

    print(f"\n完成 {len(targets)} 个渠道的骨架生成。")
    print("注意：cred / upstream / gateway / catalog 需按 docs/PROTOCOL.md 手写。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
