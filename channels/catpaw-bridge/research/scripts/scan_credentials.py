"""Phase 2 凭据落点清单（对应 scripts/scan-credentials.ts）。"""

from __future__ import annotations

from ..data_collection import collect_candidates, format_candidates
from ..paths import catpaw_layout


def main() -> int:
    layout = catpaw_layout()
    print(format_candidates(collect_candidates(layout), layout))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
