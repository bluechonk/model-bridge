/**
 * gemini-bridge 自检（完全离线，不出网）。
 *
 * 覆盖：
 *  1. 渠道装配与路径（GEMINI_HOME 隔离）
 *  2. 凭据（未登录 / 落盘读回 / 损坏容忍 / 老凭据补字段）
 *  3. OAuth 授权 URL 与本地回调（参数逐字、先监听后拼 URL、state 校验）
 *  4. 请求体改写（Cloud Code 信封关键字段、字母序键序、档位、sessionId）
 *  5. 请求头（身份五头逐字、无 x-goog-api-key / x-goog-api-client）
 *  6. 工具 schema 清洗（白名单删除 / type 数组收敛 / enum 非字符串整删）
 *  7. Gemini SSE → OpenAI delta 的增量翻译（含**逐字节喂入**、usage 取最大、
 *     工具调用独占块、思考签名不存、error 帧、断流补帧）
 *  8. 模型目录（兜底静态表、flash-only 池、未知透传）
 *  9. 额度（桶解析、端到端假上游、失败抛 CreditsError、未登录抛 NotLoggedInError）
 * 10. 端到端网关（假上游 + 真实网关，流式与非流式都出正文）+ 登录全链路
 *
 * 数据目录用 GEMINI_HOME 隔离，绝不碰真实凭据；上游 / OAuth 端点全部指向假服务。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// 必须在 import 被测模块之前设置（paths 每次调用都重新解析存储根）
const HOME = mkdtempSync(join(tmpdir(), "gemini-selftest-"));
process.env["MODEL_BRIDGE_HOME"] = HOME;
process.env["GEMINI_NO_BROWSER"] = "1";

// 共享层来自工作区包；先注册本渠道（副作用）再引渠道模块
const gw = await import("@model-bridge/gateway");
await import("../dist/channel.js");
const billing = await import("../dist/billing.js");
const catalog = await import("../dist/catalog.js");
const cred = await import("../dist/cred.js");
const upstream = await import("../dist/upstream.js");

const { paths, gateway } = gw;

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
        if (typeof delta["content"] === "string") content += delta["content"] as string;
        if (typeof delta["reasoning_content"] === "string") reasoning += delta["reasoning_content"] as string;
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

/** 构造一段 Gemini 流式 SSE（思考 + 正文 + 工具无关 + usage 收尾 + [DONE]）。 */
function geminiWire(withSignature = false): Buffer {
  const thoughtPart: Record<string, unknown> = { thought: true, text: "想想" };
  if (withSignature) thoughtPart["thoughtSignature"] = "SIG-DEADBEEF";
  const frames: unknown[] = [
    {
      response: {
        candidates: [{ content: { role: "model", parts: [thoughtPart] } }],
        usageMetadata: { promptTokenCount: 100, totalTokenCount: 100 },
      },
    },
    {
      response: {
        candidates: [{ content: { role: "model", parts: [{ text: "答案" }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, totalTokenCount: 105 },
      },
    },
    {
      response: {
        candidates: [
          { content: { role: "model", parts: [{ text: "是 42" }] }, finishReason: "STOP" },
        ],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 25,
          thoughtsTokenCount: 7,
          cachedContentTokenCount: 0,
          totalTokenCount: 125,
        },
      },
    },
    // 纯 usageMetadata 的收尾帧：candidates 为空，不算内容帧但要继续读
    {
      response: {
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 25, totalTokenCount: 125 },
      },
    },
  ];
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  return Buffer.from(`${body}data: [DONE]\n\n`, "utf8");
}

function jwt(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${payload}.sig`;
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

describe("1. 渠道装配与路径", () => {
  it("注册进共享 gateway 层，静态配置就位", () => {
    assert.equal(gw.hasChannel(), true);
    const channel = gw.getChannel();
    assert.equal(channel.config.cid, "gemini");
    assert.equal(channel.config.display, "Gemini Code Assist");
    assert.equal(channel.config.legacyDirs[0], ".gemini-bridge");
    assert.equal(channel.upstream.DISPLAY_NAME, "Gemini Code Assist");
    assert.equal(channel.upstream.WIRE, "custom", "Gemini SSE 需翻译层");
  });

  it("存储目录隔离在 MODEL_BRIDGE_HOME 下（不碰真实主目录）", () => {
    assert.equal(paths.rootDir(), HOME);
    assert.equal(paths.channelDir(), join(HOME, "gemini"));
    assert.equal(paths.credentialsPath(), join(HOME, "gemini", "credentials.json"));
  });
});

describe("2. 凭据", () => {
  it("未登录时抛 NotLoggedInError", () => {
    rmSync(paths.credentialsPath(), { force: true });
    assert.throws(() => cred.load(), cred.NotLoggedInError);
  });

  it("落盘为 snake_case，读回为契约形态", async () => {
    await cred.save({
      ...cred.EMPTY_CREDENTIALS,
      accessToken: "at-1",
      refreshToken: "rt-1",
      tokenType: "Bearer",
      expiresIn: 3600,
      scope: "openid",
      expiry: new Date(Date.now() + 3600_000).toISOString(),
      uid: "sub-1",
      email: "a@b.c",
      cloudaicompanionProject: "proj-1",
      domain: "daily-cloudcode-pa.googleapis.com",
      obtainedAt: new Date().toISOString(),
    });
    const disk = JSON.parse(readFileSync(paths.credentialsPath(), "utf8")) as Record<string, unknown>;
    assert.equal(disk["access_token"], "at-1");
    assert.equal(disk["refresh_token"], "rt-1");
    assert.equal(disk["sub"], "sub-1", "身份落在 sub（PROTOCOL §2.1）");
    assert.equal(disk["cloudaicompanionProject"], "proj-1");
    const c = cred.load();
    assert.equal(c.accessToken, "at-1");
    assert.equal(c.uid, "sub-1");
    assert.equal(c.email, "a@b.c");
    assert.equal(c.cloudaicompanionProject, "proj-1");
  });

  it("老凭据缺新字段时就地补默认，不拒绝整条凭据", () => {
    writeFileSync(paths.credentialsPath(), JSON.stringify({ access_token: "at-old", sub: "u" }), "utf8");
    const c = cred.load();
    assert.equal(c.accessToken, "at-old");
    assert.equal(c.tokenType, "", "缺字段补空串而非拒绝");
    assert.equal(c.expiresIn, 3600, "expires_in 缺失默认 3600");
  });

  it("损坏 / 结构不对 / 空 token 都按未登录处理", () => {
    writeFileSync(paths.credentialsPath(), "{ not json", "utf8");
    assert.throws(() => cred.load(), cred.NotLoggedInError);
    writeFileSync(paths.credentialsPath(), JSON.stringify(["x"]), "utf8");
    assert.throws(() => cred.load(), cred.NotLoggedInError);
    writeFileSync(paths.credentialsPath(), JSON.stringify({ access_token: "" }), "utf8");
    assert.throws(() => cred.load(), cred.NotLoggedInError);
  });

  it("过期判定含 60 秒余量；无从判断时保守视为未过期", () => {
    const soon = { ...cred.EMPTY_CREDENTIALS, expiry: new Date(Date.now() + 30_000).toISOString() };
    assert.equal(cred.isExpired(soon), true, "30 秒内到期，在 60 秒余量内视为已过期");
    const later = { ...cred.EMPTY_CREDENTIALS, expiry: new Date(Date.now() + 600_000).toISOString() };
    assert.equal(cred.isExpired(later), false);
    assert.equal(cred.isExpired(cred.EMPTY_CREDENTIALS), false, "expiry 为空不冒充已失效");
  });
});

describe("3. OAuth 授权 URL 与本地回调", () => {
  it("授权 URL 参数逐字（含 offline / consent / state）", () => {
    const url = cred.buildAuthorizeUrl("http://localhost:8845/oauth-callback", "abc123");
    const params = new URL(url).searchParams;
    assert.equal(params.get("client_id"), cred.GEMINI_DEFAULT_CLIENT_ID);
    assert.equal(params.get("response_type"), "code");
    assert.equal(params.get("redirect_uri"), "http://localhost:8845/oauth-callback");
    assert.equal(params.get("state"), "abc123");
    assert.equal(params.get("access_type"), "offline");
    assert.equal(params.get("include_granted_scopes"), "true");
    assert.equal(params.get("prompt"), "consent");
    // 六个 scope 逐字
    for (const scope of cred.OAUTH_SCOPES) assert.ok(params.get("scope")!.includes(scope));
  });

  it("本地回调服务器真实起端口并解析回调；state 校验不通过即拒绝", async () => {
    const srv = await cred.startCallbackServer({ port: 0, pathPrefix: cred.CALLBACK_PATH });
    try {
      const query = new URLSearchParams({ code: "code-1", state: "good-state" });
      const resp = await fetch(`http://127.0.0.1:${srv.port}${cred.CALLBACK_PATH}?${query}`);
      assert.equal(resp.status, 200);
      const flat = await srv.wait(3000, "good-state");
      assert.equal(flat["code"], "code-1");
    } finally {
      srv.close();
    }

    // state 不匹配必须拒绝（PROTOCOL §2.2）
    const srv2 = await cred.startCallbackServer({ port: 0, pathPrefix: cred.CALLBACK_PATH });
    try {
      const query = new URLSearchParams({ code: "code-2", state: "evil" });
      const resp2 = await fetch(`http://127.0.0.1:${srv2.port}${cred.CALLBACK_PATH}?${query}`);
      assert.equal(resp2.status, 200);
      await assert.rejects(() => srv2.wait(3000, "expected-state"), /state 校验失败/);
    } finally {
      srv2.close();
    }
  });
});

