/**
 * 公共模型池：**端到端**（真起 HTTP 网关 + 假上游）。
 *
 * 覆盖对外形态（`/v1/models` 恒三条、不带渠道前缀）与池路由（按账本挑渠道、
 * 失败转移、旧的 `<cid>/<模型>` 形态已失效）。
 *
 * 匹配/归一化的细粒度用例见 `pool-routing.test.ts`；这里只走真实请求路径。
 * 全程离线：假上游是本机 http server，存储根指向 `mkdtemp`。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { channels, clearChannels, setChannel, type Channel } from "../dist/channel.js";
import * as daemon from "../dist/daemon.js";
import * as gateway from "../dist/gateway.js";
import * as paths from "../dist/paths.js";
import * as poolUsage from "../dist/pool-usage.js";

// ── 隔离存储根（账本会落 <root>/pool-usage.json） ─────────────────────────────

let root = "";
let savedRoot: string | undefined;

before(() => {
  root = mkdtempSync(join(tmpdir(), "mb-pool-"));
  savedRoot = process.env["MODEL_BRIDGE_HOME"];
  process.env["MODEL_BRIDGE_HOME"] = root;
});

after(() => {
  if (savedRoot === undefined) delete process.env["MODEL_BRIDGE_HOME"];
  else process.env["MODEL_BRIDGE_HOME"] = savedRoot;
  rmSync(root, { recursive: true, force: true });
});

// ── 假上游 ───────────────────────────────────────────────────────────────────

interface Captured {
  url: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string | string[] | undefined>;
}

interface FakeUpstream {
  server: Server;
  url: string;
  captured: Captured[];
  /** 置 true 后一律回 500（测失败转移）。 */
  fail: boolean;
}

/** 起一个假上游，记录收到的请求；`fail` 置位后回 500。 */
async function fakeUpstream(tag: string): Promise<FakeUpstream> {
  const captured: Captured[] = [];
  const fake: FakeUpstream = { server: null as unknown as Server, url: "", captured, fail: false };
  fake.server = createServer((req, res) => {
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
      if (fake.fail) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "boom" } }));
        return;
      }
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
    fake.server.listen(0, "127.0.0.1", () =>
      resolve((fake.server.address() as { port: number }).port),
    );
  });
  fake.url = `http://127.0.0.1:${port}`;
  return fake;
}

function closeFake(fake: FakeUpstream): Promise<void> {
  return new Promise<void>((resolve) => fake.server.close(() => resolve()));
}

/**
 * 合成渠道：目录是 `[对外名, 上游 slug]` 表，`resolveModel` 做大小写不敏感匹配
 * （与真实渠道同构，用来验证「小写进池、原始写法出上游」）。
 */
