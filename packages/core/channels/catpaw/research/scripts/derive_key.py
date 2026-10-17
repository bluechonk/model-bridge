"""Phase 5 密钥派生报告（对应 scripts/derive-key.ts）。"""

from __future__ import annotations

from ..decryption import derive_local_key
from ..machineid import format_key_report
from ..redact import fingerprint


def main() -> int:
    reading, key = derive_local_key()
    machine_fp = fingerprint(reading.value) if reading.available else "-"
    print(format_key_report(reading, key, machine_fp))
    return 0 if reading.available else 1


if __name__ == "__main__":
    raise SystemExit(main())
