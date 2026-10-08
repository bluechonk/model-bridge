"""Loomy（讯飞）渠道的离线自检（不出网、不需要真实凭据）。

覆盖：
1. HMAC-SHA1 账号签名（9 段签名字符串、恒以两个换行结尾、空 body 的 MD5 为空）
2. 通用请求体信封（appid/modelid/version/devid/ua/traceid）与「签名 = 发送的字节」
3. 两套认证头（chat 两个都发 / 业务端点只发 `token`）—— 交叉验证 100002 缺少 token
4. 业务失败恒 HTTP 200：成败只能读 body 的 code（100002 / 100001）
5. 短信登录与微信扫码（405 = 已确认、404 = 已扫码待确认，**不能读反**）
6. 续期 = 有效性探测（无 refresh 端点）+ 有效期对账
7. 目录（倍率归一化、type=chat 过滤、档位清洗、缓存只缓存真实远端）
8. 请求体改写（system 先拼再放、reasoning_effort 校验不过静默不下发）
9. 额度（两个积分池、claims 直领、100002 立即终止）
10. 端到端：假上游 + 真实网关（openai 线型）

用法：python tests/selftest.py
"""

from __future__ import annotations

import asyncio
import base64
import calendar
import hashlib
import hmac
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
_TMP_HOME = Path(tempfile.mkdtemp(prefix="loomy-selftest-"))
os.environ["LOOMY_HOME"] = str(_TMP_HOME)

from aiohttp import web  # noqa: E402

from loomy_bridge import billing, catalog, cred, upstream  # noqa: E402

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


# ── 假上游（账号端点 + 业务端点 + 微信）────────────────────────────────────────

SESSION = "0123456789abcdef0123456789abcdef"  # 32 位小写 hex（实测形态）
USERID = "123456789012345678"  # 18 位数字串（实测形态）
PHONE = "13800138000"

ST: dict[str, object] = {
    "account_requests": [],  # [(path, raw_body, headers)]
    "signature_ok": True,
    "models_mode": "ok",
    "models_calls": 0,
    "points_mode": "ok",
    "first_login_mode": "ok",
    "first_login_calls": 0,
    "tasks_mode": "ok",
    "complete_mode": "ok",
    "complete_keys": [],
    "bind_mode": 1,
    "business_headers": [],
    "chat_headers": {},
    "chat_body": {},
    "wechat_frames": [],
    "wechat_queries": [],
}

FAKE = ""
FAKE_PORT = 0


def fake(path: str) -> str:
    return f"http://127.0.0.1:{FAKE_PORT}{path}"


def _account_handler_error(path: str) -> web.Response:
    return web.json_response({"code": "100001", "desc": f"未知路径 {path}"})


async def h_account(request: web.Request) -> web.Response:
    """所有账号端点：先验签，再按路径回数据。

    ⚠ 这里用**收到的原始 body 字节**重算签名（配合请求头里的 Date/Nonce），
      与客户端送来的签名比对 —— 若客户端「签一个字符串、发另一个字符串」，
      两者不一致，测试就会红。
    """
    path = request.path
    raw = await request.text()
    headers = dict(request.headers)
    ST["account_requests"].append((path, raw, headers))  # type: ignore[union-attr]

    date = headers.get("Date", "")
    nonce = headers.get("Nonce", "")
    string_to_sign = cred.build_string_to_sign(
        "POST",
        path,
        body_str=raw,
        content_type=headers.get("Content-Type", "application/json"),
        date=date,
        nonce=nonce,
    )
    expected = base64.b64encode(
        hmac.new(
            cred.ACCESS_KEY_SECRET.encode(), string_to_sign.encode(), hashlib.sha1
        ).digest()
    ).decode()
    auth = headers.get("Authorization", "")
    if auth != f"account {cred.ACCESS_KEY_ID}:{expected}":
        ST["signature_ok"] = False

    if path == cred.SEND_MSG_PATH:
        return web.json_response({"code": "000000", "desc": "success", "data": {"msgid": "msg-1"}})
    if path == cred.CHECK_CODE_PATH:
        param = json.loads(raw)["param"]
        return web.json_response(
            {
                "code": "000000",
                "data": {"session": SESSION, "userid": USERID, "phone": param["phone"]},
            }
        )
    if path == cred.BIND_AUTH_PATH:
        if ST["bind_mode"] == 0:
            return web.json_response(
                {"code": "000000", "data": {"bind": 0, "rcode": "rc-1", "isnew": 1}}
            )
        return web.json_response(
            {"code": "000000", "data": {"bind": 1, "rcode": "rc-1", "nickname": "鲸鱼"}}
        )
    if path == cred.BIND_SEND_MSG_PATH:
        return web.json_response({"code": "000000", "data": {"msgid": "bmsg-1"}})
    if path == cred.BIND_CHECK_CODE_PATH:
        return web.json_response({"code": "000000", "data": {"session": SESSION, "userid": USERID}})
    if path == cred.BIND_SKIP_PATH:
        return web.json_response({"code": "000000", "data": {"session": SESSION, "userid": USERID}})
    return _account_handler_error(path)


def _business_guard(request: web.Request) -> web.Response | None:
    """业务端点守卫：只认 `token` 头（带错 → 200 + 100002 缺少 token，与实测一致）。"""
    ST["business_headers"].append((request.path, dict(request.headers)))  # type: ignore[union-attr]
    if request.headers.get("token") != SESSION:
        return web.json_response({"code": "100002", "desc": "缺少 token"})
    return None