function makeChannel(cid: string, upstreamUrl: string, models: Array<[string, string]>): Channel {
  return {
    config: {
      cid,
      display: `Synth ${cid}`,
      version: "0.0.0",
      defaultAddr: "127.0.0.1:1",
      uiPort: 2,
      legacyDirs: [`.${cid}-bridge`],
      debugDumpEnv: `${cid.toUpperCase()}_DEBUG_DUMP`,
    },
    cred: {
      DEFAULT_BASE_URL: upstreamUrl,
      NotLoggedInError: class NotLoggedInError extends Error {},
      load: () => ({ accessToken: `tok-${cid}`, uid: `uid-${cid}`, domain: "" }),
      save: async () => {},
      login: async () => ({ accessToken: `tok-${cid}`, uid: `uid-${cid}`, domain: "" }),
      refresh: async (c: unknown) => c,
      resolveBaseUrl: () => upstreamUrl,
    },
    upstream: {
      DEFAULT_BASE_URL: upstreamUrl,
      WIRE: "openai" as const,
      DISPLAY_NAME: `Synth ${cid}`,
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
        routed_to: cid,
      }),
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: upstreamUrl }),
      newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
    },
    catalog: {
      exposedIds: () => models.map(([exposed]) => exposed),
      resolveModel: (name: string) => {
        const hit = models.find(([exposed]) => exposed.toLowerCase() === name.toLowerCase());
        return hit ? hit[1]! : name;
      },
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

function chat(gw: gateway.RunningGateway, model: string) {
  return readSse(`http://${gw.addr}/v1/chat/completions`, {
    model,
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  });
}

// ── 1. 对外形态与池路由 ──────────────────────────────────────────────────────

describe("1. /v1/models 只有三个模型，请求由池决定落到谁", () => {
  let deep: FakeUpstream; // 提供 deepseek-v4-flash（目录里是混排大小写 + 一个 glm）
  let four: FakeUpstream; // 提供 deepseek-v4.1-flash（raccoon 式连字符写法）
  let gw: gateway.RunningGateway;

  before(async () => {
    deep = await fakeUpstream("deep");
    four = await fakeUpstream("four");
    clearChannels();
    poolUsage.resetPoolLedgerForTest();
    setChannel(
      makeChannel("alpha", deep.url, [
        ["DeepSeek-V4-Flash", "DeepSeek-V4-Flash-Official"],
        ["glm-5.3-flash", "GLM-5.3-Flash"],
        ["glm-5.3-flashx", "GLM-5.3-FlashX"], // 不在池内
      ]),
    );
    setChannel(
      makeChannel("beta", four.url, [["sn-deepseek-v4-1-flash", "sn-deepseek-v4-1-flash"]]),
    );
    // 预写账本：既设定用量，也让 needsBillingRefresh 为 false（否则请求会触发后台刷新）
    poolUsage.writeBilling("alpha", { total: { used: 0 } });
    poolUsage.writeBilling("beta", { total: { used: 0 } });
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await closeFake(deep);
    await closeFake(four);
    clearChannels();
  });

  it("/v1/models 恒返回三个模型，不带渠道前缀", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/models`);
    assert.equal(resp.status, 200);
    const payload = (await resp.json()) as { data: Array<{ id: string; owned_by: string }> };
    assert.deepEqual(
      payload.data.map((m) => m.id),
      ["deepseek-v4.1-flash", "deepseek-v4-flash", "glm-5.3-flash"],
    );
    assert.equal(payload.data[0]!.owned_by, "model-bridge", "池身份，不泄露候选渠道");
  });

  it("请求 deepseek-v4-flash → 打到唯一能提供它的渠道，且用目录里的原始 slug", async () => {
    deep.captured.length = 0;
    four.captured.length = 0;
    const { status } = await chat(gw, "deepseek-v4-flash");
    assert.equal(status, 200);
    assert.equal(deep.captured.length, 1);
    assert.equal(four.captured.length, 0);
    assert.equal(deep.captured[0]!.body!["routed_to"], "alpha");
    assert.equal(
      deep.captured[0]!.body!["model"],
      "DeepSeek-V4-Flash-Official",
      "池内 id 是小写规范名，上游收到的是目录里的原始写法",
    );
    assert.equal(deep.captured[0]!.headers["authorization"], "Bearer tok-alpha");
  });

  it("大小写不敏感：DeepSeek-V4-Flash 同样命中", async () => {
    deep.captured.length = 0;
    const { status } = await chat(gw, "DeepSeek-V4-Flash");
    assert.equal(status, 200);
    assert.equal(deep.captured.length, 1);
  });

  it("4.0 与 4.1 不串号：deepseek-v4.1-flash 只打到提供 4.1 的渠道", async () => {
    deep.captured.length = 0;
    four.captured.length = 0;
    const { status } = await chat(gw, "deepseek-v4.1-flash");
    assert.equal(status, 200);
    assert.equal(four.captured.length, 1);
    assert.equal(deep.captured.length, 0, "4.0 的渠道不该被 4.1 的请求命中");
  });

  it("glm-5.3-flash 命中对应上游；flashx 不在池内", async () => {
    deep.captured.length = 0;
    const ok = await chat(gw, "glm-5.3-flash");
    assert.equal(ok.status, 200);
    assert.equal(deep.captured[0]!.body!["model"], "GLM-5.3-Flash");
    // flashx 不在池内 → 当作未知模型
    const fx = await chat(gw, "glm-5.3-flashx");
    assert.equal(fx.status, 400);
  });

  it("没有任何渠道提供的池模型 → 503", async () => {
    const keep = channels();
    clearChannels();
    try {
      const solo = await gateway.start("127.0.0.1:0", { logger: () => {} });
      try {
        const { status, text } = await chat(solo, "glm-5.3-flash");
        assert.equal(status, 503);
        assert.equal(
          (JSON.parse(text) as { error: { code: string } }).error.code,
          "not_authenticated",
        );
      } finally {
        await solo.close();
      }
    } finally {
      for (const c of keep) setChannel(c);
    }
  });

  it("未知模型 → 400 并列出三个可用 id", async () => {
    const { status, text } = await chat(gw, "gpt-4o");
    assert.equal(status, 400);
    const err = JSON.parse(text) as { error: { code: string; message: string } };
    assert.equal(err.error.code, "unknown_model");
    assert.ok(err.error.message.includes("deepseek-v4.1-flash"));
    assert.ok(err.error.message.includes("glm-5.3-flash"));
  });

  it("旧的 `<cid>/<模型>` 形态已失效（破坏性更新）", async () => {
    const { status, text } = await chat(gw, "alpha/deepseek-v4-flash");
    assert.equal(status, 400);
    assert.equal((JSON.parse(text) as { error: { code: string } }).error.code, "unknown_model");
  });

  it("/health 逐渠道报告；/ 列出渠道与服务身份", async () => {
    const health = (await (await fetch(`http://${gw.addr}/health`)).json()) as Record<
      string,
      unknown
    >;
    assert.equal(health["ok"], true);
    assert.equal(health["service"], "model-bridge");
    assert.equal(health["logged_in"], true);
    const per = health["channels"] as Array<{ cid: string; logged_in: boolean }>;
    assert.deepEqual(per.map((c) => c.cid).sort(), ["alpha", "beta"]);

    const rootInfo = (await (await fetch(`http://${gw.addr}/`)).json()) as Record<string, unknown>;
    assert.deepEqual(rootInfo["channels"], ["alpha", "beta"]);
    assert.equal(rootInfo["service"], "model-bridge");
  });
});