describe("4. 请求体：OpenAI → Cloud Code 信封", () => {
  before(async () => {
    await upstream.saveConfig({ ...upstream.defaultConfig(), project: "proj-x" });
  });

  it("信封关键字段 + 字母序键序 + 默认档位 medium", () => {
    const body = upstream.buildChatBody(
      {
        model: "gemini-3.8-flash",
        messages: [
          { role: "system", content: "你是助手" },
          { role: "user", content: "你好" },
          { role: "assistant", content: "你好！" },
          { role: "user", content: "再来" },
        ],
      },
      "gemini-3.8-flash",
    );
    // 键序即字母序（§3.2 逐层字母序序列化）
    assert.deepEqual(Object.keys(body), ["model", "project", "request", "requestId", "userAgent"]);
    assert.equal(body["model"], "gemini-3.8-flash-medium", "上游模型名 = 裸名 + 档位后缀");
    assert.equal(body["project"], "proj-x", "project 来自上游配置");
    assert.equal(body["userAgent"], "antigravity");
    assert.match(String(body["requestId"]), /^agent\/\d+\/[0-9a-f]{8}$/);

    const request = body["request"] as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(request),
      ["contents", "generationConfig", "sessionId", "systemInstruction"],
      "request 键也是字母序",
    );
    const contents = request["contents"] as Array<Record<string, unknown>>;
    assert.deepEqual(contents.map((c) => c["role"]), ["user", "model", "user"], "assistant→model");
    const system = request["systemInstruction"] as Record<string, unknown>;
    assert.equal(system["role"], "system");
    assert.equal((system["parts"] as Array<Record<string, unknown>>)[0]!["text"], "你是助手");

    const gen = request["generationConfig"] as Record<string, unknown>;
    assert.equal(gen["maxOutputTokens"], 64_000, "缺省 maxOutputTokens 64000");
    const thinking = gen["thinkingConfig"] as Record<string, unknown>;
    assert.equal(thinking["includeThoughts"], true, "includeThoughts 恒 true");
    assert.equal(thinking["thinkingBudget"], 4000, "medium 档预算 4000");

    const sessionId = request["sessionId"] as string;
    assert.match(sessionId, /^-?\d+$/, "sessionId 是有符号十进制串");
    assert.equal(
      sessionId,
      upstream.deriveGeminiSessionId("proj-x", "你好", "infer"),
      "sessionId = f(project, contents[0].text, lane)",
    );
  });

  it("档位：high 给 10000、tiered 只发 includeThoughts、未知归一 medium", () => {
    const high = upstream.buildChatBody(
      { model: "x", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
      "gemini-3.8-flash",
    );
    const highReq = high["request"] as Record<string, unknown>;
    assert.equal(high["model"], "gemini-3.8-flash-high");
    assert.equal(
      ((highReq["generationConfig"] as Record<string, unknown>)["thinkingConfig"] as Record<string, unknown>)["thinkingBudget"],
      10000,
    );

    const tiered = upstream.buildChatBody(
      { model: "x", messages: [{ role: "user", content: "hi" }], reasoning_effort: "tiered" },
      "gemini-3.8-flash",
    );
    const tieredThinking = ((tiered["request"] as Record<string, unknown>)["generationConfig"] as Record<string, unknown>)[
      "thinkingConfig"
    ] as Record<string, unknown>;
    assert.equal(tieredThinking["includeThoughts"], true);
    assert.ok(!("thinkingBudget" in tieredThinking), "tiered 档只发 includeThoughts");

    const unknown = upstream.buildChatBody(
      { model: "x", messages: [{ role: "user", content: "hi" }], reasoning_effort: "nope" },
      "gemini-3.8-flash",
    );
    assert.equal(unknown["model"], "gemini-3.8-flash-medium", "未知档位归一 medium");
  });

  it("模型 id 归一：剥掉已知档位后缀", () => {
    assert.equal(upstream.stripTierSuffix("gemini-3.8-flash-high"), "gemini-3.8-flash");
    assert.equal(upstream.stripTierSuffix("gemini-3.8-flash"), "gemini-3.8-flash");
    assert.equal(upstream.applyTier("gemini-3.8-flash-high", "low"), "gemini-3.8-flash-low");
  });

  it("工具：functionDeclarations 走清洗，tool_choice 归一", () => {
    const body = upstream.buildChatBody(
      {
        model: "x",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "bash",
              description: "执行",
              parameters: {
                type: "object",
                properties: { cmd: { type: "string", unknownKey: 1 } },
                additionalProperties: false, // 白名单外 → 删除
              },
            },
          },
        ],
        tool_choice: "required",
      },
      "gemini-3.8-flash",
    );
    const request = body["request"] as Record<string, unknown>;
    const tools = request["tools"] as Array<Record<string, unknown>>;
    const decls = tools[0]!["functionDeclarations"] as Array<Record<string, unknown>>;
    assert.equal(decls[0]!["name"], "bash");
    const schema = decls[0]!["parameters"] as Record<string, unknown>;
    assert.ok(!("additionalProperties" in schema), "白名单外键整删（上游硬 400）");
    const cmd = (schema["properties"] as Record<string, unknown>)["cmd"] as Record<string, unknown>;
    assert.ok(!("unknownKey" in cmd), "properties 递归清洗");
    const toolConfig = request["toolConfig"] as Record<string, unknown>;
    assert.deepEqual((toolConfig["functionCallingConfig"] as Record<string, unknown>)["mode"], "ANY");
  });

  it("工具结果：functionResponse 的 name 来自 tool_use.name 映射；无 name 整块丢弃", () => {
    const body = upstream.buildChatBody(
      {
        model: "x",
        messages: [
          { role: "user", content: "跑一下" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
          },
          { role: "tool", tool_call_id: "call_1", content: "ok" },
          { role: "tool", tool_call_id: "no-such", content: "dropped" },
        ],
      },
      "gemini-3.8-flash",
    );
    const contents = (body["request"] as Record<string, unknown>)["contents"] as Array<Record<string, unknown>>;
    const assistantParts = contents.find((c) => c["role"] === "model")!["parts"] as Array<Record<string, unknown>>;
    const fnCall = assistantParts.find((p) => p["functionCall"])!["functionCall"] as Record<string, unknown>;
    assert.equal(fnCall["name"], "bash");
    assert.deepEqual(fnCall["args"], { cmd: "ls" });
    const fnResponses = contents
      .flatMap((c) => c["parts"] as Array<Record<string, unknown>>)
      .filter((p) => p["functionResponse"])
      .map((p) => p["functionResponse"] as Record<string, unknown>);
    assert.equal(fnResponses.length, 1, "无 name 的工具结果整块丢弃");
    assert.equal(fnResponses[0]!["name"], "bash", "name 来自 tool_use 映射（上游按 name 配对）");
    assert.equal((fnResponses[0]!["response"] as Record<string, unknown>)["content"], "ok");
  });

  it("sessionId 只吃 project / contents[0].text / lane（不吃 model、轮数）", () => {
    const a = upstream.deriveGeminiSessionId("p", "hello", "infer");
    assert.equal(upstream.deriveGeminiSessionId("p", "hello", "infer"), a, "同输入同输出");
    assert.notEqual(upstream.deriveGeminiSessionId("p2", "hello", "infer"), a);
    assert.notEqual(upstream.deriveGeminiSessionId("p", "other", "infer"), a);
    assert.notEqual(upstream.deriveGeminiSessionId("p", "hello", "smoke"), a);
    upstream.setGeneration(0);
    const gen0 = upstream.deriveGeminiSessionId("p", "hello", "infer", 0);
    const gen1 = upstream.deriveGeminiSessionId("p", "hello", "infer", 1);
    assert.notEqual(gen0, gen1, "升代换全新 sessionId");
    upstream.setGeneration(0);
  });
});

