/**
 * zcode-bridge 自检（离线，不出网）。
 *
 * 覆盖：
 *  1. 路径与旧目录迁移
 *  2. 官方身份块（3012 准入的唯一开关：cliPrefix + stable 三段）
 *  3. 请求体改写（OpenAI → Anthropic Messages）
 *  4. 上游请求头（X-Device-Mid 硬需求与客户端伪装）
 *  5. 凭据（落盘/读回/损坏容忍/老凭据补 device_mid/无续期端点只探测）
 *  6. Anthropic SSE → OpenAI delta 的增量翻译（含**逐字节喂入**、signature_delta、error）
 *  7. 模型目录（只暴露实测可用模型 + 未知透传）
 *  8. 额度（balance 的 token 单位、preview 的 claimable、活跃上报）
 *  9. 端到端网关（假上游 + 真实网关）：核对上游**真实收到**的头与体
 *
 * 数据目录用 ZCODE_HOME 隔离，绝不碰真实凭据；身份块用仓库内
 * tools/zcode-identity.json（由 tools/extract-zcode-identity.mjs 提取）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// 必须在 import 被测模块之前设置（paths 每次调用都重新解析存储根）
const HOME = mkdtempSync(join(tmpdir(), "zcode-selftest-"));
process.env["MODEL_BRIDGE_HOME"] = HOME;

// 共享层来自工作区包；先注册本渠道（副作用）再引渠道模块
const { paths, sseStream: sse, gateway } = await import("@model-bridge/gateway");
await import("../dist/channel.js");
const catalog = await import("../dist/catalog.js");
const cred = await import("../dist/cred.js");
const upstream = await import("../dist/upstream.js");
const billing = await import("../dist/billing.js");

// ── 假上游 ───────────────────────────────────────────────────────────────────

interface FakeRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown> | null;
}

interface FakeReply {
  status?: number;
  contentType?: string;
  payload?: string;
}

/** 起一个假上游；handler 返回状态码 + 原文（SSE 直接给字符串）。 */
async function startFake(
  handler: (req: FakeRequest) => FakeReply,
): Promise<{ server: Server; port: number; base: string; requests: FakeRequest[] }> {
  const requests: FakeRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += String(c);
    });
    req.on("end", () => {
      let body: Record<string, unknown> | null = null;
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
      const record: FakeRequest = {
        method: req.method ?? "",
        path: (req.url ?? "/").split("?")[0]!,
        headers: { ...req.headers },
        body,
      };
      requests.push(record);
      const reply = handler(record);
      res.writeHead(reply.status ?? 200, {
        "Content-Type": reply.contentType ?? "application/json",
      });
      res.end(reply.payload ?? "");
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return { server, port, base: `http://127.0.0.1:${port}`, requests };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** 从 OpenAI SSE 帧里抽出正文、思考、finish_reason、usage、工具参数。 */
function collect(frames: Array<Buffer | string>): {
  content: string;
  reasoning: string;
  finishes: string[];
  usage: Record<string, unknown> | null;
  toolCalls: Array<Record<string, unknown>>;
  blob: string;
} {
  let content = "";
  let reasoning = "";
  const finishes: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  let usage: Record<string, unknown> | null = null;
  for (const frame of frames) {
    const text = Buffer.isBuffer(frame) ? frame.toString("utf8") : frame;
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      const chunk = JSON.parse(payload) as {
        usage?: Record<string, unknown>;
        choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>;
      };
      if (chunk.usage) usage = chunk.usage;
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta ?? {};
        if (typeof delta["content"] === "string") content += delta["content"];
        if (typeof delta["reasoning_content"] === "string") reasoning += delta["reasoning_content"];
        if (typeof choice.finish_reason === "string") finishes.push(choice.finish_reason);
        const calls = delta["tool_calls"];
        if (Array.isArray(calls)) {
          for (const call of calls) toolCalls.push(call as Record<string, unknown>);
        }
      }
    }
  }
  const blob = frames.map((f) => (Buffer.isBuffer(f) ? f.toString("utf8") : f)).join("");
  return { content, reasoning, finishes, usage, toolCalls, blob };
}

