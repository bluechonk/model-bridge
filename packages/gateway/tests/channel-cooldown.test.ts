/**
 * 渠道级失败冷却：**失败的渠道在下一次请求被跳过**。
 *
 * 场景（合成渠道，完全离线）：
 * - `alpha` 的假上游回 500（请求必然失败）→ 当次请求转移到 `beta` 成功；
 * - `alpha` 进冷却后，**下一次请求直接只打 `beta`**（不在坏渠道上再浪费尝试）；
 * - 冷却全池覆盖时回退兜底（不因冷却导致 503）。
 *
 * 与 `failover.test.ts` 的分工：那是**账号级**转移（同一渠道换账号），
 * 这是**渠道级**剔除（下一次请求换渠道）。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearChannels, setChannel, type BridgeConfig, type Channel } from "../dist/channel.js";
import * as gateway from "../dist/gateway.js";
import * as poolUsage from "../dist/pool-usage.js";

/** 假上游：tok-alpha 一律 500，其它 token 回 200 SSE。 */
async function fakeUpstream(): Promise<{ server: Server; url: string; captured: string[] }> {
  const captured: string[] = [];
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const authorization = String(req.headers["authorization"] ?? "");
      captured.push(authorization);
      if (authorization.includes("tok-alpha")) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("alpha upstream exploded");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ id: "c", model: "m", created: 1, choices: [{ index: 0, delta: { content: "beta 回答" }, finish_reason: null }] })}\n\n`,
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

/** 合成渠道：凭证走文件，chatUrl 指向假上游（token 决定该渠道的命运）。 */
function makeChannel(cid: string, token: string, upstreamUrl: string): Channel {
  const config: BridgeConfig = {
    cid,
    display: `Synth ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    legacyDirs: [`.${cid}-bridge`],
    debugDumpEnv: `${cid.toUpperCase()}_DEBUG_DUMP`,
  };
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: upstreamUrl,
      NotLoggedInError: class NotLoggedInError extends Error {},
      load: () => ({
        accessToken: token,
        refreshToken: `r-${cid}`,
        uid: `u-${cid}`,
        domain: "",
      }),
      save: async () => {},
      login: async () => ({}),
      refresh: async () => {
        throw new Error("该渠道没有刷新端点");
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

async function chat(addr: string): Promise<{ status: number; text: string }> {
  const resp = await fetch(`http://${addr}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  return { status: resp.status, text: await resp.text() };
}

describe("渠道级冷却：失败的渠道下一次请求被跳过", () => {
  let root = "";
  let upstream: Awaited<ReturnType<typeof fakeUpstream>>;
  let gw: gateway.RunningGateway;
  const logs: string[] = [];

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "mb-cooldown-"));
    process.env["MODEL_BRIDGE_HOME"] = root;
    upstream = await fakeUpstream();

    clearChannels();
    setChannel(makeChannel("alpha", "tok-alpha", upstream.url));
    setChannel(makeChannel("beta", "tok-beta", upstream.url));

    // alpha 账单用量高 → 正常排序下它是第一候选（模拟「优先级最高但已坏」）
    poolUsage.writeBilling("alpha", {
      total: { used: 999, size: 1000, remain: 1, unit: "credits" },
    });
    gw = await gateway.start("127.0.0.1:0", { logger: (m) => logs.push(m) });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => upstream.server.close(() => r()));
    delete process.env["MODEL_BRIDGE_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("第一次请求：alpha 失败（500）→ 自动转移到 beta 成功，alpha 进冷却", async () => {
    upstream.captured.length = 0;
    const { status, text } = await chat(gw.addr);
    assert.equal(status, 200);
    assert.ok(text.includes("beta 回答"), "由 beta 返回内容");
    assert.deepEqual(
      upstream.captured.filter((a) => a.includes("tok-")),
      ["Bearer tok-alpha", "Bearer tok-beta"],
      "先试 alpha（高优先级），失败后换 beta",
    );
    assert.equal(poolUsage.isCooling("alpha"), true, "失败渠道进入冷却（暂不可用）");
  });

  it("下一次请求：冷却中的 alpha 被硬排除——只打 beta", async () => {
    upstream.captured.length = 0;
    const { status, text } = await chat(gw.addr);
    assert.equal(status, 200);
    assert.ok(text.includes("beta 回答"));
    assert.deepEqual(
      upstream.captured.filter((a) => a.includes("tok-")),
      ["Bearer tok-beta"],
      "不得再碰冷却中的 alpha",
    );
  });

  it("全池冷却时不硬 503：回退尝试（冷却只是短暂状态）", async () => {
    poolUsage.noteFailure("beta"); // 两个候选都在冷却
    upstream.captured.length = 0;
    const { status, text } = await chat(gw.addr);
    assert.equal(status, 200, "回退兜底仍能成功（beta 上游可用）");
    assert.ok(text.includes("beta 回答"));
    assert.ok(
      logs.some((m) => m.includes("cooling down") && m.includes("falling back")),
      "日志标注了回退路径",
    );
    assert.ok(
      upstream.captured.some((a) => a.includes("tok-beta")),
      "回退时真的尝试了候选",
    );
  });
});