async def h_models(request: web.Request) -> web.Response:
    ST["models_calls"] = int(ST["models_calls"]) + 1
    guard = _business_guard(request)
    if guard is not None:
        return guard
    if ST["models_mode"] == "fail":
        return web.json_response({"code": "500000", "desc": "模型列表暂不可用"})
    return web.json_response(
        {
            "code": "000000",
            "data": {
                "reasoning_catalog_version": "v-1",
                "models": [
                    {
                        "id": "GLM-5.3-Flash",
                        "name": "GLM 5.3 Flash(x0.8)",
                        "type": "chat",
                        "context_length": 800_000,
                        "capabilities": {"reasoning": True, "input_modalities": ["text", "image"]},
                        # 重复项与脏数据都要被清洗掉
                        "reasoning_efforts": ["none", "low", "low", "bad item", "", "high", 7],
                        "default_reasoning_effort": "low",
                    },
                    {
                        "id": "embed-1",
                        "name": "Embedding",
                        "type": "embedding",  # 非 chat → 必须过滤掉
                        "context_length": 8192,
                    },
                    {
                        "id": "MiniMax-M3",
                        "name": "MiniMax M3 （x4.0）",
                        "type": "chat",
                        "context_length": 1_048_576,
                        "capabilities": {},
                    },
                    {
                        "id": "no-name-model",
                        "type": "chat",
                        "context_length": 4096,
                    },
                    {
                        "id": "risky",
                        "name": "Risky",
                        "type": "chat",
                        "capabilities": {"reasoning": "yes"},
                    },
                ]
            },
        }
    )


async def h_points_records(request: web.Request) -> web.Response:
    guard = _business_guard(request)
    if guard is not None:
        return guard
    ST["points_query"] = dict(request.query)
    if ST["points_mode"] == "auth":
        return web.json_response({"code": "100002", "desc": "缺少 token"})
    if ST["points_mode"] == "no_balance":
        return web.json_response({"code": "000000", "data": {"availableBalance": 19992}})
    if ST["points_mode"] == "with_quota":
        data = {
            "balance": 15000,
            "dailyBalance": 4992,
            "availableBalance": 19992,
            "dailyQuota": 5000,
            "dailyConsumed": 8,
            "dailyCycleDate": "2026-09-26",
        }
        return web.json_response({"code": "000000", "data": data})
    data = {
        "balance": 15000,
        "dailyBalance": 4992,
        "availableBalance": 19992,
        "dailyCycleDate": "2026-09-26",
    }
    return web.json_response({"code": "000000", "data": data})


async def h_first_login(request: web.Request) -> web.Response:
    guard = _business_guard(request)
    if guard is not None:
        return guard
    ST["first_login_calls"] = int(ST["first_login_calls"]) + 1
    if ST["first_login_mode"] == "fail":
        return web.json_response({"code": "500000", "desc": "稍后再试"})
    already = ST["first_login_mode"] == "already"
    return web.json_response(
        {
            "code": "000000",
            "data": {
                "alreadyProcessed": already,
                "currentBalance": 19992,
                "permanentBalance": 15000,
                "dailyBalance": 4992,
                "dailyQuota": 5000,
                "dailyConsumed": 8,
                "dailyCycleDate": "2026-09-26",
            },
        }
    )


async def h_tasks(request: web.Request) -> web.Response:
    guard = _business_guard(request)
    if guard is not None:
        return guard
    if ST["tasks_mode"] == "fail":
        return web.json_response({"code": "500000", "desc": "任务列表不可用"})
    return web.json_response(
        {
            "code": "000000",
            "data": {
                "tasks": {"first_message": True, "pick_skill": True},
                "earned": 99999,  # ⚠ 不采信服务端 earned，按本地表现算
                "total": 10000,
            },
        }
    )


async def h_complete(request: web.Request) -> web.Response:
    guard = _business_guard(request)
    if guard is not None:
        return guard
    body = await request.json()
    ST["complete_keys"].append(body.get("key"))  # type: ignore[union-attr]
    # 只允许 body 里有 key 一个字段（无设备指纹、无版本号、无渠道号）
    if sorted(body.keys()) != ["key"]:
        return web.json_response({"code": "100001", "desc": "参数错误"})
    mode = ST["complete_mode"]
    if mode == "unknown_key":
        return web.json_response({"code": "100001", "desc": "未知任务"})
    if mode == "auth":
        return web.json_response({"code": "100002", "desc": "缺少 token"})
    if mode == "auth_on_ppt" and body.get("key") == "generate_ppt":
        return web.json_response({"code": "100002", "desc": "缺少 token"})
    return web.json_response(
        {"code": "000000", "data": {"alreadyCompleted": False, "balance": 19992}}
    )


async def h_chat(request: web.Request) -> web.StreamResponse:
    """对话端点：只认 `Authorization: Bearer`（带错 → 200 + 100002）。"""
    ST["chat_headers"] = dict(request.headers)
    raw = await request.text()
    ST["chat_body"] = json.loads(raw)
    if request.headers.get("Authorization") != f"Bearer {SESSION}":
        return web.json_response({"code": "100002", "desc": "缺少 token"})
    resp = web.StreamResponse()
    resp.content_type = "text/event-stream"
    await resp.prepare(request)
    frames = [
        {
            "choices": [
                {"index": 0, "delta": {"reasoning_content": "想想"}, "finish_reason": None}
            ]
        },
        {"choices": [{"index": 0, "delta": {"content": "你好"}, "finish_reason": None}]},
        {"choices": [{"index": 0, "delta": {"content": "世界"}, "finish_reason": None}]},
        {
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
        },
    ]
    for frame in frames:
        payload = {"id": "chatcmpl-loomy", "object": "chat.completion.chunk", "created": 1, **frame}
        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        await resp.write(b"data: " + line + b"\n\n")
    await resp.write(b"data: [DONE]\n\n")
    await resp.write_eof()
    return resp


# ── 微信（不复用官方的 Electron 路线，纯 HTTP）────────────────────────────────


async def h_wechat_qrconnect(request: web.Request) -> web.Response:
    """授权页 HTML：内嵌 uuid（主路径是 img 的 src）。"""
    return web.Response(
        text=(
            '<html><body><img class="js_qrcode_img" '
            'src="/connect/qrcode/AbC-123_xyz789"/></body></html>'
        ),
        content_type="text/html",
    )


async def h_wechat_qrcode(request: web.Request) -> web.Response:
    uuid = request.match_info["uuid"]
    if uuid == "tiny":
        return web.Response(body=b"err", content_type="image/jpeg")
    if uuid == "html":
        return web.Response(body="<html>redirect_uri 参数错误</html>".encode() + b" " * 300)
    # 实测是 JPEG（约 47KB），这里给一段 >200 字节的 JPEG 魔数内容
    return web.Response(body=b"\xff\xd8\xff\xe0" + b"J" * 400, content_type="image/jpeg")