// ── 2. 账单已用量决定落到谁 ──────────────────────────────────────────────────

describe("2. 账单已用量排序：用得多的先走，失败当 0", () => {
  let first: FakeUpstream; // 用量高
  let second: FakeUpstream; // 用量低
  let gw: gateway.RunningGateway;

  const both = (): Array<[string, string]> => [["deepseek-v4-flash", "deepseek-v4-flash"]];

  before(async () => {
    first = await fakeUpstream("first");
    second = await fakeUpstream("second");
    clearChannels();
    poolUsage.resetPoolLedgerForTest();
    setChannel(makeChannel("first", first.url, both()));
    setChannel(makeChannel("second", second.url, both()));
    poolUsage.writeBilling("first", { total: { used: 100, unit: "credits" } });
    poolUsage.writeBilling("second", { total: { used: 10, unit: "credits" } });
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await closeFake(first);
    await closeFake(second);
    clearChannels();
  });

  it("已用量大的渠道优先", async () => {
    first.captured.length = 0;
    second.captured.length = 0;
    const { status } = await chat(gw, "deepseek-v4-flash");
    assert.equal(status, 200);
    assert.equal(first.captured.length, 1, "used=100 的渠道先走");
    assert.equal(second.captured.length, 0);
  });

  it("首选失败 → 落到次选，并把失败的渠道记进账本冷却", async () => {
    first.captured.length = 0;
    second.captured.length = 0;
    first.fail = true;
    try {
      const { status } = await chat(gw, "deepseek-v4-flash");
      assert.equal(status, 200, "次选顶上，客户端拿到正常响应");
      assert.equal(first.captured.length, 1, "先试了用量高的那家");
      assert.equal(second.captured.length, 1, "失败后落到次选");
      assert.ok(poolUsage.ledgerSnapshot().channels["first"]!.fail >= 1, "失败要记进账本");
      assert.ok(
        poolUsage.ledgerSnapshot().channels["first"]!.cooldown_until > Date.now(),
        "失败的渠道进入冷却",
      );
    } finally {
      first.fail = false;
    }
  });

  it("冷却期内排序当 0 → 直接走另一家（不再白试一次）", async () => {
    first.captured.length = 0;
    second.captured.length = 0;
    assert.equal(poolUsage.scoreOf("first"), 0, "冷却中得分当 0");
    assert.equal(poolUsage.scoreOf("second"), 10);
    const { status } = await chat(gw, "deepseek-v4-flash");
    assert.equal(status, 200);
    assert.equal(first.captured.length, 0, "冷却中的渠道不再被优先尝试");
    assert.equal(second.captured.length, 1);
  });
});

