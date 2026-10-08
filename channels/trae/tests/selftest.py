"""TRAE 渠道的离线自检（不出网、不需要真实凭据）。

覆盖：
1. 凭据与设备指纹（machine_id/device_id 32 hex、签到设备确定性派生、昵称乱码修复）
2. 登录 URL 的 18 个参数与 `auth_callback_url` 拼写
3. 回调解析（直接回传 token / PKCE 明确报错）
4. 请求体改写（function / model+config_name / content 块数组 / tools 参数变字符串 /
   max_tokens 收敛）
5. 请求头（同一 token 三处、版本头、设备头）
6. 流翻译（event 流 → OpenAI delta，含**逐字节喂入**与工具调用清理）
7. 模型目录（白名单通道过滤、硬过滤、合并优先级）
8. 错误分类顺序
9. 端到端：假上游 + 真实网关（custom 线型，流式与非流式）

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
_TMP_HOME = Path(tempfile.mkdtemp(prefix="trae-selftest-"))
os.environ["TRAE_HOME"] = str(_TMP_HOME)

from trae_bridge import billing, catalog, cred, upstream  # noqa: E402

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

    def count(self, path: str) -> int:
        return len([r for r in self.requests if r["path"] == path])

    def last(self, path: str) -> dict[str, Any]:
        for record in reversed(self.requests):
            if record["path"] == path:
                return record
        return {}


# ── 1. 凭据与设备指纹 ────────────────────────────────────────────────────────


def test_cred() -> None:
    print("=== 1. 凭据与设备指纹 ===")
    machine = cred.generate_machine_id()
    device = cred.generate_device_id()
    hex_chars = set("0123456789abcdef")
    check(
        "machine_id 是 32 位 hex",
        (len(machine), set(machine) <= hex_chars),
        (32, True),
    )
    check(
        "device_id 是 32 位 hex",
        (len(device), set(device) <= hex_chars),
        (32, True),
    )
    check("两次 device_id 不同（每账号互不相同）", cred.generate_device_id() != device, True)

    # 签到设备派生：确定性 + 15 位数字 + 代数变化
    dev_a = cred.derive_checkin_device_id("uid-1", 0)
    dev_b = cred.derive_checkin_device_id("uid-1", 0)
    other = cred.derive_checkin_device_id("uid-2", 0)
    check("签到设备 id 是 15 位数字", (len(dev_a), dev_a.isdigit()), (15, True))
    check("同一账号稳定", dev_a, dev_b)
    check("不同账号不同", dev_a != other, True)
    check("轮换代次改变设备桶", dev_a != cred.derive_checkin_device_id("uid-1", 1), True)
    check("轮换后仍是 15 位数字", cred.derive_checkin_device_id("uid-1", 3).isdigit(), True)

    market = cred.derive_market_user_id("uid-1")
    check("market uuid version 4", market[14], "4")
    check("market uuid variant", market[19] in "89ab", True)
    check("session id 是 64 hex", len(cred.derive_session_id("uid-1")), 64)

    # 昵称乱码修复
    check("latin-1 乱码修复", cred.fix_nickname("ä½ å¥½"), "你好")
    check("中文原名保留", cred.fix_nickname("小明"), "小明")
    mojibake = "Óû§8847309959"
    check("乱码修不好时回退 用户+uid末4位", cred.fix_nickname(mojibake, "u123456"), "用户3456")
    check("空昵称回退", cred.fix_nickname("", "abc9999"), "用户9999")

    # 凭据往返
    c = cred.Credentials(access_token="jwt-1", uid="u1", machine_id="m" * 32, device_id="d" * 32)
    round_trip = cred.Credentials.from_dict(c.to_dict())
    check("凭据 to_dict/from_dict 往返", round_trip.access_token, "jwt-1")
    check("camelCase 兼容", cred.Credentials.from_dict({"accessToken": "x"}).access_token, "x")


# ── 2. 登录 URL 与回调 ───────────────────────────────────────────────────────


def test_login_url() -> None:
    print()
    print("=== 2. 登录 URL 与回调解析 ===")
    url = cred.build_authorize_url(
        "http://127.0.0.1:18080/authorize", "a" * 32, "b" * 32
    )
    check_true("是 consoleHost 的 /authorization",
        url.startswith("https://www.trae.cn/authorization?"))
    query = url.split("?", 1)[1]
    params = dict(
        pair.split("=", 1) for pair in query.split("&") if "=" in pair
    )
    from urllib.parse import unquote  # noqa: PLC0415

    params = {k: unquote(v) for k, v in params.items()}
    check("参数个数（逐字 18 项）", len(params), 18)
    check("auth_callback_url 拼写正确", params.get("auth_callback_url"),
        "http://127.0.0.1:18080/authorize")
    check(
        "没有写错的 callback_url / redirect_uri",
        ("callback_url" in params, "redirect_uri" in params),
        (False, False),
    )
    check("login_trace_id 取尾 16 字符", params.get("login_trace_id"), ("a" * 32 + "b" * 32)[-16:])
    check("plugin_version ≠ ide 版本", params.get("plugin_version"), "2.3.62834")
    check("x_app_version", params.get("x_app_version"), "0.1.52")
    check("client_id", params.get("client_id"), "en1oxy7wnw8j9n")
    check("redirect=0", params.get("redirect"), "0")

    # 回调：直接回传 token
    flat = {
        "refreshToken": "rt-1",
        "userInfo": json.dumps(
            {
                "UserID": "u-9",
                "ScreenName": "小明",
                "TenantID": "t-1",
                "NonPlainTextMobile": "138****8888",
            }
        ),
        "userJwt": json.dumps({"Token": "at-1", "RefreshToken": "rt-2"}),
    }
    fields = cred.parse_callback(flat)
    check("回调 access token", fields["access_token"], "at-1")
    check("回调 refresh token（query 优先）", fields["refresh_token"], "rt-1")
    check("回调 uid", fields["uid"], "u-9")
    check("回调 TenantID 落 enterprise_id", fields["enterprise_id"], "t-1")
    check("回调脱敏手机号", fields["phone"], "138****8888")

    # userJwt 回退 refreshToken
    flat2 = {"userJwt": json.dumps({"Token": "at-2", "RefreshToken": "rt-3"})}
    check("refreshToken 回退 userJwt", cred.parse_callback(flat2)["refresh_token"], "rt-3")

    # 回调服务器：真实起一个本地端口，验证「回调直接回传 token」的解析路径
    import urllib.request  # noqa: PLC0415

    srv, port = cred._start_callback_server()
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        query = urllib.parse.urlencode(
            {
                "refreshToken": "rt-live",
                "userInfo": json.dumps({"UserID": "u-live", "ScreenName": "小明"}),
                "userJwt": json.dumps({"Token": "at-live"}),
            }
        )
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/authorize?{query}", timeout=5
        ) as resp:
            check("回调页 HTTP 200", resp.status, 200)
        with srv.lock:
            flat = dict(srv.result or {})
        parsed = cred.parse_callback(flat)
        check("回调解析出 access token", parsed["access_token"], "at-live")
        check("回调解析出 uid", parsed["uid"], "u-live")
    finally:
        srv.shutdown()
        srv.server_close()

    # PKCE 变体必须明确报错
    raised = ""
    try:
        cred.parse_callback({"code": "abc", "state": "s"})
    except RuntimeError as exc:
        raised = str(exc)
    check_true("PKCE 流程明确报错", "PKCE" in raised)


# ── 3. 请求体改写 ────────────────────────────────────────────────────────────


def test_body() -> None:
    print()
    print("=== 3. 请求体：OpenAI → SOLO ===")
    req = {
        "model": "glm-5.2",
        "messages": [
            {"role": "system", "content": "你是助手"},
            {"role": "user", "content": "你好"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "bash", "arguments": '{"cmd":"ls"}'},
                    },
                    {"id": "call_2", "type": "function", "function": {"arguments": "{}"}},
                ],
            },
            {"role": "tool", "tool_call_id": "call_1", "content": "ok"},
        ],
        "max_tokens": 131072,
        "temperature": 0.5,
        "reasoning_effort": "high",
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
    body = upstream.build_chat_body(req, "glm-5.2")

    check("stream 恒 true", body["stream"], True)
    check("function 缺省通道", body["function"], "solo_work_lite")
    check("model = config_name", body["model"], "glm-5.2")
    check("config_name 同值", body["config_name"], "glm-5.2")
    check("不存在 query 字段", "query" in body, False)
    check(
        "content 字符串 → 块数组",
        body["messages"][0]["content"],
        [{"type": "text", "text": "你是助手"}],
    )
    check(
        "tool_calls → function_call",
        body["messages"][2].get("function_call"),
        {"name": "bash", "arguments": '{"cmd":"ls"}'},
    )
    check(
        "无 name 的调用被剔除（只剩一个 function_call）",
        "tool_calls" in body["messages"][2],
        False,
    )
    check(
        "tools[].function.parameters 是 JSON 字符串",
        isinstance(body["tools"][0]["function"]["parameters"], str),
        True,
    )
    check(
        "parameters 可回解",
        json.loads(body["tools"][0]["function"]["parameters"])["type"],
        "object",
    )
    check("max_tokens 收敛到 64000", body["max_tokens"], 64000)
    check("reasoning_effort 透传", body.get("reasoning_effort"), "high")
    check("temperature 保留", body.get("temperature"), 0.5)

    # __max 后缀去掉
    check("__max 后缀去掉", upstream.build_chat_body({"model": "glm-5.2"}, "glm-5.2__max")["model"],
        "glm-5.2")

    # tool_choice 归一化
    none_body = upstream.build_chat_body(
        {"model": "x", "messages": [], "tools": req["tools"], "tool_choice": "none"}, "x"
    )
    check("tool_choice=none → 删 tools", ("tool_choice" in none_body, "tools" in none_body), (False,
        False))
    auto_body = upstream.build_chat_body({"model": "x", "messages": [], "tool_choice": "auto"}, "x")
    check("tool_choice=auto 字符串", auto_body["tool_choice"], "auto")
    fn_choice = {"type": "function", "function": {"name": "bash"}}
    fn_body = upstream.build_chat_body(
        {"model": "x", "messages": [], "tool_choice": fn_choice}, "x"
    )
    check("tool_choice 函数名归一化", fn_body["tool_choice"], "bash")

    # Max 模式成套下发
    max_body = upstream.build_chat_body(
        {"model": "glm-5.2", "messages": []},
        "glm-5.2",
        entry={
            "function": "solo_agent",
            "max_mode": True,
            "max_context": 1_000_000,
            "max_max_tokens": 200_000,
        },
    )
    check("Max 模式通道", max_body["function"], "solo_agent")
    check("Max 模式成套：strategy", max_body["model_auto_selection"], {"strategy": "max"})
    check("Max 模式成套：mode_type", max_body["mode_type"], 1)
    check("Max 模式成套：prompt_max_tokens", body.get("prompt_max_tokens"), None)
    check("Max 模式 prompt 预算", max_body["prompt_max_tokens"], 936000)
    check("Max 模式 max_tokens 用 __max 明细", max_body["max_tokens"], 200_000)

    # 空 tools 不应出现空数组
    empty_tools = upstream.build_chat_body({"model": "x", "messages": [], "tools": []}, "x")
    check("空 tools 被剔除", "tools" in empty_tools, False)


# ── 4. 请求头 ────────────────────────────────────────────────────────────────


def test_headers() -> None:
    print()
    print("=== 4. 请求头 ===")
    c = cred.Credentials(
        access_token="tok-1", uid="u-1", machine_id="m" * 32, device_id="d" * 32
    )
    headers = upstream.build_headers(c)
    check("Authorization Cloud-IDE-JWT", headers["Authorization"], "Cloud-IDE-JWT tok-1")
    check("X-Cloudide-Token 同 token", headers["X-Cloudide-Token"], "tok-1")
    check("X-Ide-Token 同 token", headers["X-Ide-Token"], "tok-1")
    check("UA", headers["User-Agent"], "Trae/0.1.52")
    check("X-Ide-Version（模型准入）", headers["X-Ide-Version"], "0.1.52")
    check("X-App-Version-Code（模型准入）", headers["X-App-Version-Code"], "20260811")
    check("X-Machine-Id", headers["X-Machine-Id"], "m" * 32)
    check("X-Device-Id", headers["X-Device-Id"], "d" * 32)
    check("X-Uid", headers["X-Uid"], "u-1")
    check("Accept 默认 SSE", headers["Accept"], "text/event-stream")

    # 环境变量覆盖模型文件路径不应影响这里
    checkin_headers = billing.build_checkin_headers(c)
    check_true("签到头含 15 位数字设备 id", checkin_headers["X-Device-Id"].isdigit())
    check(
        "签到头 Authorization 同款",
        billing.build_checkin_headers(c)["Authorization"],
        "Cloud-IDE-JWT tok-1",
    )


# ── 5. 流翻译 ────────────────────────────────────────────────────────────────


def _trae_wire() -> bytes:
    """构造一段 TRAE event 流（思考、正文、工具调用、usage、done）。"""
    events = [
        ("output", {"response": None, "reasoning_content": "让我想想", "tool_calls": None}),
        ("output", {"response": "答案", "reasoning_content": None, "tool_calls": None}),
        ("output", {"response": "是 42", "reasoning_content": None, "tool_calls": None}),
        (
            "output",
            {
                "response": "",
                "reasoning_content": None,
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "call_9",
                        "function_call": {
                            "name": "bash",
                            "arguments": '{"cmd":',
                            "namespace": "solo",
                            "partial_arguments": '{"cmd":',
                        },
                    }
                ],
            },
        ),
        ("token_usage", {"prompt_tokens": 100, "completion_tokens": 25, "reasoning_tokens": 7}),
        ("done", {"finish_reason": "stop"}),
    ]
    return "".join(
        f"event:{name}\ndata:{json.dumps(payload, ensure_ascii=False)}\n\n"
        for name, payload in events
    ).encode()


def _collect(frames: list[bytes]) -> tuple[str, str, list[str], dict | None, list[dict]]:
    content: list[str] = []
    reasoning: list[str] = []
    finishes: list[str] = []
    usage: dict | None = None
    tool_calls: list[dict] = []
    for frame in frames:
        for line in frame.decode(errors="replace").splitlines():
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                continue
            chunk = json.loads(payload)
            if chunk.get("usage"):
                usage = chunk["usage"]
            for choice in chunk.get("choices") or []:
                delta = choice.get("delta") or {}
                if delta.get("content"):
                    content.append(delta["content"])
                if delta.get("reasoning_content"):
                    reasoning.append(delta["reasoning_content"])
                if choice.get("finish_reason"):
                    finishes.append(choice["finish_reason"])
                for call in delta.get("tool_calls") or []:
                    tool_calls.append(call)
    return "".join(content), "".join(reasoning), finishes, usage, tool_calls


def test_translator() -> None:
    print()
    print("=== 5. event 流 → OpenAI delta（增量翻译器）===")
    wire = _trae_wire()

    tr = upstream.new_translator()
    frames = tr.feed(wire) + tr.finish()
    text, reasoning, finishes, usage, calls = _collect(frames)
    check("正文拼接（增量直通）", text, "答案是 42")
    check("思考归 reasoning_content", reasoning, "让我想想")
    check("finish_reason（done 事件）", finishes, ["stop"])
    check(
        "usage 归一化",
        usage,
        {
            "prompt_tokens": 100,
            "completion_tokens": 25,
            "total_tokens": 125,
            "completion_tokens_details": {"reasoning_tokens": 7},
        },
    )
    check("有 [DONE]", b"data: [DONE]" in b"".join(frames), True)
    check("工具调用 function_call → function", calls[0]["function"]["name"], "bash")
    check("清理 namespace", "namespace" in calls[0]["function"], False)
    check("清理 partial_arguments", "partial_arguments" in calls[0]["function"], False)
    check("工具参数透传", calls[0]["function"]["arguments"], '{"cmd":')

    # ② 逐字节喂（模拟 TCP 任意切分）——切帧 bug 的高发区
    tr2 = upstream.new_translator()
    frames2: list[bytes] = []
    for i in range(len(wire)):
        frames2.extend(tr2.feed(wire[i : i + 1]))
    frames2.extend(tr2.finish())
    text2, reasoning2, finishes2, usage2, calls2 = _collect(frames2)
    check("逐字节喂 正文一致", text2, "答案是 42")
    check("逐字节喂 思考一致", reasoning2, "让我想想")
    check("逐字节喂 finish 一致", finishes2, ["stop"])
    check("逐字节喂 usage 一致", usage2, usage)
    check("逐字节喂 工具一致", calls2[0]["function"]["arguments"], '{"cmd":')

    # ③ 不规则切分
    tr3 = upstream.new_translator()
    frames3: list[bytes] = []
    for size in (7, 1, 33, 100, 2, 512, 5, 1000):
        pos = 0
        while pos < len(wire):
            frames3.extend(tr3.feed(wire[pos : pos + size]))
            pos += size
        break
    frames3.extend(tr3.finish())
    text3, _, _, _, _ = _collect(frames3)
    check("不规则切分 正文一致", text3, "答案是 42")

    # ④ 多字节字符被切成两半也要正确（逐字节喂已经覆盖，这里再单点验证）
    chinese_frame = (
        'event:output\ndata:{"response":"中文流式"}\n\n'.encode()
    )
    tr4 = upstream.new_translator()
    frames4: list[bytes] = []
    for i in range(len(chinese_frame)):
        frames4.extend(tr4.feed(chinese_frame[i : i + 1]))
    frames4.extend(tr4.finish())
    text4, _, _, _, _ = _collect(frames4)
    check("UTF-8 逐字节喂不产生替换字符", "\ufffd" in text4, False)
    check("UTF-8 逐字节喂正文正确", text4, "中文流式")

    # ⑤ error 事件必须显式报错
    err_wire = 'event:error\ndata:{"code":1005,"message":"Plan 权益不足"}\n\n'.encode()
    tr5 = upstream.new_translator()
    frames5 = tr5.feed(err_wire) + tr5.finish()
    blob5 = b"".join(frames5).decode(errors="replace")
    check_true("error 产出 error 帧", '"error"' in blob5)
    check_true("error 含原因", "Plan 权益不足" in blob5)
    check_true("error 含 code", "1005" in blob5)
    check("error 后仍以 [DONE] 收尾", blob5.rstrip().endswith("data: [DONE]"), True)

    # ⑥ 中途断流（没有 done 事件）也要给结束帧
    tr6 = upstream.new_translator()
    half = 'event:output\ndata:{"response":"半截"}\n\n'.encode()
    frames6 = tr6.feed(half) + tr6.finish()
    text6, _, finishes6, _, _ = _collect(frames6)
    check("断流也有正文", text6, "半截")
    check("断流也补 finish_reason", finishes6, ["stop"])

    # ⑦ 注释行与未知事件忽略
    tr7 = upstream.new_translator()
    noise = b": keep-alive\n\nevent:metadata\ndata:{\"a\":1}\n\nevent:timing_cost\ndata:{}\n\n"
    check("噪声事件无产出", tr7.feed(noise), [])


# ── 6. 模型目录 ──────────────────────────────────────────────────────────────


def _remote_env() -> dict:
    def cfg(config_name, **kw):
        base = {
            "config_name": config_name,
            "usage": "chat_completion",
            "config_switch": True,
            "is_invisible_to_user": False,
            "display_config": {"display_name": f"{config_name} 展示名", "is_custom_model": False},
            "context_window_tokens": {"dev": 100000, "max": 200000},
        }
        base.update(kw)
        return base

    return {
        "function_configs": [
            # 白名单内、靠前者：给 glm-5.2 一个"空档位"版本
            {"function": "solo_agent", "config_info_list": [cfg("glm-5.2")]},
            # 白名单内、靠后者：同一模型带档位 + Max 模式 → 应覆盖空档位
            {
                "function": "solo_work_lite",
                "config_info_list": [
                    cfg(
                        "glm-5.2",
                        model_detail_list=[
                            {"model_name": "glm-5.2__dev", "max_tokens": 32000},
                            {"model_name": "glm-5.2__max", "max_tokens": 200000},
                        ],
                        display_config={
                            "display_name": "GLM-5.2",
                            "is_custom_model": False,
                            "max_mode": True,
                        },
                        reasoning_effort_config={
                            "default_level": "max",  # 不在 options 里
                            "options": ["low", "high"],
                            "support_thinking": True,
                        },
                        display_contact_config=json.dumps(
                            {"consumption_rate": 0.08, "activity_discount": 0.8}
                        ),
                    ),
                    cfg(
                        "kimi-k3",
                        display_config={"display_name": "Kimi K3", "is_custom_model": False},
                        display_contact_config='{"consumption_rate": 0}',
                    ),
                    # 硬过滤：自定义模型 / 隐藏 / 关闭 / 非 chat_completion
                    cfg("custom-x", display_config={"is_custom_model": True, "display_name": "X"}),
                    cfg("invisible-x", is_invisible_to_user=True),
                    cfg("off-x", config_switch=False),
                    cfg("nonchat-x", usage="other"),
                ],
            },
            # 不在白名单：整组丢弃（chat / builder / inline_chat 稳定被拒）
            {
                "function": "chat",
                "config_info_list": [cfg("glm-5.2"), cfg("only-in-chat")],
            },
            {
                "function": "builder",
                "config_info_list": [cfg("only-in-builder")],
            },
            {
                "function": "inline_chat",
                "config_info_list": [cfg("only-in-inline")],
            },
            {
                "function": "solo_agent",
                "config_info_list": [cfg("solo-agent-only")],
            },
        ]
    }


def test_catalog() -> None:
    print()
    print("=== 6. 模型目录（白名单 + 硬过滤 + 合并）===")
    entries = catalog.parse_remote_catalog(_remote_env())
    by_id = {e["id"]: e for e in entries}
    ids = list(by_id)

    check_true("白名单外的整组丢弃：chat 独有模型", "only-in-chat" not in ids)
    check_true("builder 独有模型丢弃", "only-in-builder" not in ids)
    check_true("inline_chat 独有模型丢弃", "only-in-inline" not in ids)
    check("白名单内独有模型保留", "solo-agent-only" in ids, True)
    check("硬过滤：自定义模型", "custom-x" in ids, False)
    check("硬过滤：官方隐藏", "invisible-x" in ids, False)
    check("硬过滤：config_switch=false", "off-x" in ids, False)
    check("硬过滤：usage ≠ chat_completion", "nonchat-x" in ids, False)

    glm = by_id["glm-5.2"]
    check("空档位被有档位覆盖（通道=solo_work_lite）", glm["function"], "solo_work_lite")
    check("档位标记为真", glm["tiered"], True)
    check("__dev 档位取 max_tokens", glm["max_output"], 32000)
    check("Max 模式取 __max 明细", glm["max_max_tokens"], 200000)
    check("Max 模式标记", glm["max_mode"], True)
    check("context_window 取 max", glm["context_window"], 200000)
    check("默认档不在 options 里 → 退到最强档", glm["default_effort"], "high")
    check("档位原序产出", glm["efforts"], ["low", "high"])
    check("展示名带倍率（活动期）", glm["name"], "GLM-5.2 · x0.80→x0.08")
    check("免费展示", by_id["kimi-k3"]["name"], "Kimi K3 · 免费")

    # 兜底表
    fallback_ids = catalog.exposed_ids()
    check_true("兜底表非空", fallback_ids)
    check(
        "隐藏条目不在兜底列表",
        ("summary" in fallback_ids, "browser_use_subagent" in fallback_ids),
        (False, False),
    )
    check("32 条兜底（含 4 隐藏）", len(catalog.FALLBACK_MODELS), 32)
    check("兜底 contextWindow=200000", catalog.FALLBACK_MODELS[0]["context_window"], 200000)
    check("resolve_model 未知原样", catalog.resolve_model("nope-1"), "nope-1")
    check("channel_for 缺省", catalog.channel_for("glm-5.2"), "solo_work_lite")

    # 白名单表本身
    check("白名单 15 条", len(catalog.DEFAULT_CHANNEL_WHITELIST), 15)
    check(
        "稳定被拒的通道不在白名单",
        [c for c in ("chat", "builder", "inline_chat") if c in catalog.DEFAULT_CHANNEL_WHITELIST],
        [],
    )


# ── 7. 错误分类 ──────────────────────────────────────────────────────────────


def test_errors() -> None:
    print()
    print("=== 7. 错误分类顺序 ===")
    check("1005 → hard-plan", upstream.classify_error(200, '{"code":1005,"message":"plan"}'),
        "hard-plan")
    check("4008 → quota-exceeded", upstream.classify_error(200, '{"code":4008}'), "quota-exceeded")
    check("4011 → soft-rate", upstream.classify_error(200, '{"code":4011}'), "soft-rate")
    check(
        "4008 必须先于 4011（报文里两个码都有时）",
        upstream.classify_error(200, '{"code":4008,"retry":4011}'),
        "quota-exceeded",
    )
    check("401 → session-dead", upstream.classify_error(401, ""), "session-dead")
    check("body 含 unauthorized → session-dead", upstream.classify_error(500, "Unauthorized"),
        "session-dead")
    check("429 → soft-rate", upstream.classify_error(429, "too many"), "soft-rate")
    check("404 → not-found", upstream.classify_error(404, ""), "not-found")
    check("500 → server", upstream.classify_error(500, "boom"), "server")
    check("400 → client", upstream.classify_error(400, "bad"), "client")
    check("200 → none", upstream.classify_error(200, "{}"), "none")
    check("plan 冷却 12h", upstream.cooldown_seconds("hard-plan"), 43200)
    check("session-dead 永久", upstream.cooldown_seconds("session-dead"), None)


# ── 8. 端到端网关 ────────────────────────────────────────────────────────────


async def test_gateway() -> None:
    print()
    print("=== 8. 端到端：假上游 + 真实网关（custom 线型）===")
    from aiohttp import web

    from trae_bridge import gateway

    received: dict[str, object] = {}

    async def fake_chat(request: web.Request) -> web.StreamResponse:
        received["headers"] = dict(request.headers)
        received["body"] = await request.json()
        resp = web.StreamResponse()
        resp.content_type = "text/event-stream"
        await resp.prepare(request)
        events = [
            ("output", {"response": "网关", "reasoning_content": None}),
            ("output", {"response": "通了", "reasoning_content": None}),
            ("token_usage", {"prompt_tokens": 7, "completion_tokens": 2}),
            ("done", {"finish_reason": "stop"}),
        ]
        for name, payload in events:
            await resp.write(
                f"event:{name}\ndata:{json.dumps(payload, ensure_ascii=False)}\n\n".encode()
            )
        await resp.write_eof()
        return resp

    async def fake_models(request: web.Request) -> web.Response:
        received["models_body"] = await request.json()
        return web.json_response(_remote_env())

    app = web.Application()
    app.router.add_post(upstream.CHAT_PATH, fake_chat)
    app.router.add_post(upstream.MODELS_PATH, fake_models)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    base = f"http://127.0.0.1:{port}"

    # 把上游指向假服务（模块全局在调用时读取）
    upstream.AGENT_HOST = base
    catalog.reset_remote_cache()

    # 共享 auth_flow 的调用形态是 (Config, token, uid)：必须同样可用
    cfg = upstream.default_config()
    cfg.base_url = base
    legacy = await asyncio.to_thread(upstream.fetch_models, cfg, "tok-e2e", "u-e2e")
    check_true(
        "auth_flow 形态 fetch_models 可用",
        isinstance(legacy, dict) and "function_configs" in legacy,
    )

    # 写一份假凭据（domain 与 base 同 host，避免 _cfg_for 把 host 改回真实域名）
    netloc = f"127.0.0.1:{port}"
    cred.save(
        cred.Credentials(
            access_token="tok-e2e",
            refresh_token="rt-e2e",
            uid="u-e2e",
            machine_id="a" * 32,
            device_id="b" * 32,
            domain=netloc,
        )
    )

    # 目录的远端刷新是**同步**入口（渲染路径只读缓存，见 catalog.remote_models 注释）；
    # 测试里必须丢到线程 —— 否则会阻塞本事件循环，假上游也就无法应答（这正是
    # 「渲染路径不做同步网络请求」的理由）。
    catalog.reset_remote_cache()
    remote = await asyncio.to_thread(catalog.remote_models, wait=True)
    check_true("远端目录已刷新", remote)
    check("远端目录只含白名单通道模型", sorted(e["id"] for e in remote), ["glm-5.2", "kimi-k3",
        "solo-agent-only"])
    check("远端目录函数归属", catalog.channel_for("glm-5.2"), "solo_work_lite")

    import socket

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
            check("模型列表来自远端且已过滤", ids, ["solo-agent-only", "glm-5.2", "kimi-k3"])
            check_true("列表不含被拒通道独有模型", "only-in-chat" not in ids)
            check_true("列表含白名单模型", "glm-5.2" in ids)

            async with session.get(f"http://127.0.0.1:{gw_port}/health") as resp:
                health = await resp.json()
            check("health ok", health.get("ok"), True)
            check("health 标注已登录", health.get("logged_in"), True)

            text = ""
            finishes: list[str] = []
            async with session.post(
                f"http://127.0.0.1:{gw_port}/v1/chat/completions",
                json={
                    "model": "glm-5.2",
                    "messages": [{"role": "user", "content": "hi"}],
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
                            payload_text = line[5:].strip()
                            if payload_text == "[DONE]":
                                continue
                            chunk = json.loads(payload_text)
                            for choice in chunk.get("choices") or []:
                                delta = choice.get("delta") or {}
                                if delta.get("content"):
                                    text += delta["content"]
                                if choice.get("finish_reason"):
                                    finishes.append(choice["finish_reason"])
            check("流式正文", text, "网关通了")
            check("流式 finish", finishes, ["stop"])

            sent = received.get("body") or {}
            check("上游收到 function", sent.get("function"), "solo_work_lite")
            check(
                "上游收到双字段",
                (sent.get("model"), sent.get("config_name")),
                ("glm-5.2", "glm-5.2"),
            )
            check("上游收到块数组 content", sent["messages"][0]["content"][0]["type"], "text")
            headers = received.get("headers") or {}
            check("上游收到三处 token#1", headers.get("Authorization"), "Cloud-IDE-JWT tok-e2e")
            check("上游收到三处 token#2", headers.get("X-Cloudide-Token"), "tok-e2e")
            check("上游收到三处 token#3", headers.get("X-Ide-Token"), "tok-e2e")
            check("上游收到设备头", headers.get("X-Device-Id"), "b" * 32)
            models_body = received.get("models_body") or {}
            check("目录请求带 22 个通道", len(models_body.get("functions") or []), 22)

            async with session.post(
                f"http://127.0.0.1:{gw_port}/v1/chat/completions",
                json={"model": "glm-5.2", "messages": [{"role": "user", "content": "hi"}]},
            ) as resp:
                agg = await resp.json()
            check("非流式 HTTP 200", resp.status, 200)
            check("非流式聚合出正文", agg["choices"][0]["message"]["content"], "网关通了")
            check("非流式 object", agg.get("object"), "chat.completion")
            check("非流式带 usage", agg["usage"]["prompt_tokens"], 7)
    finally:
        stop_event.set()
        await task
        await runner.cleanup()


def test_billing(fake: FakeUpstream) -> None:
    print()
    print("=== 7.5 额度与签到（claim body 是 {}）===")
    billing.UG_HOST = fake.base
    c = cred.Credentials(
        access_token="tok-b", refresh_token="rt-b", uid="u-b", checkin_generation=0
    )
    cred.save(c)

    state = {"checked": False}

    def status_route(_r: dict[str, Any]) -> tuple[int, Any]:
        return (
            200,
            {
                "code": 0,
                "checked_in": state["checked"],
                "enable": True,
                "credits": 150,
                "streak_days": 3,
            },
        )

    def claim_route(_r: dict[str, Any]) -> tuple[int, Any]:
        state["checked"] = True
        return 200, {"code": 0, "message": "success"}  # ⚠ 成功响应**不含积分数**

    fake.routes[billing.CHECKIN_STATUS_PATH] = status_route
    fake.routes[billing.CHECKIN_CLAIM_PATH] = claim_route
    fake.routes[billing.USAGE_PATH] = lambda _r: (
        200,
        {
            "user_entitlement_pack_list": [
                {
                    "entitlement_base_info": {
                        "display_desc": "TRAE 免费额度",
                        "quota": {"credits_limit": 1000},
                    },
                    "usage": {"credits_amount": 250},
                    "expire_time": int(cred.time.time()) + 3 * 86400 + 120,  # 秒级
                }
            ]
        },
    )

    info = billing.fetch_credits()
    check(
        "usage body 带 require_usage",
        fake.last(billing.USAGE_PATH)["body"].get("require_usage"),
        True,
    )
    check("usage body req_source=2", fake.last(billing.USAGE_PATH)["body"].get("req_source"), 2)
    check("包名取 display_desc", info["packages"][0]["name"], "TRAE 免费额度")
    check("remaining = limit - used", info["packages"][0]["remain"], 750.0)
    check("秒级 expire_time → 天数", info["packages"][0]["days_left"], 3)
    check("total 求和", info["total"]["remain"], 750.0)
    check("可领签到", [x["campaign_id"] for x in info["claimable"]], ["trae-daily-checkin"])
    check(
        "签到头 Authorization",
        fake.last(billing.USAGE_PATH)["headers"].get("Authorization"),
        "Cloud-IDE-JWT tok-b",
    )
    check_true(
        "签到头设备 id 是 15 位数字",
        fake.last(billing.USAGE_PATH)["headers"].get("X-Device-Id", "").isdigit(),
    )

    status_before = fake.count(billing.CHECKIN_STATUS_PATH)
    result = billing.claim_daily(c)
    check("claim body 是空对象", fake.last(billing.CHECKIN_CLAIM_PATH)["body"], {})
    check("claim 后补查 status 拿到积分", result["credits"], 150.0)
    check(
        "claim 前后各查一次 status（不能只看 claim 响应）",
        fake.count(billing.CHECKIN_STATUS_PATH) - status_before,
        2,
    )
    check("不是首次签到", result["already"], False)

    # 9074（设备级限流）→ 轮换签到设备代次
    cred.save(cred.Credentials(access_token="tok-b", uid="u-b", checkin_generation=0))
    fake.routes[billing.CHECKIN_STATUS_PATH] = lambda _r: (
        200,
        {"code": 0, "checked_in": False, "enable": True},
    )
    too_many = {"code": 9074, "message": "too many"}
    fake.routes[billing.CHECKIN_CLAIM_PATH] = lambda _r: (200, too_many)
    raised = ""
    try:
        billing.claim_daily()
    except billing.CreditsError as exc:
        raised = str(exc)
    check_true("9074 报设备级限流", "9074" in raised)
    check("9074 后轮换代次", cred.load().checkin_generation, 1)


def test_refresh(fake: FakeUpstream) -> None:
    print()
    print("=== 7.6 续期：access 与 refresh 都轮换并回写 ===")
    cred.OAUTH_HOST = fake.base
    c = cred.Credentials(
        access_token="at-old",
        refresh_token="rt-old",
        uid="u-r",
        machine_id="m" * 32,
        device_id="d" * 32,
        domain="trae-api-cn.mchost.guru",
    )
    cred.save(c)
    fake.routes[cred.EXCHANGE_PATH] = lambda _r: (
        200,
        {
            "Result": {
                "Token": "at-new",
                "RefreshToken": "rt-new",
                "TokenExpireAt": "1900000000000",
            }
        },
    )
    updated = cred.refresh(cred.load())
    sent = fake.last(cred.EXCHANGE_PATH)["body"]
    check("ExchangeToken 带 ClientID", sent["ClientID"], "en1oxy7wnw8j9n")
    check("ExchangeToken 带 refreshToken", sent["RefreshToken"], "rt-old")
    check("access 轮换", updated.access_token, "at-new")
    check("refresh 轮换", updated.refresh_token, "rt-new")
    check("过期时间回写", updated.expires_at, "1900000000000")
    check("设备指纹不动", (updated.machine_id, updated.device_id), ("m" * 32, "d" * 32))
    check("已回写磁盘", cred.load().access_token, "at-new")

    # 2xx 是 JSON 却没有 accessToken ⇒ 终态
    fake.routes[cred.EXCHANGE_PATH] = lambda _r: (200, {"Result": {"RefreshToken": "rt-x"}})
    raised = ""
    try:
        cred.refresh(cred.load())
    except RuntimeError as exc:
        raised = str(exc)
    check_true("缺 accessToken 判终态", "重新登录" in raised)

    # HTML 错误页也必须判终态（凭据失效时上游回 HTML）
    fake.routes[cred.EXCHANGE_PATH] = lambda _r: (200, (b"<html>login</html>", "text/html"))
    raised = ""
    try:
        cred.refresh(cred.load())
    except RuntimeError as exc:
        raised = str(exc)
    check_true("HTML 错误页判终态", "不是 JSON" in raised)


async def main() -> int:
    fake = FakeUpstream()
    try:
        test_cred()
        test_login_url()
        test_body()
        test_headers()
        test_translator()
        test_catalog()
        test_errors()
        test_billing(fake)
        test_refresh(fake)
        await test_gateway()
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