async def h_wechat_long_poll(request: web.Request) -> web.Response:
    ST["wechat_queries"].append(dict(request.query))  # type: ignore[union-attr]
    frames = ST["wechat_frames"]
    frame = frames.pop(0) if frames else ""
    return web.Response(text=frame, content_type="text/plain")


def _make_app() -> web.Application:
    app = web.Application()
    for path in (
        cred.SEND_MSG_PATH,
        cred.CHECK_CODE_PATH,
        cred.BIND_AUTH_PATH,
        cred.BIND_SEND_MSG_PATH,
        cred.BIND_CHECK_CODE_PATH,
        cred.BIND_SKIP_PATH,
    ):
        app.router.add_post(path, h_account)
    app.router.add_get("/api/v1/models", h_models)
    app.router.add_get("/api/v1/points/records", h_points_records)
    app.router.add_post("/api/v1/points/first-login", h_first_login)
    app.router.add_get("/api/v1/onboarding/tasks", h_tasks)
    app.router.add_post("/api/v1/onboarding/tasks/complete", h_complete)
    app.router.add_post("/api/v1/chat/completions", h_chat)
    app.router.add_get("/connect/qrconnect", h_wechat_qrconnect)
    app.router.add_get("/connect/qrcode/{uuid}", h_wechat_qrcode)
    app.router.add_get("/connect/l/qrconnect", h_wechat_long_poll)
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


def save_fake_credentials(**overrides: object) -> cred.Credentials:
    fields: dict[str, object] = {
        "access_token": SESSION,
        "userid": USERID,
        "phone": PHONE,
        "expires_at": str(int((time.time() + cred.SESSION_TTL_SECONDS) * 1000)),
    }
    fields.update(overrides)
    c = cred.Credentials(**fields)  # type: ignore[arg-type]
    cred.save(c)
    return c


# ── 1. 签名 ───────────────────────────────────────────────────────────────────


def test_signature() -> None:
    print("=== 1. HMAC-SHA1 账号签名（9 段，恒以两个换行结尾）===")
    fixed_time = ("Wed, 08 Oct 2026 12:34:56 GMT", "11111111-2222-3333-4444-555555555555")
    sts = cred.build_string_to_sign(
        "POST",
        cred.SEND_MSG_PATH,
        body_str="",
        date=fixed_time[0],
        nonce=fixed_time[1],
    )
    segments = sts.split("\n")
    check("9 段", len(segments), 9)
    check("以两个换行结尾（后两段恒为空串）", sts[-2:], "\n\n")
    check("末两段为空", segments[7:], ["", ""])
    check(
        "前 7 段",
        segments[:7],
        [
            "POST",
            cred.SEND_MSG_PATH,
            "",
            "",  # 空 body → Content-MD5 段是空串，**不是**空串的 md5
            "application/json",
            fixed_time[0],
            fixed_time[1],
        ],
    )

    # golden：手工写死 9 段（不复用被测函数）—— 锁定签名字节布局，
    # 任何「顺手」改动（去掉尾随换行、把空 body 的 MD5 段换成空串的 md5）都会让它变红
    literal = "\n".join(
        [
            "POST",
            "/login/phone/sendMsgCode",
            "",
            "",
            "application/json",
            fixed_time[0],
            fixed_time[1],
            "",
            "",
        ]
    )
    check("与手工拼的 9 段逐字节一致", sts, literal)
    expected = base64.b64encode(
        hmac.new(cred.ACCESS_KEY_SECRET.encode(), literal.encode(), hashlib.sha1).digest()
    ).decode()
    manual = base64.b64encode(
        hmac.new(cred.ACCESS_KEY_SECRET.encode(), sts.encode(), hashlib.sha1).digest()
    ).decode()
    check("golden 签名（连同密钥一起锁定）", expected, "BA+iVMKQscng2k9D1VK3gZYex/o=")
    check("同一算法重算一致", manual, expected)

    # 去掉尾随换行 → 签名必须不同（说明它真的参与签名）
    trimmed = base64.b64encode(
        hmac.new(cred.ACCESS_KEY_SECRET.encode(), sts.rstrip("\n").encode(), hashlib.sha1).digest()
    ).decode()
    check_true("去掉尾随换行即签名不匹配", trimmed != expected)

    # body 非空 → Content-MD5 = base64(md5(body))
    body = '{"base":{"appid":"GM3LOOMY"},"param":{"a":1}}'
    check(
        "Content-MD5 段",
        cred.content_md5(body),
        base64.b64encode(hashlib.md5(body.encode()).digest()).decode(),
    )
    check("空 body → 空串（不是空串的 md5）", cred.content_md5(""), "")

    # 路径转义：补前导 /、剥末尾 /、逐段转义、空段保留
    check("补前导斜杠", cred.escaped_path("login/phone/checkCode"), "/login/phone/checkCode")
    check("剥末尾斜杠", cred.escaped_path("/a/b/"), "/a/b")
    check("根路径不动", cred.escaped_path("/"), "/")
    check("只保留一个前导斜杠", cred.escaped_path("/a"), "/a")
    check("空段保留", cred.escaped_path("/a//b"), "/a//b")
    check("空格与保留字转义", cred.escaped_path("/a b/c!d"), "/a%20b/c%21d")
    check("斜杠被逐段处理（不整段转义）", cred.escaped_path("/x/y"), "/x/y")
    check("RFC3986 补转 ! ' ( ) *", cred.escape("!'()*"), "%21%27%28%29%2A")

    # 查询串：不排序、两侧转义、None → 空串
    check("查询串不排序", cred.escaped_query([("b", "2"), ("a", "1")]), "b=2&a=1")
    check("查询串值转义", cred.escaped_query({"q": "a b&c"}), "q=a%20b%26c")
    check("None 值转空串", cred.escaped_query([("k", None)]), "k=")
    check("无查询为空串", cred.escaped_query(None), "")

    # 请求头：前缀是 account，Content-MD5 仅当 body 非空
    no_body = cred.sign_headers("POST", cred.SEND_MSG_PATH)
    check_true("Authorization 前缀是 account", no_body["Authorization"].startswith("account "))
    check_true("无 body 不带 Content-MD5", "Content-MD5" not in no_body)
    with_body = cred.sign_headers("POST", cred.SEND_MSG_PATH, body_str=body)
    check("有 body 带 Content-MD5", with_body["Content-MD5"], cred.content_md5(body))
    check_true("Date 是 UTC（GMT 结尾）", with_body["Date"].endswith("GMT"))
    check("Nonce 是带连字符的 uuid", len(with_body["Nonce"]), 36)


