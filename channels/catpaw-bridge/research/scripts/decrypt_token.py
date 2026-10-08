"""Phase 6 解密验证（对应 scripts/decrypt-token.ts）。"""

from __future__ import annotations

from ..decryption import (
    cross_check_with_desktop_auth,
    decrypt_local_sso_token,
    format_decryption_report,
)


def main() -> int:
    outcome = decrypt_local_sso_token()
    cross = cross_check_with_desktop_auth(outcome.payload)
    print(format_decryption_report(outcome, cross))
    return 0 if outcome.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
