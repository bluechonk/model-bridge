/**
 * 渠道鉴权失败语义（**完全离线**：mkdtemp 存储根 + 假上游）。
 *
 * 2026-10-18 起：**上游拒绝 token 时绝不删除凭证**。
 * 401/403 可能是账号限制（11140）、临时风控或令牌轮换 —— 凭证是可恢复状态，
 * 删掉等于把可恢复变成不可恢复，用户被迫重新授权。自动化语义：
 * - 失败请求返回 502，健康度标 unauthorized，凭证与池账号**原样保留**；
 * - 已登录但凭据被拒的渠道仍进入路由，后续请求会继续尝试上游并再次失败；
 * - 未登录（没有凭证）的渠道不进入路由（不可能成功，不白耗尝试预算）。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { listAccounts } from "../dist/runtime/account-pool.js";
import { clearChannels, setChannel, type ChannelConfig, type Channel } from "../dist/runtime/channel.js";
import * as gateway from "../dist/http/gateway.js";
import * as paths from "../dist/runtime/paths.js";
import * as poolUsage from "../dist/pool/pool-usage.js";

/** 假上游：tok-dead 一律 401，其它 token 回 200 SSE。 */
async function fakeUpstream(): Promise<{ server: Server; url: string; captured: string[] }> {
  const captured: string[] = [];
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const authorization = String(req.headers["authorization"] ?? "");
      captured.push(authorization);
      if (authorization.includes("tok-dead")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 401, msg: "token rejected" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ id: "c", model: "m", created: 1, choices: [{ index: 0, delta: { content: "alive 回答" }, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ id: "c", model: "m", created: 1, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
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

/** 合成渠道：凭证走**真实文件**（自动登出要删的就是它）；refresh 无端点必然失败。 */
function makeChannel(cid: string, upstreamUrl: string): Channel {
  const config: ChannelConfig = {
    cid,
    display: `Synth ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: `${cid.toUpperCase()}_DEBUG_DUMP`,
  };
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: upstreamUrl,
      NotLoggedInError: class NotLoggedInError extends Error {},
      load: () => JSON.parse(readFileSync(paths.credentialsPath(cid), "utf8")) as Record<string, unknown>,
      save: async () => {},
      login: async () => ({}),
      refresh: async () => {
        throw new Error("no refresh endpoint");
      },
      resolveBaseUrl: () => upstreamUrl,
    },
    upstream: {
      DEFAULT_BASE_URL: upstreamUrl,
      WIRE: "openai" as const,
      DISPLAY_NAME: `Synth ${cid}`,
      chatUrl: () => `${upstreamUrl}/chat`,
      modelsUrl: () => `${upstreamUrl}/models`,
      buildHeaders: (credential: { accessToken: string }) => ({
        Authorization: `Bearer ${credential.accessToken}`,
      }),
      buildChatBody: (req: Record<string, unknown>, upstreamModel: string) => ({ ...req, model: upstreamModel }),
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: upstreamUrl }),
      newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
    },
    catalog: { exposedIds: () => ["glm-5.3-flash"], resolveModel: (n: string) => n },
    billing: {
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

function seedCredential(cid: string, token: string): void {
  mkdirSync(paths.channelDir(cid), { recursive: true });
  writeFileSync(
    paths.credentialsPath(cid),
    JSON.stringify({ accessToken: token, refreshToken: "r", uid: `${cid}-u`, domain: "" }),
    "utf8",
  );
}

async function chat(addr: string): Promise<{ status: number; text: string }> {
  const resp = await fetch(`http://${addr}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  return { status: resp.status, text: await resp.text() };
}

describe("鉴权失败：凭证保留（不再自动登出）", () => {
  let root = "";
  let upstream: Awaited<ReturnType<typeof fakeUpstream>>;
  let gw: gateway.RunningGateway;
  const logs: string[] = [];

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "modelmux-autologout-"));
    process.env["MODELMUX_HOME"] = root;
    upstream = await fakeUpstream();
    clearChannels();
    setChannel(makeChannel("dead", upstream.url));
    seedCredential("dead", "tok-dead");
    gw = await gateway.start("127.0.0.1:0", { logger: (m) => logs.push(m) });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => upstream.server.close(() => r()));
    delete process.env["MODELMUX_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("401 + 刷新不可用 → 请求失败但凭证与池账号保留", async () => {
    assert.equal(existsSync(paths.credentialsPath("dead")), true, "前置：凭证文件存在");
    const { status } = await chat(gw.addr);
    assert.equal(status, 502, "所有候选失败 → 502");
    assert.equal(existsSync(paths.credentialsPath("dead")), true, "凭证必须保留（不许删）");
    assert.equal(listAccounts("dead").accounts.length, 1, "池账号也原样保留");
    assert.ok(
      logs.some((m) => m.includes("credentials kept")),
      `日志应说明凭证保留（实际: ${logs.filter((m) => m.includes("auth failed")).join(" | ") || "无"}）`,
    );
  });

  it("下一次请求仍会尝试上游（凭证还在），并再次失败", async () => {
    upstream.captured.length = 0;
    const { status, text } = await chat(gw.addr);
    assert.equal(status, 502);
    assert.ok(upstream.captured.length > 0, "凭据还在，路由会继续尝试上游");
    const payload = JSON.parse(text) as { error: { code: string } };
    assert.equal(payload.error.code, "upstream_unauthenticated");
    assert.equal(existsSync(paths.credentialsPath("dead")), true, "多轮失败后凭证依旧保留");
  });
});

describe("候选过滤：未登录渠道不被路由（高用量也不参与）", () => {
  let root = "";
  let upstream: Awaited<ReturnType<typeof fakeUpstream>>;
  let gw: gateway.RunningGateway;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "modelmux-ghostfilter-"));
    process.env["MODELMUX_HOME"] = root;
    upstream = await fakeUpstream();
    clearChannels();
    setChannel(makeChannel("ghost", upstream.url)); // 不写凭证 = 未登录
    setChannel(makeChannel("alive", upstream.url));
    seedCredential("alive", "tok-alive");
    // ghost 账单用量最高 → 正常排序它会排第一；凭据过滤必须让它靠边
    poolUsage.writeBilling("ghost", { total: { used: 9999, size: 10000, remain: 1, unit: "credits" } });
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => upstream.server.close(() => r()));
    delete process.env["MODELMUX_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("请求只落到已登录渠道；未登录的 ghost 一次都不被尝试", async () => {
    upstream.captured.length = 0;
    const { status, text } = await chat(gw.addr);
    assert.equal(status, 200);
    assert.ok(text.includes("alive 回答"));
    assert.deepEqual(
      upstream.captured,
      ["Bearer tok-alive"],
      "ghost 没有凭据，不应出现在任何上游请求里",
    );
  });
});
