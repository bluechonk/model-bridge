"""Phase 1 —— 侦察（Reconnaissance）（移植自 phase1-reconnaissance）。

目标：在不碰任何凭据内容的前提下，先把"东西在哪"钉死。
产出：安装目录、app.asar、Agent SDK、CLI 包、Electron userData 目录、
product.json 元数据、运行中的进程、以及 userData 下全部候选文件的元数据。

本阶段是纯只读：只 stat 目录/文件 + 读 product.json（非敏感）+ 列进程。
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .paths import CatPawLayout, catpaw_layout
from .probe import PathProbe, format_bytes, format_time, probe_path
from .report import heading, kv, note, table


@dataclass
class ProductInfo:
    """product.json 里与本课题相关的字段（其余字段忽略）。"""

    version: str | None
    commit: str | None
    application_name: str | None
    data_folder_name: str | None
    cli_command_name: str | None
    app_id: str | None
    win32_mutex_name: str | None
    cli_socket_folder: str | None


def read_product_info(path: str) -> ProductInfo | None:
    """读取 product.json；缺失或损坏返回 None（不是致命错误）。"""
    try:
        parsed = json.loads(Path(path).read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None

    def string_of(key: str) -> str | None:
        value = parsed.get(key)
        return value if isinstance(value, str) and value != "" else None

    return ProductInfo(
        version=string_of("version"),
        commit=string_of("commit"),
        application_name=string_of("applicationName"),
        data_folder_name=string_of("dataFolderName"),
        cli_command_name=string_of("cliCommandName"),
        app_id=string_of("appId"),
        win32_mutex_name=string_of("win32MutexName"),
        cli_socket_folder=string_of("cliSocketFolder"),
    )


# 进程名匹配：主程序 exe 叫 `妙手.exe`（中文），CLI 叫 `catpaw-cli.exe`
_PROCESS_PATTERN = re.compile(r"catpaw|catx|paw|妙手", re.IGNORECASE)


def detect_processes(os_name: str | None = None) -> list[str]:
    """列出与妙手相关的进程名。命令不可用时返回空数组而不是抛错。"""
    os_name = os_name or sys.platform
    try:
        if os_name == "win32":
            out = subprocess.run(  # noqa: S603, S607
                ["tasklist", "/FO", "CSV", "/NH"],
                capture_output=True,
                text=True,
                check=True,
                encoding="utf-8",
                errors="replace",
            ).stdout
            names = [line.split('","')[0].lstrip('"') for line in out.splitlines()]
        else:
            out = subprocess.run(  # noqa: S603, S607
                ["ps", "-A", "-o", "comm="],
                capture_output=True,
                text=True,
                check=True,
                encoding="utf-8",
                errors="replace",
            ).stdout
            names = [line.strip() for line in out.splitlines()]
    except (OSError, subprocess.SubprocessError):
        return []
    matched = [name for name in names if _PROCESS_PATTERN.search(name)]
    return sorted(set(matched))


@dataclass
class ReconReport:
    generated_at: str
    os: str
    layout: CatPawLayout
    install_dir: PathProbe
    app_asar: PathProbe
    product_json: PathProbe
    sdk_dir: PathProbe
    cli_bundle: PathProbe
    user_data_dir: PathProbe
    product: ProductInfo | None
    user_data_files: list[PathProbe]
    running_processes: list[str]
    conclusions: list[str]


def _user_data_candidates(layout: CatPawLayout) -> list[PathProbe]:
    return [
        probe_path(layout.credential_file),
        probe_path(layout.auth_provider_file),
        probe_path(layout.enterprise_token_file),
        probe_path(layout.scope_pointer_file),
        probe_path(layout.device_uuid_file),
        probe_path(layout.local_state_file),
        probe_path(layout.auth_json_file),
    ]


def reconnaissance(layout: CatPawLayout | None = None) -> ReconReport:
    """执行侦察。"""
    layout = layout or catpaw_layout()
    install_dir = probe_path(layout.install_dir)
    app_asar = probe_path(layout.app_asar)
    product_json = probe_path(layout.product_json)
    sdk_dir = probe_path(layout.sdk_dir)
    cli_bundle = probe_path(layout.cli_bundle)
    user_data_dir = probe_path(layout.user_data_dir)
    product = read_product_info(layout.product_json) if product_json.exists else None
    user_data_files = _user_data_candidates(layout)
    running_processes = detect_processes(layout.os)

    conclusions: list[str] = []
    conclusions.append(
        f"安装目录存在：{layout.install_dir}"
        if install_dir.exists
        else f"安装目录未找到：{layout.install_dir}（可用 CATPAW_INSTALL_DIR 覆盖）"
    )
    if app_asar.exists:
        version = product.version if product else "未知"
        conclusions.append(
            f"主程序归档 app.asar {format_bytes(app_asar.size_bytes)}，版本 {version}"
        )
    else:
        conclusions.append("未找到 app.asar，Phase 4 的静态检索无法进行")
    conclusions.append(
        f"Electron userData 存在：{layout.user_data_dir}"
        if user_data_dir.exists
        else f"userData 不存在：{layout.user_data_dir}（桌面端从未启动过？）"
    )
    conclusions.append(
        f"桌面端正在运行：{', '.join(running_processes)}（其打开的文件可能锁定写入）"
        if running_processes
        else "未检测到妙手进程（桌面端未运行）"
    )

    return ReconReport(
        generated_at=datetime.now(UTC).isoformat(),
        os=layout.os,
        layout=layout,
        install_dir=install_dir,
        app_asar=app_asar,
        product_json=product_json,
        sdk_dir=sdk_dir,
        cli_bundle=cli_bundle,
        user_data_dir=user_data_dir,
        product=product,
        user_data_files=user_data_files,
        running_processes=running_processes,
        conclusions=conclusions,
    )


def format_recon_report(report: ReconReport) -> str:
    """渲染为可直接贴进 RUN-LOG 的文本。"""

    def state(probe: PathProbe) -> str:
        return "OK" if probe.exists else "MISSING"

    lines: list[str] = []
    lines.append(heading("Phase 1 · 侦察快照"))
    lines.append(kv("时间", report.generated_at))
    lines.append(kv("平台", report.os))

    lines.append(heading("安装布局"))
    lines.append(kv("安装目录", f"{state(report.install_dir)}  {report.layout.install_dir}"))
    lines.append(
        kv("app.asar", f"{state(report.app_asar)}  {format_bytes(report.app_asar.size_bytes)}")
    )
    lines.append(kv("Agent SDK", f"{state(report.sdk_dir)}  {report.layout.sdk_dir}"))
    lines.append(
        kv("CLI 包", f"{state(report.cli_bundle)}  {format_bytes(report.cli_bundle.size_bytes)}")
    )

    lines.append(heading("product.json"))
    if report.product is None:
        lines.append(note("未读到 product.json"))
    else:
        lines.append(kv("version", report.product.version))
        lines.append(kv("commit", report.product.commit))
        lines.append(kv("applicationName", report.product.application_name))
        lines.append(kv("dataFolderName", report.product.data_folder_name))
        lines.append(kv("cliCommandName", report.product.cli_command_name))
        lines.append(kv("appId", report.product.app_id))

    lines.append(heading("userData 候选文件（仅元数据）"))
    lines.append(
        table(
            [
                ["状态", "大小", "修改时间", "路径"],
                *[
                    [
                        "OK" if probe.exists else "-",
                        format_bytes(probe.size_bytes),
                        format_time(probe.mtime_ms),
                        probe.path,
                    ]
                    for probe in report.user_data_files
                ],
            ]
        )
    )

    lines.append(heading("进程"))
    lines.append(
        f"  {', '.join(report.running_processes)}" if report.running_processes else note("无")
    )

    lines.append(heading("结论"))
    for item in report.conclusions:
        lines.append(f"  - {item}")

    return "\n".join(lines)
