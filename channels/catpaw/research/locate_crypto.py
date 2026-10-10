"""Phase 4 —— 加密识别（Encryption Identification）。

目标：不看运行时内存，只在磁盘上把"token 是怎么被加密的"读出来。

手法：妙手是 Electron 应用，主进程代码全部打进 `resources/app.asar`。
asar 不压缩，JavaScript 是明文（压缩成一行的 minified 代码），
所以按字节 `find` 就能定位到实现，再把命中点前后各截一段作为证据。

实测命中（见 docs/protocols/catpaw/PROTOCOL.md 的结论速览）：
  - `StorageService` 名称 + `catpaw-desk-token-v2` 盐串
  - 密钥派生：sha256(`${machineId}:catpaw-desk-token-v2`)
  - 加密：     aes-256-gcm，base64(iv ‖ tag ‖ ct)
  - 明文：     JSON.stringify({ access_token, modified_at })
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .paths import catpaw_layout

# 检索目标：字面量 → 说明
CRYPTO_NEEDLES: list[dict[str, str]] = [
    {"needle": "catpaw-desk-token-v2", "label": "密钥派生盐串"},
    {"needle": "aes-256-gcm", "label": "对称算法（首次出现）"},
    {"needle": "Failed to decrypt SSO token", "label": "解密失败分支"},
    {"needle": "ssoTokenEnc", "label": "存储键名"},
    {"needle": "catx-credential", "label": "凭据 store 名称"},
    {"needle": "machineIdSync", "label": "机器码来源（node-machine-id）"},
]


@dataclass
class EvidenceSnippet:
    """一条检索命中：命中的字面量 + 其上下文片段。"""

    label: str
    needle: str
    snippet: str


@dataclass
class CryptoEvidence:
    file: str
    file_size_bytes: int
    scanned_bytes: int
    algorithms: list[str]
    salt: str | None
    snippets: list[EvidenceSnippet]
    scheme: dict
    observations: list[str]


def _normalize(raw: str) -> str:
    """把 minified 代码片段压成单行、去控制字符，便于贴进文档。"""
    return re.sub(r"\s{2,}", " ", re.sub(r"[\x00-\x1f\x7f]+", "", raw)).strip()


def scan_file_for_needles(
    path: str,
    needles: list[dict[str, str]],
    chunk_bytes: int = 8 * 1024 * 1024,
    window_bytes: int = 3000,
) -> list[EvidenceSnippet]:
    """分块扫描文件，返回每个 needle 的上下文片段。"""
    found: list[EvidenceSnippet] = []
    remaining = {item["needle"]: item for item in needles}
    carry = b""

    with open(path, "rb") as handle:  # noqa: PTH123
        while remaining:
            chunk = handle.read(chunk_bytes)
            if not chunk:
                break
            data = carry + chunk
            for needle, meta in list(remaining.items()):
                marker = needle.encode("utf-8")
                index = data.find(marker)
                if index == -1:
                    continue
                start = max(0, index - window_bytes)
                head = data[start:index].decode("utf-8", errors="replace")
                tail = data[index + len(marker) : index + len(marker) + 200].decode(
                    "utf-8", errors="replace"
                )
                # 命中点用 ⟨…⟩ 标出：minified 代码一行到底，没有标记根本看不出证据在哪。
                found.append(
                    EvidenceSnippet(meta["label"], needle, _normalize(f"{head}⟨{needle}⟩{tail}"))
                )
                del remaining[needle]
            carry = data[-window_bytes:]

    return found


def _has_snippet(snippets: list[EvidenceSnippet], needle: str) -> bool:
    return any(needle in item.snippet for item in snippets)


def locate_credential_crypto(asar_path: str | None = None) -> CryptoEvidence:
    """定位并归纳凭据加密方案。"""
    asar_path = asar_path or catpaw_layout().app_asar
    if not Path(asar_path).exists():
        raise FileNotFoundError(
            f"app.asar 不存在：{asar_path}（用 CATPAW_INSTALL_DIR 覆盖安装目录）"
        )
    file_size_bytes = Path(asar_path).stat().st_size
    snippets = scan_file_for_needles(asar_path, CRYPTO_NEEDLES)

    algorithms = sorted(
        {
            item["needle"]
            for item in CRYPTO_NEEDLES
            if item["label"].startswith("对称算法")
            and any(s.needle == item["needle"] for s in snippets)
        }
    )
    salt = (
        "catpaw-desk-token-v2"
        if any(s.needle == "catpaw-desk-token-v2" for s in snippets)
        else None
    )

    observations: list[str] = []
    observations.append(
        "密钥派生用 sha256，输入为 `${machineId}:catpaw-desk-token-v2`"
        if _has_snippet(snippets, "'sha256'") or _has_snippet(snippets, "`sha256`")
        else "未直接看到 sha256 字面量（可能被压缩器改名），以盐串与 32 字节密钥长度为准"
    )
    observations.append(
        "对称算法为 aes-256-gcm（AEAD，带 16 字节认证标签）"
        if _has_snippet(snippets, "'aes-256-gcm'") or _has_snippet(snippets, "`aes-256-gcm`")
        else "未直接看到 aes-256-gcm 字面量"
    )
    observations.append(
        "信封切分由实现直接写死：iv=bytes[0,12)、tag=bytes[12,28)、ct=bytes[28,)"
        if _has_snippet(snippets, "subarray(0,12)") and _has_snippet(snippets, "subarray(12,28)")
        else "切分常量未在片段窗口内出现（可加大 windowBytes 重扫）"
    )
    observations.append(
        "密文落盘在 catx-credential store 的 ssoTokenEnc 键（base64）"
        if _has_snippet(snippets, "ssoTokenEnc")
        else "未定位到存储键"
    )
    observations.append(
        "注意：`aes-256-gcm` 字面量在 asar 里并非只出现在妙手凭据模块"
        "（首个命中点属于另一个子系统），所以本工具给出的「对称算法」只是首次命中；"
        "方案判定以 `Ze()/Oe()/re()` 那段片段为准。"
    )
    observations.append(
        "解密后直接 JSON.parse ⇒ 明文是 JSON 文档"
        if _has_snippet(snippets, "JSON.parse(i)")
        else "明文解析形式未在窗口内"
    )

    return CryptoEvidence(
        file=asar_path,
        file_size_bytes=file_size_bytes,
        scanned_bytes=file_size_bytes,
        algorithms=algorithms,
        salt=salt,
        snippets=snippets,
        scheme={
            "cipher": "aes-256-gcm",
            "keyDerivation": "sha256(`${machineId}:catpaw-desk-token-v2`)",
            "ivBytes": 12,
            "tagBytes": 16,
            "envelope": "base64( iv[12] ‖ authTag[16] ‖ ciphertext )",
            "plaintextShape": "JSON：{ access_token: string, modified_at: number }",
            "storage": "catx-credential.json → ssoTokenEnc",
        },
        observations=observations,
    )


def format_crypto_evidence(evidence: CryptoEvidence) -> str:
    """渲染证据报告。"""
    lines: list[str] = []
    lines.append("\n=== Phase 4 · app.asar 静态加密识别 ===")
    lines.append(f"  文件                {evidence.file}")
    lines.append(f"  大小                {evidence.file_size_bytes / 1024 / 1024:.1f} MiB")
    lines.append(f"  命中算法            {', '.join(evidence.algorithms) or '(无)'}")
    lines.append(f"  密钥派生盐          {evidence.salt or '(未命中)'}")

    lines.append("\n--- 观察 ---")
    for item in evidence.observations:
        lines.append(f"  - {item}")

    lines.append("\n--- 证据片段 ---")
    for item in evidence.snippets:
        lines.append(f"\n  [{item.label}] needle={item.needle}")
        # 窗口取的是"命中点之前"的代码（函数体在日志调用之前），所以打印尾部最关键。
        body = f"…{item.snippet[-1500:]}" if len(item.snippet) > 1500 else item.snippet
        lines.append(f"  {body}")

    lines.append("\n--- 方案 ---")
    lines.append(f"  cipher        {evidence.scheme['cipher']}")
    lines.append(f"  key           {evidence.scheme['keyDerivation']}")
    lines.append(f"  envelope      {evidence.scheme['envelope']}")
    lines.append(f"  plaintext     {evidence.scheme['plaintextShape']}")
    lines.append(f"  storage       {evidence.scheme['storage']}")
    return "\n".join(lines)
