/**
 * trae-bridge 自检（离线，不出网）。
 *
 * 覆盖：
 *  1. 凭据与设备指纹（32 hex、签到设备确定性派生、昵称乱码修复）
 *  2. 登录 URL 的 18 个参数与 `auth_callback_url` 拼写；回调解析（直接回传 token / PKCE 报错）
 *  3. 请求体改写（function / model+config_name / content 块数组 / tools 参数变字符串 / max_tokens 收敛 / Max 模式成套）
 *  4. 请求头（同一 token 三处、版本头、设备头）
 *  5. event 流 → OpenAI delta 的增量翻译（含**逐字节喂入**与工具调用清理、error 帧）
 *  6. 模型目录（通道白名单、硬过滤、合并优先级、倍率展示名、兜底表）
 *  7. 错误分类顺序与冷却
 *  8. 额度与签到（claim body 是 {}、必须补查 status、9074 轮换设备代次）与续期（双 token 轮换）
 *  9. 端到端网关（假上游 + 真实网关）：核对上游**真实收到**的头与体
 *
 * 数据目录用 TRAE_HOME 隔离；签到/OAuth host 用 TRAE_UG_HOST / TRAE_OAUTH_HOST 指向假服务。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// 必须在 import 被测模块之前设置（paths 每次调用都重新解析存储根）
const HOME = mkdtempSync(join(tmpdir(), "trae-selftest-"));
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

/** 从 OpenAI SSE 帧里抽出正文、思考、finish_reason、usage、工具调用。 */
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

/** 构造一段 TRAE event 流（思考、正文、工具调用、usage、done）。 */
function traeWire(): Buffer {
  const events: Array<[string, Record<string, unknown>]> = [
    ["output", { response: null, reasoning_content: "让我想想", tool_calls: null }],
    ["output", { response: "答案", reasoning_content: null, tool_calls: null }],
    ["output", { response: "是 42", reasoning_content: null, tool_calls: null }],
    [
      "output",
      {
        response: "",
        reasoning_content: null,
        tool_calls: [
          {
            index: 0,
            id: "call_9",
            function_call: {
              name: "bash",
              arguments: '{"cmd":',
              namespace: "solo",
              partial_arguments: '{"cmd":',
            },
          },
        ],
      },
    ],
    ["token_usage", { prompt_tokens: 100, completion_tokens: 25, reasoning_tokens: 7 }],
    ["done", { finish_reason: "stop" }],
  ];
  return Buffer.from(
    events.map(([name, payload]) => `event:${name}\ndata:${JSON.stringify(payload)}\n\n`).join(""),
    "utf8",
  );
}

/** 远端目录载荷（覆盖白名单、硬过滤、合并优先级、倍率与档位）。 */
function remotePayload(): Record<string, unknown> {
  const cfg = (configName: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    config_name: configName,
    usage: "chat_completion",
    config_switch: true,
    is_invisible_to_user: false,
    display_config: { display_name: `${configName} 展示名`, is_custom_model: false },
    context_window_tokens: { dev: 100000, max: 200000 },
    ...extra,
  });
  return {
    function_configs: [
      // 白名单靠前者：glm-5.2 的空档位版本
      { function: "solo_agent", config_info_list: [cfg("glm-5.2"), cfg("DeepSeek-V4-Flash")] },
      // 白名单靠后者：带档位 + Max 模式 → 应覆盖空档位
      {
        function: "solo_work_lite",
        config_info_list: [
          cfg("glm-5.2", {
            model_detail_list: [
              { model_name: "glm-5.2__dev", max_tokens: 32000 },
              { model_name: "glm-5.2__max", max_tokens: 200000 },
            ],
            display_config: { display_name: "GLM-5.2", is_custom_model: false, max_mode: true },
            reasoning_effort_config: {
              default_level: "max", // 不在 options 里 → 必须退到最强档
              options: ["low", "high"],
              support_thinking: true,
            },
            display_contact_config: JSON.stringify({ consumption_rate: 0.08, activity_discount: 0.8 }),
          }),
          cfg("kimi-k3", {
            display_config: { display_name: "Kimi K3", is_custom_model: false },
            display_contact_config: '{"consumption_rate":0}',
          }),
          cfg("custom-x", { display_config: { is_custom_model: true, display_name: "X" } }),
          cfg("invisible-x", { is_invisible_to_user: true }),
          cfg("off-x", { config_switch: false }),
          cfg("nonchat-x", { usage: "other" }),
        ],
      },
      // 白名单外：整组丢弃（chat / builder / inline_chat 稳定被拒）
      { function: "chat", config_info_list: [cfg("glm-5.2"), cfg("only-in-chat")] },
      { function: "builder", config_info_list: [cfg("only-in-builder")] },
      { function: "inline_chat", config_info_list: [cfg("only-in-inline")] },
      { function: "solo_agent", config_info_list: [cfg("solo-agent-only")] },
    ],
  };
}

