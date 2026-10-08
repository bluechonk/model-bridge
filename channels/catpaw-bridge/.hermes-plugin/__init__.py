"""Hermes 侧接入：把本仓库 ZCode 插件自带的技能注册给 Hermes 原生技能加载器。

安装（git-clone 形态）：``hermes plugins install bluechonk/catpaw-bridge``
装好后技能按命名空间名显式加载：``skill_view("catpaw-bridge:catpaw-gateway")``
（插件技能是只读的，不进 ``~/.hermes/skills/``，也不出现在系统提示的技能索引里）。

技能目录按仓库的实际布局查找；一个都找不到就大声报错——静默跳过会让"装上了但没技能"
看起来像安装成功。
"""

from __future__ import annotations

import os
from pathlib import Path

PLUGIN_NAME = "catpaw-bridge"  # 同时是 plugins/<目录名>，与 .hermes-plugin/plugin.yaml 的 name 一致

_HERE = Path(os.path.realpath(__file__)).parent


def _candidates() -> list[Path]:
    """按优先级给候选技能目录。

    1. 本仓库的分层布局：<repo>/plugins/<插件名>/skills   ← ZCode 插件载荷所在（唯一真源）
    2. 仓库根布局：<repo>/skills                          ← Hermes 惯例的 clone 形态
    3. 扁平安装：<plugin-dir>/skills
    """
    repo_root = _HERE.parent
    return [
        repo_root / "plugins" / PLUGIN_NAME / "skills",
        repo_root / "skills",
        _HERE / "skills",
    ]


def _skills_dir() -> Path:
    for cand in _candidates():
        if cand.is_dir() and any((d / "SKILL.md").is_file() for d in cand.iterdir() if d.is_dir()):
            return cand
    raise RuntimeError(
        f"{PLUGIN_NAME}: 找不到技能目录（找过 {[str(p) for p in _candidates()]}）。"
        f"用 `hermes plugins install bluechonk/{PLUGIN_NAME}` 重装。"
    )


def register(ctx) -> None:
    skills_dir = _skills_dir()
    for child in sorted(skills_dir.iterdir()):
        skill_md = child / "SKILL.md"
        if child.is_dir() and skill_md.is_file():
            # register_skill 需要 pathlib.Path：传 str 会 AttributeError，
            # 而 Hermes 会把整个插件静默禁用（superpowers 实测 2026-07-23）。
            ctx.register_skill(child.name, skill_md)
