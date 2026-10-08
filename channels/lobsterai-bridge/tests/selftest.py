"""LobsterAI 渠道的离线自检（不出网、不需要真实凭据）。

覆盖：
1. 凭据与令牌轮换（uid 四级回退、expires_at 顺序、latestKeyfrom 不更新、refresh 保旧值）
2. 客户端版本号（第三方信封、正则、TTL 兜底）
3. 昵称手机号掩码归一化
4. 请求头（两个能力头是准入条件；匿名头不带 Authorization）
5. 请求体（stream 恒 true、不发 tool_choice、图片形态、工具结果图片挂起、孤儿剔除）
6. 错误分类顺序与 hard-credit 关键词全表
7. 模型目录（兜底 19 个 + 远端 level/openclawLevel 分离）
8. 额度与签到（三次回退、幂等预检）
9. 端到端：假上游 + 真实网关（openai 线型，流式与非流式）

用法：python tests/selftest.py
"""

from __future__ import annotations

import asyncio
import http.server
import json
import os
import sys
import tempfile
import threading
import urllib.parse
from collections.abc import Callable
from pathlib import Path
from typing import Any

# 让 src/ 可导入
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

# 隔离数据目录，避免碰到真实凭据
_TMP_HOME = Path(tempfile.mkdtemp(prefix="lobsterai-selftest-"))
os.environ["LOBSTERAI_HOME"] = str(_TMP_HOME)

from lobsterai_bridge import billing, catalog, cred, upstream  # noqa: E402

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


# ── 假上游（stdlib 线程服务器：不会被事件循环阻塞）────────────────────────────


class FakeUpstream:
    """带路由记录的本地假上游。路由返回 (status, payload)；payload 是 dict 走 JSON，
    是 (bytes, content_type) 则原样回。"""

    def __init__(self) -> None:
        self.routes: dict[str, Callable[[dict[str, Any]], tuple[int, Any]]] = {}
        self.requests: list[dict[str, Any]] = []
        outer = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                outer._handle("GET", self)

            def do_POST(self) -> None:  # noqa: N802
                outer._handle("POST", self)

            def log_message(self, *args: Any) -> None:
                _ = args

        self._server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.port = int(self._server.server_address[1])
        self.base = f"http://127.0.0.1:{self.port}"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def _handle(self, method: str, handler: http.server.BaseHTTPRequestHandler) -> None:
        parsed = urllib.parse.urlsplit(handler.path)
        length = int(handler.headers.get("Content-Length") or 0)
        raw = handler.rfile.read(length) if length else b""
        try:
            body = json.loads(raw) if raw else {}
        except ValueError:
            body = {"__raw__": raw.decode(errors="replace")}
        record = {
            "method": method,
            "path": parsed.path,
            "query": dict(urllib.parse.parse_qsl(parsed.query)),
            "body": body,
            "headers": {k: v for k, v in handler.headers.items()},
        }
        self.requests.append(record)
        route = self.routes.get(parsed.path)
        if route is None:
            status, payload = 404, {"code": 404, "message": "not found"}
        else:
            status, payload = route(record)
        if isinstance(payload, tuple):
            data, content_type = payload
        else:
            data = json.dumps(payload, ensure_ascii=False).encode()
            content_type = "application/json"
        handler.send_response(status)
        handler.send_header("Content-Type", content_type)
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)

    def last(self, path: str) -> dict[str, Any]:
        for record in reversed(self.requests):
            if record["path"] == path:
                return record
        return {}


# ── 1. 凭据与续期 ────────────────────────────────────────────────────────────