function makeCred(extra: Partial<cred.Credentials> = {}): cred.Credentials {
  return {
    ...cred.EMPTY_CREDENTIALS,
    accessToken: "tok-1",
    refreshToken: "rt-1",
    uid: "u-1",
    machineId: "m".repeat(32),
    deviceId: "d".repeat(32),
    domain: "",
    ...extra,
  };
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

describe("1. 凭据与设备指纹", () => {
  it("machine_id / device_id 是 32 位 hex，且 device_id 每次不同", () => {
    const hex = /^[0-9a-f]{32}$/;
    assert.match(cred.generateMachineId(), hex);
    const device = cred.generateDeviceId();
    assert.match(device, hex);
    assert.notEqual(cred.generateDeviceId(), device, "每账号 device_id 互不相同");
  });

  it("签到设备确定性派生：15 位数字、稳定、按账号与代数区分", () => {
    const a = cred.deriveCheckinDeviceId("uid-1", 0);
    assert.equal(a.length, 15);
    assert.match(a, /^\d{15}$/);
    assert.equal(cred.deriveCheckinDeviceId("uid-1", 0), a, "同一账号稳定");
    assert.notEqual(cred.deriveCheckinDeviceId("uid-2", 0), a);
    assert.notEqual(cred.deriveCheckinDeviceId("uid-1", 1), a, "轮换代次换设备桶");
    assert.match(cred.deriveCheckinDeviceId("uid-1", 3), /^\d{15}$/);
  });

  it("市场用户 id 是 UUID v4、会话 id 是 64 hex", () => {
    const market = cred.deriveMarketUserId("uid-1");
    assert.equal(market[14], "4");
    assert.ok("89ab".includes(market[19]!), "RFC4122 variant");
    assert.equal(cred.deriveSessionId("uid-1").length, 64);
  });

  it("昵称乱码修复与回退", () => {
    const mojibake = Buffer.from("你好", "utf8").toString("latin1");
    assert.equal(cred.fixNickname(mojibake), "你好", "latin-1 双重编码乱码要修回");
    assert.equal(cred.fixNickname("小明"), "小明", "正常中文保留");
    assert.equal(cred.fixNickname("Alice"), "Alice", "纯 ASCII 昵称不动");
    assert.equal(cred.fixNickname("Óû§8847309959", "u123456"), "用户3456", "修不好且无 CJK 时回退");
    assert.equal(cred.fixNickname("", "abc9999"), "用户9999");
  });

  it("凭据落盘 snake_case、读回契约形态；缺设备指纹时补齐", async () => {
    await cred.save(makeCred({ nickname: "小明" }));
    const disk = JSON.parse(readFileSync(paths.credentialsPath(), "utf8")) as Record<string, unknown>;
    assert.equal(disk["access_token"], "tok-1");
    assert.equal(disk["machine_id"], "m".repeat(32));
    const c = cred.load();
    assert.equal(c.accessToken, "tok-1");
    assert.equal(c.uid, "u-1");

    writeFileSync(
      paths.credentialsPath(),
      JSON.stringify({ access_token: "tok-old", refresh_token: "rt-old", uid: "u-x" }),
      "utf8",
    );
    const filled = cred.load();
    assert.match(filled.machineId, /^[0-9a-f]{32}$/);
    assert.match(filled.deviceId, /^[0-9a-f]{32}$/);
    const again = cred.load();
    assert.equal(again.deviceId, filled.deviceId, "补齐后必须稳定（写入磁盘）");
  });

  it("未登录 / 损坏 / 空 token 都抛 NotLoggedInError", () => {
    rmSync(paths.credentialsPath(), { force: true });
    assert.throws(() => cred.load(), cred.NotLoggedInError);
    writeFileSync(paths.credentialsPath(), "{ not json", "utf8");
    assert.throws(() => cred.load(), cred.NotLoggedInError);
    writeFileSync(paths.credentialsPath(), JSON.stringify({ access_token: "" }), "utf8");
    assert.throws(() => cred.load(), cred.NotLoggedInError);
  });

  it("resolveBaseUrl 默认 CN agentHost；intl 明确报错", () => {
    assert.equal(cred.resolveBaseUrl("auto"), "https://trae-api-cn.mchost.guru");
    assert.equal(cred.resolveBaseUrl("cn"), "https://trae-api-cn.mchost.guru");
    assert.throws(
      () => cred.resolveBaseUrl("intl"),
      (err: Error) => err.message.includes("only has a CN config"),
      "源码中不存在国际版配置",
    );
  });

  it("过期时间归一化为毫秒字符串（秒 / ISO / JWT exp 兜底）", () => {
    assert.equal(cred.normalizeExpiresAt("1900000000000"), "1900000000000");
    assert.equal(cred.normalizeExpiresAt(1_700_000_000), "1700000000000");
    assert.equal(cred.normalizeExpiresAt("2030-01-01T00:00:00Z"), String(Date.parse("2030-01-01T00:00:00Z")));
    const payload = Buffer.from(JSON.stringify({ exp: 1_900_000_000 })).toString("base64url");
    assert.equal(cred.normalizeExpiresAt(undefined, `h.${payload}.s`), "1900000000000");
  });
});

describe("2. 登录 URL 与回调", () => {
  it("18 个参数，auth_callback_url 拼写正确（写错登录页永远停在授权中）", () => {
    const url = cred.buildAuthorizeUrl("http://127.0.0.1:18080/authorize", "a".repeat(32), "b".repeat(32));
    assert.ok(url.startsWith("https://www.trae.cn/authorization?"));
    const params = new URL(url).searchParams;
    assert.equal([...params.keys()].length, 18);
    assert.equal(params.get("auth_callback_url"), "http://127.0.0.1:18080/authorize");
    assert.ok(!params.has("callback_url") && !params.has("redirect_uri"));
    assert.equal(params.get("login_trace_id"), "a".repeat(32).concat("b".repeat(32)).slice(-16));
    assert.equal(params.get("plugin_version"), "2.3.62834", "plugin_version ≠ ideVersion");
    assert.equal(params.get("x_app_version"), "0.1.52");
    assert.equal(params.get("client_id"), "en1oxy7wnw8j9n");
    assert.equal(params.get("redirect"), "0");
  });

  it("回调直接回传 token；TenantID 落 enterprise_id；PKCE 明确报错", () => {
    const fields = cred.parseCallback({
      refreshToken: "rt-1",
      userInfo: JSON.stringify({
        UserID: "u-9",
        ScreenName: "小明",
        TenantID: "t-1",
        NonPlainTextMobile: "138****8888",
      }),
      userJwt: JSON.stringify({ Token: "at-1", RefreshToken: "rt-2" }),
    });
    assert.equal(fields.access_token, "at-1");
    assert.equal(fields.refresh_token, "rt-1", "query 里的 refreshToken 优先");
    assert.equal(fields.uid, "u-9");
    assert.equal(fields.enterprise_id, "t-1", "是 TenantID 不是 EnterpriseID");
    assert.equal(fields.phone, "138****8888");
    assert.equal(fields.nickname, "小明");

    const fallback = cred.parseCallback({ userJwt: JSON.stringify({ Token: "at-2", RefreshToken: "rt-3" }) });
    assert.equal(fallback.refresh_token, "rt-3", "query 缺失时回退 userJwt.RefreshToken");

    assert.throws(
      () => cred.parseCallback({ code: "abc", state: "s" }),
      (err: Error) => err.message.includes("PKCE"),
    );
  });

  it("本地回调服务器：真实起端口并解析回调", async () => {
    const srv = await cred.startCallbackServer(0);
    try {
      const query = new URLSearchParams({
        refreshToken: "rt-live",
        userInfo: JSON.stringify({ UserID: "u-live", ScreenName: "小明" }),
        userJwt: JSON.stringify({ Token: "at-live" }),
      });
      const resp = await fetch(`http://127.0.0.1:${srv.port}/authorize?${query}`);
      assert.equal(resp.status, 200);
      const flat = await srv.wait(3000);
      const parsed = cred.parseCallback(flat);
      assert.equal(parsed.access_token, "at-live");
      assert.equal(parsed.uid, "u-live");
    } finally {
      srv.close();
    }
  });
});

describe("3. 请求体：OpenAI → SOLO", () => {
  it("function / model+config_name / content 块数组 / tools 参数字符串 / max_tokens 收敛", () => {
    const body = upstream.buildChatBody(
      {
        model: "glm-5.2",
        messages: [
          { role: "system", content: "你是助手" },
          { role: "user", content: "你好" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
              { id: "call_2", type: "function", function: { arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "ok" },
        ],
        max_tokens: 131072,
        temperature: 0.5,
        reasoning_effort: "high",
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
      "glm-5.2",
    );
    assert.equal(body["stream"], true, "强制流式");
    assert.equal(body["function"], "solo_work_lite", "缺省通道");
    assert.equal(body["model"], "glm-5.2");
    assert.equal(body["config_name"], "glm-5.2", "model 与 config_name 双字段同值");
    assert.ok(!("query" in body), "请求体不存在 query 字段");
    const messages = body["messages"] as Array<Record<string, unknown>>;
    assert.deepEqual(messages[0]!["content"], [{ type: "text", text: "你是助手" }], "content 转块数组");
    assert.deepEqual(messages[2]!["function_call"], { name: "bash", arguments: '{"cmd":"ls"}' });
    assert.ok(!("tool_calls" in messages[2]!), "tool_calls 已改写为 function_call");
    const tools = body["tools"] as Array<Record<string, unknown>>;
    const fn = tools[0]!["function"] as Record<string, unknown>;
    assert.equal(typeof fn["parameters"], "string", "SOLO 要求 parameters 是 JSON 字符串");
    assert.equal(JSON.parse(fn["parameters"] as string)["type"], "object");
    assert.equal(body["max_tokens"], 64000, "实测索要 131072 会被打成 4xx");
    assert.equal(body["reasoning_effort"], "high");
    assert.equal(body["temperature"], 0.5);
  });

  it("__max 后缀去掉；空 tools 剔除", () => {
    assert.equal(upstream.buildChatBody({ model: "glm-5.2" }, "glm-5.2__max")["model"], "glm-5.2");
    const body = upstream.buildChatBody({ model: "x", messages: [], tools: [] }, "x");
    assert.ok(!("tools" in body));
  });

  it("tool_choice 归一化", () => {
    const none = upstream.buildChatBody(
      { model: "x", messages: [], tools: [{ type: "function", function: { name: "bash" } }], tool_choice: "none" },
      "x",
    );
    assert.ok(!("tool_choice" in none) && !("tools" in none), "none → 删 tools");
    assert.equal(upstream.buildChatBody({ model: "x", messages: [], tool_choice: "auto" }, "x")["tool_choice"], "auto");
    assert.equal(
      upstream.buildChatBody(
        { model: "x", messages: [], tool_choice: { type: "function", function: { name: "bash" } } },
        "x",
      )["tool_choice"],
      "bash",
      "函数选择归一化为字符串 name",
    );
  });

  it("Max 模式必须成套下发（显式 entry 与目录 __max 后缀两条路径）", () => {
    const body = upstream.buildChatBody({ model: "glm-5.2", messages: [] }, "glm-5.2", {
      function: "solo_agent",
      max_mode: true,
      max_context: 1_000_000,
      max_max_tokens: 200_000,
    });
    assert.equal(body["function"], "solo_agent");
    assert.deepEqual(body["model_auto_selection"], { strategy: "max" });
    assert.equal(body["model_selection_strategy"], "max");
    assert.equal(body["mode_type"], 1);
    assert.equal(body["context_window_size"], 1_000_000);
    assert.equal(body["prompt_max_tokens"], 936000);
    assert.equal(body["max_tokens"], 200_000, "用 __max 明细");
    const plain = upstream.buildChatBody({ model: "glm-5.2", messages: [] }, "glm-5.2");
    assert.ok(!("prompt_max_tokens" in plain), "普通模式不下发 Max 字段");

    // 网关只传两个参数：通道与 Max 明细须从目录推导；`__max` 后缀触发套字段
    catalog.resetRemoteCache();
    catalog.mergeRemote(catalog.parseRemoteCatalog(remotePayload()));
    try {
      const viaCatalog = upstream.buildChatBody({ model: "glm-5.2__max", messages: [] }, "glm-5.2__max");
      assert.equal(viaCatalog["model"], "glm-5.2");
      assert.equal(viaCatalog["function"], "solo_work_lite", "通道由目录推导");
      assert.deepEqual(viaCatalog["model_auto_selection"], { strategy: "max" });
      assert.equal(viaCatalog["max_tokens"], 200_000);
      const normal = upstream.buildChatBody({ model: "glm-5.2", messages: [] }, "glm-5.2");
      assert.ok(!("mode_type" in normal), "没有 __max 后缀就不是 Max 模式");
    } finally {
      catalog.resetRemoteCache();
    }
  });
});

describe("4. 请求头", () => {
  it("同一 token 设三处 + 版本头 + 设备头", () => {
    const headers = upstream.buildHeaders(makeCred());
    assert.equal(headers["Authorization"], "Cloud-IDE-JWT tok-1");
    assert.equal(headers["X-Cloudide-Token"], "tok-1");
    assert.equal(headers["X-Ide-Token"], "tok-1");
    assert.equal(headers["User-Agent"], "Trae/0.1.52");
    assert.equal(headers["X-Ide-Version"], "0.1.52", "版本是模型准入条件");
    assert.equal(headers["X-App-Version-Code"], "20260811");
    assert.equal(headers["X-Machine-Id"], "m".repeat(32));
    assert.equal(headers["X-Device-Id"], "d".repeat(32));
    assert.equal(headers["X-Uid"], "u-1");
    assert.equal(headers["Accept"], "text/event-stream");
    assert.equal(headers["X-App-Id"], "6eefa01a-1036-4c7e-9ca5-d891f63bfcd8");
  });

  it("签到头含 15 位数字设备 id 与同款 Authorization", () => {
    const headers = billing.buildCheckinHeaders(makeCred());
    assert.match(String(headers["X-Device-Id"]), /^\d{15}$/);
    assert.equal(headers["Authorization"], "Cloud-IDE-JWT tok-1");
    assert.equal(headers["X-User-Region"], "CN");
    assert.match(String(headers["X-Market-User-Id"]), /^[0-9a-f-]{36}$/);
  });
});

describe("5. event 流 → OpenAI delta（增量翻译器）", () => {
  it("一次性喂入：正文 / 思考 / finish / usage / 工具清理", () => {
    const translator = upstream.newTranslator();
    const frames = [...translator.feed(traeWire()), ...translator.finish()];
    const got = collect(frames);
    assert.equal(got.content, "答案是 42");
    assert.equal(got.reasoning, "让我想想");
    assert.deepEqual(got.finishes, ["stop"]);
    assert.deepEqual(got.usage, {
      prompt_tokens: 100,
      completion_tokens: 25,
      total_tokens: 125,
      completion_tokens_details: { reasoning_tokens: 7 },
    });
    assert.ok(got.blob.includes("data: [DONE]"), "done 事件不是 [DONE]，翻译层要补");
    const fn = got.toolCalls[0]!["function"] as Record<string, unknown>;
    assert.equal(fn["name"], "bash");
    assert.equal(fn["arguments"], '{"cmd":');
    assert.ok(!("namespace" in fn), "清理 SOLO 专属字段 namespace");
    assert.ok(!("partial_arguments" in fn), "清理 SOLO 专属字段 partial_arguments");
  });

  it("逐字节喂入（TCP 任意切分 / 中文多字节被切开）", () => {
    const wire = traeWire();
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
    assert.equal((got.toolCalls[0]!["function"] as Record<string, unknown>)["arguments"], '{"cmd":');
  });

  it("不规则切分 + 中文逐字节不产生替换字符", () => {
    const wire = traeWire();
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

    const chinese = Buffer.from('event:output\ndata:{"response":"中文流式"}\n\n', "utf8");
    const t2 = upstream.newTranslator();
    const f2: Array<Buffer | string> = [];
    for (let i = 0; i < chinese.length; i += 1) f2.push(...t2.feed(chinese.subarray(i, i + 1)));
    f2.push(...t2.finish());
    const got = collect(f2);
    assert.equal(got.content, "中文流式");
    assert.ok(!got.blob.includes("\uFFFD"), "逐 chunk toString() 会把中文切成替换字符");
  });

  it("error 事件必须显式产出 error 帧，且仍以 [DONE] 收尾", () => {
    const translator = upstream.newTranslator();
    const frames = [
      ...translator.feed(Buffer.from('event:error\ndata:{"code":1005,"message":"Plan 权益不足"}\n\n', "utf8")),
      ...translator.finish(),
    ];
    const blob = collect(frames).blob;
    assert.ok(blob.includes('"error"'), "静默当成正常结束会让 UI「干净地停止、无报错」");
    assert.ok(blob.includes("Plan 权益不足"));
    assert.ok(blob.includes("1005"));
    assert.ok(blob.trimEnd().endsWith("data: [DONE]"));
  });

  it("断流（没有 done）也补 finish_reason；噪声事件无产出", () => {
    const translator = upstream.newTranslator();
    const frames = [
      ...translator.feed(Buffer.from('event:output\ndata:{"response":"半截"}\n\n', "utf8")),
      ...translator.finish(),
    ];
    const got = collect(frames);
    assert.equal(got.content, "半截");
    assert.deepEqual(got.finishes, ["stop"]);

    const t2 = upstream.newTranslator();
    const noise = Buffer.from(': keep-alive\n\nevent:metadata\ndata:{"a":1}\n\nevent:timing_cost\ndata:{}\n\n', "utf8");
    assert.deepEqual(t2.feed(noise), []);
  });
});

describe("6. 模型目录", () => {
  it("白名单过滤 + 硬过滤 + 合并优先级 + 展示名倍率", () => {
    const entries = catalog.parseRemoteCatalog(remotePayload());
    const byId = new Map(entries.map((e) => [e.id, e]));
    const ids = [...byId.keys()];
    assert.ok(!ids.includes("only-in-chat"), "白名单外整组丢弃");
    assert.ok(!ids.includes("only-in-builder"));
    assert.ok(!ids.includes("only-in-inline"));
    assert.ok(ids.includes("solo-agent-only"));
    assert.ok(!ids.includes("custom-x"), "is_custom_model 实测 5/5 报 4001");
    assert.ok(!ids.includes("invisible-x"));
    assert.ok(!ids.includes("off-x"));
    assert.ok(!ids.includes("nonchat-x"));

    const glm = byId.get("glm-5.2")!;
    assert.equal(glm.function, "solo_work_lite", "空档位被有档位覆盖（取更靠前的有档位通道）");
    assert.equal(glm.tiered, true);
    assert.equal(glm.max_output, 32000, "__dev 取 max_tokens");
    assert.equal(glm.max_max_tokens, 200000, "__max 明细");
    assert.equal(glm.max_mode, true);
    assert.equal(glm.context_window, 200000);
    assert.equal(glm.default_effort, "high", "默认档不在 options 里 → 退到最强档");
    assert.deepEqual(glm.efforts, ["low", "high"], "档位原序");
    assert.equal(glm.name, "GLM-5.2 · x0.80→x0.08", "活动期展示名");
    assert.equal(byId.get("kimi-k3")!.name, "Kimi K3 · 免费");
  });

  it("兜底表 32 条（含 4 隐藏）；exposedIds 只放行 flash（2 条）", () => {
    assert.equal(catalog.FALLBACK_MODELS.length, 32);
    const ids = catalog.exposedIds();
    assert.equal(ids.length, 2, "28 条可见兜底里只有 2 条是 flash 家族（未登录也必须有模型）");
    assert.ok(ids.every((id) => /flash/i.test(id)), "池子里只能有 flash 家族");
    assert.ok(!ids.includes("glm-5.2") && !ids.includes("kimi-k3"), "非 flash 被白名单过滤");
    // 过滤只发生在呈现层：底层表仍含全部可见条目（含被过滤的 kimi/glm）
    const detailIds = catalog.details().map((e) => e["id"]);
    assert.equal(detailIds.length, 28, "details 仍给出 28 条可见条目（4 条隐藏不出现在其中）");
    assert.ok(detailIds.includes("kimi-k3"), "底层表含非白名单模型（数据没丢）");
    assert.ok(!ids.includes("summary") && !ids.includes("browser_use_subagent"));
    assert.equal(catalog.resolveModel("nope-1"), "nope-1", "未知原样透传");
    assert.equal(catalog.channelFor("glm-5.2"), "solo_work_lite", "缺省通道");
  });

  it("白名单 15 条，绝不含稳定被拒的通道", () => {
    assert.equal(catalog.DEFAULT_CHANNEL_WHITELIST.length, 15);
    for (const bad of ["chat", "builder", "inline_chat"]) {
      assert.ok(!catalog.DEFAULT_CHANNEL_WHITELIST.includes(bad), `${bad} 稳定被拒`);
    }
  });

  it("models.json 的 alias 覆盖暴露 id，但上游用 slug", () => {
    const dir = mkdtempSync(join(tmpdir(), "trae-models-"));
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        models: [
          { slug: "DeepSeek-V4-Flash", alias: "flash", name: "Flash", function: "solo_agent" },
        ],
      }),
      "utf8",
    );
    const savedFile = process.env["TRAE_MODELS_FILE"];
    process.env["TRAE_MODELS_FILE"] = join(dir, "models.json");
    catalog.clearCache();
    try {
      assert.deepEqual(catalog.exposedIds(), ["flash"]);
      assert.equal(catalog.resolveModel("flash"), "DeepSeek-V4-Flash");
      assert.equal(catalog.channelFor("DeepSeek-V4-Flash"), "solo_agent");
    } finally {
      if (savedFile === undefined) delete process.env["TRAE_MODELS_FILE"];
      else process.env["TRAE_MODELS_FILE"] = savedFile;
      catalog.clearCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("7. 错误分类", () => {
  it("判定顺序：1005 → 4008 → 4011 → 401 → 429 → 404 → 5xx → 4xx", () => {
    assert.equal(upstream.classifyError(200, '{"code":1005,"message":"plan"}'), "hard-plan");
    assert.equal(upstream.classifyError(200, '{"code":4008}'), "quota-exceeded");
    assert.equal(upstream.classifyError(200, '{"code":4011}'), "soft-rate");
    assert.equal(
      upstream.classifyError(200, '{"code":4008,"retry":4011}'),
      "quota-exceeded",
      "4008 必须先于 4011（否则按频率超限等 60s 而不是换号）",
    );
    assert.equal(upstream.classifyError(401, ""), "session-dead");
    assert.equal(upstream.classifyError(500, "Unauthorized"), "session-dead");
    assert.equal(upstream.classifyError(429, "too many"), "soft-rate");
    assert.equal(upstream.classifyError(404, ""), "not-found");
    assert.equal(upstream.classifyError(500, "boom"), "server");
    assert.equal(upstream.classifyError(400, "bad"), "client");
    assert.equal(upstream.classifyError(200, "{}"), "none");
  });

  it("冷却时长", () => {
    assert.equal(upstream.cooldownSeconds("hard-plan"), 43200);
    assert.equal(upstream.cooldownSeconds("soft-rate"), 60);
    assert.equal(upstream.cooldownSeconds("session-dead"), null, "永久（需重新登录）");
    assert.equal(upstream.cooldownSeconds("none"), null);
  });
});

describe("8. 额度、签到与续期", () => {
  it("usage 解析权益包（秒级 expire_time → 天数），status 给出可领签到", async () => {
    const state = { checked: false };
    const fake = await startFake((req) => {
      if (req.path === billing.USAGE_PATH) {
        return {
          payload: JSON.stringify({
            user_entitlement_pack_list: [
              {
                entitlement_base_info: {
                  display_desc: "TRAE 免费额度",
                  quota: { credits_limit: 1000 },
                },
                usage: { credits_amount: 250 },
                expire_time: Math.floor(Date.now() / 1000) + 3 * 86400 + 120, // 秒级
              },
            ],
          }),
        };
      }
      if (req.path === billing.CHECKIN_STATUS_PATH) {
        return {
          payload: JSON.stringify({
            code: 0,
            checked_in: state.checked,
            enable: true,
            credits: 150,
            streak_days: 3,
          }),
        };
      }
      return { status: 404, payload: JSON.stringify({ code: 404 }) };
    });
    const savedHost = process.env["TRAE_UG_HOST"];
    process.env["TRAE_UG_HOST"] = fake.base;
    await cred.save(makeCred({ uid: "u-b" }));
    try {
      const info = await billing.fetchCredits();
      const usageReq = fake.requests.find((r) => r.path === billing.USAGE_PATH)!;
      assert.equal(usageReq.body?.["require_usage"], true);
      assert.equal(usageReq.body?.["req_source"], 2);
      assert.equal(usageReq.headers["authorization"], "Cloud-IDE-JWT tok-1");
      assert.match(String(usageReq.headers["x-device-id"]), /^\d{15}$/);
      assert.equal(info.packages[0]!.name, "TRAE 免费额度");
      assert.equal(info.packages[0]!.remain, 750);
      assert.equal(info.packages[0]!.days_left, 3, "expire_time 是秒级 Unix");
      assert.equal(info.total.remain, 750);
      assert.deepEqual(info.claimable?.map((c) => c["campaign_id"]), ["trae-daily-checkin"]);
    } finally {
      if (savedHost === undefined) delete process.env["TRAE_UG_HOST"];
      else process.env["TRAE_UG_HOST"] = savedHost;
      await closeServer(fake.server);
    }
  });

  it("claim body 是 {}，响应不含积分数 → 必须补查 status；9074 轮换设备代次", async () => {
    const state = { checked: false };
    let statusCalls = 0;
    const fake = await startFake((req) => {
      if (req.path === billing.CHECKIN_STATUS_PATH) {
        statusCalls += 1;
        return {
          payload: JSON.stringify({
            code: 0,
            checked_in: state.checked,
            enable: true,
            credits: 150,
            streak_days: 3,
          }),
        };
      }
      if (req.path === billing.CHECKIN_CLAIM_PATH) {
        state.checked = true;
        return { payload: JSON.stringify({ code: 0, message: "success" }) };
      }
      return { status: 404, payload: JSON.stringify({ code: 404 }) };
    });
    const savedHost = process.env["TRAE_UG_HOST"];
    process.env["TRAE_UG_HOST"] = fake.base;
    await cred.save(makeCred({ uid: "u-b" }));
    try {
      const result = await billing.claimDaily();
      const claimReq = fake.requests.find((r) => r.path === billing.CHECKIN_CLAIM_PATH)!;
      assert.deepEqual(claimReq.body, {}, "claim 的 body 是 {}（不是 {req_source:2}）");
      assert.equal(result.already, false);
      assert.equal(result.credits, 150, "claim 响应不含积分数，必须补查 status");
      assert.equal(statusCalls, 2, "claim 前后各查一次 status");

      // 9074（设备级限流）→ 轮换签到设备代次
      state.checked = false;
      const failing = await startFake((req) => {
        if (req.path === billing.CHECKIN_STATUS_PATH) {
          return { payload: JSON.stringify({ code: 0, checked_in: false, enable: true }) };
        }
        return { payload: JSON.stringify({ code: 9074, message: "too many" }) };
      });
      process.env["TRAE_UG_HOST"] = failing.base;
      await cred.save(makeCred({ uid: "u-b", checkinGeneration: 0 }));
      try {
        await assert.rejects(
          billing.claimDaily(),
          (err: Error) => err.message.includes("9074"),
        );
        assert.equal(cred.load().checkinGeneration, 1, "9074 后轮换代次");
      } finally {
        await closeServer(failing.server);
      }
    } finally {
      if (savedHost === undefined) delete process.env["TRAE_UG_HOST"];
      else process.env["TRAE_UG_HOST"] = savedHost;
      await closeServer(fake.server);
    }
  });

  it("续期：access 与 refresh 都轮换并回写；失效率判终态", async () => {
    const fake = await startFake(() => ({
      payload: JSON.stringify({
        Result: { Token: "at-new", RefreshToken: "rt-new", TokenExpireAt: "1900000000000" },
      }),
    }));
    const savedHost = process.env["TRAE_OAUTH_HOST"];
    process.env["TRAE_OAUTH_HOST"] = fake.base;
    await cred.save(
      makeCred({ accessToken: "at-old", refreshToken: "rt-old", domain: "trae-api-cn.mchost.guru" }),
    );
    try {
      const updated = await cred.refresh(cred.load());
      const sent = fake.requests.at(-1)!.body!;
      assert.equal(sent["ClientID"], "en1oxy7wnw8j9n");
      assert.equal(sent["RefreshToken"], "rt-old");
      assert.equal(updated.accessToken, "at-new");
      assert.equal(updated.refreshToken, "rt-new");
      assert.equal(updated.expiresAt, "1900000000000");
      assert.equal(updated.machineId, "m".repeat(32), "设备指纹不动");
      assert.equal(updated.deviceId, "d".repeat(32));
      assert.equal(cred.load().accessToken, "at-new", "续期后必须回写");
    } finally {
      await closeServer(fake.server);
    }

    // 2xx 是 JSON 却没有 accessToken ⇒ 终态
    const missing = await startFake(() => ({ payload: JSON.stringify({ Result: { RefreshToken: "rt-x" } }) }));
    process.env["TRAE_OAUTH_HOST"] = missing.base;
    try {
      await assert.rejects(cred.refresh(cred.load()), cred.ReloginRequiredError);
    } finally {
      await closeServer(missing.server);
    }

    // HTML 错误页也必须判终态（凭据失效时上游回 HTML，不能直接 .json()）
    const html = await startFake(() => ({ contentType: "text/html", payload: "<html>login</html>" }));
    process.env["TRAE_OAUTH_HOST"] = html.base;
    try {
      await assert.rejects(cred.refresh(cred.load()), cred.ReloginRequiredError);
    } finally {
      if (savedHost === undefined) delete process.env["TRAE_OAUTH_HOST"];
      else process.env["TRAE_OAUTH_HOST"] = savedHost;
      await closeServer(html.server);
    }
  });
});

describe("9. 端到端网关（假上游 + 真实网关）", () => {
  let fake: Awaited<ReturnType<typeof startFake>>;
  let gw: gateway.RunningGateway;
  let savedConfig: ReturnType<typeof upstream.defaultConfig>;
  let mode: { status: number } = { status: 200 };

  const traeFrames = (): string =>
    [
      'event:output\ndata:{"response":"网关","reasoning_content":null}\n\n',
      'event:output\ndata:{"response":"通了","reasoning_content":null}\n\n',
      'event:token_usage\ndata:{"prompt_tokens":7,"completion_tokens":2}\n\n',
      'event:done\ndata:{"finish_reason":"stop"}\n\n',
    ].join("");

  before(async () => {
    fake = await startFake((req) => {
      if (mode.status !== 200) return { status: mode.status, payload: "internal detail leak" };
      if (req.path === upstream.CHAT_PATH) {
        return { contentType: "text/event-stream", payload: traeFrames() };
      }
      if (req.path === upstream.MODELS_PATH) {
        return { payload: JSON.stringify(remotePayload()) };
      }
      return { status: 404, payload: JSON.stringify({ code: 404 }) };
    });
    savedConfig = upstream.loadConfig()[0];
    await upstream.saveConfig({ ...upstream.defaultConfig(), baseUrl: fake.base });
    await cred.save(makeCred({ accessToken: "tok-e2e", uid: "u-e2e", deviceId: "b".repeat(32) }));

    // 远端目录：真实调用 fetchModels（22 个通道）后解析入缓存
    catalog.resetRemoteCache();
    catalog.mergeRemote(catalog.parseRemoteCatalog(await upstream.fetchModels(cred.load())));
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await closeServer(fake.server);
    await upstream.saveConfig(savedConfig);
    catalog.resetRemoteCache();
  });

  it("/v1/models 来自远端且已过滤；目录请求带 22 个通道", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/models`);
    const payload = (await resp.json()) as { data: Array<{ id: string }> };
    const ids = payload.data.map((m) => m.id);
    assert.deepEqual(
      ids,
      ["deepseek-v4.1-flash", "deepseek-v4-flash", "glm-5.3-flash"],
      "对外只有三个池模型（不带渠道前缀）",
    );
    assert.ok(
      ids.every((id) => !id.includes("/")),
      "不再暴露 <cid>/<模型> 形态",
    );
    // 远端目录确实被采信：非白名单条目被过滤但数据没丢（solo-agent-only 只在远端载荷里）
    const detailIds = catalog.details().map((e) => e["id"]);
    assert.ok(detailIds.includes("solo-agent-only") && detailIds.includes("kimi-k3"), "过滤发生在呈现层，底层目录未丢数据");
    const modelsReq = fake.requests.find((r) => r.path === upstream.MODELS_PATH)!;
    assert.equal((modelsReq.body?.["functions"] as string[]).length, 22);
    assert.equal(modelsReq.headers["authorization"], "Cloud-IDE-JWT tok-e2e");
  });

  it("流式对话：event 流被增量翻译；核对上游真实收到的头与体", async () => {
    fake.requests.length = 0;
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 200);
    assert.ok(resp.headers.get("content-type")?.includes("text/event-stream"));
    const text = await resp.text();
    assert.equal(contentOf(text), "网关通了");

    const sent = fake.requests.find((r) => r.path === upstream.CHAT_PATH)!;
    assert.equal(sent.headers["authorization"], "Cloud-IDE-JWT tok-e2e");
    assert.equal(sent.headers["x-cloudide-token"], "tok-e2e");
    assert.equal(sent.headers["x-ide-token"], "tok-e2e");
    assert.equal(sent.headers["x-device-id"], "b".repeat(32));
    const body = sent.body!;
    assert.equal(body["function"], "solo_agent", "deepseek 走 solo_agent 通道");
    assert.equal(body["model"], "DeepSeek-V4-Flash", "上游收到目录里的原始写法（大小写敏感）");
    assert.equal(body["config_name"], "DeepSeek-V4-Flash", "model 与 config_name 双字段同值");
    assert.equal(body["stream"], true);
    const messages = body["messages"] as Array<{ content: Array<Record<string, unknown>> }>;
    assert.equal(messages[0]!.content[0]!["type"], "text");
  });

  it("非流式：本层聚合成 chat.completion", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] }),
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

  it("请求校验：缺 model/messages 返回 400 统一信封", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "glm-5.2" }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 400);
    const payload = (await resp.json()) as { error: { code: string } };
    assert.equal(payload.error.code, "invalid_request");
  });

  it("上游 500 → 502 upstream_error 且不回传上游原文", async () => {
    mode.status = 500;
    try {
      const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], stream: true }),
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

  it("/health 报告 ok 与登录状态", async () => {
    const resp = await fetch(`http://${gw.addr}/health`);
    const payload = (await resp.json()) as Record<string, unknown>;
    assert.equal(payload["ok"], true);
    assert.equal(payload["logged_in"], true);
  });
});
