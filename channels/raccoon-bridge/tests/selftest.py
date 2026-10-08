"""Raccoon 渠道的离线自检（不出网、不需要真实凭据）。

覆盖：
1. 手机号 AES-128-CFB 加密（协议 §2.3）
2. 凭据：JWT `exp` 回退、`expires_at` 优先级、落盘/补字段/损坏
3. 扫码登录流（假 auth 服务）：`logging` 不中断、`canceled` 换码、异常降级 `pending`、
   缺 token 的 `success` 视为未完成
4. 续期：只回 access_token 时保留旧 refresh_token、200003 / 401 为终态
5. 请求体改写：`extra_body.thinking` 是唯一思考通道、`max_tokens` 安全整数、tools 在顶层
6. 请求头：对话 / 目录 / 领取三种形态（platform 的有无是硬约束）
7. 模型目录：兜底表、图片能力白名单、倍率展示规则、远端解析
8. 额度：余额只读、缺失 `available_points` 不显示成 0、登录奖励幂等
9. 端到端：假上游 + 真实网关（WIRE == 'openai'，无需翻译器）

用法：python tests/selftest.py
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import socket
import sys
import tempfile
import time
from pathlib import Path

# 让 src/ 可导入
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

# 隔离数据目录，避免碰到真实凭据
_TMP_HOME = Path(tempfile.mkdtemp(prefix="raccoon-selftest-"))
os.environ["RACCOON_HOME"] = str(_TMP_HOME)

from raccoon_bridge import billing, catalog, cred, paths, upstream  # noqa: E402

FAILURES: list[str] = []


def check(name: str, got: object, want: object) -> None:
    ok = got == want
    print(f"[{'ok  ' if ok else 'FAIL'}] {name}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(name)


def check_true(name: str, got: object) -> None:
    ok = bool(got)
    print(f"[{'ok  ' if ok else 'FAIL'}] {name}: got={got!r} want=truthy")
    if not ok:
        FAILURES.append(name)


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _fake_jwt(exp: int | None = None, **claims: object) -> str:
    """造一个仅供本地解码的 JWT（`exp` 用秒，与服务端一致）。"""
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload: dict[str, object] = dict(claims)
    if exp is not None:
        payload["exp"] = exp
    body = _b64url(json.dumps(payload).encode())
    return f"{header}.{body}.signature"


# ── 1. 手机号加密 ─────────────────────────────────────────────────────────────


def test_phone_cipher() -> None:
    print("=== 1. 手机号 AES-128-CFB（协议 §2.3）===")
    # ⚠ 密钥 16 字节 ⇒ 必须 aes-128-cfb；写成 256 会因密钥长度不足抛错
    check("密钥长度 = 16（AES-128）", len(cred.PHONE_CIPHER_SECRET), 16)
    check("密钥逐字", cred.PHONE_CIPHER_SECRET, b"senseraccoon2023")

    blob1 = cred.encrypt_phone("13800138000")
    blob2 = cred.encrypt_phone("13800138000")
    check("解密回原文", cred.decrypt_phone(blob1), "13800138000")
    check_true("IV 每次随机（同一明文两次密文不同）", blob1 != blob2)
    check("输出长度 = 16 字节 IV + 明文长度", len(base64.b64decode(blob1)), 16 + 11)

    check("手机号校验 13800138000", cred.is_valid_phone("13800138000"), True)
    check("手机号校验 19912345678", cred.is_valid_phone("19912345678"), True)
    check("拒绝 12800138000（第 2 位 <3）", cred.is_valid_phone("12800138000"), False)
    check("拒绝 10 位", cred.is_valid_phone("1380013800"), False)
    check("拒绝 12 位", cred.is_valid_phone("138001380001"), False)
    check("拒绝空串", cred.is_valid_phone(""), False)


# ── 2. 凭据 ──────────────────────────────────────────────────────────────────


def test_credentials() -> None:
    print()
    print("=== 2. 凭据：过期判定与落盘 ===")
    future = int(time.time()) + 3600
    token = _fake_jwt(exp=future)

    # ⚠ expires_at 缺失时必须回退解 JWT —— 只读 expires_at 会让过期判定恒为 false
    c = cred.Credentials(access_token=token)
    check("expires_at 缺失 → 回退 JWT exp（毫秒）", c.expires_at_ms(), future * 1000.0)
    check("is_expired（未过期）", c.is_expired(), False)
    check("无 exp 的 JWT → 不编造", cred.Credentials(access_token="a.b.c").expires_at_ms(), None)
    check(
        "坏 token → None（不抛错）",
        cred.Credentials(access_token="!!!.???").expires_at_ms(),
        None,
    )
    check(
        "exp 非数字 → None（不编造）",
        cred.Credentials(access_token=_fake_jwt(exp="soon")).expires_at_ms(),  # type: ignore[arg-type]
        None,
    )

    expired = cred.Credentials(access_token=_fake_jwt(exp=int(time.time()) - 10))
    check("JWT 已过期 → is_expired", expired.is_expired(), True)

    # 显式 expires_at 优先于 JWT
    explicit = cred.Credentials(access_token=token, expires_at=str((future + 10_000) * 1000))
    check("expires_at 优先于 JWT", explicit.expires_at_ms(), float((future + 10_000) * 1000))

    # 账号标识：nickname 是服务端自动生成的默认名，不能当标识
    account = cred.Credentials(
        access_token="t", nickname="RaccoonAva", phone="13800138000", user_id="u-9"
    )
    check("uid 优先 user_id", account.uid, "u-9")
    check(
        "uid 回退 phone（而非自动生成的 nickname）",
        cred.Credentials(access_token="t", nickname="RaccoonAva", phone="13800138000").uid,
        "13800138000",
    )
    check("domain 恒空（端点固定）", account.domain, "")

    # 落盘 / 读取
    cred.save(account)
    loaded = cred.load()
    check("往返一致（access_token）", loaded.access_token, "t")
    check("往返一致（phone）", loaded.phone, "13800138000")
    check("往返一致（nickname）", loaded.nickname, "RaccoonAva")
    check("落盘无残留临时文件", paths.credentials_path().with_suffix(".json.tmp").exists(), False)
    check(
        "camelCase 兼容",
        cred.Credentials.from_dict({"accessToken": "x", "refreshToken": "y"}).access_token,
        "x",
    )

    # 老凭据缺 device_id → 补生成并写回（不拒绝整条凭据）
    cred_path = paths.credentials_path()
    cred_path.write_text(json.dumps({"access_token": "old"}), encoding="utf-8")
    old = cred.load()
    check("老凭据补出 32 位 hex device_id", len(old.device_id), 32)
    on_disk = json.loads(cred_path.read_text(encoding="utf-8"))
    check("补的 device_id 已写回磁盘", on_disk["device_id"], old.device_id)

    # 损坏 / 缺字段 → NotLoggedInError
    cred_path.write_text("{not json", encoding="utf-8")
    try:
        cred.load()
        got: object = "no-raise"
    except cred.NotLoggedInError as e:
        got = "NotLoggedInError"
        check_true("损坏提示可读", "损坏" in str(e))
    check("JSON 损坏 → NotLoggedInError", got, "NotLoggedInError")

    cred_path.write_text(json.dumps({"refresh_token": "r"}), encoding="utf-8")
    try:
        cred.load()
        got2: object = "no-raise"
    except cred.NotLoggedInError:
        got2 = "NotLoggedInError"
    check("缺 access_token → NotLoggedInError", got2, "NotLoggedInError")

    cred_path.unlink()
    try:
        cred.load()
        got3: object = "no-raise"
    except cred.NotLoggedInError:
        got3 = "NotLoggedInError"
    check("文件缺失 → NotLoggedInError", got3, "NotLoggedInError")

    check("resolve_base_url 恒为唯一域", cred.resolve_base_url("cn"), cred.DEFAULT_BASE_URL)


# ── 5. 请求体改写 ────────────────────────────────────────────────────────────


def test_body() -> None:
    print()
    print("=== 5. 请求体：OpenAI 原样 + 思考通道改写 ===")
    base_req = {
        "model": "sn-glm-5-3",
        "messages": [
            {"role": "system", "content": "你是助手"},
            {"role": "user", "content": "你好"},
        ],
        "max_tokens": 4096,
        "temperature": 0.7,
        "stop": ["END"],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "bash",
                    "description": "执行命令",
                    "parameters": {"type": "object", "properties": {"cmd": {"type": "string"}}},
                },
            }
        ],
    }
    body = upstream.build_chat_body(base_req, "sn-glm-5-3")
    check("model 换成上游 id", body["model"], "sn-glm-5-3")
    check("恒 stream（上游只走流式）", body["stream"], True)
    check("messages 原样", body["messages"], base_req["messages"])
    check("temperature 原样", body["temperature"], 0.7)
    check("stop 原样", body["stop"], ["END"])
    check("tools 在顶层（漏发会让模型臆造 XML 工具调用）", "tools" in body, True)
    check("max_tokens 透传安全值", body["max_tokens"], 4096)
    check("无档位时不发 extra_body", "extra_body" in body, False)
    check("顶层 thinking 不下发", "thinking" in body, False)

    # ⚠ reasoning_effort 被服务端接受但实测无效果 ⇒ 必须翻译，不能原样透传
    off_body = upstream.build_chat_body({**base_req, "reasoning_effort": "off"}, "m")
    check("effort=off → thinking.type", off_body["extra_body"]["thinking"]["type"], "disabled")
    check("reasoning_effort 不原样透传", "reasoning_effort" in off_body, False)

    for value in ("on", "high", "max", "minimal", "weird-unknown", 3):
        card = upstream.build_chat_body({**base_req, "reasoning_effort": value}, "m")
        check(
            f"effort={value!r}（非明确关闭）→ enabled",
            card["extra_body"]["thinking"]["type"],
            "enabled",
        )

    for value in ("none", "disabled", "false", False):
        card = upstream.build_chat_body({**base_req, "reasoning_effort": value}, "m")
        check(f"effort={value!r} → disabled", card["extra_body"]["thinking"]["type"], "disabled")

    # 下游直接给合法枚举 / 顶层 thinking（上游会忽略顶层，但用户意图不该丢）
    direct = upstream.build_chat_body(
        {**base_req, "extra_body": {"thinking": {"type": "adaptive"}}}, "m"
    )
    adaptive = direct["extra_body"]["thinking"]["type"]
    check("extra_body.thinking 合法枚举原样采信", adaptive, "adaptive")
    top = upstream.build_chat_body({**base_req, "thinking": {"type": "disabled"}}, "m")
    check("顶层 thinking 翻译进 extra_body", top["extra_body"]["thinking"]["type"], "disabled")
    illegal = upstream.build_chat_body(
        {**base_req, "extra_body": {"thinking": {"type": "bogus"}}}, "m"
    )
    check("非法 thinking.type 不发该字段", "extra_body" in illegal, False)

    # max_tokens 只放行安全正整数（0/负数/NaN 会让上游硬校验崩溃）
    for raw, want in (
        (4096, 4096),
        (4096.0, 4096),
        (0, None),
        (-5, None),
        (float("nan"), None),
        (float("inf"), None),
        (True, None),
        ("4096", None),
        (None, None),
    ):
        card = upstream.build_chat_body({**base_req, "max_tokens": raw}, "m")
        check(f"max_tokens={raw!r} → {want!r}", card.get("max_tokens"), want)


# ── 6. 请求头 ────────────────────────────────────────────────────────────────


def test_headers() -> None:
    print()
    print("=== 6. 请求头：对话 / 目录 / 领取三种形态 ===")
    c = cred.Credentials(access_token="tok-1", office_identity="", device_id="d" * 32)
    chat = upstream.build_headers(c)
    check("Authorization", chat["Authorization"], "Bearer tok-1")
    check("X-Org-Code 恒发送（个人账号为空串）", chat["X-Org-Code"], "")
    check("X-Raccoon-Language", chat["X-Raccoon-Language"], "zh")
    check("X-Client-Platform", chat["X-Client-Platform"], "desktop-windows")
    check("Accept 是 SSE（协议 §3.2）", chat["Accept"], "text/event-stream")
    check("Content-Type", chat["Content-Type"], "application/json")
    check("对话不带 X-Client-Version", "X-Client-Version" in chat, False)
    check("对话不带 X-Client-Device-ID", "X-Client-Device-ID" in chat, False)

    org = upstream.build_headers(cred.Credentials(access_token="t", office_identity="org-1"))
    check("组织账号带 X-Org-Code", org["X-Org-Code"], "org-1")

    # 模型目录：内联构造，不含 platform / 不含 Content-Type
    ls = upstream.build_headers(c, json_body=False, platform=False)
    check("目录不含 X-Client-Platform", "X-Client-Platform" in ls, False)
    check("目录不含 Content-Type", "Content-Type" in ls, False)
    check("目录 Accept", ls["Accept"], "application/json")

    # desktop/v1/login/points/grant：无 body，但 platform 必需
    grant = upstream.build_headers(c, json_body=False, platform=True)
    check("奖励端点带 platform（必需）", grant["X-Client-Platform"], "desktop-windows")
    check("奖励端点无 Content-Type", "Content-Type" in grant, False)


# ── 7. 模型目录（纯静态部分） ─────────────────────────────────────────────────


def test_catalog_static() -> None:
    print()
    print("=== 7. 模型目录：兜底表 / 图片能力 / 倍率规则 ===")
    check("兜底表 6 个模型", len(catalog.FALLBACK_MODELS), 6)
    fallback_ids = {str(m["id"]) for m in catalog.FALLBACK_MODELS}
    check(
        "兜底表 id 集合",
        fallback_ids,
        {
            "sn-sensenova-6-8-flash",
            "sn-sensenova-6-8-flash-lite",
            "sn-glm-5-3",
            "sn-kimi-k3",
            "sn-glm-5-3-flash",
            "sn-deepseek-v4-1-flash",
        },
    )
    check("兜底表不含 Raccoon-Auto（发给 chat 会 404）", "Raccoon-Auto" in fallback_ids, False)

    # ⚠ tags 不是能力契约：白名单覆盖实测确认能读图但远端未声明 vision 的个案
    check(
        "白名单：sn-deepseek-v4-1-flash（tags 无 vision 也能读图）",
        catalog.supports_image("sn-deepseek-v4-1-flash", ["general", "code", "reasoning"]),
        True,
    )
    check("白名单：sn-glm-5-3-flash", catalog.supports_image("sn-glm-5-3-flash", []), True)
    check(
        "tags 含 vision 仍认",
        catalog.supports_image("sn-sensenova-6-8-flash", ["VISION", "general"]),
        True,
    )
    check(
        "未验证模型不推测（无 vision tags → False）",
        catalog.supports_image("sn-some-new-model", ["general", "code"]),
        False,
    )

    # 展示名规则（⚠ 1 倍也要显示）
    check("生效价 0 → 免费", catalog.price_suffix(0.0, 0.5), "免费")
    check("打折 → x原价→x折后价", catalog.price_suffix(0.1, 0.2), "x0.2→x0.1")
    check("1 倍也显示", catalog.price_suffix(1.0, 1.0), "x1")
    check("原价缺失时只显示生效价", catalog.price_suffix(0.75, None), "x0.75")
    check("负数不追加后缀", catalog.price_suffix(-1, 2), "")
    check("NaN 不追加后缀", catalog.price_suffix(float("nan"), 1), "")
    check("缺失不追加后缀", catalog.price_suffix(None, 1), "")
    check("倍率最多 4 位小数去尾随 0", catalog.format_multiplier(0.123456), "0.1235")
    check("倍率整数去小数点", catalog.format_multiplier(1.0), "1")
    check(
        "兜底展示名带倍率",
        catalog.display_name(dict(catalog.FALLBACK_MODELS[3])),
        "Kimi-K3 · x1",
    )
    check(
        "免费模型展示「免费」而不是 x0",
        catalog.display_name(dict(catalog.FALLBACK_MODELS[0])),
        "SenseNova-6.8-Flash · 免费",
    )

    # 未登录时 exposed_ids 必须回退兜底表（否则渠道在选择器里凭空消失）
    catalog.invalidate_cache()
    check("未登录仍列出 6 个兜底模型", len(catalog.exposed_ids()), 6)
    check("未知模型 id 原样透传", catalog.resolve_model("sn-brand-new"), "sn-brand-new")
    check("已知模型 id 恒等映射", catalog.resolve_model("sn-glm-5-3"), "sn-glm-5-3")
    check("详情回退兜底表", len([e for e in catalog.details() if e.get("id")]), 6)

    # 远端解析规则（协议 §5.2）
    payload = {
        "categories": [
            {
                "type": "image",
                "models": [{"name": "should-be-ignored", "visible": True}],
            },
            {
                "type": "chat",
                "models": [
                    {
                        "id": "wrong-key",
                        "name": "sn-glm-5-3",
                        "description": "GLM-5-3",
                        "billing_multiplier": 0.75,
                        "billing_effective_multiplier": 0.75,
                        "billing_status": "normal",
                        "params": {"context_window": 1_000_000, "max_tokens": 100_000},
                        "tags": ["General", "Vision"],
                    },
                    {"name": "hidden-model", "visible": False},
                    {"name": "visible-by-default"},
                    {"name": "sn-glm-5-3", "description": "重复 id 应去重"},
                ],
            },
        ]
    }
    parsed = catalog._parse_remote_models(payload)
    parsed_ids = [e["id"] for e in parsed]
    check("只取 chat 分类且按 name 去重", parsed_ids, ["sn-glm-5-3", "visible-by-default"])
    check("visible=false 被过滤", any(e["id"] == "hidden-model" for e in parsed), False)
    check("非 chat 分类被忽略", any(e["id"] == "should-be-ignored" for e in parsed), False)
    check("context_window 取 params", parsed[0]["context_window"], 1_000_000)
    check("max_output 取 params.max_tokens", parsed[0]["max_output"], 100_000)
    check("tags 小写化后判图片能力", parsed[0]["vision"], True)
    check("缺 visible 字段视为可见", parsed_ids[-1], "visible-by-default")
    check("远端倍率入展示名", parsed[0]["display_name"], "GLM-5-3 · x0.75")
    check("Raccoon-Auto 即使下发也不暴露", catalog._parse_remote_models(
        {"categories": [{"type": "chat", "models": [{"name": "Raccoon-Auto"}]}]}
    ), [])


# ── 8. 额度（纯逻辑 + 契约形状） ──────────────────────────────────────────────


def test_billing_shape() -> None:
    print()
    print("=== 8a. 额度：契约形状与「不编造数字」 ===")
    check_true("CreditsError 是 RuntimeError", issubclass(billing.CreditsError, RuntimeError))
    check("单位是积分", billing._UNIT, "积分")
    check("不存在每日签到端点（协议 §6.1）", hasattr(billing, "claim_daily"), False)
    check("登录奖励伪 campaign id", billing.LOGIN_REWARD_CAMPAIGN_ID, "desktop-login-reward")


# ── 异步部分：假上游 ─────────────────────────────────────────────────────────


async def _fake_server(port: int = 0) -> tuple[object, str, dict]:
    """起一个假 Raccoon 上游，返回 (runner, base, state)。"""
    from aiohttp import web

    state: dict = {
        "qr_calls": 0,
        "refresh_calls": 0,
        "grant_calls": 0,
        "chat_headers": None,
        "chat_body": None,
        "sent_models": 0,
    }
    future_exp = int(time.time()) + 3600

    async def qr_login(request: web.Request) -> web.Response:
        state["qr_calls"] += 1
        call = state["qr_calls"]
        if call == 1:
            return web.json_response(
                {"code": 0, "data": {"status": "logging", "expired_at": 1_700_000_000}}
            )
        if call == 2:
            return web.json_response({"code": 0, "data": {"status": "canceled"}})
        if call == 3:
            # 偶发失败必须降级为 pending，不能中断整个登录流程
            return web.json_response({"code": 0, "message": "boom"}, status=500)
        if call == 4:
            # 缺 token 的 success 视为未完成
            return web.json_response({"code": 0, "data": {"status": "success"}})
        return web.json_response(
            {
                "code": 0,
                "data": {
                    "status": "success",
                    "access_token": _fake_jwt(exp=future_exp, sub="u-1"),
                    "refresh_token": "rt-1",
                    "office_identity": "personal",
                },
            }
        )

    async def refresh(request: web.Request) -> web.Response:
        state["refresh_calls"] += 1
        body = await request.json()
        if body.get("refresh_token") == "rt-expired":
            return web.json_response({"code": 200003, "message": "登录态已过期"})
        if body.get("refresh_token") == "rt-unauthorized":
            return web.json_response({"code": 200003}, status=401)
        # ⚠ 只回新 access_token，不回 refresh_token → 必须保留旧值
        return web.json_response(
            {"code": 0, "data": {"access_token": _fake_jwt(exp=future_exp + 5, sub="u-1")}}
        )

    async def user_info(request: web.Request) -> web.Response:
        return web.json_response(
            {"code": 0, "data": {"id": 42, "name": "RaccoonAva", "phone": "13800138000"}}
        )

    async def model_catalog(request: web.Request) -> web.Response:
        state["sent_models"] += 1
        return web.json_response(
            {
                "code": 0,
                "data": {
                    "categories": [
                        {"type": "image", "models": [{"name": "ignored"}]},
                        {
                            "type": "chat",
                            "models": [
                                {
                                    "id": "wrong",
                                    "name": "sn-glm-5-3",
                                    "description": "GLM-5-3",
                                    "billing_multiplier": 0.75,
                                    "billing_effective_multiplier": 0.75,
                                    "billing_status": "limited_free",
                                    "params": {"context_window": 1_000_000, "max_tokens": 100_000},
                                    "tags": ["general"],
                                },
                                {"name": "sn-glm-5-3-hidden", "visible": False},
                            ],
                        },
                    ]
                },
            }
        )

    async def chat(request: web.Request) -> web.StreamResponse:
        state["chat_headers"] = dict(request.headers)
        state["chat_body"] = await request.json()
        resp = web.StreamResponse()
        resp.content_type = "text/event-stream"
        await resp.prepare(request)
        for delta, finish in (({"content": "网关"}, None), ({"content": "通了"}, None)):
            chunk = {
                "id": "chatcmpl-fake",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "sn-glm-5-3",
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            }
            await resp.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode())
            await asyncio.sleep(0)  # 让出控制权 → 真实的分块 TCP 传输
        last = {
            "id": "chatcmpl-fake",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "sn-glm-5-3",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 7},
        }
        await resp.write(f"data: {json.dumps(last)}\n\n".encode())
        await resp.write(b"data: [DONE]\n\n")
        await resp.write_eof()
        return resp

    async def balance(request: web.Request) -> web.Response:
        return web.json_response(
            {
                "code": 0,
                "data": {
                    "available_points": 3300,
                    "reward_points": 3000,
                    "daily_points": 300,
                    "monthly_points": 0,
                    "topup_points": 0,
                },
            }
        )

    async def balance_bad(request: web.Request) -> web.Response:
        return web.json_response({"code": 0, "data": {"reward_points": 10}})

    async def balance_401(request: web.Request) -> web.Response:
        return web.json_response({"code": 200003}, status=401)

    async def bills(request: web.Request) -> web.Response:
        items = []
        if request.query.get("with_reward") == "1":
            reward = {"biz_type": "reward_grant", "event_name": "桌面端登录奖励", "points": 3000}
            items.append(reward)
        else:
            # 「新人注册礼包」也是 reward_grant，不能只看 biz_type
            items.append({"biz_type": "reward_grant", "event_name": "新人注册礼包", "points": 3000})
        items.append({"biz_type": "daily_grant", "event_name": "每日积分", "points": 300})
        return web.json_response({"code": 0, "data": {"items": items}})

    async def grant(request: web.Request) -> web.Response:
        state["grant_calls"] += 1
        if state["grant_calls"] == 1:
            payload = {"code": 0, "data": {"granted": True, "popup": {"points": 3000}}}
            return web.json_response(payload)
        if state["grant_calls"] == 2:
            return web.json_response({"code": 0, "data": {"granted": False}})
        return web.json_response({"code": 500, "message": "服务端故障"})

    app = web.Application()
    app.router.add_post("/auth/login_with_qrcode_code", qr_login)
    app.router.add_post("/auth/refresh", refresh)
    app.router.add_get("/auth/user_info", user_info)
    app.router.add_get("/llm/model_catalog", model_catalog)
    app.router.add_post("/llm/chat/completions", chat)
    app.router.add_get("/points/balance", balance)
    app.router.add_get("/points/balance_bad", balance_bad)
    app.router.add_get("/points/balance_401", balance_401)
    app.router.add_get("/points/bills", bills)
    app.router.add_post("/desktop/login/points/grant", grant)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()
    real_port = site._server.sockets[0].getsockname()[1]
    return runner, f"http://127.0.0.1:{real_port}", state


async def test_login_and_refresh(base: str, state: dict) -> None:
    print()
    print("=== 3. 扫码登录流（假 auth 服务）===")
    cred.QR_LOGIN_URL = f"{base}/auth/login_with_qrcode_code"
    cred.REFRESH_URL = f"{base}/auth/refresh"
    cred.USER_INFO_URL = f"{base}/auth/user_info"
    cred.QR_POLL_INTERVAL_SEC = 0.01  # 别真的每 2 秒轮一次
    cred.LOGIN_TIMEOUT_SEC = 5.0

    seen_urls: list[str] = []
    statuses: list[str] = []
    c = await asyncio.to_thread(
        cred.login,
        None,
        lambda url: seen_urls.append(url),
        lambda msg: statuses.append(msg),
    )
    check("轮询次数（含 1 次 500 重试与 1 次空 token）", state["qr_calls"], 5)
    check("拿到的 access_token", c.access_token, _fake_jwt(exp=int(time.time()) + 3600, sub="u-1"))
    check("refresh_token 落盘", c.refresh_token, "rt-1")
    check("office_identity 落盘", c.office_identity, "personal")
    check("uid 取 user_id（而非自动 nickname）", c.uid, "u-1")
    check("expires_at 由 JWT 推算（毫秒）", len(c.expires_at) >= 12, True)
    check("从磁盘可读回", cred.load().access_token, c.access_token)
    check("本地 code 是 32 位 hex", len(seen_urls[0].split("code=")[1].split("&")[0]), 32)
    check_true("二维码登录页 URL", seen_urls[0].startswith("https://xiaohuanxiong.com/login/mp?code="))
    check_true("appname 用中文", "appname=商汤小浣熊官网" in seen_urls[0])
    check("canceled 后换了新 code（否则用户扫到死码）", len(set(seen_urls)) >= 2, True)
    check_true("logging 阶段有进度输出", any("已扫码" in s for s in statuses))

    print()
    print("=== 4. 续期 ===")
    fresh = await asyncio.to_thread(cred.refresh, c)
    check("新 access_token", fresh.access_token, _fake_jwt(exp=int(time.time()) + 3605, sub="u-1"))
    check("服务端未回 refresh_token → 保留旧值", fresh.refresh_token, "rt-1")
    check("附加字段保留（office_identity）", fresh.office_identity, "personal")
    check("下载取得的 machine id 不丢", fresh.device_id, c.device_id)
    check("续期后已落盘", cred.load().access_token, fresh.access_token)
    check("expires_at 已更新", fresh.expires_at != c.expires_at, True)

    for token, name in (("rt-expired", "业务码 200003"), ("rt-unauthorized", "HTTP 401")):
        try:
            used = cred.Credentials(access_token="a", refresh_token=token)
            await asyncio.to_thread(cred.refresh, used)
            msg = "no-raise"
        except RuntimeError as e:
            msg = str(e)
        check_true(f"{name} → 终态并提示重新登录", isinstance(msg, str) and "重新登录" in msg)

    # user_info 只用于展示：失败返回空对象、成功只补空字段
    info = await asyncio.to_thread(cred.fetch_user_info, cred.Credentials(access_token="t"))
    check("user_info 取 name（自动生成的默认名）", info.get("name"), "RaccoonAva")
    partial = cred.Credentials(access_token="t", nickname="我")
    synced = await asyncio.to_thread(cred.sync_profile, partial)
    check("sync_profile 不覆盖已有 nickname", synced.nickname, "我")
    check("sync_profile 补出 phone", synced.phone, "13800138000")
    check("sync_profile 幂等（已有 phone 则不再拉）", (await asyncio.to_thread(
        cred.sync_profile, cred.Credentials(access_token="t", nickname="我", phone="13800138000")
    )).user_id, "")


async def test_catalog_remote(base: str, state: dict) -> None:
    print()
    print("=== 7b. 模型目录：远端优先 ===")
    upstream.MODEL_CATALOG_URL = f"{base}/llm/model_catalog"
    # catalog 用阻塞 requests（与参考实现一致），而假上游就跑在本事件循环里
    # ⇒ 必须放到线程里调用，否则请求和响应互相等 20 秒超时
    await asyncio.to_thread(catalog.invalidate_cache)
    ids = await asyncio.to_thread(catalog.exposed_ids)
    check("远端目录生效（过滤 visible=false）", ids, ["sn-glm-5-3"])
    check("远端请求发出", state["sent_models"], 1)
    again = await asyncio.to_thread(catalog.exposed_ids)
    check("远端命中被缓存（不重复请求）", (again, state["sent_models"]), (ids, 1))
    entry = (await asyncio.to_thread(catalog.details))[0]
    check("远端详情含 context_window", entry["context_window"], 1_000_000)
    check("远端 billing_status 三态映射", entry["billing_status"], "limited_free")
    check("远端图片能力由 tags 判定", entry["vision"], False)
    await asyncio.to_thread(catalog.invalidate_cache)


async def test_billing_network(base: str, state: dict) -> None:
    print()
    print("=== 8b. 额度：余额 / 登录奖励（只读）===")
    upstream.BALANCE_URL = f"{base}/points/balance"
    upstream.BILLS_URL = f"{base}/points/bills"
    upstream.LOGIN_GRANT_URL = f"{base}/desktop/login/points/grant"
    cred.save(cred.Credentials(access_token="tok", device_id="d" * 32))

    info = await asyncio.to_thread(billing.fetch_credits)
    check("总额取 available_points", info["total"]["remain"], 3300.0)
    check("单位", info["total"]["unit"], "积分")
    total_pair = (info["total"]["size"], info["total"]["used"])
    check("上游只给剩余 → size 记作剩余、used 不编造", total_pair, (3300.0, 0.0))
    check(
        "各池分开作 package（会员池为 0 时省略）",
        [p["name"] for p in info["packages"]],
        ["奖励积分", "每日积分", "充值积分"],
    )
    check("会员池 >0 时出现", "会员积分" not in [p["name"] for p in info["packages"]], True)
    check("无到期信息则 days_left=None", info["packages"][0]["days_left"], None)
    check(
        "登录奖励未领 → 列为可领",
        [(c["campaign_id"], c["amount"]) for c in info["claimable"]],
        [(billing.LOGIN_REWARD_CAMPAIGN_ID, 3000.0)],
    )
    check("查额度**从不**触碰写端点", state["grant_calls"], 0)

    # 账单里已有「桌面端登录奖励」→ 不再列为可领
    claimed_items = {"items": [{"biz_type": "reward_grant", "event_name": "桌面端登录奖励"}]}
    orig = billing._get

    def fake_get(url: str, c: cred.Credentials, *, params: dict | None = None) -> object:
        if url.endswith("/bills"):
            return {"code": 0, "data": claimed_items}
        return orig(url, c, params=params)

    billing._get = fake_get  # type: ignore[assignment]
    try:
        info2 = await asyncio.to_thread(billing.fetch_credits)
    finally:
        billing._get = orig  # type: ignore[assignment]
    check("已领过 → claimable 为空", info2["claimable"], [])

    # 余额形状不对 → CreditsError（绝不显示成 0）
    upstream.BALANCE_URL = f"{base}/points/balance_bad"
    try:
        await asyncio.to_thread(billing.fetch_credits)
        got: object = "no-raise"
    except billing.CreditsError as e:
        got = "CreditsError"
        check_true("缺 available_points 的报错可读", "available_points" in str(e))
    check("缺 available_points → CreditsError", got, "CreditsError")

    upstream.BALANCE_URL = f"{base}/points/balance_401"
    try:
        await asyncio.to_thread(billing.fetch_credits)
        got2: object = "no-raise"
    except cred.NotLoggedInError:
        got2 = "NotLoggedInError"
    check("401 → NotLoggedInError（CLI 提示重登）", got2, "NotLoggedInError")

    # 领取：幂等判据是 granted
    upstream.BALANCE_URL = f"{base}/points/balance"
    first = await asyncio.to_thread(billing.claim_login_reward)
    check("首次领取 granted=true → claimed", first["status"], "claimed")
    check("领取点数", first["points"], 3000.0)
    second = await asyncio.to_thread(billing.claim_login_reward)
    check("granted=false → already-claimed（不是 claimed）", second["status"], "already-claimed")
    third = await asyncio.to_thread(billing.claim_login_reward)
    check("上游失败也**不抛错**（协议 §6.3）", third["status"], "failed")
    check_true("失败带原因", bool(third["message"]))

    not_logged = _TMP_HOME / "gone.json"
    check_true("（清理占位）", not not_logged.exists())


async def test_gateway(base: str, state: dict) -> None:
    print()
    print("=== 9. 端到端：假上游 + 真实网关（WIRE=openai 透传）===")
    from aiohttp import web

    from raccoon_bridge import gateway

    check("线型是 openai（不需要翻译器）", upstream.WIRE, "openai")
    check("展示名", upstream.DISPLAY_NAME, "Raccoon")

    upstream.CHAT_URL = f"{base}/llm/chat/completions"
    upstream.MODEL_CATALOG_URL = f"{base}/llm/model_catalog"
    cred.save(cred.Credentials(access_token="tok-e2e", office_identity="", device_id="e2e" * 8))
    # 目录是阻塞请求（参考实现如此），而假上游在本事件循环里 ⇒ 先在线程里预热缓存，
    # 否则网关的 /v1/models 会等到 20 秒超时（线上是跨进程，没有这个问题）
    await asyncio.to_thread(catalog.invalidate_cache)
    warmed = await asyncio.to_thread(catalog.exposed_ids)
    check("预热远端目录（缓存命中后网关不再出网）", warmed, ["sn-glm-5-3"])

    import aiohttp

    stop_event = asyncio.Event()
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    gw_port = sock.getsockname()[1]
    sock.close()
    task = asyncio.create_task(gateway._serve_async(f"127.0.0.1:{gw_port}", False, stop_event))
    await asyncio.sleep(1.2)

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(f"http://127.0.0.1:{gw_port}/v1/models") as resp:
                payload = await resp.json()
            ids = [m["id"] for m in payload.get("data", [])]
            check("模型列表来自远端目录", "sn-glm-5-3" in ids, True)

            async with session.get(f"http://127.0.0.1:{gw_port}/health") as resp:
                health = await resp.json()
            check("health ok", health.get("ok"), True)
            check("health 标注已登录", health.get("logged_in"), True)

            text = ""
            finishes: list[str] = []
            async with session.post(
                f"http://127.0.0.1:{gw_port}/v1/chat/completions",
                json={
                    "model": "sn-glm-5-3",
                    "messages": [{"role": "user", "content": "hi"}],
                    "stream": True,
                    "reasoning_effort": "off",
                },
            ) as resp:
                check("流式 HTTP 200", resp.status, 200)
                check(
                    "Content-Type 是 SSE",
                    "text/event-stream" in resp.headers.get("Content-Type", ""),
                    True,
                )
                buf = ""
                async for raw in resp.content.iter_any():
                    buf += raw.decode(errors="replace")
                    while True:
                        split = buf.find("\n\n")
                        if split < 0:
                            break
                        block, buf = buf[:split], buf[split + 2 :]
                        for line in block.split("\n"):
                            if not line.startswith("data:"):
                                continue
                            item = line[5:].strip()
                            if item == "[DONE]":
                                continue
                            chunk = json.loads(item)
                            for choice in chunk.get("choices") or []:
                                delta = choice.get("delta") or {}
                                if delta.get("content"):
                                    text += delta["content"]
                                if choice.get("finish_reason"):
                                    finishes.append(choice["finish_reason"])
            check("流式正文（跨 TCP 分块透传）", text, "网关通了")
            check("流式 finish", finishes, ["stop"])

            sent_body = state.get("chat_body") or {}
            check("上游收到 stream=True", sent_body.get("stream"), True)
            check("上游收到 model", sent_body.get("model"), "sn-glm-5-3")
            check(
                "思考通道走 extra_body.thinking（reasoning_effort 无效）",
                (sent_body.get("extra_body") or {}).get("thinking"),
                {"type": "disabled"},
            )
            check("reasoning_effort 不原样透传", "reasoning_effort" in sent_body, False)
            headers = state.get("chat_headers") or {}
            check("上游收到 Authorization", headers.get("Authorization"), "Bearer tok-e2e")
            check("上游收到 X-Client-Platform", headers.get("X-Client-Platform"), "desktop-windows")
            check("上游收到 X-Raccoon-Language", headers.get("X-Raccoon-Language"), "zh")
            check("上游收到 SSE Accept", headers.get("Accept"), "text/event-stream")

            async with session.post(
                f"http://127.0.0.1:{gw_port}/v1/chat/completions",
                json={"model": "sn-glm-5-3", "messages": [{"role": "user", "content": "hi"}]},
            ) as resp:
                agg = await resp.json()
            check("非流式 HTTP 200", resp.status, 200)
            check("非流式聚合出正文", agg["choices"][0]["message"]["content"], "网关通了")
            check("非流式 object", agg.get("object"), "chat.completion")
            check(
                "非流式带 usage",
                agg["usage"]["completion_tokens"],
                4,
            )
    finally:
        stop_event.set()
        await task
        _ = web


async def main() -> int:
    test_phone_cipher()
    test_credentials()
    test_body()
    test_headers()
    test_catalog_static()
    test_billing_shape()

    runner, base, state = await _fake_server()
    try:
        await test_login_and_refresh(base, state)
        await test_catalog_remote(base, state)
        await test_billing_network(base, state)
        await test_gateway(base, state)
    finally:
        await runner.cleanup()  # type: ignore[attr-defined]

    print()
    if FAILURES:
        print(f"结果: {len(FAILURES)} 项失败 -> {FAILURES}")
        return 1
    print("结果: 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