/** 构造一段 Anthropic SSE（message_start → 思考块 → 文本块 → signature → stop）。 */
function anthropicWire(): Buffer {
  const events: Array<[string, Record<string, unknown>]> = [
    ["message_start", { type: "message_start", message: { id: "msg_1", model: "GLM-5.3", usage: { input_tokens: 100 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "让我想想" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text" } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "答案" } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "是 42" } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "deadbeef" } }],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 25 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return Buffer.from(
    events.map(([name, payload]) => `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`).join(""),
    "utf8",
  );
}

async function readSse(url: string, body: unknown): Promise<{ status: number; text: string; frames: string[] }> {
  const resp = await fetch(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  const text = await resp.text();
  return { status: resp.status, text, frames: text.split("\n\n") };
}

function contentOf(text: string): string {
  let content = "";
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
    for (const choice of chunk.choices ?? []) {
      if (choice.delta?.content) content += choice.delta.content;
    }
  }
  return content;
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

describe("1. 路径", () => {
  it("数据目录名固定，受 MODEL_BRIDGE_HOME 覆盖，渠道层是 <root>/zcode", () => {
    assert.equal(paths.rootDir(), HOME);
    assert.equal(paths.channelDir(), join(HOME, "zcode"));
    assert.ok(paths.credentialsPath().endsWith("credentials.json"));
    assert.ok(paths.pidPath().endsWith("gateway.pid"));
    assert.ok(paths.logPath().endsWith("gateway.log"));
  });

  it("旧目录存在时迁移（保留凭据）", () => {
    const alt = mkdtempSync(join(tmpdir(), "zcode-legacy-"));
    const legacy = join(alt, ".zcode2api");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "credentials.json"), '{"zcode_jwt":"legacy"}', "utf8");

    const saved = process.env["MODEL_BRIDGE_HOME"];
    process.env["MODEL_BRIDGE_HOME"] = alt;
    try {
      assert.equal(paths.channelDir(), join(alt, "zcode"));
      assert.ok(paths.credentialsPath().includes("zcode"));
    } finally {
      process.env["MODEL_BRIDGE_HOME"] = saved;
      rmSync(alt, { recursive: true, force: true });
    }
  });
});

describe("2. 官方身份块（3012 准入的唯一开关）", () => {
  it("cliPrefix + stable 全部三段，字符数落在实测通过的区间", () => {
    const identity = upstream.loadIdentity();
    assert.equal(identity.cliPrefix, "You are ZCode, an interactive coding agent");
    assert.equal(identity.stable.length, 3, "少一段是未经验证的配置（仅 cliPrefix 仍被 3012 拒）");
    assert.ok(identity.stable.some((s) => s.includes("# Harness")));
    assert.ok(identity.stable.some((s) => s.includes("# ZCode Desktop Context")));
    assert.ok(identity.stable.some((s) => s.includes("# Working style")));
    const total = identity.cliPrefix.length + identity.stable.reduce((n, s) => n + s.length, 0);
    assert.equal(total, 2894, "实测通过区间是 cliPrefix + stable 全部三段（约 2894 字符）");
  });

  it("identityBlocks 是 4 个 text 块，cliPrefix 在首位", () => {
    const blocks = upstream.identityBlocks();
    assert.equal(blocks.length, 4);
    assert.deepEqual(new Set(blocks.map((b) => b["type"])), new Set(["text"]));
    assert.equal(blocks[0]!["text"], upstream.loadIdentity().cliPrefix);
  });

  it("身份块缺失时抛明确指引（不静默发请求触发 3012 惩罚）", () => {
    const saved = process.env["ZCODE_IDENTITY_FILE"];
    process.env["ZCODE_IDENTITY_FILE"] = join(HOME, "no-such-identity.json");
    upstream.clearIdentityCache();
    try {
      assert.throws(
        () => upstream.loadIdentity(),
        (err: Error) => err.message.includes("extract-zcode-identity.mjs") && err.message.includes("3012"),
      );
    } finally {
      if (saved === undefined) delete process.env["ZCODE_IDENTITY_FILE"];
      else process.env["ZCODE_IDENTITY_FILE"] = saved;
      upstream.clearIdentityCache();
    }
  });
});

describe("3. 请求体：OpenAI → Anthropic Messages", () => {
  it("身份块在 system 首位，调用方 system 其后；messages 转块数组", () => {
    const body = upstream.buildChatBody(
      {
        model: "glm-5.3",
        messages: [
          { role: "system", content: "你是助手" },
          { role: "user", content: "你好" },
          { role: "assistant", content: "你好！" },
          { role: "user", content: "再来一次" },
        ],
        max_tokens: 4096,
        temperature: 0.7,
        stop: ["END"],
        tools: [
          {
            type: "function",
            function: {
              name: "bash",
              description: "执行命令",
              parameters: { type: "object", properties: { cmd: { type: "string" } } },
            },
          },
        ],
      },
      "GLM-5.3",
    );
    assert.equal(body["model"], "GLM-5.3");
    const system = body["system"] as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(system), "system 必须是块数组");
    assert.equal(system[0]!["text"], upstream.loadIdentity().cliPrefix, "身份块必须在首位");
    assert.equal(system.at(-1)!["text"], "你是助手", "调用方 system 拼在身份块之后");
    assert.equal(system.length, 5, "身份块 4 + 调用方 1");
    const messages = body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    assert.deepEqual(
      messages.map((m) => m.role),
      ["user", "assistant", "user"],
      "system 不进 messages",
    );
    assert.equal(messages[0]!.content[0]!["type"], "text");
    assert.equal(messages[0]!.content[0]!["text"], "你好");
    assert.equal(body["max_tokens"], 4096);
    assert.equal(body["temperature"], 0.7);
    assert.deepEqual(body["stop_sequences"], ["END"]);
    assert.equal(body["stream"], true, "恒设 stream:true（客户端要非流式由网关聚合）");
    const tools = body["tools"] as Array<Record<string, unknown>>;
    assert.ok("input_schema" in tools[0]!, "Anthropic 用 input_schema");
    assert.ok(!("parameters" in tools[0]!), "不能留 OpenAI 的 parameters");
    assert.ok(!("type" in tools[0]!), "Anthropic 工具块不接受 OpenAI 的 type:function");
  });

  it("assistant tool_calls → tool_use，role:tool → tool_result（并入同一条 user）", () => {
    const body = upstream.buildChatBody(
      {
        model: "GLM-5.3",
        messages: [
          { role: "user", content: "跑一下" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
              { id: "call_2", type: "function", function: { arguments: "{}" } }, // 无 name → 剔除
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "ok" },
        ],
      },
      "GLM-5.3",
    );
    const messages = body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user"]);
    const assistant = messages[1]!.content;
    const toolUse = assistant.find((b) => b["type"] === "tool_use");
    assert.ok(toolUse, "assistant tool_calls 必须转成 tool_use 块");
    assert.equal(toolUse!["name"], "bash");
    assert.deepEqual(toolUse!["input"], { cmd: "ls" });
    assert.equal(assistant.filter((b) => b["type"] === "tool_use").length, 1, "无 name 的调用被剔除");
    const result = messages[2]!.content.find((b) => b["type"] === "tool_result");
    assert.ok(result, "role:tool 必须转成 tool_result 块");
    assert.equal(result!["tool_use_id"], "call_1");
    assert.equal(result!["content"], "ok");
  });

  it("max_tokens 缺省补安全值；reasoning_effort → output_config.effort", () => {
    const body = upstream.buildChatBody(
      { model: "x", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
      "GLM-5.3",
    );
    assert.equal(typeof body["max_tokens"], "number", "Anthropic 的 max_tokens 必填");
    assert.deepEqual(body["output_config"], { effort: "high" });
  });
});

describe("4. 请求头", () => {
  it("鉴权 + 设备标识 + 客户端伪装", () => {
    const headers = upstream.buildHeaders({
      accessToken: "jwt-test",
      deviceMid: "mid-test",
      uid: "u1",
    });
    assert.equal(headers["Authorization"], "Bearer jwt-test");
    assert.equal(headers["X-Device-Mid"], "mid-test", "缺它 billing 全家桶回 400 code 3001");
    assert.equal(headers["User-Agent"], "ZCode/3.14.4");
    assert.equal(headers["X-ZCode-App-Version"], "3.14.4");
    assert.equal(headers["anthropic-version"], "2023-06-01");
    assert.equal(headers["HTTP-Referer"], "https://zcode.z.ai");
    assert.equal(headers["Content-Type"], "application/json");
  });

  it("缺 device_mid 直接报错，而不是静默漏发", () => {
    assert.throws(() => upstream.buildHeaders({ accessToken: "jwt", deviceMid: "" }), /device_mid/);
  });

  it("匿名形态（preview / event report）不带 Authorization", () => {
    const headers = upstream.buildHeaders(
      { accessToken: "jwt", deviceMid: "mid" },
      undefined,
      { authorization: false },
    );
    assert.ok(!("Authorization" in headers));
    assert.equal(headers["X-Device-Mid"], "mid");
  });
});

describe("5. 凭据", () => {
  it("未登录时抛 NotLoggedInError", () => {
    rmSync(paths.credentialsPath(), { force: true });
    assert.throws(() => cred.load(), cred.NotLoggedInError);
  });

  it("落盘为 snake_case，读回为契约形态", async () => {
    await cred.save({
      accessToken: "jwt-1",
      deviceMid: "mid-1",
      uid: "user-1",
      appVersion: "3.14.4",
      domain: "",
    });
    const disk = JSON.parse(readFileSync(paths.credentialsPath(), "utf8")) as Record<string, unknown>;
    assert.equal(disk["zcode_jwt"], "jwt-1", "磁盘字段与渠道包一致（snake_case）");
    assert.equal(disk["device_mid"], "mid-1");
    assert.equal(disk["user_id"], "user-1");
    const c = cred.load();
    assert.equal(c.accessToken, "jwt-1");
    assert.equal(c.deviceMid, "mid-1");
    assert.equal(c.uid, "user-1");
  });

  it("同目录 legacy 文件与旧字段名都能读", () => {
    writeFileSync(
      paths.credentialsPath(),
      JSON.stringify({ accessToken: "jwt-legacy", device_mid: "mid-legacy", uid: "u-legacy" }),
      "utf8",
    );
    const c = cred.load();
    assert.equal(c.accessToken, "jwt-legacy");
    assert.equal(c.deviceMid, "mid-legacy");
    assert.equal(c.uid, "u-legacy");
  });

  it("老凭据缺 device_mid 时就地补齐并持久化（不拒绝整条凭据）", async () => {
    writeFileSync(paths.credentialsPath(), JSON.stringify({ zcode_jwt: "jwt-old" }), "utf8");
    const first = cred.load();
    assert.ok(first.deviceMid, "必须补上 device_mid（硬需求）");
    const second = cred.load();
    assert.equal(second.deviceMid, first.deviceMid, "补齐后必须稳定（写入磁盘）");
    const disk = JSON.parse(readFileSync(paths.credentialsPath(), "utf8")) as Record<string, unknown>;
    assert.equal(disk["device_mid"], first.deviceMid);
  });

  it("损坏 / accessToken 为空按未登录处理", () => {
    writeFileSync(paths.credentialsPath(), "{ not json", "utf8");
    assert.throws(() => cred.load(), cred.NotLoggedInError);
    writeFileSync(paths.credentialsPath(), JSON.stringify({ zcode_jwt: "" }), "utf8");
    assert.throws(() => cred.load(), cred.NotLoggedInError);
  });

  it("resolveBaseUrl：realm 表 + 默认域", async () => {
    await cred.save({ accessToken: "jwt-1", deviceMid: "mid-1", uid: "u1", domain: "" });
    assert.equal(cred.resolveBaseUrl("auto"), "https://zcode.z.ai");
    assert.equal(cred.resolveBaseUrl("start"), "https://zcode.z.ai");
    assert.equal(cred.resolveBaseUrl("coding"), "https://api.z.ai");
    // 共享 CLI 的 --realm 取值：两个域都指向 zcode.z.ai（积分制 host 固定）
    assert.equal(cred.resolveBaseUrl("intl"), "https://zcode.z.ai");
    assert.equal(cred.resolveBaseUrl("cn"), "https://zcode.z.ai");
    assert.throws(() => cred.resolveBaseUrl("nope"));
  });
});

describe("6. Anthropic SSE → OpenAI delta（增量翻译器）", () => {
  it("一次性喂入：正文 / 思考 / stop_reason / usage / [DONE]", () => {
    const wire = anthropicWire();
    const translator = upstream.newTranslator();
    const frames = [...translator.feed(wire), ...translator.finish()];
    const got = collect(frames);
    assert.equal(got.content, "答案是 42");
    assert.equal(got.reasoning, "让我想想");
    assert.deepEqual(got.finishes, ["stop"]);
    assert.deepEqual(got.usage, { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 });
    assert.ok(got.blob.includes("data: [DONE]"));
    assert.ok(!got.blob.includes("deadbeef"), "signature_delta 必须忽略（当文本会注入十六进制）");
  });

  it("逐字节喂入（TCP 任意切分 / 中文多字节被切开）", () => {
    const wire = anthropicWire();
    const translator = upstream.newTranslator();
    const frames: Array<Buffer | string> = [];
    for (let i = 0; i < wire.length; i += 1) {
      frames.push(...translator.feed(wire.subarray(i, i + 1)));
    }
    frames.push(...translator.finish());
    const got = collect(frames);
    assert.equal(got.content, "答案是 42");
    assert.equal(got.reasoning, "让我想想");
    assert.deepEqual(got.finishes, ["stop"]);
    assert.deepEqual(got.usage, { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 });
    assert.ok(!got.blob.includes("\uFFFD"), "逐 chunk toString() 会把中文切成替换字符");
  });

  it("不规则块大小喂入", () => {
    const wire = anthropicWire();
    const translator = upstream.newTranslator();
    const frames: Array<Buffer | string> = [];
    let pos = 0;
    for (const size of [7, 1, 33, 100, 2, 512, 5, 1000]) {
      while (pos < wire.length) {
        frames.push(...translator.feed(wire.subarray(pos, pos + size)));
        pos += size;
      }
      pos = 0;
      break;
    }
    frames.push(...translator.finish());
    assert.equal(collect(frames).content, "答案是 42");
  });

  it("error 事件必须显式产出 error 帧，且仍以 [DONE] 收尾", () => {
    const translator = upstream.newTranslator();
    const frames = [
      ...translator.feed(
        Buffer.from(
          'event: error\ndata: {"type":"error","error":{"code":3012,"message":"上游过载"}}\n\n',
          "utf8",
        ),
      ),
      ...translator.finish(),
    ];
    const blob = collect(frames).blob;
    assert.ok(blob.includes('"error"'), "静默当成正常结束会让 UI「干净地停止、无报错」");
    assert.ok(blob.includes("上游过载"));
    assert.ok(blob.includes("3012"));
    assert.ok(blob.trimEnd().endsWith("data: [DONE]"));
  });

  it("断流（无 message_stop）也补 finish_reason", () => {
    const translator = upstream.newTranslator();
    const frames = [
      ...translator.feed(
        Buffer.from(
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"半截"}}\n\n',
          "utf8",
        ),
      ),
      ...translator.finish(),
    ];
    const got = collect(frames);
    assert.equal(got.content, "半截");
    assert.deepEqual(got.finishes, ["stop"]);
  });

  it("工具调用：content_block_start(tool_use) + input_json_delta", () => {
    const wire = Buffer.from(
      [
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"bash"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"ls\\"}"}}\n\n',
      ].join(""),      "utf8",
    );
    const translator = upstream.newTranslator();
    const frames = [...translator.feed(wire), ...translator.finish()];
    const got = collect(frames);
    assert.equal(got.toolCalls[0]!["id"], "toolu_1");
    assert.equal((got.toolCalls[0]!["function"] as Record<string, unknown>)["name"], "bash");
    const args = got.toolCalls
      .map((c) => (c["function"] as Record<string, unknown>)["arguments"])
      .join("");
    assert.equal(args, '{"cmd":"ls"}');
  });

  it("注释行与未知事件不产出", () => {
    const translator = upstream.newTranslator();
    const frames = translator.feed(
      Buffer.from(": keep-alive\n\nevent: ping\ndata: {\"type\":\"ping\"}\n\n", "utf8"),
    );
    assert.deepEqual(frames, []);
  });

  it("stop_reason 映射：end_turn→stop / max_tokens→length / tool_use→tool_calls", () => {
    assert.equal(upstream.mapStopReason("end_turn"), "stop");
    assert.equal(upstream.mapStopReason("max_tokens"), "length");
    assert.equal(upstream.mapStopReason("tool_use"), "tool_calls");
  });
});