describe("5. 请求头", () => {
  it("Bearer + 身份五头逐字；无 x-goog-api-key / x-goog-api-client", () => {
    const headers = upstream.buildHeaders({ accessToken: "tok-1" });
    assert.equal(headers["Authorization"], "Bearer tok-1");
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers["User-Agent"], "antigravity/4.3.0 (cmdc-pak)");
    assert.equal(headers["x-client-name"], "antigravity");
    assert.equal(headers["x-client-version"], "4.3.0");
    assert.equal(headers["x-machine-id"], "cmdc-pak");
    assert.equal(headers["x-vscode-sessionid"], "proxy");
    assert.ok(!("x-goog-api-key" in headers));
    assert.ok(!("x-goog-api-client" in headers));
  });
});

describe("6. 工具 schema 清洗", () => {
  it("白名单外删除 / type 数组收敛 / enum 非字符串整删", () => {
    const cleaned = upstream.sanitizeGeminiSchema({
      type: ["string", "null"],
      enum: ["a", "b"],
      description: "d",
      format: "date",
      notAllowed: true,
      $ref: "#/x",
    });
    assert.equal(cleaned["type"], "string", "数组 type 收敛成单个");
    assert.equal(cleaned["nullable"], true, "含 null 补 nullable:true");
    assert.deepEqual(cleaned["enum"], ["a", "b"]);
    assert.ok(!("notAllowed" in cleaned) && !("$ref" in cleaned));
    assert.equal(cleaned["format"], "date");

    const badEnum = upstream.sanitizeGeminiSchema({ type: "string", enum: ["a", 1] });
    assert.ok(!("enum" in badEnum), "enum 含非字符串值整删");
  });
});

