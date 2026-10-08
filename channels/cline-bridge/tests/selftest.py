"""Cline 渠道的离线自检（不出网、不需要真实凭据）。

覆盖：
1. `workos:` 前缀幂等补齐（本渠道最大的坑）
2. 请求体改写（system 提升到 messages[0] / enum 清洗 / reasoning_effort 原样透传 / max_tokens 夹取）
3. 请求头（Bearer 保留前缀 + 4 条伪装头 + 对话用 SSE Accept）
4. 设备码登录状态机（`authorization_pending` 不误判失败 / `slow_down` 累积退避 /
   2xx 缺 token 视为服务端异常 / 终态错误）
5. 注册与续期的响应判据（`success && data.accessToken`）与续期字段名（驼峰）
6. 模型目录合并（free 权威、下架条目丢弃、models.dev 失败不抛、clinePass 不算免费）
7. 额度（余额用 account_id 而非 JWT sub、两种失败形态、resetsAt 原样透传）
8. 端到端：假上游 + 真实网关（openai 线型，含 `delta.reasoning`）

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
import threading
import time
from pathlib import Path

# 让 src/ 可导入
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

# 隔离数据目录，避免碰到真实凭据
_TMP_HOME = Path(tempfile.mkdtemp(prefix="cline-selftest-"))
os.environ["CLINE_HOME"] = str(_TMP_HOME)

from aiohttp import web  # noqa: E402

from cline_bridge import billing, catalog, cred, upstream  # noqa: E402

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


def check_raises(name: str, fn, exc: type[BaseException]) -> BaseException | None:
    """断言调用抛指定异常，返回异常实例（供断言报文）。"""
    try:
        fn()
    except exc as e:  # noqa: PERF203
        print(f"[ok  ] {name}: 抛出 {type(e).__name__}: {e}")
        return e
    except Exception as e:  # noqa: BLE001
        print(f"[FAIL] {name}: 抛了 {type(e).__name__}（期望 {exc.__name__}）: {e}")
        FAILURES.append(name)
        return e
    print(f"[FAIL] {name}: 没有抛异常（期望 {exc.__name__}）")
    FAILURES.append(name)
    return None


def dead_port() -> int:
    """拿一个确定没人监听的端口（本机连接被立即拒绝）。"""
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


# ── 假上游（同时扮演 WorkOS 与 Cline 两个域）──────────────────────────────────

ST: dict[str, object] = {
    "device_form": {},
    "device_calls": 0,
    "authenticate_calls": 0,
    "authenticate_script": [],
    "register_body": None,
    "refresh_body": None,
    "refresh_mode": "ok",
    "register_mode": "ok",
    "balance_mode": "ok",
    "balance_paths": [],
    "limits_mode": "ok",
    "chat_headers": {},
    "chat_body": {},
}

FAKE = ""
FAKE_PORT = 0


def fake(path: str) -> str:
    return f"http://127.0.0.1:{FAKE_PORT}{path}"


def _make_app() -> web.Application:
    app = web.Application()

    async def h_device(request: web.Request) -> web.Response:
        ST["device_calls"] = int(ST["device_calls"]) + 1
        ST["device_form"] = dict(await request.post())
        return web.json_response(
            {
                "device_code": "dev-code-1",
                "user_code": "ABCD-EFGH",
                "verification_uri": fake("/device"),
                "verification_uri_complete": fake("/device?user_code=ABCD-EFGH"),
                "expires_in": 300,
                "interval": 1,
            }
        )

    async def h_authenticate(request: web.Request) -> web.Response:
        script = list(ST["authenticate_script"])  # type: ignore[arg-type]
        idx = int(ST["authenticate_calls"])
        ST["authenticate_calls"] = idx + 1
        if idx < len(script):
            item = script[idx]
            return web.json_response(item["body"], status=item.get("status", 200))
        return web.json_response({"error": "expired_token"}, status=400)

    async def h_register(request: web.Request) -> web.Response:
        ST["register_body"] = await request.json()
        mode = ST["register_mode"]
        if mode == "biz_fail":
            return web.json_response({"success": False, "error": "channel error"})
        if mode == "no_token":
            return web.json_response({"success": True, "data": {}})
        if mode == "bare":
            return web.json_response({"accessToken": "workos:bare-token"})
        if mode == "expired":
            return web.json_response({"error": "Unauthorized"}, status=401)
        return web.json_response(
            {
                "success": True,
                "data": {
                    "accessToken": "workos:eyJ-test",
                    "refreshToken": "tmgEeM-test",
                    "expiresAt": "2026-09-25T05:23:47.000Z",
                    "tokenType": "Bearer",
                    "userInfo": {
                        "clineUserId": "usr-01M3BCV4FYCGJKAWD3MJG3DBQM",
                        "email": "whale@example.com",
                        "firstName": "Whale",
                        "lastName": "Girl",
                    },
                },
            }
        )

    async def h_refresh(request: web.Request) -> web.Response:
        ST["refresh_body"] = await request.json()
        mode = ST["refresh_mode"]
        if mode == "expired":
            return web.json_response({"error": "Unauthorized: token expired"}, status=401)
        if mode == "no_token":
            return web.json_response({"success": True, "data": {}})
        if mode == "server_error":
            return web.json_response({"error": "boom"}, status=503)
        # 实测续期响应不带 userInfo → 用于验证 account_id 等字段被保留
        return web.json_response(
            {"success": True, "data": {"accessToken": "eyJ-refreshed", "refreshToken": "tmgNew"}}
        )

    async def h_models(request: web.Request) -> web.Response:
        return web.json_response(
            {
                "data": [
                    {"id": "z-ai/glm-4.7", "object": "model", "created": 1, "owned_by": "z-ai"},
                    {"id": "cline-free/downed-model", "object": "model", "created": 1},
                    {"id": "openrouter/free", "object": "model", "created": 1},
                ]
            }
        )

    async def h_recommended(request: web.Request) -> web.Response:
        return web.json_response(
            {
                "free": [
                    {"id": "stealth/space-bunny-alpha", "name": "Space Bunny Alpha"},
                    {"id": "cline-free/mimo-v2.6-flash", "name": "MiMo V2.6 Flash"},
                ],
                "recommended": [{"id": "deepseek/deepseek-v4.1-flash", "name": "DeepSeek"}],
                "clinePass": [{"id": "cline-pass/claude-opus-4", "name": "Opus"}],
            }
        )

    async def h_models_dev(request: web.Request) -> web.Response:
        # 两种 provider 块形态都放在同一个响应里（分别是直接键与 providers 嵌套键），
        # 只测「两者都认」；被测代码只取先命中的那个，故这里给直接键形态
        return web.json_response(
            {
                "cline-pass": {
                    "models": {
                        "claude-opus-4": {
                            "name": "Claude Opus 4",
                            # limit.output 存在，但**不应**被采信（会变成请求体的 max_tokens）
                            "limit": {"context": 200_000, "output": 8_192},
                            "modalities": {"input": ["text", "image", "pdf"]},
                        }
                    }
                }
            }
        )

    async def h_models_dev_nested(request: web.Request) -> web.Response:
        return web.json_response(
            {
                "providers": {
                    "cline-pass": {"models": [{"id": "nested-model", "limit": {"context": 4096}}]}
                }
            }
        )

    async def h_balance(request: web.Request) -> web.Response:
        ST["balance_paths"].append(request.path)  # type: ignore[union-attr]
        mode = ST["balance_mode"]
        if mode == "unauthorized":
            # 网关层失败形态：HTTP 401 且**没有 success 字段**
            return web.json_response({"error": "Unauthorized: invalid token"}, status=401)
        if mode == "biz_fail":
            return web.json_response({"success": False, "error": "balance unavailable"})
        if mode == "bad_format":
            return web.json_response({"error": "Invalid request format"}, status=400)
        return web.json_response(
            {
                "data": {"userId": "usr-01M3BCV4FYCGJKAWD3MJG3DBQM", "balance": 500000},
                "success": True,
            }
        )

    async def h_limits(request: web.Request) -> web.Response:
        if ST["limits_mode"] == "fail":
            return web.json_response({"error": "Internal Server Error"}, status=500)
        return web.json_response(
            {
                "success": True,
                "data": {
                    "limits": [
                        {
                            "type": "five_hour",
                            # 超额：不做夹取，如实透传
                            "percentUsed": 120,
                            "resetsAt": "2026-09-25T05:23:47.123456789Z",
                        },
                        {"type": "weekly", "percentUsed": 0, "resetsAt": ""},
                    ]
                },
            }
        )

    async def h_chat(request: web.Request) -> web.StreamResponse:
        ST["chat_headers"] = dict(request.headers)
        ST["chat_body"] = await request.json()
        resp = web.StreamResponse()
        resp.content_type = "text/event-stream"
        await resp.prepare(request)
        frames = [
            {
                "id": "chatcmpl-1",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "cline-free/mimo-v2.6-flash",
                # ⚠ Cline 的思考增量字段是 delta.reasoning（不是 reasoning_content）
                "choices": [{"index": 0, "delta": {"reasoning": "思考"}, "finish_reason": None}],
            },
            {
                "id": "chatcmpl-1",
                "object": "chat.completion.chunk",
                "created": 1,
                # 空 tool_calls 数组会被网关规范化剔除（否则 ZCode 会把思考切成碎块）
                "choices": [
                    {
                        "index": 0,
                        "delta": {"content": "网关通了", "tool_calls": []},
                        "finish_reason": None,
                    }
                ],
            },
            {
                "id": "chatcmpl-1",
                "object": "chat.completion.chunk",
                "created": 1,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
            },
        ]
        for frame in frames:
            await resp.write(
                b"data: "
                + json.dumps(frame, ensure_ascii=False, separators=(",", ":")).encode()
                + b"\n\n"
            )
        await resp.write(b"data: [DONE]\n\n")
        await resp.write_eof()
        return resp

    app.router.add_post("/user_management/authorize/device", h_device)
    app.router.add_post("/user_management/authenticate", h_authenticate)
    app.router.add_post("/api/v1/auth/register", h_register)
    app.router.add_post("/api/v1/auth/refresh", h_refresh)
    app.router.add_get("/api/v1/models", h_models)
    app.router.add_get("/api/v1/ai/cline/recommended-models", h_recommended)
    app.router.add_get("/models-dev.json", h_models_dev)
    app.router.add_get("/models-dev-nested.json", h_models_dev_nested)
    app.router.add_get("/api/v1/users/me/plan/usage-limits", h_limits)
    app.router.add_get("/api/v1/users/{user_id}/balance", h_balance)
    app.router.add_post("/api/v1/chat/completions", h_chat)
    return app


class FakeUpstream:
    """在独立线程里跑假上游，这样同步（requests）与异步（aiohttp）调用都能打它。"""

    def __init__(self) -> None:
        self.base = ""
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stop: asyncio.Event | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        deadline = time.time() + 10
        while not self.base and time.time() < deadline:
            time.sleep(0.05)
        if not self.base:
            raise RuntimeError("假上游启动失败")

    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        stop = asyncio.Event()
        self._stop = stop

        async def serve() -> None:
            runner = web.AppRunner(_make_app())
            await runner.setup()
            site = web.TCPSite(runner, "127.0.0.1", 0)
            await site.start()
            global FAKE_PORT, FAKE
            FAKE_PORT = site._server.sockets[0].getsockname()[1]
            self.base = f"http://127.0.0.1:{FAKE_PORT}"
            FAKE = self.base
            await stop.wait()
            await runner.cleanup()

        loop.run_until_complete(serve())

    def stop(self) -> None:
        if self._loop is not None and self._stop is not None:
            self._loop.call_soon_threadsafe(self._stop.set)
        if self._thread is not None:
            self._thread.join(timeout=5)


# ── 1. 前缀幂等补齐 ───────────────────────────────────────────────────────────


def test_token_prefix() -> None:
    print("=== 1. workos: 前缀不可剥（幂等补齐）===")
    check("裸 JWT 补前缀", cred.ensure_token_prefix("eyJabc"), "workos:eyJabc")
    check("已带前缀原样", cred.ensure_token_prefix("workos:eyJabc"), "workos:eyJabc")
    check("二次调用幂等", cred.ensure_token_prefix(cred.ensure_token_prefix("x")), "workos:x")
    check("空串保持空", cred.ensure_token_prefix(""), "")

    # 写一份**裸**令牌（模拟手写/外部导出的老凭据），load 必须补齐而不是拒绝
    path = _TMP_HOME / "bad-prefix.json"
    path.write_text(
        json.dumps({"access_token": "eyJplain", "account_id": "usr-x"}), encoding="utf-8"
    )
    real_path = cred.paths.credentials_path()
    real_path.parent.mkdir(parents=True, exist_ok=True)
    saved = real_path.read_text(encoding="utf-8") if real_path.is_file() else None
    real_path.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    try:
        c = cred.load()
        check("load 补齐前缀（不拒绝凭据）", c.access_token, "workos:eyJplain")
    finally:
        if saved is not None:
            real_path.write_text(saved, encoding="utf-8")

    check("uid 用 account_id", cred.Credentials(account_id="usr-1").uid, "usr-1")
    check("无域概念", cred.Credentials(access_token="workos:x").domain, "")


# ── 2. 请求体改写 ─────────────────────────────────────────────────────────────


def test_body() -> None:
    print()
    print("=== 2. 请求体：OpenAI 形状上的四处修正 ===")
    req = {
        "model": "cline-free/mimo-v2.6-flash",
        "messages": [
            {"role": "user", "content": "你好"},
            {"role": "system", "content": "你是助手"},
            {"role": "assistant", "content": "你好！"},
        ],
        "temperature": 0.7,
        "max_tokens": 2_000_000,  # 超过上界 → 夹到 943_718
        "stop": ["END"],
        "reasoning_effort": "banana",  # ⚠ 未知档位必须**原样透传**（不校验）
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "bash",
                    "description": "执行命令",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "permission": {
                                "type": "string",
                                "enum": ["allow", "", "  ", "deny"],  # 空串成员必须删掉
                            },
                            "level": {"type": "integer", "enum": [1, 2]},  # 数值枚举必须保留
                            "onlyEmpty": {"type": "string", "enum": [""]},  # 全空 → 整个键丢弃
                            "nested": {
                                "type": "array",
                                "items": {
                                    "type": "string",
                                    "enum": ["a", ""],  # 递归下钻
                                },
                            },
                        },
                    },
                },
            }
        ],
    }
    body = upstream.build_chat_body(req, "cline-free/mimo-v2.6-flash")

    check("model 用上游 id", body["model"], "cline-free/mimo-v2.6-flash")
    check("恒 stream", body["stream"], True)
    check(
        "system 提升为 messages[0]",
        [m["role"] for m in body["messages"]],
        ["system", "user", "assistant"],
    )
    check("system 内容", body["messages"][0]["content"], "你是助手")
    check("temperature 透传", body["temperature"], 0.7)
    check("max_tokens 夹到上界", body["max_tokens"], upstream.MAX_TOKENS_CAP)
    check("stop 透传", body["stop"], ["END"])
    check("未知 reasoning_effort 原样透传（不做白名单校验）", body["reasoning_effort"], "banana")

    props = body["tools"][0]["function"]["parameters"]["properties"]
    check("enum 删空串（含纯空白）", props["permission"]["enum"], ["allow", "deny"])
    check("数值 enum 整段保留", props["level"]["enum"], [1, 2])
    check("全空的 enum 键丢弃", "enum" in props["onlyEmpty"], False)
    check("嵌套 items 里的 enum 同罪", props["nested"]["items"]["enum"], ["a"])

    # max_tokens 的边界：非有限值 / ≤0 → 不发该键（不编造）
    for raw in (0, -5, float("inf"), float("nan"), "abc", None):
        b = upstream.build_chat_body({"messages": [], "max_tokens": raw}, "m")
        check(f"max_tokens={raw!r} → 不发该键", "max_tokens" in b, False)

    # 没有 system 时不凭空插一条
    b = upstream.build_chat_body({"messages": [{"role": "user", "content": "hi"}]}, "m")
    check("无 system 不插空 system", [m["role"] for m in b["messages"]], ["user"])
    check("未传的可选键不出现（不发 null）", sorted(b.keys()), ["messages", "model", "stream"])

    # 空 tool_calls 之类与 Cline 无关，但 stop 单值要归一成数组
    b = upstream.build_chat_body({"messages": [], "stop": "END"}, "m")
    check("stop 单值归一成数组", b["stop"], ["END"])

    # 图片 part 原样透传（Cline 没有腾讯那道图片视觉 token 预算，能力由模型决定）
    image_req = {
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "看图"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
                ],
            }
        ]
    }
    image_body = upstream.build_chat_body(image_req, "m")
    parts = image_body["messages"][0]["content"]
    check("图片 part 原样保留", [p["type"] for p in parts], ["text", "image_url"])
    check(
        "图片用 data URL",
        parts[1]["image_url"]["url"],
        "data:image/png;base64,AAAA",
    )


# ── 2b. 限流（429 的人类可读时长）────────────────────────────────────────────


def test_rate_limit() -> None:
    print()
    print("=== 2b. 429 的等待时长只能从英文句子里取 ===")
    real = (
        '{"error":{"code":"INFERENCE_CAP_ERROR","message":"Error 429: Daily free limit '
        'reached on model deepseek/deepseek-v4.1-flash. Try again in 19h 39m"}}'
    )
    check("实测报文：19h 39m = 70740s", upstream.parse_retry_after_seconds(429, {}, real), 70740)
    check(
        "retry-after 头优先",
        upstream.parse_retry_after_seconds(429, {"retry-after": "42"}, real),
        42,
    )
    # ⚠ 尾部 (?![a-z]) 的作用：`2 minutes` 里的 m 不能再命中一次（否则翻倍）
    check(
        "2 minutes 不翻倍",
        upstream.parse_retry_after_seconds(429, {}, "Try again in 2 minutes"),
        120,
    )
    check("各 token 累加", upstream.parse_retry_after_seconds(429, {}, "Try again in 1h 30m"), 5400)
    check("纯秒", upstream.parse_retry_after_seconds(429, {}, "try again in 45s"), 45)
    check(
        "{error:'…'} 外壳",
        upstream.parse_retry_after_seconds(429, {}, '{"error":"slow down. Try again in 5m"}'),
        300,
    )
    check(
        "{message:'…'} 外壳",
        upstream.parse_retry_after_seconds(429, {}, '{"message":"Try again in 3m"}'),
        180,
    )
    check("非 JSON 纯文本也认", upstream.parse_retry_after_seconds(429, {}, "Try again in 10s"), 10)
    check("没有时长线索 → None（不猜）", upstream.parse_retry_after_seconds(429, {}, "{}"), None)
    # ⚠ 只有 429 才有「多久后重置」：402 是额度耗尽，动作是充值而不是等
    check("402 不适用", upstream.parse_retry_after_seconds(402, {"retry-after": "9"}, real), None)


# ── 3. 请求头 ─────────────────────────────────────────────────────────────────


def test_headers() -> None:
    print()
    print("=== 3. 请求头（鉴权前缀 + 4 条伪装头）===")
    c = cred.Credentials(access_token="workos:eyJtest", account_id="usr-1")
    headers = upstream.build_headers(c)
    check("Authorization 保留 workos: 前缀", headers["Authorization"], "Bearer workos:eyJtest")
    check("HTTP-Referer", headers["HTTP-Referer"], "https://cline.bot")
    check("X-Title", headers["X-Title"], "Cline")
    check("X-IS-MULTIROOT", headers["X-IS-MULTIROOT"], "false")
    check("X-CLIENT-TYPE", headers["X-CLIENT-TYPE"], "cline-sdk")
    check("对话请求 Accept 是 SSE", headers["Accept"], "text/event-stream")
    check("对话请求 Content-Type", headers["Content-Type"], "application/json")

    # 裸令牌也要被补齐（本模块绝不发送无前缀的令牌）
    bare = upstream.build_headers(cred.Credentials(access_token="eyJbare"))
    check("裸令牌在头里被补前缀", bare["Authorization"], "Bearer workos:eyJbare")

    json_headers = upstream.build_headers(c, chat=False)
    check("非对话端点 Accept 是 json", json_headers["Accept"], "application/json")
    check_true("非对话端不带 Content-Type", "Content-Type" not in json_headers)

    # 403 地域限制必须能被识别（否则会被误判成凭据问题并白跑一次续期）
    sample = (
        '{"error":"access forbidden: cline-free/muse-spark-1.3-contributor '
        'is not available in your region","success":false}'
    )
    check_true("识别地域限制 403", upstream.is_region_restricted(sample))
    check_true("识别 region not supported", upstream.is_region_restricted("Region not supported"))
    check(
        "普通 403 不误判",
        upstream.is_region_restricted('{"error":"ENTITLEMENT_ERROR: not subscribed"}'),
        False,
    )


# ── 4. 设备码登录状态机 ───────────────────────────────────────────────────────


def test_device_flow() -> None:
    print()
    print("=== 4. 设备码授权状态机（WorkOS）===")
    slept: list[float] = []
    original_sleep = cred._sleep
    cred._sleep = slept.append  # type: ignore[assignment]
    try:
        device = cred.request_device_code()
        check("设备码请求带 client_id", ST["device_form"], {"client_id": cred.WORKOS_CLIENT_ID})
        check("三字段齐备", sorted(device.keys())[:3], ["device_code", "expires_in", "interval"])

        # ① 200 + {"error":"authorization_pending"} **不是**失败（判据是 body.error，不是状态码）
        ST["authenticate_calls"] = 0
        ST["authenticate_script"] = [
            {"status": 200, "body": {"error": "authorization_pending"}},
            {"status": 200, "body": {"error": "slow_down"}},
            {"status": 200, "body": {"access_token": "workos-at", "refresh_token": "workos-rt"}},
        ]
        slept.clear()
        tokens = cred.poll_device_token(device)
        check("pending 不误判失败、轮询到成功", tokens["access_token"], "workos-at")
        check("slow_down 真的累积退避（1s → 2s）", slept, [1.0, 2.0])

        # ② 2xx 但缺 token → 服务端异常（不是「等用户」，否则死循环到超时）
        ST["authenticate_calls"] = 0
        ST["authenticate_script"] = [{"status": 200, "body": {"ok": True}}]
        check_raises("2xx 缺 token → 报错", lambda: cred.poll_device_token(device), RuntimeError)

        # ③ 终态错误
        for err in ("access_denied", "expired_token", "invalid_grant"):
            ST["authenticate_calls"] = 0
            ST["authenticate_script"] = [{"status": 200, "body": {"error": err}}]
            check_raises(
                f"{err} → 终态失败", lambda e=err: cred.poll_device_token(device), RuntimeError
            )

        # ④ 其它非 2xx → 终态失败
        ST["authenticate_calls"] = 0
        ST["authenticate_script"] = [{"status": 500, "body": {"message": "boom"}}]
        check_raises("5xx → 终态失败", lambda: cred.poll_device_token(device), RuntimeError)

        # ⑤ 间隔下限 1 秒（服务端可能下发 0 或负数）
        check("interval=0 → 下限 1s", cred._poll_interval_ms({"interval": 0}), 1000)
        check("interval=5 → 5s", cred._poll_interval_ms({"interval": 5}), 5000)

        # ⑥ 完整 login：设备码 → 轮询 → register → 落盘
        ST["authenticate_calls"] = 0
        ST["authenticate_script"] = [
            {"status": 200, "body": {"error": "authorization_pending"}},
            {"status": 200, "body": {"access_token": "workos-at", "refresh_token": "workos-rt"}},
        ]
        ST["register_mode"] = "ok"
        original_open = cred._open_browser
        cred._open_browser = lambda url: None  # 测试里不真开浏览器
        statuses: list[str] = []
        urls: list[str] = []
        try:
            c = cred.login(on_url=urls.append, on_status=statuses.append)
        finally:
            cred._open_browser = original_open
        check(
            "on_url 立刻拿到带的 user_code 的完整链接",
            urls,
            [fake("/device?user_code=ABCD-EFGH")],
        )
        check_true("on_status 有进度输出", statuses)
        check("登录落盘的令牌保留前缀", c.access_token, "workos:eyJ-test")
        check("refresh_token 落盘", c.refresh_token, "tmgEeM-test")
        check(
            "account_id 取自 userInfo.clineUserId",
            c.account_id,
            "usr-01M3BCV4FYCGJKAWD3MJG3DBQM",
        )
        check("email 落盘", c.email, "whale@example.com")
        check("nickname 落盘", c.nickname, "Whale Girl")
        check("expiresAt(ISO) → 毫秒时间戳", c.expire_time, 1790313827000)
        check("凭据已落盘（可重新加载）", cred.load().access_token, "workos:eyJ-test")
        # 注册请求体必须是驼峰
        check(
            "register 请求体是驼峰",
            sorted((ST["register_body"] or {}).keys()),
            ["accessToken", "refreshToken"],
        )
    finally:
        cred._sleep = original_sleep


def test_token_envelope() -> None:
    print()
    print("=== 5. 响应判据 success && data.accessToken（注册/续期同构）===")
    ST["register_mode"] = "biz_fail"
    e = check_raises(
        "success:false 不当作成功", lambda: cred.register_token("a", "b"), RuntimeError
    )
    check_true("报错文案带上游原因", e is not None and "channel error" in str(e))

    ST["register_mode"] = "no_token"
    check_raises("200 但缺 accessToken → 报错", lambda: cred.register_token("a", "b"), RuntimeError)

    ST["register_mode"] = "bare"
    c = cred.register_token("a", "b")
    check("兼容裸响应（无 data 信封）", c.access_token, "workos:bare-token")

    ST["register_mode"] = "expired"
    check_raises("401 → 终态", lambda: cred.register_token("a", "b"), cred.RefreshTokenExpiredError)
    ST["register_mode"] = "ok"

    # ── 续期：字段名是驼峰 refreshToken + grantType ──
    c = cred.Credentials(
        access_token="workos:old",
        refresh_token="tmgOld",
        account_id="usr-keep",
        email="keep@example.com",
        nickname="Keep",
        expire_time=1,
    )
    ST["refresh_mode"] = "ok"
    next_c = cred.refresh(c)
    body = ST["refresh_body"] or {}
    check("续期字段名是驼峰 refreshToken", body.get("refreshToken"), "tmgOld")
    check("续期字段名是驼峰 grantType", body.get("grantType"), "refresh_token")
    check("不含 OAuth 标准字段名", sorted(body.keys()), ["grantType", "refreshToken"])
    check("新令牌保留前缀", next_c.access_token, "workos:eyJ-refreshed")
    check("新 refreshToken 落盘", next_c.refresh_token, "tmgNew")
    check("续期保留 account_id", next_c.account_id, "usr-keep")
    check("续期保留 email", next_c.email, "keep@example.com")
    check("续期保留 nickname", next_c.nickname, "Keep")
    check("续期后磁盘同步", cred.load().refresh_token, "tmgNew")

    ST["refresh_mode"] = "expired"
    check_raises(
        "续期 401 → RefreshTokenExpiredError",
        lambda: cred.refresh(c),
        cred.RefreshTokenExpiredError,
    )
    ST["refresh_mode"] = "no_token"
    check_raises(
        "续期 200 缺 token → RefreshTokenExpiredError",
        lambda: cred.refresh(c),
        cred.RefreshTokenExpiredError,
    )
    ST["refresh_mode"] = "server_error"
    e = check_raises("续期 503 → 普通错误（可重试）", lambda: cred.refresh(c), RuntimeError)
    check_true(
        "503 不是「令牌失效」",
        e is not None and not isinstance(e, cred.RefreshTokenExpiredError),
    )
    ST["refresh_mode"] = "ok"

    check_raises(
        "无 refresh_token 即不可静默续期",
        lambda: cred.refresh(cred.Credentials(access_token="workos:x")),
        RuntimeError,
    )


# ── 6. 模型目录 ───────────────────────────────────────────────────────────────


def test_catalog() -> None:
    print()
    print("=== 6. 模型目录（free 权威集合 + 兜底下线 + models.dev 失败不抛）===")
    cred.save(
        cred.Credentials(
            access_token="workos:eyJcat",
            account_id="usr-cat",
            refresh_token="rt",
            expire_time=None,
        )
    )

    # ① models.dev 指向**不可达**端口：必须不影响目录（失败绝不抛到调用方），
    #    且能力字段退回本地兜底表
    catalog.MODELS_DEV_URL = f"http://127.0.0.1:{dead_port()}/api.json"
    catalog.reset_cache()
    rows = catalog.details()
    by_id = {row["id"]: row for row in rows}
    order = [row["id"] for row in rows]
    check(
        "合并顺序：free → recommended/clinePass → /models 其余",
        order,
        [
            "stealth/space-bunny-alpha",
            "cline-free/mimo-v2.6-flash",
            "deepseek/deepseek-v4.1-flash",
            "cline-pass/claude-opus-4",
            "z-ai/glm-4.7",
            "cline-free/downed-model",
            "openrouter/free",
        ],
    )
    check_true(
        "远端已不认识的兜底条目被丢弃（下架模型不再挂着免费出现）",
        "cline-free/muse-spark-1.3-contributor" not in by_id,
    )
    check(
        "兜底表为远端条目补元数据（窗口）",
        by_id["cline-free/mimo-v2.6-flash"]["context_window"],
        1_048_576,
    )
    check(
        "免费模型名字写进 name（带 · 免费）",
        by_id["cline-free/mimo-v2.6-flash"]["name"],
        "MiMo-V2.6-Flash · 免费",
    )
    check("free 数组命中的是免费", by_id["stealth/space-bunny-alpha"]["is_free"], True)
    check("recommended 不是免费", by_id["deepseek/deepseek-v4.1-flash"]["is_free"], False)
    check("clinePass 不是免费（订阅制）", by_id["cline-pass/claude-opus-4"]["is_free"], False)
    check("cline-free/ 前缀兜底算免费", by_id["cline-free/downed-model"]["is_free"], True)
    check("models.dev 挂了也不抛、窗口保持未知（0）", by_id["z-ai/glm-4.7"]["context_window"], 0)
    check(
        "档位统一 5 档",
        by_id["z-ai/glm-4.7"]["efforts"],
        ["none", "low", "medium", "high", "max"],
    )
    check("默认档是 high", by_id["z-ai/glm-4.7"]["default_effort"], "high")
    check("档位展示名与 wire 值刻意不同", by_id["z-ai/glm-4.7"]["effort_names"]["max"], "Extra")
    check_true("exposed_ids 非空", catalog.exposed_ids())
    check(
        "exposed_ids 顺序与目录一致",
        catalog.exposed_ids()[:2],
        ["stealth/space-bunny-alpha", "cline-free/mimo-v2.6-flash"],
    )
    check(
        "resolve_model 未知原样返回",
        catalog.resolve_model("cli/claude-sonnet-4"),
        "cli/claude-sonnet-4",
    )
    check("resolve_model 已知原样返回", catalog.resolve_model("z-ai/glm-4.7"), "z-ai/glm-4.7")

    # 免费判定的后缀语义（不能写成 includes(':free')）
    check("`:free` 结尾算免费", catalog.is_free("openrouter/gpt:free"), True)
    check("中间的 :free 不算", catalog.is_free("vendor:free/legacy"), False)

    # ② models.dev 可用时补窗口/图片能力（两种 provider 块形态都认）
    catalog.MODELS_DEV_URL = fake("/models-dev.json")
    catalog.reset_cache()
    rows = {row["id"]: row for row in catalog.details()}
    check("models.dev 补上下文窗口", rows["cline-pass/claude-opus-4"]["context_window"], 200_000)
    check("models.dev 补图片能力（只认 image）", rows["cline-pass/claude-opus-4"]["vision"], True)
    check(
        "models.dev 的 limit.output 刻意不采信（max_output 保持 0）",
        rows["cline-pass/claude-opus-4"]["max_output"],
        0,
    )
    catalog.MODELS_DEV_URL = fake("/models-dev-nested.json")
    catalog.reset_cache()
    meta = catalog.models_dev_meta() or {}
    check(
        "providers 嵌套形态也认，且裸 id 补 cline-pass/ 前缀",
        meta.get("cline-pass/nested-model"),
        {"context_window": 4096},
    )

    # ③ 远端整体不可用 → 整表保底（否则渠道会在选择器里凭空消失）
    original_base = upstream.DEFAULT_BASE_URL
    upstream.DEFAULT_BASE_URL = f"http://127.0.0.1:{dead_port()}"
    catalog.reset_cache()
    try:
        ids = catalog.exposed_ids()
        check(
            "远端不可用 → 兜底表整表",
            ids,
            [
                "stealth/space-bunny-alpha",
                "cline-free/mimo-v2.6-flash",
                "cline-free/muse-spark-1.3-contributor",
            ],
        )
        fallback = {row["id"]: row for row in catalog.details()}
        check(
            "兜底条目标注免费",
            fallback["cline-free/muse-spark-1.3-contributor"]["is_free"],
            True,
        )
    finally:
        upstream.DEFAULT_BASE_URL = original_base
        catalog.MODELS_DEV_URL = fake("/models-dev.json")
        catalog.reset_cache()


# ── 7. 额度 ───────────────────────────────────────────────────────────────────


def test_billing() -> None:
    print()
    print("=== 7. 额度（余额 account_id / 两种失败形态 / 窗口原样）===")
    # JWT 里带一个看起来很像账号的 sub —— 余额查询必须**不用**它
    payload = base64.urlsafe_b64encode(
        json.dumps({"sub": "user_01M3BCQ86DV4S9KKBT85X4GKTV"}).encode()
    ).decode().rstrip("=")
    cred.save(
        cred.Credentials(
            access_token=f"workos:eyJ.{payload}.sig",
            refresh_token="rt",
            account_id="usr-01M3BCV4FYCGJKAWD3MJG3DBQM",
        )
    )

    ST["balance_mode"] = "ok"
    ST["limits_mode"] = "ok"
    ST["balance_paths"] = []
    info = billing.fetch_credits()

    check(
        "余额端点用 account_id（usr-…）而不是 JWT 的 sub（user_…）",
        list(ST["balance_paths"]),  # type: ignore[arg-type]
        ["/api/v1/users/usr-01M3BCV4FYCGJKAWD3MJG3DBQM/balance"],
    )
    check("换算：500000 / 100000 = $5.00", info["total"]["remain"], 5.0)
    check("单位 USD", info["total"]["unit"], "USD")
    check("总量未知要显式标记（size 是回填值）", info["total"]["size_known"], False)
    check("packages 一条", len(info["packages"]), 1)
    check("packages 无编造的到期天数", info["packages"][0]["days_left"], None)
    limits = info["usage_limits"]
    check("窗口查询成功", limits["ok"], True)
    check("窗口数", len(limits["limits"]), 2)
    check("percentUsed 不夹取（120 如实透传）", limits["limits"][0]["percent_used"], 120.0)
    check(
        "resetsAt 是纳秒 ISO 字符串 → 原样上报（不按毫秒解析）",
        limits["limits"][0]["resets_at"],
        "2026-09-25T05:23:47.123456789Z",
    )
    check("用量为 0 的窗口 resetsAt 是空串", limits["limits"][1]["resets_at"], "")
    check("无签到 → claimable 恒空", info["claimable"], [])

    # 失败形态①：业务层 {success:false,error}（HTTP 200）→ 抛 CreditsError（不显示成 0）
    ST["balance_mode"] = "biz_fail"
    e = check_raises("业务失败 → CreditsError", billing.fetch_credits, billing.CreditsError)
    check_true("报错带上游原因", e is not None and "balance unavailable" in str(e))

    # 失败形态②：网关层 401 且**没有 success 字段** → NotLoggedInError（提示重新登录）
    ST["balance_mode"] = "unauthorized"
    check_raises(
        "401（无 success 字段）→ NotLoggedInError", billing.fetch_credits, cred.NotLoggedInError
    )

    # 400：userId 传错的典型症状，报错要直接点出来
    ST["balance_mode"] = "bad_format"
    e = check_raises("400 → CreditsError", billing.fetch_credits, billing.CreditsError)
    check_true("文案点明 account_id 而非 sub", e is not None and "account_id" in str(e))

    # 缺 account_id 时不瞎猜（既不用 sub，也不返回 0）
    cred.save(cred.Credentials(access_token="workos:eyJ", refresh_token="rt", account_id=""))
    ST["balance_mode"] = "ok"
    check_raises("缺 account_id → CreditsError", billing.fetch_credits, billing.CreditsError)

    # 窗口查询失败只作为数据上报（ok:false），不影响余额
    cred.save(
        cred.Credentials(
            access_token="workos:eyJ",
            refresh_token="rt",
            account_id="usr-01M3BCV4FYCGJKAWD3MJG3DBQM",
        )
    )
    ST["limits_mode"] = "fail"
    info = billing.fetch_credits()
    check("窗口失败也是数据（ok:false）", info["usage_limits"]["ok"], False)
    check_true("窗口失败带原因", bool(info["usage_limits"]["error"]))
    check("窗口失败不影响余额", info["total"]["remain"], 5.0)
    ST["limits_mode"] = "ok"

    # 未登录 → NotLoggedInError（CLI 据此提示运行 cline login）
    cred.paths.credentials_path().unlink()
    check_raises("未登录 → NotLoggedInError", billing.fetch_credits, cred.NotLoggedInError)

    # 换算系数的唯一不确定点：常量必须是 100000（源码无证据，按 PROTOCOL 标注）
    check("CLINE_BALANCE_SCALE 常量", billing.CLINE_BALANCE_SCALE, 100_000)


# ── 8. 端到端：假上游 + 真实网关 ─────────────────────────────────────────────


async def test_gateway() -> None:
    print()
    print("=== 8. 端到端：假上游 + 真实网关（openai 线型）===")
    import aiohttp

    from cline_bridge import gateway

    cred.save(
        cred.Credentials(
            access_token="workos:eyJ-e2e",
            refresh_token="rt-e2e",
            account_id="usr-01M3BCV4FYCGJKAWD3MJG3DBQM",
            nickname="E2E",
        )
    )
    catalog.reset_cache()

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    gw_port = sock.getsockname()[1]
    sock.close()

    stop_event = asyncio.Event()
    task = asyncio.create_task(gateway._serve_async(f"127.0.0.1:{gw_port}", False, stop_event))
    await asyncio.sleep(1.2)
    base = f"http://127.0.0.1:{gw_port}"

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{base}/v1/models") as resp:
                payload = await resp.json()
            ids = [m["id"] for m in payload.get("data", [])]
            check_true("模型列表非空", ids)
            check_true("模型列表含免费模型", "cline-free/mimo-v2.6-flash" in ids)

            async with session.get(f"{base}/health") as resp:
                health = await resp.json()
            check("health ok", health.get("ok"), True)
            check("health 标注已登录", health.get("logged_in"), True)

            content = ""
            reasoning = ""
            finishes: list[str] = []
            saw_empty_tool_calls = False
            async with session.post(
                f"{base}/v1/chat/completions",
                json={
                    "model": "cline-free/mimo-v2.6-flash",
                    "messages": [
                        {"role": "system", "content": "身份"},
                        {"role": "user", "content": "hi"},
                    ],
                    "stream": True,
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
                            data = line[5:].strip()
                            if data == "[DONE]":
                                continue
                            chunk = json.loads(data)
                            for choice in chunk.get("choices") or []:
                                delta = choice.get("delta") or {}
                                if delta.get("content"):
                                    content += delta["content"]
                                if delta.get("reasoning"):
                                    reasoning += delta["reasoning"]
                                if "tool_calls" in delta:
                                    saw_empty_tool_calls = True
                                if choice.get("finish_reason"):
                                    finishes.append(choice["finish_reason"])
            check("流式正文", content, "网关通了")
            check("思考增量（delta.reasoning）透传", reasoning, "思考")
            check("流式 finish", finishes, ["stop"])
            check("空 tool_calls 被规范化剔除", saw_empty_tool_calls, False)

            sent_headers = ST["chat_headers"] or {}
            sent_body = ST["chat_body"] or {}
            check(
                "上游收到带前缀的 Authorization",
                sent_headers.get("Authorization"),
                "Bearer workos:eyJ-e2e",
            )
            check("上游收到客户端伪装头", sent_headers.get("X-CLIENT-TYPE"), "cline-sdk")
            check("上游收到 SSE Accept", sent_headers.get("Accept"), "text/event-stream")
            check("上游收到 model", sent_body.get("model"), "cline-free/mimo-v2.6-flash")
            check("上游收到恒 stream", sent_body.get("stream"), True)
            check("上游收到提升后的 system", sent_body["messages"][0]["role"], "system")

            async with session.post(
                f"{base}/v1/chat/completions",
                json={
                    "model": "cline-free/mimo-v2.6-flash",
                    "messages": [{"role": "user", "content": "hi"}],
                },
            ) as resp:
                agg = await resp.json()
            check("非流式 HTTP 200", resp.status, 200)
            check("非流式聚合出正文", agg["choices"][0]["message"]["content"], "网关通了")
            check("非流式 object", agg.get("object"), "chat.completion")
    finally:
        stop_event.set()
        await task


# ── main ──────────────────────────────────────────────────────────────────────


def main() -> int:
    fake_server = FakeUpstream()
    fake_server.start()
    # 把两个域都指向假上游（cred 与 upstream 各自持有基址）
    cred.DEFAULT_BASE_URL = fake_server.base
    cred.WORKOS_BASE_URL = fake_server.base
    upstream.DEFAULT_BASE_URL = fake_server.base
    try:
        test_token_prefix()
        test_body()
        test_rate_limit()
        test_headers()
        test_device_flow()
        test_token_envelope()
        test_catalog()
        test_billing()
        asyncio.run(test_gateway())
    finally:
        fake_server.stop()

    print()
    if FAILURES:
        print(f"结果: {len(FAILURES)} 项失败 -> {FAILURES}")
        return 1
    print("结果: 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
