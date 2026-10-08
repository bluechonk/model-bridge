/**
 * minimax-bridge 自检（**完全离线**，不出网、不需要真实凭据）。
 *
 * 覆盖 PROTOCOL.md 的关键结论：
 *  1. 路径（MINIMAX_HOME 隔离）
 *  2. 凭据：落盘/读回/损坏容忍、`expires_at` 由 `expires_in` 自算（access_token 非 JWT）
 *  3. 登录 URL 构建与设备码轮询（两种 pending 形态、slow_down 累积、终态、onUrl 立刻回调）
 *  4. 请求头：仅 Authorization + Content-Type + Accept，**不含** anthropic-version
 *  5. 请求体改写：system 顶层字符串、成对提交、tool_use/tool_result、图片裸 base64、
 *     thinking 档位表
 *  6. Anthropic SSE → OpenAI delta 的增量翻译（含**逐字节喂入**、signature_delta、
 *     thinking→reasoning、无内容块抛错）
 *  7. 模型目录：flash-only 池 + 未知名透传
 *  8. 额度：签到面板 + Σ remaining_amount + timezone_id query + base_resp.status_code
 *  9. 端到端网关（假上游 + 真实网关）：流式/非流式正文、上游真实收到的头与体、错误路径
 *
 * 数据目录用 MINIMAX_HOME 指向 mkdtemp，绝不碰真实凭据。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const HOME = mkdtempSync(join(tmpdir(), "minimax-selftest-"));
process.env["MODEL_BRIDGE_HOME"] = HOME;
process.env["MINIMAX_NO_BROWSER"] = "1"; // 测试里绝不真开浏览器

// ── 假上游 ───────────────────────────────────────────────────────────────────

interface FakeRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown> | null;
  raw: string;
}

interface FakeReply {
  status?: number;
  contentType?: string;
  payload?: string;
}

const ACCOUNT_ID = "acct_01MINIMAX";

/** 令牌端点脚本（按顺序返回；耗尽后回 expired_token）。 */
const tokenScript: Array<{ status: number; body: unknown }> = [];
let tokenCalls = 0;
let deviceCalls = 0;
let deviceForm = "";
let chatHeaders: Record<string, string | string[] | undefined> = {};
let chatBody: Record<string, unknown> | null = null;
let chatMode: "ok" | "500" = "ok";
let signinMode: "ok" | "biz_fail" = "ok";
let creditMode: "ok" | "biz_fail" | "500" = "ok";
let claimScript: number[] = [];
let claimCalls = 0;
let lastSigninQuery = "";

let fakePort = 0;
function fakeBase(): string {
  return `http://127.0.0.1:${fakePort}`;
}

const SIGNIN_DAYS = [
  { day_no: 1, points: 10, is_today: false, status: 3 },
  { day_no: 2, points: 20, is_today: true, status: 2 },
  { day_no: 3, points: 30, is_today: false, status: 1 },
  { day_no: 4, points: 40, is_today: false, status: 1 },
  { day_no: 5, points: 50, is_today: false, status: 1 },
  { day_no: 6, points: 60, is_today: false, status: 1 },
  { day_no: 7, points: 70, is_today: false, status: 1 },
];

const ANTHROPIC_FRAMES = (): string =>
  [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_e2e","model":"MiniMax-M3.1-Flash-Preview","usage":{"input_tokens":7}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"网关"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"通了"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");

