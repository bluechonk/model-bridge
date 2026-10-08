"""上游模型目录（对应 scripts/list-models.ts）。

唯一出网的研究脚本，且默认 dry-run：必须显式 `--live` 才真发请求。
"""

from __future__ import annotations

import asyncio
import sys

from ..cred import get_local_credential
from ..upstream_client import CatPawUpstreamClient


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    live = "--live" in args

    credential = get_local_credential()
    if credential is None:
        print("[list-models] 无可用凭据（先在妙手桌面端登录，或运行 catpaw login）")
        return 1
    if not live:
        print(
            f"[list-models] dry-run：有可用凭据（来源 {credential.source}）；"
            "加 --live 才真发请求"
        )
        return 0

    models = asyncio.run(CatPawUpstreamClient().list_models(credential))
    for model in models:
        print(f"modelType={model.model_type} id={model.id} ({model.display_name})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
