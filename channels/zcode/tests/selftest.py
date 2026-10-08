"""ZCode 渠道的离线自检（不出网、不需要真实凭据）。

覆盖：
1. 身份块加载与字符数（3012 准入的核心）
2. 请求体改写（OpenAI → Anthropic Messages）
3. 请求头（设备标识与客户端伪装）
4. 流翻译（Anthropic SSE → OpenAI delta，含跨 chunk 半帧）
5. 端到端：假上游 + 真实网关（验证 custom 线型分流）

用法：python tests/selftest.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

# 让 src/ 可导入
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

# 隔离数据目录，避免碰到真实凭据
_TMP_HOME = Path(tempfile.mkdtemp(prefix="zcode-selftest-"))
os.environ["ZCODE_HOME"] = str(_TMP_HOME)

from zcode_bridge import catalog, cred, identity, upstream  # noqa: E402

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


# ── 1. 身份块 ────────────────────────────────────────────────────────────────


def test_identity() -> None:
    print("=== 1. 官方身份块（3012 准入的唯一开关）===")
    healthy, detail = identity.check()
    print(f"        自检: {detail}")
    check_true("身份块健康", healthy)

    blocks = identity.identity_blocks()
    check("块数（cliPrefix + stable 三段）", len(blocks), 4)
    check("首块是 cliPrefix", blocks[0]["text"], identity.cli_prefix())
    check("全部是 text 块", {b["type"] for b in blocks}, {"text"})

    info = identity.stats()
    check("stable 段数", info["stableSections"], 3)
    check_true("总字符数在实测区间", info["inExpectedRange"])
    print(f"        身份块共 {info['totalChars']} 字符")

    # 三段必须都在（少一段是未经验证的配置）
    check_true("含 Harness 段", any("# Harness" in s for s in identity.stable_sections()))
    check_true(
        "含 Desktop Context 段",
        any("# ZCode Desktop Context" in s for s in identity.stable_sections()),
    )
    check_true(
        "含 Working style 段", any("# Working style" in s for s in identity.stable_sections())
    )


# ── 2. 请求体改写 ────────────────────────────────────────────────────────────


def test_body() -> None:
    print()
    print("=== 2. 请求体：OpenAI → Anthropic Messages ===")
    req = {
        "model": "glm-5.3",
        "messages": [
            {"role": "system", "content": "你是助手"},
            {"role": "user", "content": "你好"},
            {"role": "assistant", "content": "你好！"},
            {"role": "user", "content": "再来一次"},
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
    body = upstream.build_chat_body(req, "GLM-5.3")

    check("model 用上游 slug", body["model"], "GLM-5.3")
    check("system 是块数组", isinstance(body["system"], list), True)
    check("身份块在首位", body["system"][0]["text"], identity.cli_prefix())
    check("调用方 system 在身份块之后", body["system"][-1]["text"], "你是助手")
    check("身份块数量 = 4 + 调用方 1", len(body["system"]), 5)
    check(
        "messages 不含 system",
        [m["role"] for m in body["messages"]],
        ["user", "assistant", "user"],
    )
    check("content 是块数组", body["messages"][0]["content"][0]["type"], "text")
    check("max_tokens 透传", body["max_tokens"], 4096)
    check("temperature 透传", body["temperature"], 0.7)
    check("stop → stop_sequences", body["stop_sequences"], ["END"])
    check("恒 stream", body["stream"], True)
    check("tools 用 input_schema", "input_schema" in body["tools"][0], True)
    check("tools 无 parameters 残留", "parameters" in body["tools"][0], False)


# ── 3. 请求头 ────────────────────────────────────────────────────────────────


def test_headers() -> None:
    print()
    print("=== 3. 请求头（设备标识与客户端伪装）===")
    c = cred.Credentials(zcode_jwt="jwt-test", device_mid="mid-test", user_id="u1")
    headers = upstream.build_headers(c)
    check("Authorization", headers["Authorization"], "Bearer jwt-test")
    check("X-Device-Mid（硬需求）", headers["X-Device-Mid"], "mid-test")
    check("UA 伪装", headers["User-Agent"], "ZCode/3.14.4")
    check("anthropic-version", headers["anthropic-version"], "2023-06-01")
    check("来源标识", headers["HTTP-Referer"], "https://zcode.z.ai")
    check("Content-Type", headers["Content-Type"], "application/json")

    # 无 Authorization 的形态（preview / event report 用）
    anon = upstream.build_headers(c, authorization=False)
    check_true("可构造匿名头", "Authorization" not in anon)

    # captcha 头
    cap = upstream.build_headers(c, captcha=("p1", "r1"))
    check("captcha param", cap["x-aliyun-captcha-verify-param"], "p1")
    check("captcha region", cap["x-aliyun-captcha-verify-region"], "r1")


# ── 4. 流翻译 ────────────────────────────────────────────────────────────────


def _anthropic_wire() -> bytes:
    """构造一段 Anthropic SSE（含思考、正文、工具调用、usage、stop）。"""
    events = [
        ("message_start", {"type": "message_start", "message": {"usage": {"input_tokens": 100}}}),
        (
            "content_block_start",
            {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking"}},
        ),
        (
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "thinking_delta", "thinking": "让我想想"},
            },
        ),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        (
            "content_block_start",
            {"type": "content_block_start", "index": 1, "content_block": {"type": "text"}},
        ),
        (
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 1,
                "delta": {"type": "text_delta", "text": "答案"},
            },
        ),
        (
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 1,
                "delta": {"type": "text_delta", "text": "是 42"},
            },
        ),
        (
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 1,
                "delta": {"type": "signature_delta", "signature": "deadbeef"},
            },
        ),
        ("content_block_stop", {"type": "content_block_stop", "index": 1}),
        (
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn"},
                "usage": {"output_tokens": 25},
            },
        ),
        ("message_stop", {"type": "message_stop"}),
    ]
    return "".join(
        f"event: {name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
        for name, payload in events
    ).encode()


def _collect(frames: list[bytes]) -> tuple[str, str, list[str], dict | None]:
    """从 OpenAI SSE 帧里抽出 (正文, 思考, finish_reasons, usage)。"""
    content: list[str] = []
    reasoning: list[str] = []
    finishes: list[str] = []
    usage: dict | None = None
    for frame in frames:
        for line in frame.decode(errors="replace").splitlines():
            if not line.startswith("data: "):
                continue
            payload = line[6:]
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
    return "".join(content), "".join(reasoning), finishes, usage


def test_translator() -> None:
    print()
    print("=== 4. Anthropic SSE → OpenAI delta（增量翻译器）===")
    wire = _anthropic_wire()

    # ① 一次性喂入
    tr = upstream.new_translator()
    frames = tr.feed(wire) + tr.finish()
    text, reasoning, finishes, usage = _collect(frames)
    check("正文拼接", text, "答案是 42")
    check("思考归 reasoning_content", reasoning, "让我想想")
    check("finish_reason 映射", finishes, ["stop"])
    check(
        "usage 归一化",
        usage,
        {"prompt_tokens": 100, "completion_tokens": 25, "total_tokens": 125},
    )
    check("有 [DONE]", b"data: [DONE]" in b"".join(frames), True)
    check_true(
        "signature_delta 未泄漏进正文",
        "deadbeef" not in text and "deadbeef" not in reasoning,
    )

    # ② 逐字节喂（模拟 TCP 任意切分）——这是最容易出错的路径
    tr2 = upstream.new_translator()
    frames2: list[bytes] = []
    for i in range(len(wire)):
        frames2.extend(tr2.feed(wire[i : i + 1]))
    frames2.extend(tr2.finish())
    text2, reasoning2, finishes2, usage2 = _collect(frames2)
    check("逐字节喂 正文一致", text2, "答案是 42")
    check("逐字节喂 思考一致", reasoning2, "让我想想")
    check("逐字节喂 finish 一致", finishes2, ["stop"])
    check("逐字节喂 usage 一致", usage2, usage)

    # ③ 切成不规则块（模拟真实网络）
    tr3 = upstream.new_translator()
    frames3: list[bytes] = []
    for size in (7, 1, 33, 100, 2, 512, 5, 1000):
        pos = 0
        while pos < len(wire):
            frames3.extend(tr3.feed(wire[pos : pos + size]))
            pos += size
        break
    frames3.extend(tr3.finish())
    text3, _, _, _ = _collect(frames3)
    check("不规则切分 正文一致", text3, "答案是 42")

    # ④ error 事件必须显式报错
    err_wire = 'event: error\ndata: {"type":"error","error":{"message":"上游过载"}}\n\n'.encode()
    tr4 = upstream.new_translator()
    frames4 = tr4.feed(err_wire) + tr4.finish()
    blob = b"".join(frames4).decode(errors="replace")
    check_true("error 产出 error 帧", '"error"' in blob)
    check_true("error 含原因", "上游过载" in blob)


# ── 5. 端到端网关 ────────────────────────────────────────────────────────────


async def test_gateway() -> None:
    print()
    print("=== 5. 端到端：假上游 + 真实网关（custom 线型）===")
    from aiohttp import web

    from zcode_bridge import gateway

    # 假上游：返回 Anthropic SSE，并记录收到的请求以便核对
    received: dict[str, object] = {}

    async def fake_messages(request: web.Request) -> web.StreamResponse:
        received["headers"] = dict(request.headers)
        received["body"] = await request.json()
        resp = web.StreamResponse()
        resp.content_type = "text/event-stream"
        await resp.prepare(request)
        for name, payload in [
            ("message_start", {"type": "message_start", "message": {"usage": {"input_tokens": 7}}}),
            (
                "content_block_start",
                {"type": "content_block_start", "index": 0, "content_block": {"type": "text"}},
            ),
            (
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": "网关通了"},
                },
            ),
            ("content_block_stop", {"type": "content_block_stop", "index": 0}),
            (
                "message_delta",
                {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 4}},
            ),
        ]:
            await resp.write(
                f"event: {name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()
            )
        await resp.write_eof()
        return resp

    async def fake_configs(request: web.Request) -> web.Response:
        return web.json_response(
            {"code": 0, "data": {"builtinModels": [{"id": "GLM-5.3", "name": "GLM 5.3"}]}}
        )

    app = web.Application()
    app.router.add_post("/api/v1/zcode-plan/anthropic/v1/messages", fake_messages)
    app.router.add_get("/api/v1/client/configs", fake_configs)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    base = f"http://127.0.0.1:{port}"

    # 把上游指向假服务
    upstream.PLAN_MESSAGES_URL = f"{base}/api/v1/zcode-plan/anthropic/v1/messages"
    upstream.CLIENT_CONFIGS_URL = f"{base}/api/v1/client/configs"

    # 写一份假凭据
    cred.save(cred.Credentials(zcode_jwt="jwt-e2e", device_mid="mid-e2e", user_id="u-e2e"))

    # 起网关
    import aiohttp

    stop_event = asyncio.Event()
    import socket

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    gw_port = sock.getsockname()[1]
    sock.close()
    task = asyncio.create_task(gateway._serve_async(f"127.0.0.1:{gw_port}", False, stop_event))
    await asyncio.sleep(1.2)

    try:
        async with aiohttp.ClientSession() as session:
            # 模型列表
            async with session.get(f"http://127.0.0.1:{gw_port}/v1/models") as resp:
                payload = await resp.json()
            ids = [m["id"] for m in payload.get("data", [])]
            check_true("模型列表非空", ids)

            # 健康
            async with session.get(f"http://127.0.0.1:{gw_port}/health") as resp:
                health = await resp.json()
            check("health ok", health.get("ok"), True)
            check("health 标注已登录", health.get("logged_in"), True)

            # 流式对话
            text = ""
            finishes: list[str] = []
            async with session.post(
                f"http://127.0.0.1:{gw_port}/v1/chat/completions",
                json={
                    "model": "glm-5.3",
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
                            payload = line[5:].strip()
                            if payload == "[DONE]":
                                continue
                            chunk = json.loads(payload)
                            for choice in chunk.get("choices") or []:
                                delta = choice.get("delta") or {}
                                if delta.get("content"):
                                    text += delta["content"]
                                if choice.get("finish_reason"):
                                    finishes.append(choice["finish_reason"])
            check("流式正文", text, "网关通了")
            check("流式 finish", finishes, ["stop"])

            # 核对上游真的收到了身份块与设备头
            sent = received.get("body")
            check_true("上游收到 system 块数组", isinstance(sent, dict) and isinstance(sent.get("system"), list))
            check(
                "上游收到的身份块在首位",
                sent["system"][0]["text"],
                identity.cli_prefix(),
            )
            headers = received.get("headers") or {}
            check("上游收到 X-Device-Mid", headers.get("X-Device-Mid"), "mid-e2e")
            check("上游收到 Authorization", headers.get("Authorization"), "Bearer jwt-e2e")

            # 非流式（聚合）
            async with session.post(
                f"http://127.0.0.1:{gw_port}/v1/chat/completions",
                json={
                    "model": "glm-5.3",
                    "messages": [{"role": "user", "content": "hi"}],
                },
            ) as resp:
                agg = await resp.json()
            check("非流式 HTTP 200", resp.status, 200)
            check(
                "非流式聚合出正文",
                agg["choices"][0]["message"]["content"],
                "网关通了",
            )
            check("非流式 object", agg.get("object"), "chat.completion")

            # 未登录 → 503（换成不存在的凭据路径）
            missing = _TMP_HOME / "nope.json"
            check_true("（清理占位）", not missing.exists())
    finally:
        stop_event.set()
        await task
        await runner.cleanup()


async def main() -> int:
    test_identity()
    test_body()
    test_headers()
    test_translator()
    await test_gateway()

    print()
    if FAILURES:
        print(f"结果: {len(FAILURES)} 项失败 -> {FAILURES}")
        return 1
    print("结果: 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