describe("7. Gemini SSE → OpenAI delta（增量翻译器）", () => {
  it("一次性喂入：正文 / 思考 / finish / usage（取最大 total）/ [DONE]", () => {
    const translator = upstream.newTranslator();
    const frames = [...translator.feed(geminiWire()), ...translator.finish()];
    const got = collect(frames);
    assert.equal(got.content, "答案是 42");
    assert.equal(got.reasoning, "想想");
    assert.deepEqual(got.finishes, ["stop"]);
    assert.deepEqual(got.usage, {
      prompt_tokens: 100,
      completion_tokens: 25,
      total_tokens: 125,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 7 },
    });
    assert.ok(got.blob.includes("data: [DONE]"));
    assert.ok(!got.blob.includes("SIG-DEADBEEF"), "思考分片签名刻意不存");
  });

  it("逐字节喂入（TCP 任意切分 / 中文多字节被切开）", () => {
    const wire = geminiWire();
    const translator = upstream.newTranslator();
    const frames: Array<Buffer | string> = [];
    for (let i = 0; i < wire.length; i += 1) {
      frames.push(...translator.feed(wire.subarray(i, i + 1)));
    }
    frames.push(...translator.finish());
    const got = collect(frames);
    assert.equal(got.content, "答案是 42");
    assert.equal(got.reasoning, "想想");
    assert.deepEqual(got.finishes, ["stop"]);
    assert.deepEqual(got.usage, {
      prompt_tokens: 100,
      completion_tokens: 25,
      total_tokens: 125,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 7 },
    });
    assert.ok(!got.blob.includes("\uFFFD"), "逐 chunk toString() 会把中文切成替换字符");
  });

  it("不规则块大小喂入", () => {
    const wire = geminiWire();
    const translator = upstream.newTranslator();
    const frames: Array<Buffer | string> = [];
    let pos = 0;
    for (const size of [7, 1, 33, 100, 2, 512, 5, 1000]) {
      while (pos < wire.length) {
        frames.push(...translator.feed(wire.subarray(pos, pos + size)));
        pos += size;
      }
      break;
    }
    frames.push(...translator.finish());
    assert.equal(collect(frames).content, "答案是 42");
  });

  it("工具调用独占一个块，参数一次性发完", () => {
    const wire = Buffer.from(
      `data: ${JSON.stringify({
        response: {
          candidates: [
            {
              content: { parts: [{ functionCall: { name: "bash", args: { cmd: "ls" } } }] },
              finishReason: "STOP",
            },
          ],
        },
      })}\n\ndata: [DONE]\n\n`,
      "utf8",
    );
    const translator = upstream.newTranslator();
    const got = collect([...translator.feed(wire), ...translator.finish()]);
    assert.deepEqual(got.finishes, ["tool_calls"], "有工具调用 → tool-calls");
    assert.equal((got.toolCalls[0]!["function"] as Record<string, unknown>)["name"], "bash");
    assert.equal((got.toolCalls[0]!["function"] as Record<string, unknown>)["arguments"], '{"cmd":"ls"}');
    assert.match(String(got.toolCalls[0]!["id"]), /^gemini_tool_/);
  });

  it("error 帧必须显式产出，且仍以 [DONE] 收尾", () => {
    const translator = upstream.newTranslator();
    const frames = [
      ...translator.feed(Buffer.from('data: {"error":{"code":400,"message":"上游过载"}}\n\n', "utf8")),
      ...translator.finish(),
    ];
    const blob = collect(frames).blob;
    assert.ok(blob.includes('"error"'), "静默当成正常结束会让 UI「干净地停止、无报错」");
    assert.ok(blob.includes("上游过载"));
    assert.ok(blob.trimEnd().endsWith("data: [DONE]"));
  });

  it("断流（无 [DONE]）也补 finish_reason；无任何内容块 → 抛错", () => {
    const partial = upstream.newTranslator();
    const frames = [
      ...partial.feed(
        Buffer.from(
          `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "半截" }] } }] } })}\n\n`,
          "utf8",
        ),
      ),
      ...partial.finish(),
    ];
    const got = collect(frames);
    assert.equal(got.content, "半截");
    assert.deepEqual(got.finishes, ["stop"]);

    const empty = upstream.newTranslator();
    empty.feed(
      Buffer.from('data: {"response":{"usageMetadata":{"totalTokenCount":5}}}\n\n', "utf8"),
    );
    assert.throws(() => empty.finish(), /没有任何内容块/);
  });

  it("注释行与纯 usage 帧不产出内容", () => {
    const translator = upstream.newTranslator();
    const frames = translator.feed(
      Buffer.from(': keep-alive\n\ndata: {"response":{"usageMetadata":{"totalTokenCount":9}}}\n\n', "utf8"),
    );
    assert.deepEqual(frames, []);
  });
});

