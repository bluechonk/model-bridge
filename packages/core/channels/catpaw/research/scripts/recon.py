"""Phase 1 侦察快照（对应 scripts/recon.ts）。"""

from __future__ import annotations

from ..recon import format_recon_report, reconnaissance


def main() -> int:
    print(format_recon_report(reconnaissance()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