def test_account_body() -> None:
    print()
    print("=== 2. 通用请求体信封与「签名 = 发送的字节」===")
    body = cred.account_body({"phone": PHONE})
    check("两个顶层键", sorted(body.keys()), ["base", "param"])
    check(
        "base 段",
        sorted(body["base"].keys()),
        ["appid", "devid", "modelid", "traceid", "ua", "version"],
    )
    check("appid", body["base"]["appid"], "GM3LOOMY")
    check("modelid", body["base"]["modelid"], "Web")
    check("version", body["base"]["version"], "1.0.0")
    check("devid", body["base"]["devid"], "web")
    check(
        "ua 硬编码客户端值（Windows 上也发这个）",
        body["base"]["ua"],
        "Loomy|Desktop|Electron|macOS",
    )
    check("traceid 是 32 位 hex", len(str(body["base"]["traceid"])), 32)
    check(
        "traceid 每次重新生成",
        cred.account_body({})["base"]["traceid"] != cred.account_body({})["base"]["traceid"],
        True,
    )

    # 真发一次：服务器用收到的原始 body 字节重算签名并比对
    ST["account_requests"].clear()
    ST["signature_ok"] = True
    msgid = cred.send_sms_code(PHONE)
    check("msgid 原样带回", msgid, "msg-1")
    requests_seen = ST["account_requests"]
    check("收到 1 个账号请求", len(requests_seen), 1)  # type: ignore[arg-type]
    path, raw, headers = requests_seen[0]  # type: ignore[index]
    check("路径", path, cred.SEND_MSG_PATH)
    check(
        "param 段带 ccode/expire",
        sorted(json.loads(raw)["param"].keys()),
        ["ccode", "expire", "phone"],
    )
    check("用 application/json", headers.get("Content-Type"), "application/json")
    check("服务端重算签名一致（签发的就是发出去的字节）", ST["signature_ok"], True)


# ── 3. 两套认证头 ─────────────────────────────────────────────────────────────


def test_headers() -> None:
    print()
    print("=== 3. 两套认证头（chat 两个都发 / 业务端点只发 token）===")
    c = save_fake_credentials()
    chat = upstream.build_headers(c)
    check("chat 端点发 Authorization", chat.get("Authorization"), f"Bearer {SESSION}")
    check("chat 端点也发 token", chat.get("token"), SESSION)
    check("chat 端点 Accept SSE", chat.get("Accept"), "text/event-stream")
    check("chat 端点 Content-Type", chat.get("Content-Type"), "application/json")

    biz = upstream.build_headers(c, chat=False)
    check("业务端点发 token", biz.get("token"), SESSION)
    check_true("业务端点**不**发 Authorization", "Authorization" not in biz)
    check("业务端点 Accept json", biz.get("Accept"), "application/json")

    # 交叉验证：带错的那个头 → 200 + 100002（实测结论）
    import requests

    resp = requests.get(
        f"{FAKE}/api/v1/models", headers={"Authorization": f"Bearer {SESSION}"}, timeout=10
    )
    payload = resp.json()
    check("业务端点只认 token（带 Authorization 回 100002）", payload["code"], "100002")
    check("缺 token 的文案", payload["desc"], "缺少 token")

    resp = requests.post(
        f"{FAKE}/api/v1/chat/completions", headers={"token": SESSION}, json={}, timeout=10
    )
    check("chat 端点只认 Bearer（带 token 回 100002）", resp.json()["code"], "100002")

    ST["business_headers"] = []
    upstream.fetch_points_records(c)
    sent = ST["business_headers"][-1][1]  # type: ignore[index]
    check_true("业务端点请求确实不带 Authorization", "Authorization" not in sent)
    check("业务端点请求带 token", sent.get("token"), SESSION)


# ── 4. 业务失败恒 200 ─────────────────────────────────────────────────────────


def test_business_codes() -> None:
    print()
    print("=== 4. 业务失败恒 HTTP 200：只能读 code ===")
    c = save_fake_credentials()

    ST["models_mode"] = "fail"
    e = check_raises(
        "code 非 000000 → 报错（不是静默成功）",
        lambda: upstream.fetch_models(c),
        RuntimeError,
    )
    check_true("报错带 desc", e is not None and "模型列表暂不可用" in str(e))
    ST["models_mode"] = "ok"

    code, desc, data = upstream.parse_envelope(
        {"code": "100001", "desc": "来自 desc", "message": "来自 message", "data": {"x": 1}}
    )
    check("code 归一成字符串", code, "100001")
    check("desc 优先于 message", desc, "来自 desc")
    check("data 原样返回", data, {"x": 1})
    check("100002 识别为登录失效", upstream.is_auth_error("100002"), True)
    check("其它码不算登录失效", upstream.is_auth_error("100001"), False)

    # 登录失效：fetch_models / refresh 都要抛
    ST["points_mode"] = "auth"
    check_raises(
        "points/records 回 100002 → UpstreamUnauthorized",
        lambda: upstream.fetch_points_records(c),
        upstream.UpstreamUnauthorized,
    )
    ST["points_mode"] = "ok"
    check_raises(
        "业务端点 100002 → UpstreamUnauthorized",
        _fetch_models_with_bad_token,
        upstream.UpstreamUnauthorized,
    )


def _fetch_models_with_bad_token() -> None:
    upstream.fetch_models(cred.Credentials(access_token="wrong-session"))


# ── 5. 登录（短信 + 微信）─────────────────────────────────────────────────────