describe("8. 模型目录", () => {
  it("池内只放行 flash；兜底表 1 条；未知透传", () => {
    assert.deepEqual(catalog.exposedIds(), ["gemini-3.8-flash"], "flash-only 池策略");
    assert.equal(catalog.resolveModel("gemini-3.8-flash"), "gemini-3.8-flash");
    assert.equal(catalog.resolveModel("gemini-3.8-flash-high"), "gemini-3.8-flash", "剥档位后缀");
    assert.equal(catalog.resolveModel("totally-bogus"), "totally-bogus", "未知原样透传");
    assert.equal(catalog.loadCatalog().length, 1);
  });

  it("不暴露 lite（真机恒 404）与 4 个带后缀的模型名", () => {
    const ids = catalog.exposedIds();
    assert.ok(!ids.some((id) => id.includes("lite")));
    assert.ok(!ids.some((id) => id.endsWith("-low") || id.endsWith("-tiered")));
  });

  it("details 供状态页（含档位与窗口）", () => {
    const detail = catalog.details()[0]!;
    assert.equal(detail["id"], "gemini-3.8-flash");
    assert.equal(detail["context_window"], 1_000_000);
    assert.equal(detail["max_output"], 64_000);
    assert.deepEqual(detail["efforts"], ["low", "medium", "high", "tiered"]);
    assert.equal(detail["default_effort"], "medium");
  });
});

