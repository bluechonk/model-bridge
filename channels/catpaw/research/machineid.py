"""机器码读取（移植自 phase5）。

妙手不把密钥藏进 Electron safeStorage / DPAPI —— 密钥完全由机器码推导：

    key = SHA-256(`${machine_id}:catpaw-desk-token-v2`)

machineId 来自 node-machine-id 的 machineIdSync(true)（原始值）：

  Windows  HKLM\\SOFTWARE\\Microsoft\\Cryptography → MachineGuid
  Linux    /etc/machine-id（回退 /var/lib/dbus/machine-id）
  macOS    ioreg -rd1 -c IOPlatformExpertDevice → IOPlatformUUID

归一化必须与 node-machine-id 完全一致，否则会派生出错误的密钥。
"""

from __future__ import annotations

import re
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

LINUX_MACHINE_ID_PATHS = ("/etc/machine-id", "/var/lib/dbus/machine-id")


@dataclass
class MachineIdReading:
    """机器码读取结果。value 不是秘密，但本工具默认也不打印原文。"""

    available: bool
    value: str
    origin: str
    error: str | None = None


def _default_run(file: str, args: list[str]) -> str:
    result = subprocess.run(  # noqa: S603 - 固定 argv，无用户可控片段
        [file, *args],
        capture_output=True,
        text=True,
        check=True,
        encoding="utf-8",
        errors="replace",
    )
    return result.stdout


def _default_read_text(path: str) -> str:
    return Path(path).read_text(encoding="utf-8", errors="replace")


def read_machine_id(
    os_name: str | None = None,
    run: Callable[[str, list[str]], str] | None = None,
    read_text: Callable[[str], str] | None = None,
) -> MachineIdReading:
    """读取本机机器码。"""
    os_name = os_name or sys.platform
    run = run or _default_run
    read_text = read_text or _default_read_text

    try:
        if os_name == "win32":
            query = r"HKLM\SOFTWARE\Microsoft\Cryptography"
            out = run("reg", ["query", query, "/v", "MachineGuid"])
            # 归一化必须与 node-machine-id 的 `c()` 一致：
            #   取 "REG_SZ" 之后的部分 → 去掉所有空白 → 转小写
            after_marker = out.split("REG_SZ", 1)[1] if "REG_SZ" in out else ""
            value = re.sub(r"\s+", "", after_marker).lower()
            if value == "":
                return MachineIdReading(False, "", query, "MachineGuid 行未解析出值")
            origin = f"{query} → MachineGuid（按 node-machine-id 归一化）"
            return MachineIdReading(True, value, origin)

        if os_name == "darwin":
            out = run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"])
            match = re.search(r'"IOPlatformUUID"\s*=\s*"([^"]+)"', out)
            value = match.group(1) if match else ""
            if value == "":
                return MachineIdReading(
                    False, "", "ioreg IOPlatformUUID", "未解析出 IOPlatformUUID"
                )
            return MachineIdReading(True, value, "ioreg → IOPlatformUUID")

        for path in LINUX_MACHINE_ID_PATHS:
            try:
                value = read_text(path).strip()
            except OSError:
                continue
            if value != "":
                return MachineIdReading(True, value, path)
        return MachineIdReading(
            False, "", " | ".join(LINUX_MACHINE_ID_PATHS), "所有候选文件都读不到"
        )
    except (OSError, subprocess.SubprocessError, IndexError, ValueError) as exc:
        return MachineIdReading(False, "", os_name, str(exc))


def describe_key_derivation() -> list[str]:
    """人类可读的派生说明（写进文档用）。"""
    return [
        "key = SHA-256( UTF-8( `${machineId}:catpaw-desk-token-v2` ) )",
        "machineId = node-machine-id 的 machineIdSync(true)（原始值）",
        "SHA-256 输出 32 字节 ⇒ AES-256；同一机器上密钥恒定",
        "没有 KDF 迭代/加盐：机器码本身即全部密钥材料",
    ]


def format_key_report(
    reading: MachineIdReading, key: bytes | None, machine_id_fingerprint: str
) -> str:
    """渲染密钥派生报告（不打印机器码原文，只给指纹与长度）。"""
    lines: list[str] = []
    lines.append("\n=== Phase 5 · 密钥派生 ===")
    lines.append(f"  机器码可用          {reading.available}")
    lines.append(f"  机器码来源          {reading.origin}")
    lines.append(f"  机器码长度          {len(reading.value)}")
    lines.append(f"  机器码指纹          {machine_id_fingerprint}")
    if reading.error is not None:
        lines.append(f"  错误                {reading.error}")
    lines.append(f"  派生密钥长度        {len(key) if key is not None else '-'} 字节")
    lines.append("\n--- 派生规则 ---")
    for item in describe_key_derivation():
        lines.append(f"  - {item}")
    return "\n".join(lines)
