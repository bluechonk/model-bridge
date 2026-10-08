/**
 * 账号池的**失败转移**：当前账号被上游拒绝时，自动切到池内另一个账号。
 *
 * 用文件背书的合成渠道（凭证真写在临时存储根的 `credentials.json`），
 * 假上游对 tok-A 回 401、对 tok-B 回 200 —— 于是「换账号」这条链路能真验到。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { activateAccount, captureActive, listAccounts } from "../dist/account-pool.js";
import { clearChannels, setChannel, type BridgeConfig, type Channel } from "../dist/channel.js";
import * as gateway from "../dist/gateway.js";
import * as paths from "../dist/paths.js";

const CID = "solo";

interface Captured {
  authorization: string;
  body: Record<string, unknown> | null;
}

/** 假上游：tok-B 放行，其它一切 401。 */
async function fakeUpstream(): Promise<{ server: Server; url: string; captured: Captured[] }> {
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
      const authorization = String(req.headers["authorization"] ?? "");
      captured.push({ authorization, body });

      if (authorization !== "Bearer tok-B") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 401, msg: "invalid token" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ id: "c", model: "m", created: 1, choices: [{ index: 0, delta: { content: "B 回答" }, finish_reason: null }] })}\n\n`,
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

/** 合成渠道：凭证走真实文件；**没有刷新端点**（refresh 抛错）→ 只能靠换账号。 */
function makeChannel(cid: string): Channel {
  const config: BridgeConfig = {
    cid,
    display: `Synth ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    legacyDirs: [`.${cid}-bridge`],
    debugDumpEnv: `${cid.toUpperCase()}_DEBUG_DUMP`,
  };
  const load = (): Record<string, unknown> =>
    JSON.parse(readFileSync(paths.credentialsPath(cid), "utf8")) as Record<string, unknown>;
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      load,
      save: async (c: Record<string, unknown>) => {
        writeFileSync(paths.credentialsPath(cid), JSON.stringify(c, null, 2), "utf8");
      },
      login: async () => load(),
      refresh: async () => {
        throw new Error("该渠道没有刷新端点");
      },
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "openai" as const,
      DISPLAY_NAME: `Synth ${cid}`,
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      loadConfig: () => [{ baseUrl: "http://127.0.0.1:1" }, false],
      saveConfig: async () => {},
      chatUrl: () => `${process.env["MB_TEST_UPSTREAM"] ?? "http://127.0.0.1:1"}/chat`,
      modelsUrl: () => "http://127.0.0.1:1/models",
      buildHeaders: (credential: { accessToken: string }) => ({
        Authorization: `Bearer ${credential.accessToken}`,
      }),
      buildChatBody: (req: Record<string, unknown>, upstreamModel: string) => ({ ...req, model: upstreamModel }),
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
    },
    catalog: { exposedIds: () => ["pool-x"], resolveModel: (n: string) => n },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

/** 写一份「登录成果」。 */
function seed(uid: string, token: string): void {
  mkdirSync(paths.channelDir(CID), { recursive: true });
  writeFileSync(
    paths.credentialsPath(CID),
    JSON.stringify({ accessToken: token, refreshToken: `r-${uid}`, uid, domain: "" }, null, 2),
    "utf8",
  );
}

async function chat(addr: string): Promise<{ status: number; text: string }> {
  const resp = await fetch(`http://${addr}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "pool-x", messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  return { status: resp.status, text: await resp.text() };
}

describe("账号池失败转移", () => {
  let root = "";
  let upstream: Awaited<ReturnType<typeof fakeUpstream>>;
  let gw: gateway.RunningGateway;
  let keyA = "";
  let keyB = "";

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "mb-failover-"));
    process.env["MODEL_BRIDGE_HOME"] = root;
    upstream = await fakeUpstream();
    process.env["MB_TEST_UPSTREAM"] = upstream.url;

    clearChannels();
    setChannel(makeChannel(CID));
    // 池子里放两个账号：A（假上游会拒绝）、B（可用）
    seed("user-A", "tok-A");
    keyA = captureActive(CID)!.key;
    seed("user-B", "tok-B");
    keyB = captureActive(CID)!.key;
    activateAccount(keyA, CID); // 当前生效 = A（注定被拒）
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => upstream.server.close(() => r()));
    delete process.env["MB_TEST_UPSTREAM"];
    delete process.env["MODEL_BRIDGE_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("生效账号 A 被拒 → 自动切到池内账号 B，请求照样成功", async () => {
    upstream.captured.length = 0;
    const { status, text } = await chat(gw.addr);
    assert.equal(status, 200, "换账号后应当成功");
    assert.ok(text.includes("B 回答"), "返回的是 B 的响应");

    assert.deepEqual(
      upstream.captured.map((c) => c.authorization),
      ["Bearer tok-A", "Bearer tok-B"],
      "先用 A（被拒），再用 B",
    );

    const index = listAccounts(CID);
    assert.equal(index.active, keyB, "生效账号已切到 B");
    assert.equal(index.accounts.find((a) => a.key === keyA)!.health, "unauthorized", "A 被标记为不可用");
    assert.equal(index.accounts.find((a) => a.key === keyB)!.health, "ok", "B 标记为可用");
  });

  it("下一个请求直接用 B（A 已被跳过，不重复踩坑）", async () => {
    upstream.captured.length = 0;
    const { status } = await chat(gw.addr);
    assert.equal(status, 200);
    assert.deepEqual(
      upstream.captured.map((c) => c.authorization),
      ["Bearer tok-B"],
      "只打一次，且用 B",
    );
  });

  it("池里只有一个（坏）账号时：不转移，明确报 upstream_unauthenticated", async () => {
    const soloKey = keyB;
    // 把 B 也标成不可用 → 池内没有可用账号
    const index = listAccounts(CID);
    const b = index.accounts.find((a) => a.key === soloKey)!;
    assert.equal(b.health, "ok");
    // 直接用 A 的 token 覆盖生效凭证（会被拒），并把 B 标成 unauthorized
    seed("user-A", "tok-A");
    activateAccount(keyA, CID);
    // 手动把 B 也标灰：模拟"两个账号都失效"
    const path = join(paths.channelDir(CID), "accounts.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as { accounts: Array<{ key: string; health: string }> };
    for (const a of raw.accounts) if (a.key === keyB) a.health = "unauthorized";
    writeFileSync(path, JSON.stringify(raw, null, 2), "utf8");

    const { status, text } = await chat(gw.addr);
    assert.equal(status, 502);
    const payload = JSON.parse(text) as { error: { code: string } };
    assert.equal(payload.error.code, "upstream_unauthenticated");
  });
});
