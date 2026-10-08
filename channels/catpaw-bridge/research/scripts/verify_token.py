"""端到端验证：解密 + 与 auth.json 交叉比对 + 加解密往返（对应 scripts/verify-token.ts）。"""

from __future__ import annotations

from ..crypto import decrypt_sso_token, encrypt_sso_token
from ..decryption import (
    cross_check_with_desktop_auth,
    decrypt_local_sso_token,
    derive_local_key,
    format_decryption_report,
)


def main() -> int:
    outcome = decrypt_local_sso_token()
    cross = cross_check_with_desktop_auth(outcome.payload)
    print(format_decryption_report(outcome, cross))

    round_trip = False
    if outcome.ok and outcome.payload is not None:
        _, key = derive_local_key()
        if key is None:
            print("\n--- 加解密往返 ---\n  跳过：读不到机器码")
        else:
            re_encoded = encrypt_sso_token(outcome.payload, key)
            again = decrypt_sso_token(re_encoded, key)
            round_trip = again.access_token == outcome.payload.access_token
            print("\n--- 加解密往返 ---")
            print(f"  重新加密后解密一致: {round_trip}")

    # 与 TS 版一致：三条都满足才算通过（auth.json 缺失时 same_fingerprint 为 None，不算失败）
    ok = outcome.ok and round_trip and cross.same_fingerprint is not False
    print(f"\n验证结论: {'通过' if ok else '未通过'}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