def test_credentials(fake: FakeUpstream) -> None:
    print("=== 1. 凭据与续期语义 ===")
    # ⚠ 单一基址来源：覆盖 upstream.API_BASE 即整体指向假上游（含 exchange/refresh）
    upstream.API_BASE = fake.base
    check("cred 与 upstream 共用基址", cred.resolve_base_url(), fake.base)
    # uid 四级回退
    check("uid 取 user.id", cred._uid_from_user({"id": "a", "userId": "b", "yid": "c"}), "a")
    check("uid 回退 user.userId", cred._uid_from_user({"userId": "b", "yid": "c"}), "b")
    check("uid 回退 user.yid", cred._uid_from_user({"yid": "c"}), "c")
    check("uid 末级哈希", cred._uid_fallback_hash("tok")[:16], cred._uid_fallback_hash("tok"))
    check("uid 哈希长度 16", len(cred._uid_fallback_hash("tok")), 16)

    # expires_at 顺序：expiresIn → JWT exp → 空
    payload = {"expiresIn": 3600, "accessToken": "x"}
    at = int(cred._expires_at(payload, "x"))
    check_true("expiresIn → 毫秒时间戳", 3_590_000 < at - int(cred.time.time() * 1000) < 3_610_000)
    import base64  # noqa: PLC0415

    header = base64.urlsafe_b64encode(b'{"alg":"none"}').decode().rstrip("=")
    claims = base64.urlsafe_b64encode(b'{"exp":1900000000}').decode().rstrip("=")
    jwt_token = f"{header}.{claims}.sig"
    check("JWT exp 兜底（秒→毫秒）", cred._expires_at({"accessToken": jwt_token}, jwt_token),
        str(1900000000 * 1000))
    check("无法解析时留空", cred._expires_at({}, "not-a-jwt"), "")

    # 昵称掩码
    check("掩码归一化到末 2 位", cred.normalize_nickname("130****1100"), "130******00")
    check("已归一化时幂等", cred.normalize_nickname("130******00"), "130******00")
    check("普通昵称不动", cred.normalize_nickname("小明"), "小明")
    check("带前缀的昵称不动", cred.normalize_nickname("用户130****1100"), "用户130****1100")

    # 客户端版本号：第三方信封 + 正则
    cred.VERSION_URL = fake.base + "/version"
    fake.routes["/version"] = lambda _r: (200, {"code": 0, "msg": "OK",
        "data": {"value": {"version": "2026.9.10"}}})
    check("动态版本号", cred.client_version(force=True), "2026.9.10")
    check("缓存命中不再请求", cred.client_version_cached(), "2026.9.10")
    fake.routes["/version"] = lambda _r: (200, {"data": {"value": {"version": "not-a-version"}}})
    check("非法版本号 → 兜底常量", cred.client_version(force=True), "2026.9.4")

    # exchange：latestKeyfrom 用当前时刻；refresh：用存储值 + 保旧 refresh
    fake.routes["/api/auth/exchange"] = lambda _r: (
        200,
        {
            "code": 0,
            "data": {
                "accessToken": "at-1",
                "refreshToken": "rt-1",
                "expiresIn": 7200,
                "user": {"id": "u-1", "yid": "yid-1", "nickname": "130****1100"},
            },
        },
    )
    c = cred.exchange("code-1", "uuid-1", "111")
    check("exchange access token", c.access_token, "at-1")
    check("exchange refresh token", c.refresh_token, "rt-1")
    check("exchange uid 回退链", c.uid, "u-1")
    check("exchange 昵称掩码", c.nickname, "130******00")
    sent = fake.last("/api/auth/exchange")["body"]
    check("exchange 带 authCode", sent["authCode"], "code-1")
    check("exchange uuid", sent["uuid"], "uuid-1")
    check("exchange firstKeyfrom", sent["firstKeyfrom"], "111")
    check_true("exchange latestKeyfrom 是当前时刻", sent["latestKeyfrom"].isdigit())
    check("exchange 带 version", sent["version"], "2026.9.4")

    c.first_keyfrom = "111"
    c.latest_keyfrom = "222"
    c.user_id = "yid-1"
    fake.routes["/api/auth/refresh"] = lambda _r: (
        200,
        {"code": 0, "data": {"accessToken": "at-2", "expiresIn": 60, "user": {"id": "u-1"}}},
    )
    c2 = cred.refresh(c)
    sent = fake.last("/api/auth/refresh")["body"]
    check("refresh 用存储的 latestKeyfrom", sent["latestKeyfrom"], "222")
    check("refresh 带 uuid", sent["uuid"], "uuid-1")
    check("refresh 带 userId（非空时）", sent["userId"], "yid-1")
    check("refresh 不回传 refreshToken 时保旧值", c2.refresh_token, "rt-1")
    check("refresh 更新 access token", c2.access_token, "at-2")
    check("refresh 不改 latest_keyfrom", c2.latest_keyfrom, "222")
    check("refresh 不带 Authorization（匿名头）",
        "Authorization" in fake.last("/api/auth/refresh")["headers"], False)

    # 空 uuid / 空 userId 时**不带**这两个键
    c3 = cred.Credentials(access_token="at", refresh_token="rt", uuid="", user_id="")
    cred.refresh(c3)
    sent = fake.last("/api/auth/refresh")["body"]
    check("空 uuid 不带该键", "uuid" in sent, False)
    check("空 userId 不带该键", "userId" in sent, False)

    # 终态判定
    fake.routes["/api/auth/refresh"] = lambda _r: (401, {"code": 40100,
        "message": "token rejected"})
    raised = ""
    try:
        cred.refresh(c)
    except cred.RefreshTokenExpiredError as exc:
        raised = str(exc)
    check_true("401 → 终态", "已失效" in raised)
    fake.routes["/api/auth/refresh"] = lambda _r: (200, {"code": 0, "data": {"accessToken": ""}})
    raised = ""
    try:
        cred.refresh(c)
    except cred.RefreshTokenExpiredError as exc:
        raised = str(exc)
    check_true("code:0 但空 accessToken → 终态", "空 accessToken" in raised)
    fake.routes["/api/auth/refresh"] = lambda _r: (503, {"code": 5001, "message": "boom"})
    raised = ""
    try:
        cred.refresh(c)
    except cred.RefreshTokenExpiredError:
        raised = "terminal"
    except RuntimeError as exc:
        raised = f"retryable:{exc}"
    check_true("5xx → 可重试（非终态）", raised.startswith("retryable:"))

    # 登录 URL：hash 段显式拼装 + redirect_uri 形态
    url = cred.build_login_url(45678, "st-1")
    check_true("登录 URL 是 portal#/login 形态", url.startswith("https://lobsterai.youdao.com/portal#/login?"))
    expect_redirect = "redirect_uri=http%3A%2F%2F127.0.0.1%3A45678%2Fauth%2Fcallback"
    check_true("redirect_uri 指向本地回调", expect_redirect in url)
    check_true("state 在 query 里", "state=st-1" in url)

    # 回调服务器：state 不匹配必须 400（防 CSRF/串号）
    srv = cred._CallbackServer(("127.0.0.1", 0), "st-ok", "uuid-x", "111")
    port = int(srv.server_address[1])
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        code, body = _http_get(f"http://127.0.0.1:{port}/auth/callback?code=c1&state=wrong")
        check("state 不匹配 → 400", code, 400)
        fake.routes["/api/auth/exchange"] = lambda _r: (
            200,
            {"code": 0, "data": {"accessToken": "at-live", "refreshToken": "rt-live"}},
        )
        code, body = _http_get(f"http://127.0.0.1:{port}/auth/callback?code=c1&state=st-ok")
        check("state 匹配 → 200", code, 200)
        check_true("成功页文案逐字", "登录成功，可以关闭此窗口了" in body)
        with srv.lock:
            result = srv.result
        check_true("回调里已完成 exchange", result is not None and result.access_token == "at-live")
    finally:
        srv.shutdown()
        srv.server_close()

    # 凭据往返 + load 补 uuid
    cred.save(c3)
    loaded = cred.load()
    check_true("凭据可读", loaded.access_token)
    fields = set(loaded.to_dict())
    check("凭据往返字段完整", {"uuid", "first_keyfrom", "latest_keyfrom"} <= fields, True)


