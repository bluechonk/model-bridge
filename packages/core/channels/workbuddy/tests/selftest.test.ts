/**
 * @modelmux/workbuddy（国内版 CodeBuddy）自检（离线，不出网）。
 *
 * 覆盖：
 *  1. 路径与「无历史目录」边界
 *  2. 模型目录（对外名 = 上游名；旧短名仅作输入兼容）
 *  3. 凭据落盘/读取/损坏容忍 + 单域登录基址
 *  4. 上游 URL 组装与鉴权头
 *  5. SSE 规范化（注释行剔除、空 tool_calls 剔除）与聚合
 *  6. 端到端网关（假上游）：system 注入、强制流式、指纹改写、非流式聚合、错误信封
 *
 * 数据目录用 MODELMUX_HOME 隔离，绝不碰真实凭据。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

// 必须在 import 被测模块之前设置（paths 每次调用都重新解析存储根）
const HOME = mkdtempSync(join(tmpdir(), "wb-cn-selftest-"));
process.env["MODELMUX_HOME"] = HOME;

// 共享层来自工作区包；先注册本渠道（副作用）再引渠道模块
const { paths, sseStream: sse, gateway } = await import("@modelmux/gateway");
const channelModule = await import("../dist/channel.js");
const billing = await import("../dist/billing.js");
const catalog = await import("../dist/catalog.js");
const cred = await import("../dist/cred.js");
const upstream = await import("../dist/upstream.js");

// ── 假上游 ───────────────────────────────────────────────────────────────────

interface Captured {
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown> | null;
}

/** 起一个假 WorkBuddy 上游，返回端口与请求捕获槽。 */
async function startFakeUpstream(
  options: { frames?: string[]; status?: number; body?: string } = {},
): Promise<{ server: Server; port: number; captured: Captured[] }> {
  const captured: Captured[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += String(c);
    });
    req.on("end", () => {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      captured.push({ headers: { ...req.headers }, body: parsed });

      if (options.status && options.status !== 200) {
        res.writeHead(options.status, { "Content-Type": "application/json" });
        res.end(options.body ?? JSON.stringify({ error: { message: "upstream refused" } }));
        return;
      }
      if (options.body !== undefined) {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(options.body);
        return;
      }
      const frames = options.frames ?? [
        `data: ${JSON.stringify({ id: "c1", model: "m", created: 1, choices: [{ index: 0, delta: { role: "assistant", content: "网关", tool_calls: [] }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", model: "m", created: 1, choices: [{ index: 0, delta: { content: "通了", tool_calls: [] }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", model: "m", created: 1, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
        "data: [DONE]\n\n",
      ];
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const frame of frames) res.write(frame);
      res.end();
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
  return { server, port, captured };
}

async function readSseFrames(url: string, body: unknown): Promise<string> {
  const resp = await fetch(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(resp.status, 200, `期望 200，实际 ${resp.status}`);
  const text = await resp.text();
  let content = "";
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const chunk = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string } }>;
    };
    for (const choice of chunk.choices ?? []) {
      if (choice.delta?.content) content += choice.delta.content;
    }
  }
  return content;
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

describe("1. 路径", () => {
  it("数据目录名固定，受 MODELMUX_HOME 覆盖，渠道层是 <root>/workbuddy", () => {
    assert.equal(paths.rootDir(), HOME);
    assert.equal(paths.channelDir(), join(HOME, "workbuddy"));
    assert.ok(paths.credentialsPath().endsWith("credentials.json"));
    assert.ok(paths.pidPath().endsWith("gateway.pid"));
    assert.ok(paths.logPath().endsWith("gateway.log"));
  });

});

describe("2. 模型目录", () => {
  it("对外名 = 上游名；历史短名仅作输入兼容", () => {
    assert.ok(catalog.exposedIds().includes("deepseek-v4.1-flash"), "对外暴露上游真名");
    assert.ok(!catalog.exposedIds().includes("deepseek-flash"), "旧短名不再出现在列表里");
    assert.equal(catalog.resolveModel("deepseek-v4.1-flash"), "deepseek-v4.1-flash");
    assert.equal(catalog.resolveModel("deepseek-flash"), "deepseek-v4.1-flash", "旧短名仍能解析（老配置不断）");
  });

  it("未知模型名原样透传", () => {
    assert.equal(catalog.resolveModel("no-such-model"), "no-such-model");
  });

  it("models.json 的 alias 字段优先", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-models-"));
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({ models: [{ slug: "upstream-x", alias: "short-x" }] }),
      "utf8",
    );
    const savedCwd = process.cwd();
    const savedEnv = process.env["WB_MODELS_FILE"];
    process.env["WB_MODELS_FILE"] = join(dir, "models.json");
    catalog.clearCache();
    try {
      assert.equal(catalog.resolveModel("short-x"), "upstream-x");
    } finally {
      if (savedEnv === undefined) delete process.env["WB_MODELS_FILE"];
      else process.env["WB_MODELS_FILE"] = savedEnv;
      process.chdir(savedCwd);
      catalog.clearCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("3. 凭据", () => {
  it("未登录时抛 NotLoggedInError", () => {
    rmSync(paths.credentialsPath(), { force: true });
    assert.throws(() => cred.load(), cred.NotLoggedInError);
  });

  it("落盘后可读回，且 uid 从 JWT sub 补全", async () => {
    // 构造一个 sub 可解的 JWT（只要求第二段是合法 base64url JSON）
    const payload = Buffer.from(JSON.stringify({ sub: "user-123" })).toString("base64url");
    const jwt = `header.${payload}.sig`;
    await cred.save({
      ...cred.EMPTY_CREDENTIALS,
      accessToken: jwt,
      refreshToken: "r",
      domain: "www.codebuddy.ai",
      obtainedAt: "2026-10-08T00:00:00.000Z",
    });
    const c = cred.load();
    assert.equal(c.uid, "user-123", "uid 应从 JWT sub 提取");
    assert.equal(c.domain, "www.codebuddy.ai");
  });

  it("凭据文件损坏时按未登录处理（不抛解析异常）", () => {
    writeFileSync(paths.credentialsPath(), "{ not json", "utf8");
    assert.throws(() => cred.load(), cred.NotLoggedInError);
  });

  it("accessToken 为空时按未登录处理", () => {
    writeFileSync(paths.credentialsPath(), JSON.stringify({ accessToken: "" }), "utf8");
    assert.throws(() => cred.load(), cred.NotLoggedInError);
  });

  it("登录基址恒为国内域（realm 参数被忽略）", async () => {
    const payload = Buffer.from(JSON.stringify({ sub: "u" })).toString("base64url");
    await cred.save({
      ...cred.EMPTY_CREDENTIALS,
      accessToken: `h.${payload}.s`,
      domain: "www.workbuddy.ai",
    });
    assert.equal(cred.resolveBaseUrl("auto"), "https://www.codebuddy.ai");
    assert.equal(cred.resolveBaseUrl("intl"), "https://www.codebuddy.ai", "没有 intl 一说，恒国内域");
    assert.equal(cred.resolveBaseUrl("cn"), "https://www.codebuddy.ai");
  });
});

describe("4. 上游配置", () => {
  it("URL 组装（chat 路径不用 prefixPath）", () => {
    const cfg = upstream.defaultConfig();
    assert.equal(upstream.chatUrl(cfg), "https://www.codebuddy.ai/v2/chat/completions");
    assert.equal(
      upstream.modelsUrl(cfg),
      "https://www.codebuddy.ai/v2/enterprises/personal/models",
    );
  });

  it("applyAuth 设置鉴权头与归属头", () => {
    const headers: Record<string, string> = {};
    upstream.applyAuth(headers, upstream.defaultConfig(), "tok", "uid-1");
    assert.equal(headers["Authorization"], "Bearer tok");
    assert.equal(headers["X-User-Id"], "uid-1");
    assert.equal(headers["X-Domain"], "www.codebuddy.ai");
    // 上游按 UA 归因「使用端」并参与渠道校验 —— 用官方桌面端 UA（5.5.6）
    assert.equal(headers["User-Agent"], "WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1");
  });

  it("buildChatHeaders 补齐身分头族（X-Conversation-ID 恒发、ID 形态合规）", () => {
    const cred = { accessToken: "tok", uid: "uid-1", domain: "www.codebuddy.ai" };
    const a = upstream.buildChatHeaders(cred);
    const b = upstream.buildChatHeaders(cred);
    for (const name of [
      "X-Agent-Intent", "X-Agent-Purpose", "X-Agent-Type",
      "X-IDE-Name", "X-IDE-Type", "X-IDE-Version",
      "X-Conversation-ID", "X-Conversation-Request-ID", "X-Root-Request-ID",
      "X-Conversation-Message-ID", "X-Request-ID",
      "traceparent", "b3", "X-B3-TraceId", "X-B3-SpanId", "X-B3-Sampled",
    ]) {
      assert.ok(a[name], `缺身分头 ${name}`);
    }
    assert.equal(a["X-IDE-Version"], "5.5.6");
    assert.equal(a["X-Conversation-Request-ID"], a["X-Root-Request-ID"], "两者同值");
    assert.equal(a["X-Conversation-Message-ID"], a["X-Request-ID"], "两者同值");
    assert.match(a["X-Conversation-ID"] as string, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.match(a["X-Request-ID"] as string, /^[0-9a-f]{32}$/);
    assert.notEqual(a["X-Conversation-ID"], b["X-Conversation-ID"], "ID 每轮新生");
  });

  it("resolveConfig 取 endpoint 与鉴权属性", () => {
    const cfg = upstream.resolveConfig(
      {
        endpoint: "https://www.workbuddy.ai",
        authentication: {
          attributes: { tokenHeader: "X-Token", usernameHeader: "X-Uid" },
        },
      },
      upstream.defaultConfig(),
    );
    assert.equal(cfg.baseUrl, "https://www.workbuddy.ai");
    assert.equal(cfg.tokenHeader, "X-Token");
    assert.equal(cfg.usernameHeader, "X-Uid");
    // 即使载荷声明了 prefixPath，chat 路径也固定为 /v2/chat/completions
    assert.equal(cfg.chatPath, "/v2/chat/completions");
  });
});

describe("5. SSE 规范化与聚合", () => {
  it("聚合出正文、思考与 usage", () => {
    const buf = Buffer.from(
      [
        `data: ${JSON.stringify({ id: "x", model: "m", created: 5, choices: [{ index: 0, delta: { content: "你" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "想" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "好" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""),
      "utf8",
    );
    const agg = sse.aggregateChatSse(buf);
    assert.equal(agg.object, "chat.completion");
    assert.equal(agg.choices[0]!.message.content, "你好");
    assert.equal(agg.choices[0]!.message.reasoning_content, "想");
    assert.equal(agg.choices[0]!.finish_reason, "stop");
    assert.equal((agg.usage as { total_tokens: number }).total_tokens, 3);
  });
});

describe("6. 端到端网关", () => {
  let fake: Awaited<ReturnType<typeof startFakeUpstream>>;
  let gw: gateway.RunningGateway;

  before(async () => {
    fake = await startFakeUpstream();
    // 写一份「有效」假凭据
    const payload = Buffer.from(JSON.stringify({ sub: "e2e" })).toString("base64url");
    await cred.save({
      ...cred.EMPTY_CREDENTIALS,
      accessToken: `h.${payload}.s`,
      refreshToken: "r",
      domain: "",
    });
    // 把上游指向假服务
    await upstream.saveConfig({
      baseUrl: `http://127.0.0.1:${fake.port}`,
      chatPath: "/v2/chat/completions",
      tokenHeader: "Authorization",
      tokenType: "bearerToken",
      usernameHeader: "X-User-Id",
    });
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  it("/v1/models 返回上游模型名", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/models`);
    assert.equal(resp.status, 200);
    const payload = (await resp.json()) as { data: Array<{ id: string }> };
    assert.ok(payload.data.some((m) => m.id === "workbuddy/deepseek-v4.1-flash"));
  });

  it("/health 报告 ok 与登录状态", async () => {
    const resp = await fetch(`http://${gw.addr}/health`);
    const payload = (await resp.json()) as Record<string, unknown>;
    assert.equal(payload["ok"], true);
    assert.equal(payload["logged_in"], true);
  });

  it("流式对话：正常出字", async () => {
    const text = await readSseFrames(`http://${gw.addr}/v1/chat/completions`, {
      model: "workbuddy/deepseek-v4.1-flash",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    assert.equal(text, "网关通了");
  });

  it("裸模型名与渠道目录外的模型都判 400（渠道由请求方前缀指定）", async () => {
    const post = (model: string) =>
      fetch(`http://${gw.addr}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream: true }),
      });
    // 渠道自己的 catalog 仍能解析旧短名，但**网关入口**只接受 `<cid>/<模型>` —— 裸名是格式错误。
    const bare = await post("deepseek-flash");
    assert.equal(bare.status, 400);
    // 带对了前缀、但渠道目录里没有这个模型：同样 400（渠道没货）
    const noModel = await post("workbuddy/deepseek-flash");
    assert.equal(noModel.status, 400);
    for (const resp of [bare, noModel]) {
      const payload = (await resp.json()) as { error: { code: string } };
      assert.equal(payload.error.code, "unknown_model");
    }
  });

  it("上游约束：注入 system + 强制 stream + 模型名映射", async () => {
    fake.captured.length = 0;
    await readSseFrames(`http://${gw.addr}/v1/chat/completions`, {
      model: "workbuddy/deepseek-v4.1-flash",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const sent = fake.captured.at(-1)!.body!;
    const messages = sent["messages"] as Array<{ role: string }>;
    assert.equal(messages[0]!.role, "system", "首条必须是 system（上游硬约束）");
    assert.equal(sent["stream"], true, "上游只支持流式，必须强制 stream:true");
    assert.equal(sent["model"], "deepseek-v4.1-flash", "短名应映射为上游 slug");
  });

  it("上游约束：指纹改写为等价表述", async () => {
    fake.captured.length = 0;
    await readSseFrames(`http://${gw.addr}/v1/chat/completions`, {
      model: "workbuddy/deepseek-v4.1-flash",
      messages: [
        { role: "system", content: "Main branch (you will usually use this for PRs)" },
        { role: "user", content: "hi" },
      ],
      stream: true,
    });
    const sent = fake.captured.at(-1)!.body!;
    const messages = sent["messages"] as Array<{ content: string }>;
    const text = messages.map((m) => m.content).join("\n");
    assert.ok(
      !text.includes("you will usually use this for PRs"),
      "命中指纹的样板文本必须被改写，否则整条会话被 11128 拒绝",
    );
    assert.ok(text.includes("Main branch (used for PRs)"), "应改写为等价表述");
  });

  it("非流式：本层聚合成 chat.completion", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "workbuddy/deepseek-v4.1-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 200);
    const payload = (await resp.json()) as {
      object: string;
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(payload.object, "chat.completion");
    assert.equal(payload.choices[0]!.message.content, "网关通了");
  });

  it("请求校验：缺 model/messages 返回 400 统一信封", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "x" }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 400);
    const payload = (await resp.json()) as { error: { code: string } };
    assert.equal(payload.error.code, "invalid_request");
  });

  it("非法 JSON 返回 400 invalid_json", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      body: "{ not json",
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 400);
    const payload = (await resp.json()) as { error: { code: string } };
    assert.equal(payload.error.code, "invalid_json");
  });

  it("未知路径返回 JSON 404（不是裸连接错误）", async () => {
    const resp = await fetch(`http://${gw.addr}/nope`);
    assert.equal(resp.status, 404);
    const payload = (await resp.json()) as { error: { code: string } };
    assert.equal(payload.error.code, "not_found");
  });
});

describe("7. 上游错误处理", () => {
  it("上游 500 转成 502 upstream_error（不回传上游原文）", async () => {
    const failing = await startFakeUpstream({ status: 500, body: "internal detail leak" });
    const saved = upstream.loadConfig();
    await upstream.saveConfig({
      baseUrl: `http://127.0.0.1:${failing.port}`,
      chatPath: "/v2/chat/completions",
      tokenHeader: "Authorization",
      tokenType: "bearerToken",
      usernameHeader: "X-User-Id",
    });
    const gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
    try {
      const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({
          model: "workbuddy/deepseek-v4.1-flash",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(resp.status, 502);
      const payload = (await resp.json()) as { error: { code: string; message: string } };
      assert.equal(payload.error.code, "upstream_error");
      assert.ok(
        !payload.error.message.includes("internal detail leak"),
        "上游原始错误体不应回传客户端",
      );
    } finally {
      await gw.close();
      await new Promise<void>((r) => failing.server.close(() => r()));
      await upstream.saveConfig(saved[0]);
    }
  });
});

// ── 8. 每日签到（billing/meter 域，离线 mock fetch） ─────────────────────────

describe("8. 每日签到", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function writeCredential(): void {
    const dir = join(HOME, "workbuddy");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "credentials.json"),
      JSON.stringify({ accessToken: "tok-w", uid: "u-2", domain: "www.codebuddy.ai" }),
    );
  }

  it("daily-checkin POST 空 body；业务码 0 = 签到成功", async () => {
    writeCredential();
    let captured: { url: string; method: string; body: string } | null = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(input), method: String(init?.method), body: String(init?.body ?? "") };
      return new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 });
    }) as typeof fetch;
    const r = await billing.dailyCheckin();
    assert.match(captured!.url, /\/v2\/billing\/meter\/daily-checkin$/);
    assert.equal(captured!.method, "POST");
    assert.deepEqual(JSON.parse(captured!.body), {});
    assert.deepEqual(r, { checkedIn: true, already: false, message: "签到成功" });
  });

  it("上游幂等拒绝（今天已签）按成功回报", async () => {
    writeCredential();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 50001, msg: "already checked in today" }), { status: 200 })) as typeof fetch;
    const r = await billing.dailyCheckin();
    assert.deepEqual(r, { checkedIn: true, already: true, message: "already checked in today" });
  });

  it("其他业务码如实抛 CreditsError", async () => {
    writeCredential();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 40001, msg: "activity ended" }), { status: 200 })) as typeof fetch;
    await assert.rejects(() => billing.dailyCheckin(), /activity ended/);
  });
});