def test_sms_login() -> None:
    print()
    print("=== 5a. 短信登录（声明 14 天，本地推算 expires_at）===")
    c = cred.verify_sms_code(PHONE, "123456", "msg-1")
    check("session 落进 access_token", c.access_token, SESSION)
    check("userid", c.userid, USERID)
    check("phone 原样带回", c.phone, PHONE)
    check("expires_at 是毫秒时间戳字符串", len(c.expires_at), 13)
    check_true("未过期", not cred.is_expired(c))
    check("uid 用 userid", c.uid, USERID)
    check("无域概念", c.domain, "")

    # login() 走环境变量输入（无窗口工程没有输入框）
    os.environ[cred.PHONE_ENV] = PHONE
    os.environ[cred.SMS_CODE_ENV] = "654321"
    ST["first_login_calls"] = 0
    try:
        c2 = cred.login(on_status=lambda _msg: None)
    finally:
        del os.environ[cred.PHONE_ENV]
        del os.environ[cred.SMS_CODE_ENV]
    check("login 落盘", cred.load().access_token, SESSION)
    check("login 后触发每日额度初始化", ST["first_login_calls"], 1)
    check_true("login 版本有效", not cred.is_expired(c2))


def test_wechat_login() -> None:
    print()
    print("=== 5b. 微信扫码（405 = 已确认，404 = 已扫码待确认 —— 不能读反）===")
    html = (
        '<html><img class="js_qrcode_img" src="/connect/qrcode/UUID_1-abc"/></html>'
    )
    check("主路径提取 uuid", cred.extract_wechat_uuid(html), "UUID_1-abc")
    check(
        "兜底路径提取 uuid",
        cred.extract_wechat_uuid(
            'var fordevtool = "https://x/connect/l/qrconnect?uuid=UUID_2-xyz";'
        ),
        "UUID_2-xyz",
    )
    check("字符集不符 → 空", cred.extract_wechat_uuid('src="/connect/qrcode/a b"'), "")
    check("页面里没有 uuid → 空", cred.extract_wechat_uuid("<html></html>"), "")

    authorize = cred.wechat_authorize_url("state-1")
    check_true("授权页带官方 appid", f"appid={cred.WECHAT_APP_ID}" in authorize)
    check_true(
        "redirect_uri 用官方地址（白名单，不能换成本地回调）",
        "loomy.xunfei.cn%2Foauth%2Fwechat%2Fcallback" in authorize,
    )
    check_true("以 #wechat_redirect 结尾", authorize.endswith("#wechat_redirect"))

    check_true("JPEG 魔数识别", cred.looks_like_image(b"\xff\xd8\xff\xe0rest"))
    check_true("PNG 魔数识别", cred.looks_like_image(b"\x89PNG\r\n\x1a\nrest"))
    check_true("GIF 魔数识别", cred.looks_like_image(b"GIF89arest"))
    check("HTML 不是图片", cred.looks_like_image(b"<html>"), False)
    check_true("真实二维码字节", len(cred.fetch_wechat_qr("AbC-123_xyz789")) > 200)
    check_raises("字节数 < 200 视为错误页", lambda: cred.fetch_wechat_qr("tiny"), RuntimeError)
    check_raises("不是图片视为错误页", lambda: cred.fetch_wechat_qr("html"), RuntimeError)

    # 长轮询状态机（语义以微信授权页内嵌 JS 为准）
    ST["wechat_queries"].clear()
    cases = [
        (408, "", "waiting"),
        (404, "", "scanned"),
        (405, "the-code", "confirmed"),
        (405, "", "scanned"),  # 405 但没带 code → 保守继续轮询
        (403, "", "cancelled"),
        (402, "", "expired"),
        (400, "", "waiting"),  # 未知 → 保守 waiting（绝不误判成功）
        (999, "", "waiting"),
    ]
    for errcode, code, want in cases:
        ST["wechat_frames"] = [f"window.wx_errcode={errcode};window.wx_code='{code}';"]
        frame = cred.wechat_poll_once("UUID_1-abc")
        check(f"errcode {errcode} → {want}", frame["status"], want)
        if want == "confirmed":
            check("405 帧里带回 wx_code", frame["code"], "the-code")
    query = ST["wechat_queries"][-1]  # type: ignore[index]
    check("长轮询带 uuid", query.get("uuid"), "UUID_1-abc")
    check_true("长轮询带毫秒时间戳 _", str(query.get("_", "")).isdigit())

    # 网络异常 → error 状态而**不抛错**
    good_poll = cred.WECHAT_LONG_POLL_URL
    cred.WECHAT_LONG_POLL_URL = f"http://127.0.0.1:{dead_port()}/connect/l/qrconnect"
    try:
        frame = cred.wechat_poll_once("UUID_1-abc")
        check("网络异常返回 error（不抛错）", frame["status"], "error")
    finally:
        cred.WECHAT_LONG_POLL_URL = good_poll

    # 完整扫码：408 → 404 → 405(带 code) → bind=1 → skip
    ST["wechat_frames"] = [
        "window.wx_errcode=408;window.wx_code='';",
        "window.wx_errcode=404;window.wx_code='';",
        "window.wx_errcode=405;window.wx_code='wx-code-1';",
    ]
    ST["bind_mode"] = 1
    urls: list[str] = []
    statuses: list[str] = []
    c = cred.wechat_wait_for_code(
        on_url=urls.append, on_status=statuses.append, timeout_sec=5, poll_interval_sec=0
    )
    check("拿到 wx_code", c, "wx-code-1")
    check_true("on_url 立刻回调（qrconnect 授权页）", urls and "/connect/qrconnect?" in urls[0])
    check_true("on_status 报过「已扫码」", any("已扫码" in s for s in statuses))

    ST["first_login_calls"] = 0
    ST["wechat_frames"] = ["window.wx_errcode=405;window.wx_code='wx-code-1';"]
    c = cred.login_wechat(on_status=lambda _m: None)
    check("已绑手机号走 skip，拿到 session", c.access_token, SESSION)
    check("凭据落盘", cred.load().userid, USERID)
    check("微信登录也触发每日额度初始化", ST["first_login_calls"], 1)

    # 未绑手机号（bind=0）→ sendMsg + checkCode
    ST["bind_mode"] = 0
    ST["wechat_frames"] = ["window.wx_errcode=405;window.wx_code='wx-code-2';"]
    os.environ[cred.PHONE_ENV] = PHONE
    os.environ[cred.SMS_CODE_ENV] = "111111"
    try:
        c = cred.login_wechat(on_status=lambda _m: None)
    finally:
        del os.environ[cred.PHONE_ENV]
        del os.environ[cred.SMS_CODE_ENV]
    check("未绑手机号也能登录", c.access_token, SESSION)
    check("来源标注绑定流程", c.source, "loomy-wechat-bind")

    # bind 缺失归 0（走绑定流程，不拿无效 session）
    ST["bind_mode"] = 0
    bind = cred.bind_auth_third_account("wxcode")
    check("bind 缺失归 0", bind["bind"], 0)
    check_raises("缺 rcode 必须明确报错", lambda: cred.bind_skip(""), RuntimeError)


