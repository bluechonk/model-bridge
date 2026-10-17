/**
 * Web 看板端到端：真起 console server + 真静态页，fetch 验证首页 / API / 路径穿越 / 同源。
 * 存储根用 mkdtemp，不碰真实主目录。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import { after, before, describe, it } from "node:test";

import { start, emptySnapshot, type ControlBridge } from "../../core/gateway/dist/console.js";
import { channels, clearChannels, setChannel, type Channel, type ChannelConfig } from "../../core/gateway/dist/channel.js";
import { runInChannel } from "../../core/gateway/dist/channel-context.js";
import { listAccounts, syncPool } from "../../core/gateway/dist/account-pool.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HOME = mkdtempSync(join(tmpdir(), "modelmux-web-e2e-"));
process.env["MODELMUX_HOME"] = HOME;

/** 合成渠道：credentials.json 即视为已登录，不碰网络。 */
function makeChannel(cid: string): Channel {
  const config: ChannelConfig = {
    cid,
    display: `Synth ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
  };
  const load = (): Record<string, unknown> => {
    throw new Error("not logged in");
  };
  const save = async (): Promise<void> => {};
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      load,
      save,
      login: async () => ({} as Record<string, unknown>),
      refresh: async (c) => c,
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "openai" as const,
      DISPLAY_NAME: `Synth ${cid}`,
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({}),
      loadConfig: () => [{}, false],
      saveConfig: async () => {},
      chatUrl: () => "http://127.0.0.1:1/chat",
      modelsUrl: () => "http://127.0.0.1:1/models",
      buildHeaders: () => ({}),
      buildChatBody: (req) => req,
      fetchModels: async () => ({}),
      resolveConfig: () => ({}),
      newTranslator: () => ({ feed: (c) => [c], finish: () => [] }),
    },
    catalog: { exposedIds: () => [], resolveModel: (n) => n },
    billing: { CreditsError: class CreditsError extends Error {}, fetchCredits: async () => ({ ok: true, total: {}, packages: [] }) },
  } as unknown as Channel;
}

void channels;
void runInChannel;
void listAccounts;
void syncPool;
void writeFileSync;
void mkdirSync;

const bridge: ControlBridge = {
  provider: () => {
    const snap = emptySnapshot();
    snap.ui_state = "running";
    return snap;
  },
};

let server: Awaited<ReturnType<typeof start>>;

before(async () => {
  setChannel(makeChannel("webchan"));
  server = await start(0, bridge, "127.0.0.1");
});

after(async () => {
  await server.close();
  rmSync(HOME, { recursive: true, force: true });
});

describe("console 静态托管与命令 API", () => {
  it("首页 200 且是 index.html", async () => {
    const res = await fetch(server.url);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('<div id="root">'));
    assert.ok(html.includes('<script type="module"'));
  });

  it("跨渠道 status 命令返回全部渠道", async () => {
    const res = await fetch(`${server.url}api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "status" }),
    });
    assert.equal(res.status, 200);
    const payload = (await res.json()) as { ok: boolean; data?: { channels?: Array<{ cid: string }> } };
    assert.equal(payload.ok, true);
    assert.ok((payload.data?.channels ?? []).some((c) => c.cid === "webchan"));
  });

  it("静态路径穿越拒绝 403", async () => {
    const status = await new Promise<number>((resolveRequest, rejectRequest) => {
      // fetch 会把 .. 规范化掉，这里用原生请求保住原始路径，真正打到服务端守卫。
      const req = request(server.url, { path: "/assets/%2e%2e%2fsecret" }, (res) => {
        res.resume();
        res.on("end", () => resolveRequest(res.statusCode ?? 0));
      });
      req.on("error", rejectRequest);
      req.end();
    });
    assert.equal(status, 403);
  });

  it("跨源写命令拒绝 403", async () => {
    const res = await fetch(`${server.url}api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://example.com" },
      body: JSON.stringify({ action: "status" }),
    });
    assert.equal(res.status, 403);
  });
});
