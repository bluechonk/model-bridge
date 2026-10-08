"""妙手 SSO token 的加解密原语（移植自 phase6/tokenCrypto.ts）。

由 Phase 4 在 app.asar 里读到的实现（minified 后函数名 Ze / Oe / re）：

    key = SHA-256(`${machineId}:catpaw-desk-token-v2`)
    加密  Oe(payload):
      iv  = random(12)
      ct  = AES-256-GCM(key, iv).encrypt(JSON.stringify(payload))
      out = base64( iv ‖ authTag(16) ‖ ct )
    解密  re(encoded):
      raw = base64_decode(encoded)
      iv  = raw[0,12)  tag = raw[12,28)  ct = raw[28,)
      JSON.parse( AES-256-GCM-decrypt(ct, iv, tag) )
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
from dataclasses import dataclass

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# GCM nonce 长度
IV_BYTES = 12
# GCM 认证标签长度
TAG_BYTES = 16
# 密钥派生用的固定后缀（Phase 4 证据）
KEY_SALT_SUFFIX = ":catpaw-desk-token-v2"


def derive_sso_token_key(machine_id: str) -> bytes:
    """密钥派生：sha256(`${machineId}:catpaw-desk-token-v2`)，32 字节。"""
    return hashlib.sha256(f"{machine_id}{KEY_SALT_SUFFIX}".encode()).digest()


@dataclass
class SsoTokenPayload:
    """解密后的明文形状：{ access_token, modified_at }。"""

    access_token: str
    modified_at: int


def is_sso_token_payload(value: object) -> bool:
    """校验明文形状。"""
    if not isinstance(value, dict):
        return False
    access_token = value.get("access_token")
    return (
        isinstance(access_token, str)
        and access_token != ""
        and isinstance(value.get("modified_at"), int)
    )


def decrypt_sso_token(encoded: str, key: bytes) -> SsoTokenPayload:
    """解密 `ssoTokenEnc`。

    @throws 当 base64 非法、长度不足、密钥不符（GCM tag 校验失败）或明文不是 JSON。
    """
    try:
        raw = base64.b64decode(encoded, validate=False)
    except (ValueError, TypeError) as exc:
        raise ValueError(f"base64 非法: {exc}") from exc
    if len(raw) <= IV_BYTES + TAG_BYTES:
        raise ValueError(f"密文过短：{len(raw)} 字节，至少需要 {IV_BYTES + TAG_BYTES + 1}")

    iv = raw[:IV_BYTES]
    tag = raw[IV_BYTES : IV_BYTES + TAG_BYTES]
    ciphertext = raw[IV_BYTES + TAG_BYTES :]

    # cryptography 的 AESGCM.decrypt 期望 ct ‖ tag
    plaintext = AESGCM(key).decrypt(iv, ciphertext + tag, None)
    parsed = json.loads(plaintext.decode("utf-8"))
    if not is_sso_token_payload(parsed):
        raise ValueError("解密成功但明文形状不符（期望 { access_token, modified_at }）")
    return SsoTokenPayload(access_token=parsed["access_token"], modified_at=parsed["modified_at"])


def encrypt_sso_token(payload: SsoTokenPayload, key: bytes) -> str:
    """按原实现的格式加密回去（用于往返验证与文档示例）。"""
    iv = os.urandom(IV_BYTES)
    body = json.dumps({"access_token": payload.access_token, "modified_at": payload.modified_at})
    ct_tag = AESGCM(key).encrypt(iv, body.encode(), None)
    ciphertext, tag = ct_tag[:-TAG_BYTES], ct_tag[-TAG_BYTES:]
    return base64.b64encode(iv + tag + ciphertext).decode("ascii")
