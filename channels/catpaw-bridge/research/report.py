"""终端报告排版：所有研究脚本共用同一套标题/键值/表格格式，
便于把 stdout 直接贴进 docs/**/RUN-LOG.md 当作证据。
"""

from __future__ import annotations


def heading(text: str) -> str:
    """一级标题。"""
    return f"\n=== {text} ==="


def subheading(text: str) -> str:
    """二级标题。"""
    return f"\n--- {text} ---"


def kv(key: str, value: object, width: int = 22) -> str:
    """单行键值，键对齐到固定宽度。"""
    rendered = "-" if value is None else str(value)
    return f"  {key:<{width}} {rendered}"


def table(rows: list[list[str]] | tuple[tuple[str, ...], ...], gap: str = "  ") -> str:
    """无边框表格：第一行是表头。"""
    if not rows:
        return ""
    widths: list[int] = []
    for row in rows:
        for i, cell in enumerate(row):
            if i >= len(widths):
                widths.append(len(cell))
            else:
                widths[i] = max(widths[i], len(cell))
    out: list[str] = []
    for row in rows:
        parts = [cell.ljust(widths[i]) for i, cell in enumerate(row)]
        out.append(gap.join(parts).rstrip())
    return "\n".join(out)


def note(text: str) -> str:
    """备注行。"""
    return f"  # {text}"


def block(lines: list[str] | tuple[str, ...]) -> str:
    """打印一个段落块（数组间不加空行）。"""
    return "\n".join(lines)