# ── 2. 请求头 ────────────────────────────────────────────────────────────────


def _http_get(url: str) -> tuple[int, str]:
    """取 (状态码, 正文)；4xx/5xx 不抛异常（登录失败页也要能被断言）。"""
    import urllib.error  # noqa: PLC0415
    import urllib.request  # noqa: PLC0415

    try:
        with urllib.request.urlopen(url, timeout=5) as resp:  # noqa: S310 - 本机回调
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


def test_headers() -> None:
    print()
    print("=== 2. 请求头（能力头是准入条件）===")
    c = cred.Credentials(access_token="tok-1", uid="u-1")
    chat = upstream.build_headers(c)
    check("Authorization", chat["Authorization"], "Bearer tok-1")
    check("UA 伪装", chat["User-Agent"], "LobsterAI/0.1.0")
    check("Accept 含 SSE", chat["Accept"], "text/event-stream, application/json")
    check(
        "能力头（kimi-k3-agentic-v1,thinking-level-control-v1）",
        chat[cred.CAPABILITIES_HEADER],
        "kimi-k3-agentic-v1,thinking-level-control-v1",
    )
    check_true("版本头非空", chat[cred.VERSION_HEADER])
    check_true(
        "不带 CodeBuddy 归属头",
        not any(k.startswith("X-Domain") or k.startswith("X-Product") for k in chat),
    )

    anon = cred.anon_headers()
    check("匿名头不带 Authorization", "Authorization" in anon, False)
    check("匿名头只有三项", sorted(anon), ["Accept", "Content-Type", "User-Agent"])


