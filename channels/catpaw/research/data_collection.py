"""Phase 2 —— 数据收集。

把本机上所有可能承载凭据/会话的落点枚举出来，按"是否加密"分类，
并给出每个文件的结构（顶层键、库表名、编码），绝不打印值。

三条来源线：
  1. 桌面端加密凭据：catx-credential.json → ssoTokenEnc（AES-256-GCM）
  2. CLI 明文登录态：~/.meituan-catpaw/auth.json（同一 token 的明文副本）
  3. 旧版 CatPawAI（VSCode 系）state.vscdb（仅保留探测路径做历史对照）
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from .paths import CatPawLayout, catpaw_layout
from .probe import PathProbe, format_bytes, format_time, probe_path
from .redact import mask_secret
from .report import heading, kv, note, table


def json_top_level_keys(text: str) -> list[str]:
    """读取 JSON 顶层键；不是 JSON 就返回空数组。"""
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return []
    if not isinstance(parsed, dict):
        return []
    return list(parsed.keys())


def sqlite_table_names(path: str) -> list[str]:
    """读取 sqlite 的表名列表（只读打开，绝不写入）。"""
    try:
        uri = Path(path).resolve().as_uri() + "?mode=ro"
        con = sqlite3.connect(uri, uri=True)
    except (sqlite3.Error, ValueError, OSError):
        return []
    try:
        rows = con.execute(
            "select name from sqlite_master where type in ('table','view') order by name"
        ).fetchall()
        return [str(row[0]) for row in rows if row[0]]
    except sqlite3.Error:
        return []
    finally:
        con.close()


@dataclass
class DesktopAuth:
    """CLI 侧明文登录态的形状（只保留判定需要的字段）。"""

    login_type: str
    access_token: str
    uid: str
    login_name: str
    source: str = "auth.json"


_TOKEN_BAD_CHARS = re.compile(r"[\r\n\0]")


def read_desktop_auth(path: str) -> DesktopAuth | None:
    """解析 CLI 明文 auth.json。

    支持两种形状：
      嵌套  {"auth": {loginType, accessToken, ...}, "account": {uid, loginName, ...}}
      扁平  {loginType, accessToken, uid, ...}

    校验：loginType ∈ {passport, ''}；token 非空、≤8192、单行可打印。
    """
    try:
        parsed = json.loads(Path(path).read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None

    doc = parsed
    nested = isinstance(doc.get("auth"), dict)
    auth = doc["auth"] if nested else doc
    identity = doc["account"] if (nested and isinstance(doc.get("account"), dict)) else doc

    def string_of(record: object, key: str) -> str:
        if isinstance(record, dict):
            value = record.get(key)
            return value if isinstance(value, str) else ""
        return ""

    login_type = string_of(auth, "loginType")
    if login_type not in ("", "passport"):
        return None

    access_token = string_of(auth, "accessToken")
    if access_token == "" or len(access_token) > 8192:
        return None
    if _TOKEN_BAD_CHARS.search(access_token):
        return None

    return DesktopAuth(
        login_type=login_type,
        access_token=access_token,
        uid=string_of(identity, "uid"),
        login_name=string_of(identity, "loginName"),
    )


def read_encrypted_sso_token(path: str) -> str | None:
    """读出 catx-credential.json 里的密文（不解密）。"""
    try:
        parsed = json.loads(Path(path).read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    value = parsed.get("ssoTokenEnc")
    return value if isinstance(value, str) and value != "" else None


@dataclass
class Candidate:
    """一个候选落点的元数据 + 结构（无值）。"""

    kind: str
    path: str
    probe: PathProbe
    encoding: str
    structure: list[str]
    credential_bearing: bool
    note: str


def _read_text(path: str) -> str:
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _find_memory_databases(layout: CatPawLayout) -> list[str]:
    """在 userData 目录中找会话记忆库：catpaw-memory-<scope>.db。"""
    try:
        entries = list(Path(layout.memory_db_dir).iterdir())
    except OSError:
        return []
    names = sorted(
        name for name in entries if re.fullmatch(r"catpaw-memory-.*\.db", name.name)
    )
    return [str(name) for name in names]


def collect_candidates(layout: CatPawLayout | None = None) -> list[Candidate]:
    """枚举本机全部候选落点。"""
    layout = layout or catpaw_layout()
    candidates: list[Candidate] = []

    def add_file(
        kind: str,
        path: str,
        encoding: str,
        credential_bearing: bool,
        note: str,
        structure_reader=None,
    ) -> None:
        probe = probe_path(path)
        structure: list[str] = []
        if probe.exists and structure_reader is not None:
            structure = structure_reader()
        candidates.append(
            Candidate(kind, path, probe, encoding, structure, credential_bearing, note)
        )

    add_file(
        "encrypted-credential",
        layout.credential_file,
        "json",
        True,
        "ssoTokenEnc = base64(IV12 ‖ tag16 ‖ AES-256-GCM 密文)，本课题主目标",
        lambda: json_top_level_keys(_read_text(layout.credential_file)),
    )
    add_file(
        "auth-provider-pointer",
        layout.auth_provider_file,
        "json",
        False,
        "activeProvider，指明当前登录通道（catx-passport / 企业版）",
        lambda: json_top_level_keys(_read_text(layout.auth_provider_file)),
    )
    add_file(
        "enterprise-token",
        layout.enterprise_token_file,
        "json",
        True,
        "epToken / sessions / refreshJournal，企业版通道会话（本机为空）",
        lambda: json_top_level_keys(_read_text(layout.enterprise_token_file)),
    )
    add_file(
        "scope-pointer",
        layout.scope_pointer_file,
        "json",
        False,
        "多租户 scope 指针，值形如 <uid><随机段>，决定加密凭据落在哪个 scope",
        lambda: json_top_level_keys(_read_text(layout.scope_pointer_file)),
    )

    uuid_probe = probe_path(layout.device_uuid_file)
    candidates.append(
        Candidate(
            "device-uuid",
            layout.device_uuid_file,
            uuid_probe,
            "text",
            ["<uuid>"] if uuid_probe.exists else [],
            False,
            "设备 UUID（非密钥材料；密钥材料来自机器码，见 Phase 5）",
        )
    )

    add_file(
        "electron-local-state",
        layout.local_state_file,
        "json",
        False,
        "含 os_crypt（Electron safeStorage 元数据）；妙手 token 未走这条通道，仅作对照",
        lambda: json_top_level_keys(_read_text(layout.local_state_file)),
    )
    add_file(
        "desktop-auth-json",
        layout.auth_json_file,
        "json",
        True,
        "CLI 落盘的明文登录态，与 ssoTokenEnc 解密结果互为验证",
        lambda: json_top_level_keys(_read_text(layout.auth_json_file)),
    )

    for db_path in _find_memory_databases(layout):
        probe = probe_path(db_path)
        candidates.append(
            Candidate(
                "session-memory-db",
                db_path,
                probe,
                "sqlite",
                sqlite_table_names(db_path) if probe.exists else [],
                False,
                "会话/记忆库（conversations、sessions、memory_chunks_fts…），不含凭据",
            )
        )

    for legacy in layout.legacy_vscdb_candidates:
        probe = probe_path(legacy)
        candidates.append(
            Candidate(
                "legacy-vscdb",
                legacy,
                probe,
                "sqlite",
                sqlite_table_names(legacy) if probe.exists else [],
                True,
                "旧版 CatPawAI（VSCode 系）凭据表；本机不存在，仅作历史对照",
            )
        )

    return candidates


def format_candidates(candidates: list[Candidate], layout: CatPawLayout) -> str:
    """渲染候选清单。"""
    lines: list[str] = []
    lines.append(heading("Phase 2 · 凭据落点清单"))
    lines.append(kv("userData", layout.user_data_dir))
    lines.append(kv("CLI 目录", layout.cli_socket_dir))

    lines.append(heading("落点"))
    lines.append(
        table(
            [
                ["类别", "状态", "大小", "修改时间", "编码", "凭据"],
                *[
                    [
                        c.kind,
                        "OK" if c.probe.exists else "-",
                        format_bytes(c.probe.size_bytes),
                        format_time(c.probe.mtime_ms),
                        c.encoding,
                        "YES" if c.credential_bearing else "no",
                    ]
                    for c in candidates
                ],
            ]
        )
    )

    lines.append(heading("结构（仅键名/表名）"))
    for candidate in candidates:
        if not candidate.probe.exists:
            continue
        lines.append(f"  {candidate.kind}: {', '.join(candidate.structure) or '(空)'}")
        lines.append(note(candidate.note))

    return "\n".join(lines)


def describe_token(token: str) -> str:
    """交叉验证用：把明文 token 摘要成可打印的一行。"""
    return mask_secret(token)
