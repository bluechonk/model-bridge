"""Phase 4 app.asar 静态加密识别（对应 scripts/locate-crypto.ts）。"""

from __future__ import annotations

from ..locate_crypto import format_crypto_evidence, locate_credential_crypto


def main() -> int:
    try:
        evidence = locate_credential_crypto()
    except FileNotFoundError as exc:
        print(exc)
        return 1
    print(format_crypto_evidence(evidence))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