describe("9. 额度（配额窗口）", () => {
  it("按 bucketId 匹配；resetTime 解析失败的桶整条丢弃", () => {
    const buckets = billing.parseQuotaBuckets({
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "gemini-weekly", window: "weekly", resetTime: "2026-01-01T00:00:00Z", remainingFraction: 0.99 },
            { bucketId: "gemini-5h", window: "5h", resetTime: "not-a-date", remainingFraction: 0.2 },
          ],
        },
        { displayName: "Claude and GPT models", buckets: [{ bucketId: "3p-x", remainingFraction: 0.5 }] },
      ],
    });
    assert.equal(buckets.length, 1, "resetTime 解析失败的桶被丢弃，3p-* 与本 provider 无关");
    assert.equal(buckets[0]!.bucketId, "gemini-weekly");
  });

  before(async () => {
    billing.clearCache();
  });

  it("端到端假上游：两桶平均百分比、单位 %、透出 tier", async () => {
    const fake = await startFake((req) => {
      if (req.path.endsWith("loadCodeAssist")) {
        return { payload: JSON.stringify({ paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } }) };
      }
      if (req.path.endsWith("retrieveUserQuotaSummary")) {
        return {
          payload: JSON.stringify({
            groups: [
              {
                displayName: "Gemini Models",
                buckets: [
                  { bucketId: "gemini-weekly", window: "weekly", resetTime: "2026-01-01T00:00:00Z", remainingFraction: 0.99 },
                  { bucketId: "gemini-5h", window: "5h", resetTime: "2026-01-01T00:00:00Z", remainingFraction: 0.2 },
                ],
              },
            ],
          }),
        };
      }
      return { status: 404, payload: "{}" };
    });
    const savedSandbox = process.env["GEMINI_SANDBOX_ENDPOINT"];
    process.env["GEMINI_SANDBOX_ENDPOINT"] = fake.base;
    await cred.save({ ...cred.EMPTY_CREDENTIALS, accessToken: "at-q", cloudaicompanionProject: "proj-q" });
    billing.clearCache();
    try {
      const info = await billing.fetchCredits();
      assert.equal(info.ok, true);
      assert.equal(info.total.unit, "%");
      assert.equal(info.total.remain, 59.5, "取两窗口平均（非 min）");
      assert.equal(info.packages.length, 2);
      assert.equal(info.tier, "Pro", "判据是 paidTier");

      const quotaReq = fake.requests.find((r) => r.path.endsWith("retrieveUserQuotaSummary"))!;
      assert.equal(quotaReq.body!["project"], "proj-q", "请求体必须带 project");
      assert.equal(quotaReq.headers["authorization"], "Bearer at-q");
      assert.equal(quotaReq.headers["x-client-name"], "antigravity", "含五个伪装头");
      assert.equal(quotaReq.headers["x-goog-api-key"], undefined);
    } finally {
      if (savedSandbox === undefined) delete process.env["GEMINI_SANDBOX_ENDPOINT"];
      else process.env["GEMINI_SANDBOX_ENDPOINT"] = savedSandbox;
      await closeServer(fake.server);
      billing.clearCache();
    }
  });

  it("上游 5xx 抛 CreditsError（「查不到」不能显示成 0）", async () => {
    const fake = await startFake(() => ({ status: 500, payload: "boom" }));
    const savedSandbox = process.env["GEMINI_SANDBOX_ENDPOINT"];
    process.env["GEMINI_SANDBOX_ENDPOINT"] = fake.base;
    await cred.save({ ...cred.EMPTY_CREDENTIALS, accessToken: "at-e" });
    billing.clearCache();
    try {
      await assert.rejects(billing.fetchCredits(), billing.CreditsError);
    } finally {
      if (savedSandbox === undefined) delete process.env["GEMINI_SANDBOX_ENDPOINT"];
      else process.env["GEMINI_SANDBOX_ENDPOINT"] = savedSandbox;
      await closeServer(fake.server);
      billing.clearCache();
    }
  });

  it("桶都认不出抛 CreditsError（不伪造 100%）", async () => {
    const fake = await startFake(() => ({ payload: JSON.stringify({ groups: [] }) }));
    const savedSandbox = process.env["GEMINI_SANDBOX_ENDPOINT"];
    process.env["GEMINI_SANDBOX_ENDPOINT"] = fake.base;
    await cred.save({ ...cred.EMPTY_CREDENTIALS, accessToken: "at-n" });
    billing.clearCache();
    try {
      await assert.rejects(billing.fetchCredits(), billing.CreditsError);
    } finally {
      if (savedSandbox === undefined) delete process.env["GEMINI_SANDBOX_ENDPOINT"];
      else process.env["GEMINI_SANDBOX_ENDPOINT"] = savedSandbox;
      await closeServer(fake.server);
      billing.clearCache();
    }
  });

  it("未登录抛 cred.NotLoggedInError", async () => {
    rmSync(paths.credentialsPath(), { force: true });
    billing.clearCache();
    await assert.rejects(billing.fetchCredits(), cred.NotLoggedInError);
  });
});

