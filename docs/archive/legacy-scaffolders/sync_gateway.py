"""把已验证的 gateway.py 复制到全部 <渠道>-bridge 项目。

`gateway.py` 是**渠道无关**的（差异全由 `upstream` 模块的钩子提供），
故在 11 个项目里应当是同一份，只有三处需要参数化：
  - `logging.getLogger("zcode-bridge")` → `<cid>-bridge`
  - 服务名（health / root 的 `"service"` 字段）
  - `DISPLAY_NAME` 的兜底值

用法：python sync_gateway.py [源项目] [--check]
"""

from __future__ import annotations

import difflib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

CHANNELS = [
    "qoder",
    "zcode",
    "trae",
    "codearts",
    "lobsterai",
    "cline",
    "loomy",
    "raccoon",
    "minimax",
    "gemini",
]


def parameterize(text: str, cid: str) -> str:
    """把源（zcode）的 gateway.py 参数化成目标渠道的版本。"""
    out = text
    # logger 名与打印前缀
    out = out.replace('logging.getLogger("zcode-bridge")', f'logging.getLogger("{cid}-bridge")')
    out = out.replace('f"[zcode-bridge] ', f'f"[{cid}-bridge] ')
    out = out.replace('format="[zcode-bridge] %(message)s"', f'format="[{cid}-bridge] %(message)s"')
    # 服务标识
    out = out.replace('"service": "zcode-bridge"', f'"service": "{cid}-bridge"')
    out = out.replace('f"\\[{cid}-bridge\\]"', "")  # 防御：避免重复替换
    # DISPLAY_NAME 兜底值
    out = out.replace('getattr(upstream, "DISPLAY_NAME", "zcode")', f'getattr(upstream, "DISPLAY_NAME", "{cid}")')
    return out


def main() -> int:
    check_only = "--check" in sys.argv
    source_cid = "zcode"
    source = ROOT / f"{source_cid}-bridge" / "src" / f"{source_cid}_bridge" / "gateway.py"
    if not source.is_file():
        print(f"源文件不存在: {source}")
        return 2
    template = source.read_text(encoding="utf-8")

    drift: list[str] = []
    for cid in CHANNELS:
        target = ROOT / f"{cid}-bridge" / "src" / f"{cid}_bridge" / "gateway.py"
        if not target.parent.is_dir():
            print(f"[skip] {cid}-bridge 不存在")
            continue
        want = parameterize(template, cid)
        current = target.read_text(encoding="utf-8") if target.is_file() else ""

        if check_only:
            if current != want:
                drift.append(cid)
                diff = difflib.unified_diff(
                    current.splitlines(), want.splitlines(), lineterm="", n=1
                )
                head = list(diff)[:12]
                print(f"[DRIFT] {cid}-bridge")
                for line in head:
                    print("   ", line)
            else:
                print(f"[ok]   {cid}-bridge 与模板一致")
            continue

        if current == want:
            print(f"[ok]   {cid}-bridge 已是最新")
            continue
        target.write_text(want, encoding="utf-8")
        print(f"[sync] {cid}-bridge")

    if check_only and drift:
        print(f"\n{len(drift)} 个项目与模板不一致：{drift}")
        return 1
    if check_only:
        print("\n全部一致。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