# ── 6. refresh = 有效性探测 ───────────────────────────────────────────────────


def test_refresh() -> None:
    print()
    print("=== 6. refresh()：无续期端点 → 只做有效性探测 + 有效期对账 ===")
    expired = save_fake_credentials(expires_at=str(int((time.time() - 86400) * 1000)))
    check_true("本地推算已过期", cred.is_expired(expired))
    back = cred.refresh(expired)
    check_true("探测通过 → 更正本地过期时间（不再显示已过期）", not cred.is_expired(back))
    check("对账后落盘", cred.load().expires_at, back.expires_at)
    check("session 不变", back.access_token, SESSION)

    fresh = save_fake_credentials()
    stamp = fresh.expires_at
    check("仍有效时不改动时间戳", cred.refresh(fresh).expires_at, stamp)

    ST["points_mode"] = "auth"
    e = check_raises(
        "探测失败 → 抛错（不假装续期成功）",
        lambda: cred.refresh(cred.load()),
        RuntimeError,
    )
    check_true("报错说明没有续期端点", e is not None and "续期" in str(e))
    ST["points_mode"] = "ok"

    # load() 能补旧凭据缺的 expires_at（按 obtained_at + 14 天补算）
    legacy = _TMP_HOME / ".loomy-bridge" / "credentials.json"
    legacy.write_text(
        json.dumps(
            {
                "access_token": SESSION,
                "userid": USERID,
                "obtained_at": "2026-10-01T00:00:00.000000000Z",
            }
        ),
        encoding="utf-8",
    )
    loaded = cred.load()
    expected_expiry = int(
        calendar.timegm(time.strptime("2026-10-15T00:00:00", "%Y-%m-%dT%H:%M:%S")) * 1000
    )
    check("缺 expires_at → 按 obtained_at + 14 天补算", loaded.expires_at, str(expected_expiry))

    # 空/损坏文件 → NotLoggedInError
    legacy.write_text("{}", encoding="utf-8")
    check_raises("无 access_token → NotLoggedInError", cred.load, cred.NotLoggedInError)
    legacy.write_text("{not json", encoding="utf-8")
    check_raises("损坏 → NotLoggedInError", cred.load, cred.NotLoggedInError)
    legacy.unlink()
    check_raises("缺失 → NotLoggedInError", cred.load, cred.NotLoggedInError)


# ── 7. 目录 ───────────────────────────────────────────────────────────────────


def test_catalog() -> None:
    print()
    print("=== 7. 模型目录（倍率归一化 / type=chat 过滤 / 档位清洗）===")
    # 倍率三种括号风格 + 幂等 + 只认末尾 + 主体为空时原样保留
    check("全角括号", catalog.split_rate("MiniMax M3 （x4.0）"), ("MiniMax M3", "x4.0"))
    check("半角括号", catalog.split_rate("Qwen 3.8 Max (x12.0)"), ("Qwen 3.8 Max", "x12.0"))
    check("括号紧贴", catalog.split_rate("GLM 5.3 Flash(x0.8)"), ("GLM 5.3 Flash", "x0.8"))
    check(
        "展示名（已规范化）",
        catalog.display_name("Qwen 3.8 Max (x12.0)"),
        "Qwen 3.8 Max · x12.0",
    )
    check(
        "幂等（再次规范化不变）",
        catalog.display_name(catalog.display_name("Qwen 3.8 Max (x12.0)")),
        "Qwen 3.8 Max · x12.0",
    )
    check("中间的括号不动", catalog.display_name("Qwen (turbo) Max"), "Qwen (turbo) Max")
    check("无倍率不加分隔符", catalog.display_name("Spark X"), "Spark X")
    check("主体为空时原样保留", catalog.split_rate("（x4.0）"), ("（x4.0）", ""))

    save_fake_credentials()

    # ① 远端可用：type=chat 过滤、倍率归一化、档位清洗、默认档是我们自己的 high
    catalog.reset_cache()
    rows = catalog.details()
    ids = [row["id"] for row in rows]
    check("只保留 type=chat", ids, ["GLM-5.3-Flash", "MiniMax-M3", "no-name-model", "risky"])
    by_id = {row["id"]: row for row in rows}
    glm = by_id["GLM-5.3-Flash"]
    check("远端倍率归一化", glm["name"], "GLM 5.3 Flash · x0.8")
    check("倍率单独留字段", glm["rate"], "x0.8")
    check("上下文窗口取远端", glm["context_window"], 800_000)
    check("图片能力来自 capabilities.input_modalities", glm["vision"], True)
    check("思考能力严格 True", glm["reasoning"], True)
    check("档位清洗（去重 + 丢脏数据）", glm["efforts"], ["none", "low", "high"])
    check("默认档是本插件的 high（不采信远端的 low）", glm["default_effort"], "high")
    check("远端声明的默认档仅留作排查", glm["remote_default_effort"], "low")
    check("无 name 时退回 id", by_id["no-name-model"]["name"], "no-name-model")
    check("reasoning 是字符串 'yes' → 不算思考", by_id["risky"]["reasoning"], False)
    check("远端条目不声明图片能力", by_id["risky"]["vision"], False)
    check("catalog 版本", catalog.catalog_version(), "v-1")
    check("exposed_ids 与目录一致", catalog.exposed_ids(), ids)
    check("resolve_model 未知原样返回", catalog.resolve_model("unknown-x"), "unknown-x")
    check("resolve_model 已知原样返回", catalog.resolve_model("MiniMax-M3"), "MiniMax-M3")

    # ② 缓存：只缓存真实远端目录（第二次调用不再打网络）
    calls_before = int(ST["models_calls"])
    catalog.remote_models()
    catalog.details()
    check("远端目录命中缓存（不重复打网络）", int(ST["models_calls"]) - calls_before, 0)

    # ③ 远端不可用 → 整表兜底（8 条），档位用兜底表
    original_base = upstream.DEFAULT_BASE_URL
    upstream.DEFAULT_BASE_URL = f"http://127.0.0.1:{dead_port()}"
    catalog.reset_cache()
    try:
        fallback_ids = catalog.exposed_ids()
        check(
            "远端不可用 → 8 条兜底表",
            fallback_ids,
            [
                "deepseek-v4-flash-0731",
                "MiniMax-M3",
                "Kimi-k2.6",
                "qwen-3.8-max",
                "GLM-5.3-Flash",
                "qwen3.8-flash",
                "spark-x",
                "mimo-v2.5",
            ],
        )
        spark = {row["id"]: row for row in catalog.details()}["spark-x"]
        check("兜底条目的倍率在 name 里", spark["name"], "Spark X2.5 · x0.1")
        check("兜底条目不声明图片能力", spark["vision"], False)
        check(
            "兜底档位",
            catalog.efforts_for("spark-x"),
            ["none", "low", "medium", "high", "xhigh"],
        )
        check("兜底默认档 high", catalog.default_effort_for("spark-x"), "high")
        check("未知模型的档位为空", catalog.efforts_for("nope"), [])
    finally:
        upstream.DEFAULT_BASE_URL = original_base
        catalog.reset_cache()

    # ④ models.json 短名（可选覆盖）
    alias_file = _TMP_HOME / "alias-models.json"
    alias_file.write_text(
        json.dumps({"models": [{"slug": "spark-x", "alias": "spark"}]}), encoding="utf-8"
    )
    os.environ["LOOMY_MODELS_FILE"] = str(alias_file)
    try:
        catalog.reset_cache()
        ids_alias = catalog.exposed_ids()
        check("短名排在最前", ids_alias[0], "spark")
        check("短名映射到上游 id", catalog.resolve_model("spark"), "spark-x")
        check("已被短名覆盖的 id 不重复暴露", ids_alias.count("spark-x"), 0)
    finally:
        del os.environ["LOOMY_MODELS_FILE"]
        catalog.reset_cache()


