"""Phase 3 密文结构分析（对应 scripts/analyze-token-blob.ts）。

用法：catpaw-analyze [base64 文件]
  不给参数时读取本机 catx-credential.json 的 ssoTokenEnc。
"""

from __future__ import annotations

import sys
from pathlib import Path

from ..analyze import analyze_encoded_blob, format_blob_analysis
from ..data_collection import read_encrypted_sso_token
from ..paths import catpaw_layout


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args:
        try:
            encoded = Path(args[0]).read_text(encoding="utf-8").strip()
        except OSError as exc:
            print(f"读文件失败: {exc}")
            return 1
        source = args[0]
    else:
        layout = catpaw_layout()
        encoded = read_encrypted_sso_token(layout.credential_file)
        source = layout.credential_file
    if not encoded:
        print("读不到 ssoTokenEnc")
        return 1
    print(format_blob_analysis(analyze_encoded_blob(encoded), source))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