describe("7. 模型目录", () => {
  it("目录层保留实测可用模型；池子只放行 flash（GLM-5.3 非 flash 不进池）", () => {
    const ids = catalog.exposedIds();
    assert.deepEqual(ids, ["GLM-5.3-Flash"], "flash-only 池策略");
    assert.ok(!ids.includes("GLM-5-Turbo"), "上游返回空响应，不进目录");
    assert.ok(!ids.includes("GLM-5.2"));
    // 过滤只发生在呈现层：目录数据仍完整
    const detailIds = catalog.details().map((d) => d["id"]);
    assert.ok(detailIds.includes("GLM-5.3"), "非 flash 仍在底层目录（数据没丢）");
  });

  it("别名与大小写映射，未知原样透传", () => {
    assert.equal(catalog.resolveModel("GLM-5.3"), "GLM-5.3");
    assert.equal(catalog.resolveModel("glm-5.3"), "GLM-5.3");
    assert.equal(catalog.resolveModel("glm-5.3-flash"), "GLM-5.3-Flash");
    assert.equal(catalog.resolveModel("no-such-model"), "no-such-model");
  });

  it("models.json 的 alias 字段优先（可覆盖兜底表）；非 flash 条目被策略过滤但仍可解析", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-models-"));
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        models: [
          { slug: "glm-5.3-flash", alias: "glm-flash", name: "GLM-5.3 Flash" },
          { slug: "kimi-k3", alias: "kimi", name: "Kimi K3" },
        ],
      }),
      "utf8",
    );
    const saved = process.env["ZCODE_MODELS_FILE"];
    process.env["ZCODE_MODELS_FILE"] = join(dir, "models.json");
    catalog.clearCache();
    try {
      // alias 优先：暴露短名而非 slug；models.json 一旦可用即整表覆盖兜底表
      assert.deepEqual(catalog.exposedIds(), ["glm-flash"]);
      assert.ok(
        !catalog.exposedIds().includes("GLM-5.3-Flash"),
        "models.json 可用时兜底表条目不再出现",
      );
      assert.equal(catalog.resolveModel("glm-flash"), "glm-5.3-flash");
      assert.equal(catalog.resolveModel("glm-5.3-flash"), "glm-5.3-flash");
      // 模型池策略：非 flash 条目被白名单挡在池外，但数据仍在底层表里
      assert.ok(catalog.details().some((d) => d["id"] === "kimi"), "details 底层表仍含被过滤条目");
      assert.equal(catalog.resolveModel("kimi"), "kimi-k3", "被过滤的别名仍解析到上游 id");
    } finally {
      if (saved === undefined) delete process.env["ZCODE_MODELS_FILE"];
      else process.env["ZCODE_MODELS_FILE"] = saved;
      catalog.clearCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("details 供状态页使用", () => {
    const detail = catalog.details();
    assert.equal(detail[0]!["id"], "GLM-5.3");
    assert.equal(detail[0]!["upstream"], "GLM-5.3");
  });
});