# ── 8. 请求体改写 ─────────────────────────────────────────────────────────────


def test_chat_body() -> None:
    print()
    print("=== 8. 请求体（system 先拼再放 / 档位校验不过静默不下发）===")
    catalog.reset_cache()
    req = {
        "model": "GLM-5.3-Flash",
        "messages": [
            {"role": "user", "content": "你好"},
            {"role": "system", "content": "你是助手"},
        ],
        "temperature": 0.3,
        "max_tokens": 4096,
        "reasoning_effort": "high",  # 在远端 efforts 内 → 下发
        "tools": [
            {
                "type": "function",
                "function": {"name": "bash", "description": "执行命令", "parameters": {}},
            }
        ],
    }
    body = upstream.build_chat_body(req, "GLM-5.3-Flash")
    check("model 用上游 id", body["model"], "GLM-5.3-Flash")
    check("恒 stream", body["stream"], True)
    check(
        "system 先拼再放进 messages[0]",
        body["messages"][0],
        {"role": "system", "content": "你是助手"},
    )
    check("其余消息保持顺序", [m["role"] for m in body["messages"]], ["system", "user"])
    check("valid 档位下发", body["reasoning_effort"], "high")
    check("max_tokens 透传", body["max_tokens"], 4096)
    check("temperature 透传", body["temperature"], 0.3)

    bad = upstream.build_chat_body({**req, "reasoning_effort": "banana"}, "GLM-5.3-Flash")
    check("远端不认的档位静默不下发", "reasoning_effort" in bad, False)
    unknown_model = upstream.build_chat_body({**req, "reasoning_effort": "high"}, "no-such-model")
    check("模型未知（档位未知）也不下发", "reasoning_effort" in unknown_model, False)

    minimal = upstream.build_chat_body({"messages": [{"role": "user", "content": "hi"}]}, "spark-x")
    check(
        "可选字段缺省时不发该键（不是发 null）",
        sorted(minimal.keys()),
        ["messages", "model", "stream"],
    )
    check("无 system 不插空 system", [m["role"] for m in minimal["messages"]], ["user"])


# ── 9. 额度 ───────────────────────────────────────────────────────────────────


