"""Phase 6 —— 解密验证。

端到端把 Phase 2~5 的结论串起来：

    catx-credential.json → ssoTokenEnc
         → base64 解码 → 切分 IV/tag/ct
         → key = sha256(`${machineId}:catpaw-desk-token-v2`)
         → AES-256-GCM 解密 → JSON.parse
         → { access_token, modified_at }

再做一次交叉验证：把解密出的 access_token 与 CLI 侧明文 auth.json 的
accessToken 比对（长度 + sha256 指纹）。

全程只输出脱敏信息：token 只给 `前缀…[长度]` 与指纹。
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, datetime

from .crypto import SsoTokenPayload, decrypt_sso_token, derive_sso_token_key
from .data_collection import read_desktop_auth, read_encrypted_sso_token
from .machineid import MachineIdReading, read_machine_id
from .paths import CatPawLayout, catpaw_layout
from .redact import fingerprint, mask_secret


@dataclass
class DecryptionOutcome:
    """一次解密尝试的结果。"""

    ok: bool
    credential_file: str
    encoded_length: int | None
    payload: SsoTokenPayload | None
    token_mask: str | None
    token_fingerprint: str | None
    modified_at: str | None
    error: str | None


def _empty(layout: CatPawLayout) -> DecryptionOutcome:
    return DecryptionOutcome(
        ok=False,
        credential_file=layout.credential_file,
        encoded_length=None,
        payload=None,
        token_mask=None,
        token_fingerprint=None,
        modified_at=None,
        error=None,
    )


def _iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=UTC).isoformat()


def decrypt_local_sso_token(layout: CatPawLayout | None = None) -> DecryptionOutcome:
    """执行本机解密。"""
    layout = layout or catpaw_layout()
    empty = _empty(layout)

    encoded = read_encrypted_sso_token(layout.credential_file)
    if encoded is None:
        return replace(empty, error=f"读不到 ssoTokenEnc：{layout.credential_file}")

    reading = read_machine_id()
    if not reading.available:
        return replace(
            empty,
            encoded_length=len(encoded),
            error=f"读不到机器码：{reading.error or reading.origin}",
        )

    key = derive_sso_token_key(reading.value)
    try:
        payload = decrypt_sso_token(encoded, key)
    except Exception as exc:  # noqa: BLE001 - 解密失败统一收敛
        return replace(empty, encoded_length=len(encoded), error=str(exc))

    return DecryptionOutcome(
        ok=True,
        credential_file=layout.credential_file,
        encoded_length=len(encoded),
        payload=payload,
        token_mask=mask_secret(payload.access_token),
        token_fingerprint=fingerprint(payload.access_token),
        modified_at=_iso(payload.modified_at),
        error=None,
    )


@dataclass
class CrossCheck:
    """与 CLI 明文登录态的交叉验证结果。"""

    present: bool
    auth_file: str
    auth_mask: str | None
    same_length: bool | None
    same_fingerprint: bool | None
    verdict: str


def cross_check_with_desktop_auth(
    payload: SsoTokenPayload | None, layout: CatPawLayout | None = None
) -> CrossCheck:
    """用 CLI 侧明文 auth.json 交叉验证解出来的 token。"""
    layout = layout or catpaw_layout()
    auth = read_desktop_auth(layout.auth_json_file)
    if auth is None:
        return CrossCheck(
            present=False,
            auth_file=layout.auth_json_file,
            auth_mask=None,
            same_length=None,
            same_fingerprint=None,
            verdict="CLI 明文 auth.json 不存在或不可解析，无法交叉验证",
        )
    if payload is None:
        return CrossCheck(
            present=True,
            auth_file=layout.auth_json_file,
            auth_mask=mask_secret(auth.access_token),
            same_length=None,
            same_fingerprint=None,
            verdict="解密未成功，跳过比对",
        )

    same_length = len(auth.access_token) == len(payload.access_token)
    same_fp = fingerprint(auth.access_token) == fingerprint(payload.access_token)
    if same_fp:
        verdict = "解密结果与 CLI 明文登录态完全一致（同一 access_token）"
    elif same_length:
        verdict = "长度一致但指纹不同：凭据已在本机轮换，密文与明文不同步"
    else:
        verdict = "长度与指纹都不同：两者可能来自不同账号/scope"
    return CrossCheck(
        present=True,
        auth_file=layout.auth_json_file,
        auth_mask=mask_secret(auth.access_token),
        same_length=same_length,
        same_fingerprint=same_fp,
        verdict=verdict,
    )


def decrypt_encoded_token(encoded: str, key: bytes) -> SsoTokenPayload:
    """读一份密文与 key，纯函数式解密（给测试与脚本用）。"""
    return decrypt_sso_token(encoded, key)


def derive_local_key() -> tuple[MachineIdReading, bytes | None]:
    """读取机器码并派生密钥，供脚本拆分展示。"""
    reading = read_machine_id()
    if not reading.available:
        return reading, None
    return reading, derive_sso_token_key(reading.value)


def read_auth_token_fingerprint(layout: CatPawLayout | None = None) -> str | None:
    """计算明文 token 的指纹（给交叉验证脚本用）。"""
    layout = layout or catpaw_layout()
    auth = read_desktop_auth(layout.auth_json_file)
    if auth is None:
        return None
    return fingerprint(auth.access_token)


def format_decryption_report(outcome: DecryptionOutcome, cross: CrossCheck) -> str:
    """渲染解密报告。"""
    lines: list[str] = []
    encoded_len = outcome.encoded_length if outcome.encoded_length is not None else "-"
    same_len = cross.same_length if cross.same_length is not None else "-"
    same_fp = cross.same_fingerprint if cross.same_fingerprint is not None else "-"
    lines.append("\n=== Phase 6 · 解密验证 ===")
    lines.append(f"  凭据文件            {outcome.credential_file}")
    lines.append(f"  密文长度(base64)    {encoded_len}")
    lines.append(f"  解密成功            {outcome.ok}")
    if outcome.error is not None:
        lines.append(f"  错误                {outcome.error}")
    if outcome.payload is not None:
        lines.append(f"  access_token        {outcome.token_mask or '-'}")
        lines.append(f"  token 指纹          {outcome.token_fingerprint or '-'}")
        lines.append(f"  modified_at         {outcome.modified_at or '-'}")
    lines.append("\n--- 交叉验证（CLI 明文登录态） ---")
    lines.append(f"  文件存在            {cross.present}")
    lines.append(f"  auth.json token     {cross.auth_mask or '-'}")
    lines.append(f"  长度一致            {same_len}")
    lines.append(f"  指纹一致            {same_fp}")
    lines.append(f"  结论                {cross.verdict}")
    return "\n".join(lines)
