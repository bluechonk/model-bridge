"""文件系统探测器：只取元数据（存在性、大小、mtime），不读内容。

逆向过程中"某文件在不在、多大、什么时候动的"本身就是证据，
且完全是只读操作。
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass


@dataclass
class PathProbe:
    """单路径探测结果。kind ∈ file / dir / other / missing。"""

    path: str
    exists: bool
    kind: str
    size_bytes: int | None
    mtime_ms: float | None


def probe_path(path: str) -> PathProbe:
    """探测一个路径；任何异常都收敛成 missing，不抛。"""
    try:
        st = os.stat(path)
    except OSError:
        return PathProbe(path=path, exists=False, kind="missing", size_bytes=None, mtime_ms=None)
    if os.path.isdir(path):
        kind = "dir"
    elif os.path.isfile(path):
        kind = "file"
    else:
        kind = "other"
    return PathProbe(
        path=path,
        exists=True,
        kind=kind,
        size_bytes=st.st_size if kind == "file" else None,
        mtime_ms=st.st_mtime * 1000,
    )


def format_bytes(num: int | None) -> str:
    """人类可读的字节数。"""
    if num is None:
        return "-"
    if num < 1024:
        return f"{num} B"
    units = ["KiB", "MiB", "GiB"]
    value = num / 1024
    i = 0
    while value >= 1024 and i < len(units) - 1:
        value /= 1024
        i += 1
    return f"{value:.1f} {units[i]}"


def format_time(mtime_ms: float | None) -> str:
    """ISO 8601（UTC，与 TS 版 toISOString 对齐）；空值给 `-`。"""
    if mtime_ms is None:
        return "-"
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(mtime_ms / 1000))