function route(req: IncomingMessage, raw: string, res: ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const reply = (r: FakeReply): void => {
    res.writeHead(r.status ?? 200, { "Content-Type": r.contentType ?? "application/json" });
    res.end(r.payload ?? "");
  };

  if (path === "/oauth2/device/code") {
    deviceCalls += 1;
    deviceForm = raw;
    reply({
      payload: JSON.stringify({
        device_code: "dev-code-1",
        user_code: "ABCD-EFGH",
        verification_uri: `${fakeBase()}/device`,
        verification_uri_complete: `${fakeBase()}/device?user_code=ABCD-EFGH`,
        expires_in: 300,
        interval: 1,
      }),
    });
    return true;
  }
  if (path === "/oauth2/token") {
    const idx = tokenCalls;
    tokenCalls += 1;
    const item = tokenScript[idx];
    if (item) {
      reply({ status: item.status, payload: JSON.stringify(item.body) });
      return true;
    }
    reply({ status: 400, payload: JSON.stringify({ error: "expired_token" }) });
    return true;
  }
  if (path === "/mavis/api/v1/models") {
    reply({
      payload: JSON.stringify({
        providers: [
          {
            providerId: "minimax",
            config: {
              models: {
                "MiniMax-M3.1-Flash-Preview": {
                  name: "M3.1-Flash-Preview",
                  limit: { context: 512000, output: 128000 },
                  context_window_options: [512000, 1000000],
                  modalities: { input: ["text", "image"] },
                  effort_options: ["default", "low", "medium", "high", "xhigh", "max"],
                  default_effort: "default",
                  thinking_config: { mode: "forced_on" },
                },
                "MiniMax-M3": {
                  name: "M3",
                  limit: { context: 1000000, output: 128000 },
                  modalities: { input: ["text", "image"] },
                  thinking_config: { mode: "switchable" },
                },
              },
              model_order: ["MiniMax-M3.1-Flash-Preview", "MiniMax-M3"],
            },
          },
        ],
      }),
    });
    return true;
  }
  if (path === "/mavis/api/v1/llm/v1/messages") {
    chatHeaders = { ...req.headers };
    chatBody = JSON.parse(raw || "{}") as Record<string, unknown>;
    if (chatMode === "500") {
      reply({ status: 500, payload: "internal detail leak" });
      return true;
    }
    reply({ contentType: "text/event-stream", payload: ANTHROPIC_FRAMES() });
    return true;
  }
  if (path === "/minimax-cloud/api/v1/signin/status") {
    lastSigninQuery = url.search;
    if (signinMode === "biz_fail") {
      reply({ payload: JSON.stringify({ base_resp: { status_code: 2001, status_msg: "invalid timezone_id" } }) });
      return true;
    }
    reply({ payload: JSON.stringify({ data: { days: SIGNIN_DAYS, scene: 2 }, base_resp: { status_code: 0 } }) });
    return true;
  }
  if (path === "/minimax-cloud/api/v1/signin/claim") {
    const result = claimScript[claimCalls] ?? 2;
    claimCalls += 1;
    reply({ payload: JSON.stringify({ data: { claim_result: result, points: 20 }, base_resp: { status_code: 0 } }) });
    return true;
  }
  if (path === "/minimax-cloud/api/v1/credit/details") {
    if (creditMode === "biz_fail") {
      reply({ payload: JSON.stringify({ details: [], total_count: 0, base_resp: { status_code: 1, status_msg: "boom" } }) });
      return true;
    }
    if (creditMode === "500") {
      reply({ status: 500, payload: "boom" });
      return true;
    }
    reply({
      payload: JSON.stringify({
        details: [
          {
            remaining_amount: "800.00",
            consumed_amount: "0.00",
            granted_amount: "800.00",
            credit_type: 2,
            granted_at_ms: 1,
            expire_at_ms: 2,
          },
          {
            remaining_amount: "200.00",
            consumed_amount: "0.00",
            granted_amount: "400.00",
            credit_type: 2,
          },
        ],
        total_count: 2,
        base_resp: { status_code: 0, status_msg: "ok" },
      }),
    });
    return true;
  }
  reply({ status: 404, payload: JSON.stringify({ error: "not found" }) });
  return false;
}

const fakeServer: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => {
    raw += String(c);
  });
  req.on("end", () => route(req, raw, res));
});

await new Promise<void>((resolve) => {
  fakeServer.listen(0, "127.0.0.1", () => {
    fakePort = (fakeServer.address() as { port: number }).port;
    resolve();
  });
});

// ── 被测模块（设置 env 后再 import）───────────────────────────────────────────

const { paths, gateway } = await import("@model-bridge/gateway");
await import("../dist/channel.js");
const billing = await import("../dist/billing.js");
const catalog = await import("../dist/catalog.js");
const cred = await import("../dist/cred.js");
const upstream = await import("../dist/upstream.js");

// 上游指向假服务（对话/目录/额度都走它）
await upstream.saveConfig({ ...upstream.defaultConfig(), baseUrl: fakeBase() });

// ── 帮助函数 ─────────────────────────────────────────────────────────────────

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
        if (Array.isArray(calls)) for (const call of calls) toolCalls.push(call as Record<string, unknown>);
      }
    }
  }
  const blob = frames.map((f) => (Buffer.isBuffer(f) ? f.toString("utf8") : f)).join("");
  return { content, reasoning, finishes, usage, toolCalls, blob };
}