describe("10. 端到端网关（假上游 + 真实网关）", () => {
  let fake: Awaited<ReturnType<typeof startFake>>;
  let gwServer: gateway.RunningGateway;
  let mode: { status: number } = { status: 200 };

  function geminiSse(): string {
    return (
      `data: ${JSON.stringify({
        response: {
          candidates: [{ content: { role: "model", parts: [{ text: "网关" }] } }],
          usageMetadata: { promptTokenCount: 7, totalTokenCount: 7 },
        },
      })}\n\n` +
      `data: ${JSON.stringify({
        response: {
          candidates: [{ content: { role: "model", parts: [{ text: "通了" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4, totalTokenCount: 11 },
        },
      })}\n\n` +
      `data: [DONE]\n\n`
    );
  }

  before(async () => {
    fake = await startFake((req) => {
      if (mode.status !== 200) return { status: mode.status, payload: "internal detail leak" };
      if (req.path === "/token") {
        return {
          payload: JSON.stringify({
            access_token: "at-e2e",
            refresh_token: "rt-e2e",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "openid",
            id_token: jwt({ sub: "sub-e2e", email: "e2e@example.com" }),
          }),
        };
      }
      if (req.path === "/userinfo") {
        return { payload: JSON.stringify({ id: "sub-e2e", email: "e2e@example.com" }) };
      }
      if (req.path.endsWith("loadCodeAssist")) {
        return { payload: JSON.stringify({ cloudaicompanionProject: "proj-e2e" }) };
      }
      if (req.path === "/v1internal:streamGenerateContent") {
        return { contentType: "text/event-stream", payload: geminiSse() };
      }
      return { status: 404, payload: "{}" };
    });
    // 端点必须指向假上游，否则 chatUrl 会打真实 Cloud Code
    await upstream.saveConfig({ baseUrl: fake.base, project: "proj-e2e" });
    await cred.save({ ...cred.EMPTY_CREDENTIALS, accessToken: "at-e2e", uid: "u-e2e", cloudaicompanionProject: "proj-e2e" });
    gwServer = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gwServer?.close().catch(() => {});
    await closeServer(fake.server);
  });

  it("/v1/models 只返回池内模型（flash-only）", async () => {
    const resp = await fetch(`http://${gwServer.addr}/v1/models`);
    assert.equal(resp.status, 200);
    const payload = (await resp.json()) as { data: Array<{ id: string }> };
    assert.deepEqual(payload.data.map((m) => m.id), ["gemini-3.8-flash"]);
  });

  it("/health 报告 ok 与登录状态", async () => {
    const resp = await fetch(`http://${gwServer.addr}/health`);
    const payload = (await resp.json()) as Record<string, unknown>;
    assert.equal(payload["ok"], true);
    assert.equal(payload["logged_in"], true);
  });

  it("流式对话：自定义线型被增量翻译出正文，并核对上游真实收到的头与体", async () => {
    fake.requests.length = 0;
    const resp = await fetch(`http://${gwServer.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [
          { role: "system", content: "你是助手" },
          { role: "user", content: "hi" },
        ],
        stream: true,
      }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 200);
    const text = await resp.text();
    assert.equal(contentOf(text), "网关通了");
    assert.ok(text.includes("data: [DONE]"));

    const sent = fake.requests.at(-1)!;
    assert.equal(sent.path, "/v1internal:streamGenerateContent");
    assert.equal(sent.headers["authorization"], "Bearer at-e2e");
    assert.equal(sent.headers["x-client-name"], "antigravity");
    assert.equal(sent.headers["x-machine-id"], "cmdc-pak");
    const body = sent.body!;
    assert.equal(body["model"], "gemini-3.8-flash-medium");
    assert.equal(body["project"], "proj-e2e");
    const contents = (body["request"] as Record<string, unknown>)["contents"] as Array<Record<string, unknown>>;
    assert.deepEqual(contents.map((c) => c["role"]), ["user"]);
  });

  it("非流式：本层聚合成 chat.completion", async () => {
    const resp = await fetch(`http://${gwServer.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "hi" }] }),
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
      const resp = await fetch(`http://${gwServer.addr}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "hi" }], stream: true }),
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
    const resp = await fetch(`http://${gwServer.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.8-flash" }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 400);
    const payload = (await resp.json()) as { error: { code: string } };
    assert.equal(payload.error.code, "invalid_request");
  });

  it("登录全链路：真实授权 URL → 本地回调（state）→ 换令牌 → 落盘", async () => {
    const savedAuthorize = process.env["GEMINI_AUTHORIZE_URL"];
    const savedToken = process.env["GEMINI_TOKEN_URL"];
    const savedUserinfo = process.env["GEMINI_USERINFO_URL"];
    const savedSandbox = process.env["GEMINI_SANDBOX_ENDPOINT"];
    process.env["GEMINI_AUTHORIZE_URL"] = `${fake.base}/authorize`;
    process.env["GEMINI_TOKEN_URL"] = `${fake.base}/token`;
    process.env["GEMINI_USERINFO_URL"] = `${fake.base}/userinfo`;
    process.env["GEMINI_SANDBOX_ENDPOINT"] = fake.base;
    rmSync(paths.credentialsPath(), { force: true });
    let authorizeUrl = "";
    try {
      const c = await cred.login(undefined, {
        onUrl: (url) => {
          authorizeUrl = url;
          // 解析回调端口与 state，主动打回调（模拟浏览器重定向）
          const parsed = new URL(url);
          const redirect = parsed.searchParams.get("redirect_uri")!;
          const state = parsed.searchParams.get("state")!;
          const cb = new URL(redirect);
          const q = new URLSearchParams({ code: "auth-code-1", state });
          // 用 127.0.0.1 打回调（login 必然监听 IPv4；避免 localhost→::1 在无 IPv6 环境下连不上）
          void fetch(`http://127.0.0.1:${cb.port}${cb.pathname}?${q}`).catch(() => {});
        },
      });
      // 先监听后拼 URL：redirect_uri 的 host 必须是 localhost（PROTOCOL §2.2）
      assert.equal(new URL(authorizeUrl).searchParams.get("redirect_uri")!.startsWith("http://localhost:"), true);
      assert.equal(c.accessToken, "at-e2e");
      assert.equal(c.refreshToken, "rt-e2e");
      assert.equal(c.uid, "sub-e2e", "身份从 id_token 的 sub 解出");
      assert.equal(c.email, "e2e@example.com");
      assert.ok(c.expiry, "expiry 由 expires_in 自算为 RFC3339");
      const onDisk = JSON.parse(readFileSync(paths.credentialsPath(), "utf8")) as Record<string, unknown>;
      assert.equal(onDisk["access_token"], "at-e2e");
    } finally {
      if (savedAuthorize === undefined) delete process.env["GEMINI_AUTHORIZE_URL"];
      else process.env["GEMINI_AUTHORIZE_URL"] = savedAuthorize;
      if (savedToken === undefined) delete process.env["GEMINI_TOKEN_URL"];
      else process.env["GEMINI_TOKEN_URL"] = savedToken;
      if (savedUserinfo === undefined) delete process.env["GEMINI_USERINFO_URL"];
      else process.env["GEMINI_USERINFO_URL"] = savedUserinfo;
      if (savedSandbox === undefined) delete process.env["GEMINI_SANDBOX_ENDPOINT"];
      else process.env["GEMINI_SANDBOX_ENDPOINT"] = savedSandbox;
    }
  });
});