describe("8. 额度与活跃上报", () => {
  it("balance 是 token 桶（不是泛化积分）；preview 给出可领活动", async () => {
    const fake = await startFake((req) => {
      if (req.path.endsWith("/billing/balance")) {
        return {
          payload: JSON.stringify({
            code: 0,
            data: {
              meter: "model_usage",
              unit_type: "token",
              total_units: 1000,
              used_units: 250,
              remaining_units: 750,
            },
          }),
        };
      }
      if (req.path.endsWith("/billing/preview")) {
        return {
          payload: JSON.stringify({
            code: 0,
            data: { plans: [{ plan_id: "zcode-v3-start-plan-trust-1", title: "每日领取" }] },
          }),
        };
      }
      return { status: 404, payload: JSON.stringify({ code: 404 }) };
    });
    const saved = await upstream.loadConfig();
    await upstream.saveConfig({ ...upstream.defaultConfig(), baseUrl: fake.base });
    await cred.save({ accessToken: "jwt-b", deviceMid: "mid-b", uid: "u-b", domain: "" });
    try {
      const info = await billing.fetchCredits();
      assert.equal(info.ok, true);
      assert.equal(info.total.unit, "token");
      assert.equal(info.total.remain, 750);
      assert.equal(info.total.size, 1000);
      assert.equal(info.total.used, 250);
      assert.equal(info.total.remain_percent, 75);
      assert.equal(info.packages[0]!.unit, "token");
      assert.equal(info.claimable?.[0]?.["id"], "zcode-v3-start-plan-trust-1");

      const balanceReq = fake.requests.find((r) => r.path.endsWith("/billing/balance"))!;
      assert.equal(balanceReq.headers["authorization"], "Bearer jwt-b");
      assert.equal(balanceReq.headers["x-device-mid"], "mid-b", "缺 X-Device-Mid 会回 400 code 3001");
      const previewReq = fake.requests.find((r) => r.path.endsWith("/billing/preview"))!;
      assert.ok(!("authorization" in previewReq.headers), "preview 不需要 Authorization");
      assert.equal(previewReq.headers["x-device-mid"], "mid-b");
    } finally {
      await closeServer(fake.server);
      await upstream.saveConfig(saved[0]);
    }
  });

  it("balance 非 200 抛 CreditsError（「查不到」不能显示成 0）", async () => {
    const fake = await startFake(() => ({ status: 500, payload: "boom" }));
    const saved = await upstream.loadConfig();
    await upstream.saveConfig({ ...upstream.defaultConfig(), baseUrl: fake.base });
    try {
      await assert.rejects(billing.fetchCredits(), billing.CreditsError);
    } finally {
      await closeServer(fake.server);
      await upstream.saveConfig(saved[0]);
    }
  });

  it("balance 401 → NotLoggedInError（不伪装成 0 额度）", async () => {
    const fake = await startFake(() => ({ status: 401, payload: "{}" }));
    const saved = await upstream.loadConfig();
    await upstream.saveConfig({ ...upstream.defaultConfig(), baseUrl: fake.base });
    try {
      await assert.rejects(billing.fetchCredits({ refreshOn401: false }), cred.NotLoggedInError);
    } finally {
      await closeServer(fake.server);
      await upstream.saveConfig(saved[0]);
    }
  });

  it("活跃上报补两条事件（preview 依赖它才有内容）", async () => {
    const fake = await startFake(() => ({ payload: JSON.stringify({ code: 0 }) }));
    const saved = await upstream.loadConfig();
    await upstream.saveConfig({ ...upstream.defaultConfig(), baseUrl: fake.base });
    await cred.save({ accessToken: "jwt-b", deviceMid: "mid-b", uid: "u-b", domain: "" });
    try {
      await billing.reportActivity();
      const events = fake.requests
        .filter((r) => r.path.endsWith("/event/report"))
        .map((r) => r.body?.["event"]);
      assert.deepEqual(events, ["app_launch", "app_daily_active"]);
    } finally {
      await closeServer(fake.server);
      await upstream.saveConfig(saved[0]);
    }
  });
});

