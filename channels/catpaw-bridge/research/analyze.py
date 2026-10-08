"""Phase 3 —— 格式分析（Format Analysis）（移植自 phase3-format-analysis）。

目标：把 `ssoTokenEnc` 当成一个黑盒字节串来量。产出可被证伪的结构结论：

  - base64 解码后多少字节（密文长度 = 明文长度 + 认证标签开销）
  - 字节分布的香农熵（接近 8 bit/byte ⇒ 不是明文/不是压缩，是加密或随机）
  - 可打印字符占比、是否像 JSON
  - 头部若干字节（IV 候选）

切分（IV=12、tag=16）不是本阶段猜出来的，而是 Phase 4 在 app.asar 里读到的
实现常量；本阶段只负责用长度与熵去**印证**这个切分是自洽的。
"""

from __future__ import annotations

import base64
import math
from dataclasses import dataclass

from .redact import fingerprint_bytes


@dataclass
class BlobLayout:
    """由 Phase 4 的代码证据确定的字节切分。"""

    iv_bytes: int
    tag_bytes: int


DEFAULT_BLOB_LAYOUT = BlobLayout(12, 16)


@dataclass
class BlobAnalysis:
    """一次格式分析的结果。"""

    encoded_length: int
    byte_length: int
    segments: dict
    iv_hex: str
    tag_prefix_hex: str
    entropy: float
    printable_ratio: float
    looks_like_json: bool
    digest: str
    verdict: str


def shannon_entropy(data: bytes) -> float:
    """香农熵（bit/byte）。空输入返回 0。"""
    if len(data) == 0:
        return 0.0
    counts = [0] * 256
    for byte in data:
        counts[byte] += 1
    entropy = 0.0
    for count in counts:
        if count == 0:
            continue
        p = count / len(data)
        entropy -= p * math.log2(p)
    return entropy


def printable_ratio(data: bytes) -> float:
    """可打印 ASCII（0x20~0x7e）占比。"""
    if len(data) == 0:
        return 0.0
    printable = sum(1 for byte in data if 0x20 <= byte <= 0x7E)
    return printable / len(data)


def decode_base64(encoded: str) -> bytes:
    """解 base64，非法输入抛错（调用方负责判定）。"""
    return base64.b64decode(encoded, validate=False)


def analyze_encoded_blob(encoded: str, layout: BlobLayout = DEFAULT_BLOB_LAYOUT) -> BlobAnalysis:
    """分析 `ssoTokenEnc`。"""
    data = decode_base64(encoded)
    iv = data[: layout.iv_bytes]
    tag = data[layout.iv_bytes : layout.iv_bytes + layout.tag_bytes]
    ciphertext = data[layout.iv_bytes + layout.tag_bytes :]

    entropy = shannon_entropy(ciphertext)
    ratio = printable_ratio(ciphertext)
    # 判定"该字段是否根本没加密"要看**整个**解码结果的首字节：
    # 真信封的首字节是随机 IV，几乎不可能是 `{`/`[`/`"`；明文 JSON 落盘则必然以它们开头。
    first = data[0] if len(data) > 0 else -1
    looks_like_json = first in (0x7B, 0x5B, 0x22)

    verdict_parts: list[str] = []
    verdict_parts.append(
        f"{len(data)} 字节 = IV {len(iv)} + tag {len(tag)} + 密文 {len(ciphertext)}"
    )
    verdict_parts.append(f"密文熵 {entropy:.3f} bit/byte")
    if len(ciphertext) == 0:
        verdict_parts.append("长度不足以容纳 IV+tag ⇒ 不可能是本格式的信封")
    elif looks_like_json:
        verdict_parts.append("整个字段像明文 JSON ⇒ 该字段可能未加密（需重新定位）")
    elif entropy > 7.5:
        verdict_parts.append("高熵且非明文结构 ⇒ AES-256-GCM 密文特征明显")
    else:
        verdict_parts.append(
            "非明文结构；短密文的熵估计天然偏低，结合 Phase 4 的实现证据判定为 AES-256-GCM 密文"
        )

    return BlobAnalysis(
        encoded_length=len(encoded),
        byte_length=len(data),
        segments={"iv": len(iv), "tag": len(tag), "ciphertext": len(ciphertext)},
        iv_hex=iv.hex(),
        tag_prefix_hex=tag[:8].hex(),
        entropy=entropy,
        printable_ratio=ratio,
        looks_like_json=looks_like_json,
        digest=fingerprint_bytes(ciphertext),
        verdict="；".join(verdict_parts),
    )


def format_blob_analysis(analysis: BlobAnalysis, source: str) -> str:
    """渲染分析结果。"""
    lines: list[str] = []
    lines.append("\n=== Phase 3 · 密文结构分析 ===")
    lines.append(f"  来源                {source}")
    lines.append(f"  base64 长度         {analysis.encoded_length}")
    lines.append(f"  解码字节数          {analysis.byte_length}")
    lines.append(
        "  切分                "
        f"IV {analysis.segments['iv']} + tag {analysis.segments['tag']} "
        f"+ 密文 {analysis.segments['ciphertext']}"
    )
    lines.append(f"  IV (hex)            {analysis.iv_hex}")
    lines.append(f"  auth tag 前 8 字节  {analysis.tag_prefix_hex}")
    lines.append(f"  密文熵              {analysis.entropy:.4f} bit/byte")
    lines.append(f"  密文可打印占比      {analysis.printable_ratio * 100:.1f}%")
    lines.append(f"  像 JSON 明文        {analysis.looks_like_json}")
    lines.append(f"  密文指纹            {analysis.digest}")
    lines.append(f"  结论                {analysis.verdict}")
    return "\n".join(lines)