# ── 3. 请求体 ────────────────────────────────────────────────────────────────


def test_body() -> None:
    print()
    print("=== 3. 请求体（OpenAI → LobsterAI）===")
    req = {
        "model": "kimi-k3",
        "messages": [
            {"role": "system", "content": "你是助手"},
            {"role": "user", "content": "看图"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": "call_1", "type": "function", "function": {"name": "read",
                        "arguments": "{}"}},
                    {"id": "call_2", "type": "function", "function": {"arguments": "{}"}},
                    {"id": "call_orphan", "type": "function", "function": {"name": "bash",
                        "arguments": "{}"}},
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_2",
                "content": [{"type": "image", "source": {"type": "base64",
                    "media_type": "image/png", "data": "AAA"}}],
            },
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "content": [
                    {"type": "text", "text": "结果"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,BBB"}},
                ],
            },
        ],
        "max_tokens": 1024,
        "temperature": 0.3,
        "stop": ["END"],
        "reasoning_effort": "max",
        "prompt_cache_key": "should-not-send",
        "tool_choice": "auto",
    }
    body = upstream.build_chat_body(req, "kimi-k3")

    check("stream 恒 true（false 会 500）", body["stream"], True)
    check("不发 prompt_cache_key", "prompt_cache_key" in body, False)
    check("不发 tool_choice", "tool_choice" in body, False)
    check("temperature 透传", body["temperature"], 0.3)
    check("max_tokens 透传", body["max_tokens"], 1024)
    check("stop 透传", body["stop"], ["END"])
    check("reasoning_effort 用 wire 值（max→xhigh）", body["reasoning_effort"], "xhigh")
    roles = [m["role"] for m in body["messages"]]
    check(
        "消息顺序保持（孤儿 tool_result 已剔除）",
        roles,
        ["system", "user", "assistant", "tool", "user"],
    )
    assistant = body["messages"][2]
    check("无 name 的 tool_call 剔除", [c["id"] for c in assistant["tool_calls"]], ["call_1"])
    check("孤儿 tool_call 剔除（call_orphan 无响应）", len(assistant["tool_calls"]), 1)
    check("有 tool_calls 时空 content → null", assistant["content"], None)
    orphan_tool = body["messages"][3]
    check("孤儿 tool_result 剔除", orphan_tool["tool_call_id"], "call_1")
    check("tool content 是字符串", orphan_tool["content"], "结果")
    check("工具结果图片挂到独立 user 消息", body["messages"][4]["role"], "user")
    check(
        "载体文本逐字",
        body["messages"][4]["content"][0]["text"],
        "Attached image(s) from tool result:",
    )
    check(
        "图片统一 image_url 形态",
        body["messages"][4]["content"][1]["type"],
        "image_url",
    )
    check_true("data URL 保留",
        body["messages"][4]["content"][1]["image_url"]["url"].startswith("data:image/png"))

    # user 消息里的 {type:'image'} 形态转 image_url
    body2 = upstream.build_chat_body(
        {
            "model": "kimi-k3",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "图"},
                        {"type": "image", "source": {"media_type": "image/jpeg", "data": "CCC"}},
                    ],
                }
            ],
        },
        "kimi-k3",
    )
    block = body2["messages"][0]["content"][1]
    check("image 块 → image_url", block["type"], "image_url")
    check("media_type 进 data URL", block["image_url"]["url"], "data:image/jpeg;base64,CCC")

    # system 前置（options.system 语义）
    body3 = upstream.build_chat_body(
        {"model": "x", "messages": [{"role": "user", "content": "hi"}], "system": "sys"}, "x"
    )
    check("system unshift 到首位", body3["messages"][0]["role"], "system")

    # tools 仅非空时带
    check("空 tools 不带", "tools" in upstream.build_chat_body({"model": "x", "messages": []}, "x"),
        False)
    check_true(
        "非空 tools 带",
        "tools"
        in upstream.build_chat_body(
            {"model": "x", "messages": [], "tools": [{"type": "function",
                "function": {"name": "bash"}}]},
            "x",
        ),
    )

    # 模型声明不支持图片 → 显式报错（不静默丢弃）
    catalog.reset_remote_cache()
    raised = ""
    try:
        upstream.normalize_messages(
            [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:x"}}]}],
            supports_image=False,
        )
    except upstream.UnsupportedContentError as exc:
        raised = str(exc)
    check_true("不支持图片的模型显式报错", "不支持图片" in raised)


# ── 4. 错误分类 ──────────────────────────────────────────────────────────────


def test_classify() -> None:
    print()
    print("=== 4. 错误分类（顺序不可重排）===")
    check("402 → hard-credit", upstream.classify_error(402, ""), "hard-credit")
    check(
        "400 + 中文「积分不足」→ hard-credit（body 排在状态码前）",
        upstream.classify_error(400, "积分不足，请充值"),
        "hard-credit",
    )
    check(
        "400 + 「额度已用完」→ hard-credit（2026-09 补的关键词）",
        upstream.classify_error(400, "免费额度已用完，请升级套餐"),
        "hard-credit",
    )
    check(
        "400 + 「升级套餐」→ hard-credit",
        upstream.classify_error(400, "请升级套餐"),
        "hard-credit",
    )
    check(
        "40100 → session-dead（排在 429/404 前）",
        upstream.classify_error(404, "40100"),
        "session-dead",
    )
    check("40101 → session-dead", upstream.classify_error(429, '{"code":"40101"}'), "session-dead")
    check(
        "token rejected → session-dead",
        upstream.classify_error(400, "refresh token was rejected"),
        "session-dead",
    )
    check("429 → soft-rate", upstream.classify_error(429, ""), "soft-rate")
    check("404 → not-found", upstream.classify_error(404, ""), "not-found")
    check("503 → server", upstream.classify_error(503, ""), "server")
    check("400 普通错误 → client", upstream.classify_error(400, "bad request"), "client")
    check("200 → none", upstream.classify_error(200, "{}"), "none")
    check("英文关键词大小写不敏感", upstream.classify_error(400, "Out Of Credit"), "hard-credit")

    # 关键词全表抽查（含 2026-09 新增的 4 个英文）
    for marker in ("insufficient credit", "quota used up", "upgrade your plan",
        "free credits used"):
        check(f"关键词 {marker!r}", upstream.classify_error(400, marker), "hard-credit")

    # 流内错误分类器：状态码失效，未命中 → client（可轮转）
    check("流内未命中 → client", upstream.classify_stream_error("boom"), "client")
    check("流内命中积分不足", upstream.classify_stream_error("积分不足"), "hard-credit")

    # 三个派生谓词
    rotate = [upstream.should_rotate_account(k) for k in ("none", "client", "server")]
    check("除 none 外都换号", rotate, [False, True, True])
    check(
        "只对三类记限流徽章",
        [upstream.records_rate_limit(k) for k in ("hard-credit", "soft-rate", "not-found",
            "client")],
        [True, True, True, False],
    )
    check("只有 session-dead 是终态", upstream.is_terminal_error("session-dead"), True)
    check("换号上限 3", upstream.MAX_ROTATE, 3)
    check("限流兜底 1 小时", upstream.RATE_LIMIT_FALLBACK_MS, 3_600_000)


# ── 5. 模型目录 ──────────────────────────────────────────────────────────────


def test_catalog() -> None:
    print()
    print("=== 5. 模型目录 ===")
    check("兜底 19 个", len(catalog.FALLBACK_MODEL_IDS), 19)
    check("兜底 contextWindow=131072", catalog.FALLBACK_MODELS[0]["context_window"], 131_072)
    check("兜底含 kimi-k2.7-code", "kimi-k2.7-code" in catalog.FALLBACK_MODEL_IDS, True)
    check("兜底不含 costMultiplier", "cost_multiplier" in catalog.FALLBACK_MODELS[0], False)
    check("resolve_model 原样", catalog.resolve_model("glm-5.2"), "glm-5.2")

    rows = [
        {
            "modelId": "kimi-k3",
            "modelName": "Kimi K3",
            "contextWindow": 1000000,
            "maxTokens": 65536,
            "supportsImage": True,
            "supportsThinking": True,
            "thinkingConfig": {
                "options": [
                    {"level": "low", "openclawLevel": "low"},
                    {"level": "max", "openclawLevel": "xhigh"},
                ],
                "defaultLevel": "low",
            },
            "costMultiplier": 1.08,
            "description": "d",
            "requestCapabilities": ["tools"],
            "provider": "x",
            "apiFormat": "y",
            "runtimeProfile": "z",
        },
        {"modelId": "plain", "costMultiplier": "x0.05"},
    ]
    parsed = catalog.parse_remote_models(rows)
    entry = parsed[0]
    check("远端 id", entry["id"], "kimi-k3")
    check("远端窗口", entry["context_window"], 1_000_000)
    check("远端 max_output", entry["max_output"], 65_536)
    check("supports_image", entry["supports_image"], True)
    check("level 与 openclawLevel 分离（展示）", entry["efforts"], ["low", "max"])
    check(
        "level 与 openclawLevel 分离（wire）",
        entry["efforts_wire"],
        {"low": "low", "max": "xhigh"},
    )
    check("裸数字 costMultiplier", entry["cost_multiplier"], 1.08)
    check("字符串 costMultiplier 也认", parsed[1]["cost_multiplier"], 0.05)
    check("不取 provider", "provider" in entry, False)
    check_true("兜底 id 列表非空", catalog.exposed_ids())
    check("未知模型不在兜底表", catalog.entry_for("nope"), None)


# ── 6. 额度与签到 ────────────────────────────────────────────────────────────


def test_billing(fake: FakeUpstream) -> None:
    print()
    print("=== 6. 额度与签到 ===")
    upstream.API_BASE = fake.base
    cred.save(
        cred.Credentials(
            access_token="tok-b",
            refresh_token="rt-b",
            uid="u-b",
            user_id="yid-b",
            uuid="uuid-b",
            first_keyfrom="1",
            latest_keyfrom="2",
        )
    )
    fake.routes["/api/user/profile-summary"] = lambda _r: (
        200,
        {
            "code": 0,
            "msg": "success",
            "data": {
                "totalCreditsRemaining": 5297.72,
                "creditItems": [
                    {"type": "campaign", "label": "每日登录奖励", "creditsRemaining": 4997.72,
                        "expiresAt": "2026-10-23T01:21:23"},
                    {"type": "campaign", "label": "每日登录奖励", "creditsRemaining": -5,
                        "expiresAt": "2026-10-23T01:21:23"},
                    {"type": "free", "label": "免费额度", "creditsRemaining": 300,
                        "expiresAt": "2036-01-01T00:00:00"},
                ],
            },
        },
    )
    fake.routes["/api/client-activities/slot"] = lambda _r: (
        200,
        {
            "code": 0,
            "data": {
                "slotState": "visible",
                "activity": {"activityCode": "daily-checkin", "configRevision": "rev-7"},
            },
        },
    )
    fake.routes["/api/client-activities/daily-checkin/context"] = lambda _r: (
        200,
        {"code": 0, "data": {"state": {"claimedToday": False},
            "actions": [{"action": "check_in"}]}},
    )
    fake.routes["/api/client-activities/daily-checkin/actions/check_in"] = lambda _r: (
        200,
        {"code": 0, "data": {"result": {"rewardCredits": 150}}},
    )

    info = billing.fetch_credits()
    check("总额取 totalCreditsRemaining", info["total"]["remain"], 5297.72)
    check("单位", info["total"]["unit"], "credits")
    check("包数", len(info["packages"]), 3)
    check("负数 clamp 到 0", info["packages"][1]["remain"], 0.0)
    check("面值推断=同组最大剩余", info["packages"][0]["size"], 4997.72)
    check("used 由面值推断", info["packages"][0]["used"], 0.0)
    check_true("ISO 8601 到期天数可算", isinstance(info["packages"][0]["days_left"], int))
    check("可领签到", [c["campaign_id"] for c in info["claimable"]], ["daily-checkin"])

    slot_query = fake.last("/api/client-activities/slot")["query"]
    check("slot placement 固定", slot_query["placement"], "desktop_sidebar")
    check("slot containerApiVersion 固定", slot_query["containerApiVersion"], "2")
    check("slot platform=win32（伪装形态，与运行环境无关）", slot_query["platform"], "win32")
    check_true("slot clientVersion 非空", slot_query["clientVersion"])
    check(
        "context 带 configRevision",
        fake.last("/api/client-activities/daily-checkin/context")["query"]["configRevision"],
        "rev-7",
    )

    result = billing.claim_checkin()
    check("签到成功（三级回退 rewardCredits）", result["credits"], 150.0)
    sent = fake.last("/api/client-activities/daily-checkin/actions/check_in")["body"]
    check("check_in configRevision", sent["configRevision"], "rev-7")
    check("check_in payload 空对象", sent["payload"], {})
    check_true("check_in 带幂等键", len(sent["idempotencyKey"]) == 36)

    # 幂等预检：claimedToday 为真时不再请求
    fake.routes["/api/client-activities/daily-checkin/context"] = lambda _r: (
        200,
        {"code": 0, "data": {"state": {"claimedToday": True}, "actions": [{"action": "check_in"}]}},
    )
    before = len([r for r in fake.requests if r["path"].endswith("/check_in")])
    result2 = billing.claim_checkin()
    after = len([r for r in fake.requests if r["path"].endswith("/check_in")])
    check("已签到不重复请求", (result2["already"], after), (True, before))

    # actions 不含 check_in → 不请求
    fake.routes["/api/client-activities/daily-checkin/context"] = lambda _r: (
        200,
        {"code": 0, "data": {"state": {"claimedToday": False}, "actions": [{"action": "share"}]}},
    )
    result3 = billing.claim_checkin()
    check("无 check_in 动作时不请求", result3["ok"], False)

    # 查不到 ≠ 0
    fake.routes["/api/user/profile-summary"] = lambda _r: (200, {"code": 0, "data": {}})
    raised = ""
    try:
        billing.fetch_credits()
    except billing.CreditsError as exc:
        raised = str(exc)
    check_true("查不到时抛 CreditsError", raised)


# ── 7. 端到端网关 ────────────────────────────────────────────────────────────


async def test_gateway(fake: FakeUpstream) -> None:
    print()
    print("=== 7. 端到端：假上游 + 真实网关（openai 线型）===")
    import socket

    import aiohttp

    from lobsterai_bridge import gateway

    sse = (
        'data:{"id":"c1","choices":[{"index":0,"delta":{"content":"网关"},"finish_reason":null}]}\n\n'
        'data:{"id":"c1","choices":[{"index":0,"delta":{"content":"通了","reasoning_content":null}}]}\n\n'
        'data:{"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
        "data: [DONE]\n\n"
    ).encode()

    def chat_route(_r: dict[str, Any]) -> tuple[int, Any]:
        return 200, (sse, "text/event-stream; charset=utf-8")

    fake.routes[upstream.CHAT_PATH] = chat_route
    fake.routes[upstream.MODELS_PATH] = lambda _r: (
        200,
        {
            "code": 0,
            "message": "success",
            "data": [
                {"modelId": "kimi-k3", "modelName": "Kimi K3", "contextWindow": 1000000},
                {"modelId": "glm-5.2", "modelName": "GLM-5.2", "contextWindow": 1000000},
            ],
        },
    )
    upstream.API_BASE = fake.base
    cred.VERSION_URL = fake.base + "/version"
    # 共享 auth_flow 的调用形态是 (Config, token, uid)：必须同样可用
    cfg = upstream.default_config()
    cfg.base_url = fake.base
    legacy = await asyncio.to_thread(upstream.fetch_models, cfg, "tok-b", "u-b")
    check_true(
        "auth_flow 形态 fetch_models 可用",
        isinstance(legacy, dict) and legacy.get("models"),
    )
    fake.routes["/version"] = lambda _r: (200, {"code": 0,
        "data": {"value": {"version": "2026.9.10"}}})

    check("动态版本号（强制刷新）", cred.client_version(force=True), "2026.9.10")
    check("凭据已落盘且是最新写入值", cred.load().access_token, "tok-b")
    catalog.reset_remote_cache()
    remote = await asyncio.to_thread(catalog.remote_models, wait=True)
    check("远端目录解析", [e["id"] for e in remote], ["kimi-k3", "glm-5.2"])
    sent_query = fake.last(upstream.MODELS_PATH)["query"]
    check("模型 query 带 firstKeyfrom", sent_query.get("firstKeyfrom"), "1")
    check("模型 query 带 latestKeyfrom", sent_query.get("latestKeyfrom"), "2")
    check("模型 query 带 version", sent_query.get("version"), "2026.9.10")
    check("模型 query 不带 refreshToken", "refreshToken" in sent_query, False)
    models_headers = fake.last(upstream.MODELS_PATH)["headers"]
    check(
        "模型端点带能力头",
        models_headers.get(cred.CAPABILITIES_HEADER),
        "kimi-k3-agentic-v1,thinking-level-control-v1",
    )

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
            check("模型列表来自远端", ids, ["kimi-k3", "glm-5.2"])

            async with session.get(f"http://127.0.0.1:{gw_port}/health") as resp:
                health = await resp.json()
            check("health logged_in", health.get("logged_in"), True)

            text = ""
            finishes: list[str] = []
            async with session.post(
                f"http://127.0.0.1:{gw_port}/v1/chat/completions",
                json={
                    "model": "kimi-k3",
                    "messages": [{"role": "user", "content": "hi"}],
                    "stream": True,
                },
            ) as resp:
                check("流式 HTTP 200", resp.status, 200)
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
                                    text += delta["content"]
                                if choice.get("finish_reason"):
                                    finishes.append(choice["finish_reason"])
            check("流式正文（data: 无空格也认）", text, "网关通了")
            check("流式 finish", finishes, ["stop"])

            chat_record = fake.last(upstream.CHAT_PATH)
            body = chat_record["body"]
            check("上游收到 stream=true", body["stream"], True)
            check("上游收到 messages", body["messages"][0]["content"], "hi")
            check("上游不发 tool_choice", "tool_choice" in body, False)
            headers = chat_record["headers"]
            check("上游收到 Bearer", headers.get("Authorization"), "Bearer tok-b")
            check(
                "上游收到能力头",
                headers.get(cred.CAPABILITIES_HEADER),
                "kimi-k3-agentic-v1,thinking-level-control-v1",
            )

            async with session.post(
                f"http://127.0.0.1:{gw_port}/v1/chat/completions",
                json={"model": "kimi-k3", "messages": [{"role": "user", "content": "hi"}]},
            ) as resp:
                agg = await resp.json()
            check("非流式聚合出正文", agg["choices"][0]["message"]["content"], "网关通了")
            check("非流式 object", agg.get("object"), "chat.completion")
    finally:
        stop_event.set()
        await task


async def main() -> int:
    fake = FakeUpstream()
    fake.routes["/version"] = lambda _r: (200, {"code": 0,
        "data": {"value": {"version": "2026.9.10"}}})
    try:
        test_credentials(fake)
        test_headers()
        test_body()
        test_classify()
        test_catalog()
        test_billing(fake)
        await test_gateway(fake)
    finally:
        fake.close()

    print()
    if FAILURES:
        print(f"结果: {len(FAILURES)} 项失败 -> {FAILURES}")
        return 1
    print("结果: 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