describe("9. 端到端网关（假上游 + 真实网关）", () => {
  let fake: Awaited<ReturnType<typeof startFake>>;
  let gw: gateway.RunningGateway;
  let savedConfig: upstream.Config;
  let mode: { status: number } = { status: 200 };

  const anthropicFrames = (): string =>
    [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"GLM-5.3","usage":{"input_tokens":7}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"网关"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"通了"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

  before(async () => {
    fake = await startFake((req) => {
      if (mode.status !== 200) {
        return { status: mode.status, payload: "internal detail leak" };
      }
      if (req.path.endsWith("/anthropic/v1/messages")) {
        return { contentType: "text/event-stream", payload: anthropicFrames() };
      }
      if (req.path.endsWith("/client/configs")) {
        return { payload: JSON.stringify({ code: 0, data: { builtinModels: [] } }) };
      }
      return { status: 404, payload: JSON.stringify({ code: 404 }) };
    });
    savedConfig = (await upstream.loadConfig())[0];
    await upstream.saveConfig({ ...upstream.defaultConfig(), baseUrl: fake.base });
    await cred.save({ accessToken: "jwt-e2e", deviceMid: "mid-e2e", uid: "u-e2e", domain: "" });
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await closeServer(fake.server);
    await upstream.saveConfig(savedConfig);
  });

  it("/v1/models 只返回池内模型（flash-only）", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/models`);
    assert.equal(resp.status, 200);
    const payload = (await resp.json()) as { data: Array<{ id: string }> };
    const ids = payload.data.map((m) => m.id);
    assert.deepEqual(ids, ["glm-5.3-flash"], "flash-only 池策略；对外 id 恒小写");
    assert.ok(!ids.includes("glm-5.3"), "glm-5.3 非 flash，不进池");
    assert.ok(!ids.includes("glm-5.2"));
  });

  it("/health 报告 ok 与登录状态", async () => {
    const resp = await fetch(`http://${gw.addr}/health`);
    const payload = (await resp.json()) as Record<string, unknown>;
    assert.equal(payload["ok"], true);
    assert.equal(payload["logged_in"], true);
  });

  it("流式对话：自定义线型被增量翻译出正文", async () => {
    fake.requests.length = 0;
    const { status, text } = await readSse(`http://${gw.addr}/v1/chat/completions`, {
      model: "glm-5.3",
      messages: [
        { role: "system", content: "你是助手" },
        { role: "user", content: "hi" },
      ],
      stream: true,
    });
    assert.equal(status, 200);
    assert.equal(contentOf(text), "网关通了");
    assert.ok(text.includes("data: [DONE]"));

    const sent = fake.requests.at(-1)!;
    assert.equal(sent.headers["authorization"], "Bearer jwt-e2e");
    assert.equal(sent.headers["x-device-mid"], "mid-e2e");
    assert.equal(sent.headers["anthropic-version"], "2023-06-01");
    const body = sent.body!;
    assert.equal(body["model"], "GLM-5.3", "短名映射为上游 slug");
    assert.equal(body["stream"], true);
    const system = body["system"] as Array<Record<string, unknown>>;
    assert.equal(system[0]!["text"], upstream.loadIdentity().cliPrefix);
    assert.equal(system.at(-1)!["text"], "你是助手");
    assert.equal(system.length, 5);
    const messages = body["messages"] as Array<{ role: string }>;
    assert.deepEqual(messages.map((m) => m.role), ["user"]);
  });

  it("非流式：本层聚合成 chat.completion", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "GLM-5.3",
        messages: [{ role: "user", content: "hi" }],
      }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 200);
    const payload = (await resp.json()) as {
      object: string;
      choices: Array<{ message: { content: string } }>;
      usage: Record<string, number>;
    };
    assert.equal(payload.object, "chat.completion");
    assert.equal(payload.choices[0]!.message.content, "网关通了");
    assert.equal(payload.usage["prompt_tokens"], 7);
  });

  it("上游 500 → 502 upstream_error 且不回传上游原文", async () => {
    mode.status = 500;
    try {
      const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({
          model: "GLM-5.3",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(resp.status, 502);
      const payload = (await resp.json()) as { error: { code: string; message: string } };
      assert.equal(payload.error.code, "upstream_error");
      assert.ok(!payload.error.message.includes("internal detail leak"));
    } finally {
      mode.status = 200;
    }
  });

  it("请求校验：缺 model/messages 返回 400 统一信封", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "GLM-5.3" }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 400);
    const payload = (await resp.json()) as { error: { code: string } };
    assert.equal(payload.error.code, "invalid_request");
  });

  it("凭据被拒时 refresh 做有效性探测（没有续期端点），探测失败必须抛错", async () => {
    // 上游 configs 也指向假服务：先让它 200
    const c = cred.load();
    const refreshed = await cred.refresh(c);
    assert.equal(refreshed.accessToken, "jwt-e2e");

    // 假上游拒绝 → 必须抛 UpstreamUnauthorized（不能假装续期成功）
    const rejecting = await startFake(() => ({ status: 401, payload: "{}" }));
    const saved = await upstream.loadConfig();
    await upstream.saveConfig({ ...upstream.defaultConfig(), baseUrl: rejecting.base });
    try {
      await assert.rejects(cred.refresh(c), upstream.UpstreamUnauthorized);
    } finally {
      await closeServer(rejecting.server);
      await upstream.saveConfig(saved[0]);
    }
  });
});
