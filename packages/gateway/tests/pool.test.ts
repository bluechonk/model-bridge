/**
 * 模型池路由：`<cid>/<模型>` → 渠道；`/v1/models` 并集；`/health` 逐渠道。
 *
 * 用两个**合成渠道**（各自的假上游 + 假凭据），完全不碰磁盘与真实账号。
 * 单渠道模式的兼容行为（裸短名、`logged_in` 形状）另有用例锁定。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import {
  channelCount,
  channels,
  clearChannels,
  setChannel,
  type Channel,
} from "../dist/channel.js";
import * as gateway from "../dist/gateway.js";
import { resolveTarget } from "../dist/gateway.js";

// ── 合成渠道 ─────────────────────────────────────────────────────────────────

interface Captured {
  url: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string | string[] | undefined>;
}

/** 起一个假上游，记录收到的请求。 */
async function fakeUpstream(tag: string): Promise<{ server: Server; url: string; captured: Captured[] }> {
  const captured: Captured[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += String(c);
    });
    req.on("end", () => {
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = null;
      }
      captured.push({ url: req.url ?? "", body, headers: { ...req.headers } });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ id: tag, model: tag, created: 1, choices: [{ index: 0, delta: { content: tag }, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ id: tag, model: tag, created: 1, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return { server, url: `http://127.0.0.1:${port}`, captured };
}

/** 造一个合成渠道：模型池只暴露 `pool-<tag>` 与大小写混排的 `Mixed-<tag>`，上游是假服务。 */
function makeChannel(cid: string, tag: string, upstreamUrl: string): Channel {
  const models: Record<string, string> = {
    [`pool-${tag}`]: `upstream-${tag}`,
    [`Mixed-${tag}`]: `Upstream-Mixed-${tag}`,
  };
  return {
    config: {
      cid,
      display: `Synth ${tag}`,
      version: "0.0.0",
      defaultAddr: "127.0.0.1:1",
      uiPort: 2,
      legacyDirs: [`.${cid}-bridge`],
      debugDumpEnv: `${cid.toUpperCase()}_DEBUG_DUMP`,
    },
    cred: {
      DEFAULT_BASE_URL: upstreamUrl,
      NotLoggedInError: class NotLoggedInError extends Error {},
      load: () => ({ accessToken: `tok-${tag}`, uid: `uid-${tag}`, domain: "" }),
      save: async () => {},
      login: async () => ({ accessToken: `tok-${tag}`, uid: `uid-${tag}`, domain: "" }),
      refresh: async (c: unknown) => c,
      resolveBaseUrl: () => upstreamUrl,
    },
    upstream: {
      DEFAULT_BASE_URL: upstreamUrl,
      WIRE: "openai" as const,
      DISPLAY_NAME: `Synth ${tag}`,
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({ baseUrl: upstreamUrl }),
      loadConfig: () => [{ baseUrl: upstreamUrl }, false],
      saveConfig: async () => {},
      chatUrl: () => `${upstreamUrl}/chat`,
      modelsUrl: () => `${upstreamUrl}/models`,
      buildHeaders: (credential: { accessToken: string }) => ({
        Authorization: `Bearer ${credential.accessToken}`,
      }),
      // 打上渠道标记，测试据此断言请求真的路由到该渠道
      buildChatBody: (req: Record<string, unknown>, upstreamModel: string) => ({
        ...req,
        model: upstreamModel,
        routed_to: tag,
      }),
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: upstreamUrl }),
      newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
    },
    catalog: {
      exposedIds: () => Object.keys(models),
      resolveModel: (name: string) => models[name] ?? name,
    },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

async function readSse(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const resp = await fetch(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return { status: resp.status, text: await resp.text() };
}

// ── 多渠道路由 ───────────────────────────────────────────────────────────────

describe("1. 多渠道路由（两张池子）", () => {
  let alpha: Awaited<ReturnType<typeof fakeUpstream>>;
  let beta: Awaited<ReturnType<typeof fakeUpstream>>;
  let gw: gateway.RunningGateway;

  before(async () => {
    alpha = await fakeUpstream("alpha");
    beta = await fakeUpstream("beta");
    clearChannels();
    setChannel(makeChannel("alpha", "alpha", alpha.url));
    setChannel(makeChannel("beta", "beta", beta.url));
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => alpha.server.close(() => r()));
    await new Promise<void>((r) => beta.server.close(() => r()));
    clearChannels();
  });

  it("/v1/models 是两张池子的并集，且带 cid 前缀（模型部分恒小写）", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/models`);
    assert.equal(resp.status, 200);
    const payload = (await resp.json()) as { data: Array<{ id: string; owned_by: string }> };
    const ids = payload.data.map((m) => m.id).sort();
    assert.deepEqual(ids, [
      "alpha/mixed-alpha",
      "alpha/pool-alpha",
      "beta/mixed-beta",
      "beta/pool-beta",
    ]);
    assert.ok(ids.every((id) => id === id.toLowerCase()), "对外 id 必须全小写");
    assert.equal(payload.data.find((m) => m.id === "alpha/pool-alpha")!.owned_by, "Synth alpha");
  });

  it("小写 id 大小写不敏感地解析回上游的原始写法", async () => {
    alpha.captured.length = 0;
    const { status } = await readSse(`http://${gw.addr}/v1/chat/completions`, {
      model: "alpha/mixed-alpha",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    assert.equal(status, 200);
    assert.equal(
      alpha.captured[0]!.body!["model"],
      "Upstream-Mixed-alpha",
      "池内 id 小写，但上游 slug 用目录里的原始大小写",
    );
  });

  it("带前缀的模型路由到对应渠道，且模型名按该渠道的目录解析", async () => {
    alpha.captured.length = 0;
    beta.captured.length = 0;
    const first = await readSse(`http://${gw.addr}/v1/chat/completions`, {
      model: "alpha/pool-alpha",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    assert.equal(first.status, 200);
    assert.ok(first.text.includes("alpha"));
    assert.equal(alpha.captured.length, 1, "只打到 alpha 的假上游");
    assert.equal(beta.captured.length, 0);
    assert.equal(alpha.captured[0]!.body!["routed_to"], "alpha");
    assert.equal(alpha.captured[0]!.body!["model"], "upstream-alpha", "短名经该渠道目录映射");
    assert.equal(alpha.captured[0]!.headers["authorization"], "Bearer tok-alpha");

    const second = await readSse(`http://${gw.addr}/v1/chat/completions`, {
      model: "beta/pool-beta",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    assert.equal(second.status, 200);
    assert.equal(beta.captured.length, 1);
    assert.equal(beta.captured[0]!.headers["authorization"], "Bearer tok-beta", "用该渠道自己的凭证");
  });

  it("前缀未知 → 400 unknown_channel（不静默回落到别的渠道）", async () => {
    const { status, text } = await readSse(`http://${gw.addr}/v1/chat/completions`, {
      model: "nope/pool-x",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(status, 400);
    assert.equal((JSON.parse(text) as { error: { code: string } }).error.code, "unknown_channel");
  });

  it("多渠道路由下不带前缀 → 400（不知道发给谁）", async () => {
    const { status, text } = await readSse(`http://${gw.addr}/v1/chat/completions`, {
      model: "pool-alpha",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(status, 400);
    assert.equal((JSON.parse(text) as { error: { code: string } }).error.code, "unknown_channel");
  });

  it("/health 逐渠道报告；/ 列出渠道与服务身份", async () => {
    const health = (await (await fetch(`http://${gw.addr}/health`)).json()) as Record<string, unknown>;
    assert.equal(health["ok"], true);
    assert.equal(health["service"], "model-bridge");
    assert.equal(health["logged_in"], true);
    const per = health["channels"] as Array<{ cid: string; logged_in: boolean }>;
    assert.deepEqual(per.map((c) => c.cid).sort(), ["alpha", "beta"]);

    const root = (await (await fetch(`http://${gw.addr}/`)).json()) as Record<string, unknown>;
    assert.deepEqual(root["channels"], ["alpha", "beta"]);
    assert.equal(root["service"], "model-bridge");
  });
});

describe("2. 单渠道兼容（裸短名）", () => {
  let only: Awaited<ReturnType<typeof fakeUpstream>>;
  let gw: gateway.RunningGateway;

  before(async () => {
    only = await fakeUpstream("solo");
    clearChannels();
    setChannel(makeChannel("solo", "solo", only.url));
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => only.server.close(() => r()));
    clearChannels();
  });

  it("只注册一个渠道时 /v1/models 仍是裸短名，/health 仍是旧形状", async () => {
    const models = (await (await fetch(`http://${gw.addr}/v1/models`)).json()) as {
      data: Array<{ id: string }>;
    };
    assert.deepEqual(
      models.data.map((m) => m.id),
      ["pool-solo", "mixed-solo"],
      "单渠道保持裸短名（既有客户端配置不用改）；池内 id 恒小写",
    );

    const health = (await (await fetch(`http://${gw.addr}/health`)).json()) as Record<string, unknown>;
    assert.equal(health["service"], "solo-bridge");
    assert.equal(health["logged_in"], true);
    assert.equal(health["channels"], undefined, "单渠道不额外塞 channels 字段");
  });

  it("不带前缀的模型仍可用（单渠道模式）", async () => {
    const { status } = await readSse(`http://${gw.addr}/v1/chat/completions`, {
      model: "pool-solo",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    assert.equal(status, 200);
  });

  it("带自身前缀也可以（客户端配置可移植）", async () => {
    const { status } = await readSse(`http://${gw.addr}/v1/chat/completions`, {
      model: "solo/pool-solo",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    assert.equal(status, 200);
  });
});

describe("3. resolveTarget 解析规则", () => {
  it("多渠道路由下逐条判定", () => {
    clearChannels();
    setChannel(makeChannel("alpha", "alpha", "http://127.0.0.1:1"));
    setChannel(makeChannel("beta", "beta", "http://127.0.0.1:1"));
    assert.equal(channelCount(), 2);
    assert.equal(channels().length, 2);

    assert.equal(resolveTarget("alpha/pool-alpha").channel.config.cid, "alpha");
    assert.equal(resolveTarget("alpha/pool-alpha").upstreamModel, "pool-alpha");
    assert.equal(resolveTarget("beta/x").channel.config.cid, "beta");
    assert.throws(() => resolveTarget("gamma/x"), /未知渠道前缀/);
    assert.throws(() => resolveTarget("pool-alpha"), /必须带渠道前缀/);

    clearChannels();
    setChannel(makeChannel("alpha", "alpha", "http://127.0.0.1:1"));
    assert.equal(resolveTarget("pool-alpha").channel.config.cid, "alpha");
    // 单渠道模式下前缀不像渠道名 → 交给该渠道原样处理（上游 slug 可能含 `/`）
    assert.equal(resolveTarget("vendor/model").upstreamModel, "vendor/model");
    clearChannels();
  });
});