/** 构造一段 Anthropic SSE（message_start → 思考块 → 文本块 → signature → stop）。 */
function anthropicWire(): Buffer {
  const events: Array<[string, Record<string, unknown>]> = [
    ["message_start", { type: "message_start", message: { id: "msg_1", model: "MiniMax-M3.1-Flash-Preview", usage: { input_tokens: 100 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "让我想想" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text" } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "答案" } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "是 42" } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "deadbeef" } }],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 25, output_tokens_details: { thinking_tokens: 8 } } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return Buffer.from(
    events.map(([name, payload]) => `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`).join(""),
    "utf8",
  );
}

async function readSse(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const resp = await fetch(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return { status: resp.status, text: await resp.text() };
}

function contentOf(text: string): string {
  let content = "";
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
    for (const choice of chunk.choices ?? []) if (choice.delta?.content) content += choice.delta.content;
  }
  return content;
}

async function saveFakeCreds(overrides: Partial<cred.Credentials> = {}): Promise<cred.Credentials> {
  const c: cred.Credentials = {
    ...cred.EMPTY_CREDENTIALS,
    accessToken: "mmoat_e2e_access_token",
    refreshToken: "mmort_e2e_refresh_token",
    tokenType: "Bearer",
    expiresAt: Date.now() + 3600_000,
    scope: cred.PRODUCT_SCOPE,
    uid: ACCOUNT_ID,
    domain: "",
    ...overrides,
  };
  await cred.save(c);
  return cred.load();
}

after(() => {
  fakeServer.close();
  rmSync(HOME, { recursive: true, force: true });
});

// ── 1. 路径 ───────────────────────────────────────────────────────────────────

describe("1. 路径", () => {
  it("数据目录名固定，受 MODEL_BRIDGE_HOME 覆盖，渠道层是 <root>/minimax", () => {
    assert.equal(paths.rootDir(), HOME);
    assert.equal(paths.channelDir(), join(HOME, "minimax"));
    assert.ok(paths.credentialsPath().endsWith("credentials.json"));
    assert.ok(paths.upstreamPath().endsWith("upstream.json"));
  });
});

// ── 2. 凭据 ───────────────────────────────────────────────────────────────────

describe("2. 凭据", () => {
  it("未登录时抛 NotLoggedInError", () => {
    rmSync(paths.credentialsPath(), { force: true });
    assert.throws(() => cred.load(), cred.NotLoggedInError);
  });

  it("落盘为 snake_case，读回为契约形态", async () => {
    await cred.save({
      ...cred.EMPTY_CREDENTIALS,
      accessToken: "mmoat_tok",
      refreshToken: "mmort_ref",
      expiresAt: 1790313827000,
      scope: cred.PRODUCT_SCOPE,
      uid: ACCOUNT_ID,
      nickname: "Mini",
    });
    const disk = JSON.parse(readFileSync(paths.credentialsPath(), "utf8")) as Record<string, unknown>;
    assert.equal(disk["access_token"], "mmoat_tok");
    assert.equal(disk["refresh_token"], "mmort_ref");
    assert.equal(disk["expires_at"], "1790313827000", "expires_at 磁盘上是字符串（§2.1）");
    assert.equal(disk["account_id"], ACCOUNT_ID);
    const c = cred.load();
    assert.equal(c.accessToken, "mmoat_tok");
    assert.equal(c.uid, ACCOUNT_ID);
    assert.equal(c.expiresAt, 1790313827000);
    assert.equal(c.domain, "", "本渠道无 domain 概念");
  });

  it("expires_at 判据：>1e12 视为毫秒，否则视为秒（§2.1）", () => {
    assert.equal(cred.parseExpiresAt("1790313827000"), 1790313827000);
    assert.equal(cred.parseExpiresAt("1790313827"), 1790313827000);
    assert.equal(cred.parseExpiresAt(""), null);
    assert.equal(cred.parseExpiresAt("not-a-number"), null);
  });

  it("损坏 / access_token 为空按未登录处理", () => {
    writeFileSync(paths.credentialsPath(), "{ not json", "utf8");
    assert.throws(() => cred.load(), cred.NotLoggedInError);
    writeFileSync(paths.credentialsPath(), JSON.stringify({ access_token: "" }), "utf8");
    assert.throws(() => cred.load(), cred.NotLoggedInError);
  });

  it("resolveBaseUrl 走 MINIMAX_ACCOUNT_BASE_URL（单域渠道，无 realm）", () => {
    const saved = process.env["MINIMAX_ACCOUNT_BASE_URL"];
    process.env["MINIMAX_ACCOUNT_BASE_URL"] = "https://acct.example";
    try {
      assert.equal(cred.resolveBaseUrl("auto"), "https://acct.example");
    } finally {
      if (saved === undefined) delete process.env["MINIMAX_ACCOUNT_BASE_URL"];
      else process.env["MINIMAX_ACCOUNT_BASE_URL"] = saved;
    }
    assert.equal(cred.DEFAULT_BASE_URL, cred.ACCOUNT_BASE_URL, "默认登录基址是账号基址");
  });

  it("PKCE：challenge = base64url(sha256(verifier,'ascii'))，且不是明文（§2.3）", () => {
    const pkce = cred.generatePkce();
    assert.ok(pkce.verifier.length > 20);
    assert.notEqual(pkce.challenge, pkce.verifier);
    assert.ok(!pkce.challenge.includes("+") && !pkce.challenge.includes("/"), "base64url 无 + /");
  });
});

// ── 3. 设备码登录 ─────────────────────────────────────────────────────────────

describe("3. 设备码 + PKCE 登录", () => {
  it("第 1 步：请求设备码带 client_id/scope/audience/code_challenge（§2.3）", async () => {
    deviceCalls = 0;
    const pkce = cred.generatePkce();
    const device = await cred.requestDeviceCode(fakeBase(), pkce);
    assert.equal(deviceCalls, 1);
    const form = new URLSearchParams(deviceForm);
    assert.equal(form.get("client_id"), "mcode-public");
    assert.equal(form.get("scope"), "agent.default");
    assert.equal(form.get("audience"), "agent-backend");
    assert.equal(form.get("code_challenge"), pkce.challenge);
    assert.equal(form.get("code_challenge_method"), "S256");
    assert.equal(device.deviceCode, "dev-code-1");
    assert.equal(device.userCode, "ABCD-EFGH");
    assert.equal(device.interval, 1);
  });

  it("轮询：两种 pending 形态都认，slow_down 累积抬高 5s（§2.3）", async () => {
    const pkce = cred.generatePkce();
    const device = await cred.requestDeviceCode(fakeBase(), pkce);
    tokenCalls = 0;
    tokenScript.length = 0;
    // 形态二：非 200 + error:authorization_pending   形态一：200 + status:pending
    tokenScript.push(
      { status: 400, body: { error: "authorization_pending" } },
      { status: 200, body: { status: "pending" } },
      { status: 400, body: { error: "slow_down" } },
      {
        status: 200,
        body: {
          access_token: "mmoat_at",
          refresh_token: "mmort_rt",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "agent.default openid",
        },
      },
    );
    const slept: number[] = [];
    const payload = await cred.pollDeviceToken(fakeBase(), pkce, device, {
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    assert.equal(payload["access_token"], "mmoat_at");
    // interval 1s → 1000；slow_down 后 → 6000（+5000）
    assert.deepEqual(slept, [1000, 1000, 6000]);
    assert.equal(tokenCalls, 4);
  });

  it("终态：denied / expired / 2xx 无 token / 5xx 都失败", async () => {
    const pkce = cred.generatePkce();
    const device = await cred.requestDeviceCode(fakeBase(), pkce);
    for (const [status, body, re] of [
      [200, { status: "denied" }, /拒绝/],
      [200, { status: "expired" }, /过期/],
      [400, { error: "expired_token" }, /过期/],
      [200, { status: "whatever" }, /没有 access_token/],
      [500, { error: "boom" }, /HTTP 500/],
    ] as const) {
      tokenCalls = 0;
      tokenScript.length = 0;
      tokenScript.push({ status, body });
      await assert.rejects(
        () => cred.pollDeviceToken(fakeBase(), pkce, device, { sleep: async () => {} }),
        re,
      );
    }
  });

  it("令牌响应硬校验：scope 缺 agent.default / token_type 非 bearer / expires_in 非正数（§2.3）", async () => {
    const base = { access_token: "mmoat_x", refresh_token: "mmort_y", token_type: "Bearer", expires_in: 60, scope: "agent.default" };
    assert.throws(() => cred.parseTokenGrant({ ...base, scope: "openid" }), /scope/);
    assert.throws(() => cred.parseTokenGrant({ ...base, token_type: "mac" }), /token_type/);
    assert.throws(() => cred.parseTokenGrant({ ...base, expires_in: 0 }), /expires_in/);
    assert.throws(() => cred.parseTokenGrant({ ...base, access_token: "" }), /access_token/);
    // 续期响应不回 refresh_token 时回退到上一个（§2.3）
    const g = cred.parseTokenGrant({ access_token: "mmoat_z", token_type: "Bearer", expires_in: 60, scope: "agent.default" }, "mmort_old");
    assert.equal(g.refreshToken, "mmort_old");
    assert.ok(g.expiresAt > Date.now(), "access_token 非 JWT ⇒ expires_at 由 expires_in 自算（§2.1）");
  });

  it("完整 login：onUrl 立刻回调、优先 verification_uri_complete、落盘", async () => {
    tokenCalls = 0;
    tokenScript.length = 0;
    tokenScript.push(
      { status: 200, body: { status: "pending" } },
      {
        status: 200,
        body: {
          access_token: "mmoat_login",
          refresh_token: "mmort_login",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "agent.default",
          account_id: ACCOUNT_ID,
          nickname: "MiniMax User",
        },
      },
    );
    const urls: string[] = [];
    const statuses: string[] = [];
    const c = await cred.login(fakeBase(), {
      onUrl: (u) => urls.push(u),
      onStatus: (m) => statuses.push(m),
      sleep: async () => {},
    });
    assert.deepEqual(urls, [`${fakeBase()}/device?user_code=ABCD-EFGH`], "优先带 user_code 的完整链接");
    assert.ok(statuses.length > 0);
    assert.equal(c.accessToken, "mmoat_login");
    assert.equal(c.refreshToken, "mmort_login");
    assert.equal(c.uid, ACCOUNT_ID);
    assert.equal(c.nickname, "MiniMax User");
    assert.equal(cred.load().accessToken, "mmoat_login", "登录后已落盘");
  });

  it("续期：grant_type=refresh_token，保留旧 refresh_token 与账号字段（§2.3）", async () => {
    const c = await saveFakeCreds();
    tokenCalls = 0;
    tokenScript.length = 0;
    tokenScript.push({
      status: 200,
      body: { access_token: "mmoat_new", token_type: "Bearer", expires_in: 3600, scope: "agent.default" },
    });
    const next = await cred.refresh(c, fakeBase());
    assert.equal(next.accessToken, "mmoat_new");
    assert.equal(next.refreshToken, c.refreshToken, "响应不回 refresh_token → 保留旧的");
    assert.equal(next.uid, ACCOUNT_ID);
    assert.equal(cred.load().accessToken, "mmoat_new", "续期后磁盘同步");
  });
});

// ── 4. 请求头 ─────────────────────────────────────────────────────────────────

describe("4. 请求头", () => {
  it("仅 Authorization + Content-Type + Accept，不含 anthropic-version（§2.2/§3.4）", () => {
    const headers = upstream.buildHeaders({ accessToken: "mmoat_x" });
    assert.equal(headers["Authorization"], "Bearer mmoat_x");
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers["Accept"], "text/event-stream");
    assert.ok(!("anthropic-version" in headers), "不照抄 Anthropic 官方文档加那个头");
    assert.ok(!("X-Device-Mid" in headers));
  });

  it("业务端点 Accept 是 application/json（§2.2）", () => {
    const headers = upstream.businessHeaders({ accessToken: "mmoat_x" });
    assert.equal(headers["Accept"], "application/json");
    assert.equal(headers["Authorization"], "Bearer mmoat_x");
  });
});

// ── 5. 请求体改写 ─────────────────────────────────────────────────────────────

describe("5. 请求体：OpenAI → Anthropic Messages", () => {
  it("system 是顶层字符串；messages 转块数组（§3.1）", () => {
    const body = upstream.buildChatBody(
      {
        model: "x",
        messages: [
          { role: "system", content: "你是助手" },
          { role: "user", content: "你好" },
        ],
        max_tokens: 4096,
        temperature: 0.5,
        stop: ["END"],
      },
      "MiniMax-M3.1-Flash-Preview",
    );
    assert.equal(body["model"], "MiniMax-M3.1-Flash-Preview");
    assert.equal(body["system"], "你是助手");
    assert.equal(body["stream"], true, "恒设 stream:true");
    assert.equal(body["max_tokens"], 4096);
    assert.equal(body["temperature"], 0.5);
    assert.deepEqual(body["stop_sequences"], ["END"]);
    const messages = body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    assert.deepEqual(messages.map((m) => m.role), ["user"], "system 不进 messages");
    assert.equal(messages[0]!.content[0]!["type"], "text");
    assert.equal(messages[0]!.content[0]!["text"], "你好");
  });

  it("成对提交：assistant + 其全部 tool_result 作为一组（§3.3）", () => {
    const body = upstream.buildChatBody(
      {
        model: "x",
        messages: [
          { role: "user", content: "跑一下" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
              { id: "call_2", type: "function", function: { name: "read", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "ok" },
          { role: "tool", tool_call_id: "call_2", content: "file" },
          { role: "user", content: "谢谢" },
        ],
      },
      "MiniMax-M3.1-Flash-Preview",
    );
    const messages = body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user", "user"]);
    const assistant = messages[1]!.content;
    const toolUses = assistant.filter((b) => b["type"] === "tool_use");
    assert.equal(toolUses.length, 2, "assistant 的全部 tool_use 一起提交");
    assert.deepEqual(toolUses[0]!["input"], { cmd: "ls" });
    // 紧随其后的 user 消息携带**全部** tool_result（成对提交）
    const results = messages[2]!.content.filter((b) => b["type"] === "tool_result");
    assert.equal(results.length, 2, "N 个结果合成一条 user 的 N 个 tool_result 块");
    assert.equal(results[0]!["tool_use_id"], "call_1");
    assert.equal(results[1]!["tool_use_id"], "call_2");
  });

  it("图片：裸 base64、无 data: 前缀；内联失败抛错（§3.3）", () => {
    const body = upstream.buildChatBody(
      {
        model: "x",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "看图" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
        ],
      },
      "MiniMax-M3.1-Flash-Preview",
    );
    const messages = body["messages"] as Array<{ content: Array<Record<string, unknown>> }>;
    const image = messages[0]!.content.find((b) => b["type"] === "image") as Record<string, unknown>;
    const source = image["source"] as Record<string, unknown>;
    assert.equal(source["type"], "base64");
    assert.equal(source["media_type"], "image/png");
    assert.equal(source["data"], "AAAA", "裸 base64，无 data: 前缀");

    assert.throws(
      () =>
        upstream.buildChatBody(
          { model: "x", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }] },
          "MiniMax-M3.1-Flash-Preview",
        ),
      /图片/,
      "消息体里的图片内联失败必须抛错，不静默丢图",
    );
  });

  it("thinking 决策表（§3.2）：none/on/档位/必须 adaptive/默认不发", () => {
    const mk = (effort: string | undefined, model: string): Record<string, unknown> =>
      upstream.buildChatBody(
        { model: "x", messages: [{ role: "user", content: "hi" }], ...(effort ? { reasoning_effort: effort } : {}) },
        model,
      );
    assert.deepEqual(mk("none", "MiniMax-M2.7")["thinking"], { type: "disabled" });
    assert.deepEqual(mk("on", "MiniMax-M2.7")["thinking"], { type: "adaptive" });
    const tiered = mk("high", "MiniMax-M3.1-Flash-Preview");
    assert.deepEqual(tiered["thinking"], { type: "adaptive" });
    assert.deepEqual(tiered["output_config"], { effort: "high" });
    // M3.1 必须 adaptive，传 none 也是 adaptive（不是 disabled）
    assert.deepEqual(mk("none", "MiniMax-M3.1-Flash-Preview")["thinking"], { type: "adaptive" });
    assert.equal(mk(undefined, "MiniMax-M3.1-Flash-Preview")["thinking"] !== undefined, true, "M3.1 不发 thinking 会被硬拒 400");
    // M2.7 / M3 无档位：整个不发
    assert.ok(!("thinking" in mk(undefined, "MiniMax-M2.7")));
    assert.ok(!("thinking" in mk(undefined, "MiniMax-M3")));
  });
});

// ── 6. 增量翻译器 ─────────────────────────────────────────────────────────────

describe("6. Anthropic SSE → OpenAI delta（增量翻译器）", () => {
  it("一次性喂入：正文/思考/stop_reason/usage/[DONE]（§4）", () => {
    const translator = upstream.newTranslator();
    const frames = [...translator.feed(anthropicWire()), ...translator.finish()];
    const got = collect(frames);
    assert.equal(got.content, "答案是 42");
    assert.equal(got.reasoning, "让我想想", "thinking 块必须映射成 reasoning");
    assert.deepEqual(got.finishes, ["stop"]);
    assert.deepEqual(got.usage, {
      prompt_tokens: 100,
      completion_tokens: 25,
      total_tokens: 125,
      completion_tokens_details: { reasoning_tokens: 8 },
    });
    assert.ok(got.blob.includes("data: [DONE]"));
    assert.ok(!got.blob.includes("deadbeef"), "signature_delta 必须忽略（当文本会注入十六进制）");
  });

  it("逐字节喂入（TCP 任意切分 / 中文多字节被切开）", () => {
    const wire = anthropicWire();
    const translator = upstream.newTranslator();
    const frames: Array<Buffer | string> = [];
    for (let i = 0; i < wire.length; i += 1) frames.push(...translator.feed(wire.subarray(i, i + 1)));
    frames.push(...translator.finish());
    const got = collect(frames);
    assert.equal(got.content, "答案是 42");
    assert.equal(got.reasoning, "让我想想");
    assert.ok(!got.blob.includes("\uFFFD"), "逐 chunk toString() 会把中文切成替换字符");
  });

  it("不规则块大小喂入", () => {
    const wire = anthropicWire();
    for (const size of [3, 7, 1, 64, 2, 512, 1000]) {
      const translator = upstream.newTranslator();
      const frames: Array<Buffer | string> = [];
      for (let pos = 0; pos < wire.length; pos += size) {
        frames.push(...translator.feed(wire.subarray(pos, pos + size)));
      }
      frames.push(...translator.finish());
      assert.equal(collect(frames).content, "答案是 42", `块大小 ${size}`);
    }
  });

  it("无内容块 → finish 抛错（§4）", () => {
    const translator = upstream.newTranslator();
    translator.feed(Buffer.from('event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n', "utf8"));
    assert.throws(() => translator.finish(), /内容块/);
  });

  it("断流（无 message_stop）也补 finish_reason 与 [DONE]", () => {
    const translator = upstream.newTranslator();
    const frames = [
      ...translator.feed(
        Buffer.from('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"半截"}}\n\n', "utf8"),
      ),
      ...translator.finish(),
    ];
    const got = collect(frames);
    assert.equal(got.content, "半截");
    assert.deepEqual(got.finishes, ["stop"]);
    assert.ok(got.blob.trimEnd().endsWith("data: [DONE]"));
  });

  it("error 事件显式产出 error 帧，仍以 [DONE] 收尾", () => {
    const translator = upstream.newTranslator();
    const frames = [
      ...translator.feed(Buffer.from('event: error\ndata: {"type":"error","error":{"code":2013,"message":"上游过载"}}\n\n', "utf8")),
      ...translator.finish(),
    ];
    const blob = collect(frames).blob;
    assert.ok(blob.includes('"error"'), "静默当成正常结束会让 UI「干净地停止、无报错」");
    assert.ok(blob.includes("上游过载"));
    assert.ok(blob.includes("2013"));
    assert.ok(blob.trimEnd().endsWith("data: [DONE]"));
  });

  it("工具调用：content_block_start(tool_use) + input_json_delta", () => {
    const wire = Buffer.from(
      [
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"bash"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"ls\\"}"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
      ].join(""),
      "utf8",
    );
    const t = upstream.newTranslator();
    const got = collect([...t.feed(wire), ...t.finish()]);
    assert.equal(got.toolCalls[0]!["id"], "toolu_1");
    assert.equal((got.toolCalls[0]!["function"] as Record<string, unknown>)["name"], "bash");
    assert.deepEqual(got.finishes, ["tool-calls"], "stop_reason tool_use → tool-calls");
  });

  it("注释行与 ping 不产出", () => {
    const frames = upstream.newTranslator().feed(Buffer.from(': keep-alive\n\nevent: ping\ndata: {"type":"ping"}\n\n', "utf8"));
    assert.deepEqual(frames, []);
  });
});

// ── 7. 模型目录 ───────────────────────────────────────────────────────────────

describe("7. 模型目录", () => {
  it("池子只放行 flash（只有 M3.1-Flash-Preview 进池，其余不进 = 预期）", () => {
    const ids = catalog.exposedIds();
    assert.deepEqual(ids, ["MiniMax-M3.1-Flash-Preview"], "flash-only 池策略");
    assert.ok(!ids.includes("MiniMax-M3"));
    assert.ok(!ids.includes("MiniMax-M2.7"));
    // 过滤只发生在呈现层：目录数据仍完整（4 条）
    const detailIds = catalog.details().map((d) => d["id"]);
    assert.equal(detailIds.length, 4);
    assert.ok(detailIds.includes("MiniMax-M3"), "非 flash 仍在底层目录（数据没丢）");
  });

  it("兜底表字面量照 §5.2（窗口取档位最大档）", () => {
    const entries = catalog.FALLBACK_MODELS;
    assert.deepEqual(
      entries.map((e) => e.id),
      ["MiniMax-M3.1-Flash-Preview", "MiniMax-M3", "MiniMax-M2.7-highspeed", "MiniMax-M2.7"],
    );
    const flash = entries[0]!;
    assert.equal(flash.contextWindow, 1_000_000, "context_window_options 最大档 1M（不是 limit.context 的 512000）");
    assert.equal(flash.thinkingMode, "forced_on");
    assert.deepEqual(flash.effortOptions, ["default", "low", "medium", "high", "xhigh", "max"]);
    assert.equal(flash.defaultEffort, "default");
    assert.equal(entries[1]!.thinkingMode, "switchable");
    assert.equal(entries[2]!.supportsImage, false);
  });

  it("resolveModel：id 即 slug，大小写不敏感命中，未知名原样透传", () => {
    assert.equal(catalog.resolveModel("MiniMax-M3.1-Flash-Preview"), "MiniMax-M3.1-Flash-Preview");
    assert.equal(catalog.resolveModel("minimax-m3"), "MiniMax-M3", "小写命中 id");
    assert.equal(catalog.resolveModel("M3.1-Flash-Preview"), "MiniMax-M3.1-Flash-Preview", "展示短名命中");
    assert.equal(catalog.resolveModel("no-such-model"), "no-such-model", "未知原样透传");
  });

  it("fetchModels：URL 带 region=cn&buildEnv=prod，解析 providers[].config.models（§5.1）", async () => {
    assert.equal(
      upstream.modelsUrl({ ...upstream.defaultConfig(), baseUrl: fakeBase() }),
      `${fakeBase()}/mavis/api/v1/models?region=cn&buildEnv=prod`,
    );
    const data = await upstream.fetchModels({ accessToken: "mmoat_x" });
    const models = data["models"] as Array<Record<string, unknown>>;
    assert.deepEqual(
      models.map((m) => m["id"]),
      ["MiniMax-M3.1-Flash-Preview", "MiniMax-M3"],
      "按 model_order 排序，key 注入为 id",
    );
    const flash = models[0]!;
    assert.equal(flash["name"], "M3.1-Flash-Preview", "条目 name 是短名");
    assert.equal(flash["contextWindow"], 1_000_000, "窗口取 context_window_options 最大档");
    assert.equal(flash["maxTokens"], 128_000, "maxTokens 取 limit.output");
    assert.equal(flash["supportsImage"], true);
    assert.equal(flash["defaultEffort"], "default");
    assert.equal(flash["thinkingMode"], "forced_on");
  });

  it("normalizeModel：defaultEffort 不落在 effortOptions 内即丢弃（§5.1）", () => {
    const entry = upstream.normalizeModel("m", {
      name: "m",
      limit: { context: 4096, output: 1024 },
      effort_options: ["low", "high"],
      default_effort: "medium", // 不在 effort_options → 丢弃
      thinking_config: { mode: "forced_on" },
    });
    assert.equal(entry.defaultEffort, null);
    assert.equal(entry.contextWindow, 4096, "无档位表回退 limit.context");
  });
});

// ── 8. 额度与签到 ─────────────────────────────────────────────────────────────

describe("8. 额度与签到", () => {
  before(async () => {
    await saveFakeCreds();
  });

  it("fetchCredits：余额 = Σ remaining_amount；timezone_id 是 IANA 名 query（§6.2/§6.4）", async () => {
    signinMode = "ok";
    creditMode = "ok";
    const info = await billing.fetchCredits();
    assert.equal(info.ok, true);
    assert.equal(info.total.remain, 1000, "800 + 200");
    assert.equal(info.total.size, 1200, "800 + 400 granted");
    assert.equal(info.total.used, 200);
    assert.equal(info.total.unit, "points");
    assert.equal(info.claimable?.[0]?.["day_no"], 2, "今日可领 → claimable");
    // timezone_id 是 signin/status 的必填 query，且必须是 IANA 名（§6.2 点 1）
    assert.ok(lastSigninQuery.includes("timezone_id="), "timezone_id 是必填 query");
    const tz = decodeURIComponent(
      new URLSearchParams(lastSigninQuery.replace(/^\?/, "")).get("timezone_id") ?? "",
    );
    assert.ok(tz === "UTC" || tz.includes("/"), `timezone_id 必须是 IANA 名（收到 ${tz}）`);
  });

  it("签到面板硬校验失败 → CreditsError（不当作 0）", async () => {
    signinMode = "biz_fail";
    await assert.rejects(billing.fetchCredits(), billing.CreditsError);
    signinMode = "ok";
  });

  it("credit/details 非 200 → CreditsError（「查不到」不能显示成 0）", async () => {
    creditMode = "500";
    try {
      await assert.rejects(billing.fetchCredits(), billing.CreditsError);
    } finally {
      creditMode = "ok";
    }
  });

  it("未登录 → NotLoggedInError", async () => {
    rmSync(paths.credentialsPath(), { force: true });
    await assert.rejects(billing.fetchCredits({ refreshOn401: false }), cred.NotLoggedInError);
    await saveFakeCreds();
  });

  it("签到面板解析：今日已领 = is_today && status===3；claim 幂等 = claim_result 2（§6.2/§6.3）", () => {
    const panel = billing.parseSigninPanel({
      days: [
        { day_no: 1, points: 10, is_today: false, status: 3 },
        { day_no: 2, points: 20, is_today: true, status: 3 },
        { day_no: 3, points: 30, is_today: false, status: 1 },
        { day_no: 4, points: 40, is_today: false, status: 1 },
        { day_no: 5, points: 50, is_today: false, status: 1 },
        { day_no: 6, points: 60, is_today: false, status: 1 },
        { day_no: 7, points: 70, is_today: false, status: 1 },
      ],
      scene: 3,
    });
    assert.equal(panel.claimedToday, true, "is_today && status 3");
    assert.equal(panel.claimable, null);
    assert.equal(panel.isStreakDay, false, "isStreakDay 不可判读 → 恒 false");
    // days 不是恰 7 条 → 抛
    assert.throws(() => billing.parseSigninPanel({ days: [] }), billing.CreditsError);
  });

  it("claimSignin：重复领取幂等判据 claim_result===2（§6.2）", async () => {
    claimCalls = 0;
    claimScript = [2, 1];
    const first = await billing.claimSignin();
    assert.equal(first.claimResult, 2);
    assert.equal(first.alreadyClaimed, true);
    const second = await billing.claimSignin();
    assert.equal(second.claimResult, 1);
    assert.equal(second.alreadyClaimed, false);
  });
});

// ── 9. 端到端网关 ─────────────────────────────────────────────────────────────

describe("9. 端到端网关（假上游 + 真实网关）", () => {
  let gw: gateway.RunningGateway;

  before(async () => {
    await upstream.saveConfig({ ...upstream.defaultConfig(), baseUrl: fakeBase() });
    await saveFakeCreds();
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
  });

  it("/v1/models 只返回池内模型（flash-only）", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/models`);
    assert.equal(resp.status, 200);
    const payload = (await resp.json()) as { data: Array<{ id: string }> };
    assert.deepEqual(payload.data.map((m) => m.id), ["minimax-m3.1-flash-preview"], "对外 id 恒小写");
  });

  it("/health 报告 ok 与登录状态", async () => {
    const resp = await fetch(`http://${gw.addr}/health`);
    const payload = (await resp.json()) as Record<string, unknown>;
    assert.equal(payload["ok"], true);
    assert.equal(payload["logged_in"], true);
  });

  it("流式对话：自定义线型被增量翻译出正文；核对上游真实收到的头与体", async () => {
    chatMode = "ok";
    const { status, text } = await readSse(`http://${gw.addr}/v1/chat/completions`, {
      model: "MiniMax-M3.1-Flash-Preview",
      messages: [
        { role: "system", content: "你是助手" },
        { role: "user", content: "hi" },
      ],
      stream: true,
    });
    assert.equal(status, 200);
    assert.equal(contentOf(text), "网关通了");
    assert.ok(text.includes("data: [DONE]"));

    assert.equal(chatHeaders["authorization"], "Bearer mmoat_e2e_access_token");
    assert.equal(chatHeaders["accept"], "text/event-stream");
    assert.ok(!("anthropic-version" in chatHeaders));
    const body = chatBody!;
    assert.equal(body["model"], "MiniMax-M3.1-Flash-Preview", "短名映射为上游 slug");
    assert.equal(body["stream"], true);
    assert.equal(body["system"], "你是助手", "system 是顶层字符串");
    assert.ok(body["thinking"] !== undefined, "M3.1 必须发 adaptive thinking");
  });

  it("非流式：本层聚合成 chat.completion", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "MiniMax-M3.1-Flash-Preview", messages: [{ role: "user", content: "hi" }] }),
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
    chatMode = "500";
    try {
      const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: "MiniMax-M3.1-Flash-Preview", messages: [{ role: "user", content: "hi" }], stream: true }),
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(resp.status, 502);
      const payload = (await resp.json()) as { error: { code: string; message: string } };
      assert.equal(payload.error.code, "upstream_error");
      assert.ok(!payload.error.message.includes("internal detail leak"));
    } finally {
      chatMode = "ok";
    }
  });

  it("请求校验：缺 model/messages 返回 400 统一信封", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "MiniMax-M3.1-Flash-Preview" }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 400);
    const payload = (await resp.json()) as { error: { code: string } };
    assert.equal(payload.error.code, "invalid_request");
  });

  it("凭据被拒时 refresh 走设备码续期端点", async () => {
    const c = await saveFakeCreds();
    tokenCalls = 0;
    tokenScript.length = 0;
    tokenScript.push({
      status: 200,
      body: { access_token: "mmoat_refreshed", token_type: "Bearer", expires_in: 3600, scope: "agent.default" },
    });
    const next = await cred.refresh(c, fakeBase());
    assert.equal(next.accessToken, "mmoat_refreshed");
  });
});