// ── 3. 仓库级命令在多渠道路由下可用 ─────────────────────────────────────────

describe("3. 仓库级命令在多渠道路由下可用", () => {
  let solo: FakeUpstream;

  before(async () => {
    solo = await fakeUpstream("x");
    clearChannels();
    poolUsage.resetPoolLedgerForTest();
    setChannel(makeChannel("alpha", solo.url, [["deepseek-v4-flash", "deepseek-v4-flash"]]));
    setChannel(makeChannel("beta", solo.url, [["deepseek-v4-flash", "deepseek-v4-flash"]]));
  });

  after(async () => {
    await closeFake(solo);
    clearChannels();
  });

  it("daemon.status 不抛错（根级路径解析不再要求「唯一渠道」）", async () => {
    // 回归：曾因 paths.rootDir() 走 getChannel() 而在多渠道路由下直接抛错
    const code = await daemon.status({ json: true, addr: "127.0.0.1:1", uiPort: 1 });
    assert.equal(code, 0);
  });

  it("daemon.logs / paths 同样不抛错（有无日志文件都不是异常）", () => {
    const code = daemon.logs(1, true);
    assert.ok(code === 0 || code === 1, `logs 返回 ${code}（只该是 0/1）`);
    assert.equal(paths.rootDir(), root);
    assert.ok(paths.rootPidPath().endsWith("gateway.pid"));
    assert.ok(paths.rootLogPath().endsWith("gateway.log"));
  });
});

// ── 4. 单渠道模式 ────────────────────────────────────────────────────────────

describe("4. 单渠道模式也走池（不再暴露裸短名）", () => {
  let only: FakeUpstream;
  let gw: gateway.RunningGateway;

  before(async () => {
    only = await fakeUpstream("solo");
    clearChannels();
    poolUsage.resetPoolLedgerForTest();
    setChannel(makeChannel("solo", only.url, [["deepseek-v4-flash", "deepseek-v4-flash"]]));
    poolUsage.writeBilling("solo", { total: { used: 0 } });
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await closeFake(only);
    clearChannels();
  });

  it("/v1/models 仍是三个池模型；service 身份是 solo-bridge", async () => {
    const models = (await (await fetch(`http://${gw.addr}/v1/models`)).json()) as {
      data: Array<{ id: string; owned_by: string }>;
    };
    assert.deepEqual(
      models.data.map((m) => m.id),
      ["deepseek-v4.1-flash", "deepseek-v4-flash", "glm-5.3-flash"],
    );
    assert.equal(models.data[0]!.owned_by, "solo-bridge");

    const health = (await (await fetch(`http://${gw.addr}/health`)).json()) as Record<
      string,
      unknown
    >;
    assert.equal(health["service"], "solo-bridge");
    assert.equal(health["logged_in"], true);
  });

  it("池内模型可用", async () => {
    const { status } = await chat(gw, "deepseek-v4-flash");
    assert.equal(status, 200);
  });

  it("该渠道提供不了的池模型 → 503", async () => {
    const { status } = await chat(gw, "glm-5.3-flash");
    assert.equal(status, 503);
  });
});