def test_billing() -> None:
    print()
    print("=== 9. 额度（两个积分池 / 直领 / 100002 立即终止）===")
    save_fake_credentials()
    ST["points_mode"] = "ok"
    ST["tasks_mode"] = "ok"
    ST["complete_mode"] = "ok"
    ST["complete_keys"] = []

    info = billing.fetch_credits()
    check("只读端点参数", ST["points_query"], {"pageNo": "1", "pageSize": "1", "recordType": "all"})
    check("总量用 availableBalance", info["total"]["remain"], 19992.0)
    check("单位是积分", info["total"]["unit"], "积分")
    check("未签到时 dailyQuota 未知（不硬编码 5000）", info["total"]["daily_quota_known"], False)
    check("两个积分池", [p["name"] for p in info["packages"]], ["永久积分", "每日赠送"])
    check("永久池", info["packages"][0]["remain"], 15000.0)
    check("每日池", info["packages"][1]["remain"], 4992.0)
    check("每日池不编造到期天数", info["packages"][1]["days_left"], None)
    check("可领任务 = 未完成的 6 个（前两个已完成）", len(info["claimable"]), 6)
    check("可领任务合计 10000 - 1500 = 8500", sum(c["amount"] for c in info["claimable"]), 8500.0)
    check("claimable 带 key 与标题", info["claimable"][0]["campaign_id"], "generate_ppt")
    check_true("claimable 带中文标题", "PPT" in info["claimable"][0]["label"])

    # first-login 的响应里才有 dailyQuota → 已知时算真实 used
    ST["points_mode"] = "with_quota"
    info = billing.fetch_credits()
    check("拿到 dailyQuota → 总量 = 永久 + 配额", info["total"]["size"], 20000.0)
    check("used = size - available", info["total"]["used"], 8.0)
    check("quota 已知标记", info["total"]["daily_quota_known"], True)
    ST["points_mode"] = "ok"

    # 形状不对 → 抛错，而不是显示成 0
    ST["points_mode"] = "no_balance"
    check_raises(
        "缺 balance → CreditsError（不显示成 0）",
        billing.fetch_credits,
        billing.CreditsError,
    )
    ST["points_mode"] = "auth"
    check_raises("100002 → NotLoggedInError", billing.fetch_credits, cred.NotLoggedInError)
    ST["points_mode"] = "ok"

    # 任务列表挂了不影响余额
    ST["tasks_mode"] = "fail"
    info = billing.fetch_credits()
    check("任务列表失败 → claimable 空表（余额仍在）", info["claimable"], [])
    check("余额仍在", info["total"]["remain"], 19992.0)
    ST["tasks_mode"] = "ok"

    # 直领：body 只有 key
    result = billing.claim("first_message")
    check("直领状态", result["status"], "completed")
    check("积分", result["amount"], 500.0)
    check("上报 key", ST["complete_keys"][-1], "first_message")

    # 每日额度初始化：alreadyProcessed 映射成 already-claimed
    ST["first_login_mode"] = "already"
    out = billing.trigger_daily_quota()
    check("幂等判据 alreadyProcessed", out["status"], "already-claimed")
    check("dailyQuota 从 first-login 拿", out["daily_quota"], 5000.0)
    ST["first_login_mode"] = "fail"
    out = billing.trigger_daily_quota()
    check("初始化失败也不抛错", out["status"], "failed")
    check_true("失败带原因", bool(out.get("error")))
    ST["first_login_mode"] = "ok"

    # 未知 key → 100001 → CreditsError
    ST["complete_mode"] = "unknown_key"
    check_raises(
        "未知 task key → CreditsError",
        lambda: billing.claim("nope"),
        billing.CreditsError,
    )
    ST["complete_mode"] = "ok"

    # claim_all：已完成的跳过不发请求；100002 立即终止（不再打后续任务）
    ST["complete_keys"] = []
    result = billing.claim_all()
    check(
        "跳过已完成的（first_message / pick_skill 不发请求）",
        ST["complete_keys"][0],
        "generate_ppt",
    )
    check("本地算 earned", result["earned"], 8500.0)
    check("结果条数 = 8", len(result["results"]), 8)
    check("前两条是 skipped", [r["status"] for r in result["results"][:2]], ["skipped", "skipped"])

    ST["complete_keys"] = []
    # generate_ppt 会回 100002 → 立即抛出，不再对后续任务发请求
    ST["complete_mode"] = "auth_on_ppt"
    check_raises("claim_all 遇 100002 立即抛出", billing.claim_all, cred.NotLoggedInError)
    check("只发了 1 个请求（后续任务不再打）", ST["complete_keys"], ["generate_ppt"])
    ST["complete_mode"] = "ok"

    # 未登录 → NotLoggedInError
    cred.paths.credentials_path().unlink()
    check_raises("未登录 → NotLoggedInError", billing.fetch_credits, cred.NotLoggedInError)


# ── 10. 端到端 ────────────────────────────────────────────────────────────────


async def test_gateway() -> None:
    print()
    print("=== 10. 端到端：假上游 + 真实网关（openai 线型）===")
    import aiohttp

    from loomy_bridge import gateway

    save_fake_credentials()
    catalog.reset_cache()
    ST["points_mode"] = "ok"
    ST["tasks_mode"] = "ok"
    ST["complete_mode"] = "ok"

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
            check_true("模型列表含远端条目", "GLM-5.3-Flash" in ids)

            async with session.get(f"{base}/health") as resp:
                health = await resp.json()
            check("health ok", health.get("ok"), True)
            check("health 标注已登录", health.get("logged_in"), True)

            content = ""
            reasoning = ""
            finishes: list[str] = []
            async with session.post(
                f"{base}/v1/chat/completions",
                json={
                    "model": "GLM-5.3-Flash",
                    "messages": [
                        {"role": "system", "content": "身份"},
                        {"role": "user", "content": "hi"},
                    ],
                    "reasoning_effort": "high",
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
                                if delta.get("reasoning_content"):
                                    reasoning += delta["reasoning_content"]
                                if choice.get("finish_reason"):
                                    finishes.append(choice["finish_reason"])
            check("流式正文", content, "你好世界")
            check("思考增量透传", reasoning, "想想")
            check("流式 finish", finishes, ["stop"])

            sent = ST["chat_headers"] or {}
            body = ST["chat_body"] or {}
            check("上游收到 Bearer 会话", sent.get("Authorization"), f"Bearer {SESSION}")
            check("上游也收到 token 头", sent.get("token"), SESSION)
            check("上游收到 SSE Accept", sent.get("Accept"), "text/event-stream")
            check("上游收到 model", body.get("model"), "GLM-5.3-Flash")
            check("上游收到恒 stream", body.get("stream"), True)
            check("上游收到校验过的档位", body.get("reasoning_effort"), "high")
            check("上游收到提升后的 system", body["messages"][0]["role"], "system")

            async with session.post(
                f"{base}/v1/chat/completions",
                json={"model": "GLM-5.3-Flash", "messages": [{"role": "user", "content": "hi"}]},
            ) as resp:
                agg = await resp.json()
            check("非流式 HTTP 200", resp.status, 200)
            check("非流式聚合出正文", agg["choices"][0]["message"]["content"], "你好世界")
            check("非流式 object", agg.get("object"), "chat.completion")
    finally:
        stop_event.set()
        await task


# ── main ──────────────────────────────────────────────────────────────────────


def main() -> int:
    fake_server = FakeUpstream()
    fake_server.start()
    cred.DEFAULT_BASE_URL = fake_server.base
    upstream.DEFAULT_BASE_URL = f"{fake_server.base}/api/v1"
    # 微信三个端点也指向假上游（真实地址见 cred.py 的常量注释）
    cred.WECHAT_AUTHORIZE_URL = f"{fake_server.base}/connect/qrconnect"
    cred.WECHAT_QRCODE_URL_TMPL = f"{fake_server.base}/connect/qrcode/{{uuid}}"
    cred.WECHAT_LONG_POLL_URL = f"{fake_server.base}/connect/l/qrconnect"
    try:
        test_signature()
        test_account_body()
        test_headers()
        test_business_codes()
        test_sms_login()
        test_wechat_login()
        test_refresh()
        test_catalog()
        test_chat_body()
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
