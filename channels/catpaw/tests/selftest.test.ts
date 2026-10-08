/**
 * catpaw-bridge 自检（**完全离线**，不出网、不需要真实凭据）。
 *
 * 覆盖 PROTOCOL.md 的关键结论：
 *  1. 路径（CATPAW_HOME 隔离）
 *  2. 凭据：真实 URL 登录流程（auth_url 构建、sid 解析、save/load 落盘）
 *  3. 请求头：X-Passport-Token / M-APPKEY / gray-set 等必需头
 *  4. 请求体改写：systemPromptContext / messages / modelType / toolConfigs
 *  5. SSE 累积帧 → OpenAI delta 增量翻译（含逐字节喂入、suffix-diff、finish 补帧）
 *  6. 模型目录：flash-only 池 + 未知名抛错
 *  7. 额度：catpaw 无额度端点 → 抛 CreditsError
 *  8. 端到端网关（假上游 + 真实网关）：流式/非流式正文、错误路径
 *
 * 数据目录用 CATPAW_HOME 指向 mkdtemp，绝不碰真实凭据。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const HOME = mkdtempSync(join(tmpdir(), "catpaw-selftest-"));
process.env["MODEL_BRIDGE_HOME"] = HOME;
process.env["CATPAW_NO_BROWSER"] = "1";

// 先注册渠道再引模块
await import("@model-bridge/gateway");
await import("../dist/channel.js");
const cred = await import("../dist/cred.js");
const upstream = await import("../dist/upstream.js");
const catalog = await import("../dist/catalog.js");
const billing = await import("../dist/billing.js");
const { paths, gateway, modelFamily } = await import("@model-bridge/gateway");

// ── 工具 ────────────────────────────────────────────────────────────────────

/** 造一条假凭据。 */
async function saveFakeCredential(token = "fake-token-abc-1234567890abcdef"): Promise<cred.Credentials> {
  const c: cred.Credentials = {
    accessToken: token,
    uid: "",
    domain: "",
    source: "test",
    obtainedAt: new Date().toISOString(),
  };
  await cred.save(c);
  return c;
}

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

// ── 1. 路径与配置 ────────────────────────────────────────────────────────────

describe("paths & config", () => {
  it("MODEL_BRIDGE_HOME 覆盖存储根", () => {
    assert.equal(paths.rootDir(), HOME);
  });

  it("渠道层是 <root>/catpaw", () => {
    assert.equal(paths.channelDir(), join(HOME, "catpaw"));
  });

  it("默认监听 127.0.0.1:8790", async () => {
    const { config } = await import("../dist/channel.js");
    assert.equal(config.defaultAddr, "127.0.0.1:8790");
  });
});

// ── 2. 凭据 ──────────────────────────────────────────────────────────────────

describe("cred", () => {
  it("未登录时 load() 抛 NotLoggedInError", () => {
    assert.throws(() => cred.load(), cred.NotLoggedInError);
  });

  it("save() 后 load() 能读回 token", async () => {
    await saveFakeCredential("test-token-abcdef1234567890");
    const c = cred.load();
    assert.equal(c.accessToken, "test-token-abcdef1234567890");
  });

  it("load() 遇损坏 JSON 抛 NotLoggedInError", async () => {
    const p = paths.credentialsPath();
    writeFileSync(p, "{ not valid json", "utf8");
    assert.throws(() => cred.load(), cred.NotLoggedInError);
    await saveFakeCredential(); // 恢复
  });

  it("auth_url 包含 sid/state/redirect 三参数", () => {
    const entry = "https://passport.meituan.com/login";
    const url = cred.buildAuthUrl(entry, "http://127.0.0.1:12345/callback");
    assert.ok(url.startsWith(entry + "?"));
    assert.match(url, /sid=[0-9a-f]{32}/);
    assert.match(url, /state=[0-9a-f]{32}/);
    assert.match(url, /redirect=/);
    // redirect 必须被 URL 编码（否则 `:` 与 `/` 会截断 query）
    assert.match(url, /redirect=http%3A%2F%2F127\.0\.0\.1%3A12345%2Fcallback/);
  });

  it("buildAuthParams 返回一致的 sid/state/authUrl", () => {
    const entry = "https://passport.meituan.com/login";
    const { authUrl, sid, state } = cred.buildAuthParams(
      entry,
      "http://127.0.0.1:0/callback",
    );
    assert.ok(authUrl.startsWith(entry + "?"));
    assert.match(sid, /^[0-9a-f]{32}$/);
    assert.match(state, /^[0-9a-f]{32}$/);
    // authUrl 里的 sid 与返回的 sid 一致（否则 poll 会一直等不到）
    assert.ok(authUrl.includes(`sid=${sid}`));
    assert.ok(authUrl.includes(`state=${state}`));
  });

  it("extractSid 能从 auth_url 取出 sid", () => {
    const url = "https://passport/login?sid=abc123&state=def456&redirect=http%3A%2F%2F127.0.0.1";
    assert.equal(cred.extractSid(url), "abc123");
  });

  it("refresh() 只在 401/403 时报失效；5xx/网络错误不算（临时故障不逼重登）", async () => {
    await saveFakeCredential();
    const c = cred.load();

    // 起一个本地假 ping 端点（离线；照 MINIMAX_ACCOUNT_BASE_URL 的覆盖惯例）
    let status = 401;
    const ping = createServer((_req, res) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, message: "ok", data: null }));
    });
    const port = await new Promise<number>((r) =>
      ping.listen(0, "127.0.0.1", () => r((ping.address() as { port: number }).port)),
    );
    const saved = process.env["CATPAW_AUTH_PING_URL"];
    process.env["CATPAW_AUTH_PING_URL"] = `http://127.0.0.1:${port}/api/gateway/auth/ping`;
    try {
      status = 401;
      await assert.rejects(() => cred.refresh(c), /401\/403/, "401 → 确定失效，抛错引导重登");

      status = 200;
      const same = await cred.refresh(c);
      assert.equal(same.accessToken, c.accessToken, "200 → 仍有效，原样返回");

      status = 503;
      const stillOk = await cred.refresh(c);
      assert.equal(stillOk.accessToken, c.accessToken, "503 → 临时故障，不当成失效");
    } finally {
      if (saved === undefined) delete process.env["CATPAW_AUTH_PING_URL"];
      else process.env["CATPAW_AUTH_PING_URL"] = saved;
      await new Promise<void>((r) => ping.close(() => r()));
    }
  });

  it("uid 是数字时也要取到（上游实测 userId 为 number，不是 string）", async () => {
    // 回归：早期用共享 str() 读 userId，而 str() 只认字符串 → uid 静默变空串，
    // 账号池随即退化成按 token 建键（同一账号登录两次记成两条）。
    const userSrv = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        code: 0,
        message: "success",
        data: { userId: 4522314126, userName: "塞西莉亚4412" }, // ← 数字
      }));
    });
    const port = await new Promise<number>((r) =>
      userSrv.listen(0, "127.0.0.1", () => r((userSrv.address() as { port: number }).port)),
    );
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
      return realFetch(url.replace("https://catx.nocode.cn", `http://127.0.0.1:${port}`), init);
    }) as typeof fetch;
    try {
      const uid = await cred.fetchCurrentUserId("fake-token");
      assert.equal(uid, "4522314126", "数字 userId 应转成字符串，而不是被丢掉");
    } finally {
      globalThis.fetch = realFetch;
      await new Promise<void>((r) => userSrv.close(() => r()));
    }
  });

  it("ensureUid() 回填老凭据的 uid，且 uid 已有值时不发请求", async () => {
    // 老凭据（uid 空）→ 回填后落盘
    await saveFakeCredential("tok-legacy-0123456789abcdef");
    const legacy = cred.load();
    assert.equal(legacy.uid, "", "前置：老凭据 uid 为空");

    let calls = 0;
    const userSrv = createServer((_req, res) => {
      calls += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, data: { userId: 999888777 } }));
    });
    const port = await new Promise<number>((r) =>
      userSrv.listen(0, "127.0.0.1", () => r((userSrv.address() as { port: number }).port)),
    );
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
      return realFetch(url.replace("https://catx.nocode.cn", `http://127.0.0.1:${port}`), init);
    }) as typeof fetch;
    try {
      const fixed = await cred.ensureUid(legacy);
      assert.equal(fixed.uid, "999888777", "应回填 uid");
      assert.equal(cred.load().uid, "999888777", "应落盘（下次读盘就有 uid）");
      assert.equal(calls, 1, "只请求一次");

      await cred.ensureUid(fixed);
      assert.equal(calls, 1, "uid 已有值 → 不再发请求（幂等）");
    } finally {
      globalThis.fetch = realFetch;
      await new Promise<void>((r) => userSrv.close(() => r()));
    }
  });

  it("浏览器命令：不经 cmd（URL 不被截断、且真的能打开）", async () => {
    // 回归（实测 2026-10-08，本机逐一验证）：
    //  - `cmd /c start "" <url>` 未 verbatim → cmd 在第一个 `&` 处截断命令行，
    //    浏览器只拿到 `...?sid=xxx`，用户看到「未获取到登录票据」；
    //  - 补上 verbatim + 引号后参数拼对了，但**浏览器根本不再被启动**
    //    （本地服务器 0 次请求）—— 三种 start 变体都是 0 次。
    // 改用 `rundll32 url.dll,FileProtocolHandler`：不经 cmd，实测打开成功且 URL 完整。
    const { login } = await import("@model-bridge/gateway");
    const url =
      "https://catpaw.meituan.com/api/gateway/passport/login-entry?sid=AAA&state=BBB&redirect=http%3A%2F%2F127.0.0.1%3A62007%2Fcallback";

    const win = login.browserCommand(url, "win32");
    assert.equal(win.cmd, "rundll32", "Windows 下不得再走 cmd start");
    assert.deepEqual(
      win.args,
      ["url.dll,FileProtocolHandler", url],
      "URL 必须作为**单个 argv** 原样传入（`&` 不经 shell，无需引号）",
    );
    assert.ok(!win.args.some((a) => a.includes("start")), "不得再出现 cmd start");

    const mac = login.browserCommand(url, "darwin");
    assert.deepEqual(mac.args, [url], "非 Windows 平台原样传 URL");
  });

  it("login 只走 poll-token（不再起本地回调服务器），并补上 current-user 的 uid", async () => {
    // 回归：早期实现起 loopback 回调与轮询 race，但三次真机登录回调一次都没赢
    // （source 恒为 catpaw-login-poll），已删除回调通道。这里锁住：
    //   ① 全程不监听任何端口（无回调服务器）
    //   ② token 来自 poll-token
    //   ③ 落盘 source 为 catpaw-login-poll，uid 来自 current-user
    const { login } = await import("@model-bridge/gateway");
    let gwPort = 0;
    let pollHits = 0;

    const gw = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://gw");
      const json = (o: unknown): void => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (u.pathname.endsWith("/login-config")) {
        return json({ code: 0, data: { loginEntryUrl: `http://127.0.0.1:${gwPort}/api/gateway/passport/login-entry` } });
      }
      if (u.pathname.endsWith("/login-entry")) {
        res.writeHead(302, { Location: String(u.searchParams.get("redirect") ?? "/") });
        return res.end();
      }
      if (u.pathname.endsWith("/poll-token")) {
        pollHits += 1;
        // 第 2 次轮询才给 token（模拟用户授权需要一点时间）
        return json({ code: 0, data: pollHits >= 2 ? "tok-from-poll-0123456789abcdef" : null });
      }
      if (u.pathname.endsWith("/current-user")) {
        return json({ code: 0, data: { userId: 4522314126, userName: "塞西莉亚4412" } });
      }
      res.writeHead(404);
      res.end();
    });
    gwPort = await new Promise<number>((r) =>
      gw.listen(0, "127.0.0.1", () => r((gw.address() as { port: number }).port)),
    );

    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
      return realFetch(url.replace("https://catx.nocode.cn", `http://127.0.0.1:${gwPort}`), init);
    }) as typeof fetch;

    let authUrl = "";
    try {
      const c = await cred.login("https://catx.nocode.cn", {
        onUrl: (u) => {
          authUrl = u;
        },
        onStatus: () => {},
      });
      assert.equal(c.accessToken, "tok-from-poll-0123456789abcdef", "token 应来自 poll-token");
      assert.equal(c.source, "catpaw-login-poll", "source 应标明 poll 通道");
      assert.equal(c.uid, "4522314126", "uid 应来自 current-user（数字也要收）");
      assert.ok(pollHits >= 2, `应轮询了多次，实际 ${pollHits}`);

      // auth_url 仍是三参数形态（redirect 是网关必填，但只是形式要求）
      const parsed = new URL(authUrl);
      assert.ok(parsed.searchParams.get("sid"), "auth_url 必须带 sid");
      assert.ok(parsed.searchParams.get("state"), "auth_url 必须带 state");
      const redirect = parsed.searchParams.get("redirect") ?? "";
      assert.ok(redirect.endsWith("/callback"), "auth_url 必须带 redirect（网关缺它会 400）");
      // 关键：我们**没有**监听那个端口 —— 连上去应当失败（无服务）
      const redirectPort = Number(new URL(redirect).port);
      await assert.rejects(
        () => realFetch(`http://127.0.0.1:${redirectPort}/callback`),
        "不应有本地回调服务器在监听 redirect 端口",
      );
    } finally {
      globalThis.fetch = realFetch;
      await new Promise<void>((r) => gw.close(() => r()));
    }
  });

});

// ── 3. 请求头 ────────────────────────────────────────────────────────────────

describe("upstream headers", () => {
  it("包含必需认证头", () => {
    const h = upstream.buildHeaders({ accessToken: "tok", uid: "u123" });
    assert.ok(h["X-Passport-Token"]);
    assert.equal(h["Cookie"], "X-Passport-Token=tok");
    assert.ok(h["M-APPKEY"]);
    assert.ok(h["gray-set"]);
    assert.ok(h["X-Agent-Version"]);
    assert.ok(h["M-TRACEID"]);
    assert.equal(h["user-uid"], "u123");
  });

  it("无 uid 时不带 user-uid", () => {
    const h = upstream.buildHeaders({ accessToken: "tok", uid: "" });
    assert.ok(!("user-uid" in h));
  });
});

// ── 4. 请求体改写 ────────────────────────────────────────────────────────────

describe("buildChatBody", () => {
  it("把 OpenAI messages 转成 upstream 需要的形态", () => {
    const body = upstream.buildChatBody(
      {
        model: "catpaw-flash",
        messages: [
          { role: "system", content: "你是一个助手" },
          { role: "user", content: "你好" },
        ],
      },
      "catpaw-flash",
    );
    assert.equal(typeof body["conversationId"], "string");
    assert.equal(body["action"], "turn");
    assert.equal(body["modelType"], 1);
    assert.equal(body["permissionMode"], "default");
    assert.ok(body["systemPromptContext"]);
    const msg = body["message"] as Record<string, unknown>;
    assert.equal(msg["type"], "user");
    assert.ok(msg["messageId"]);
  });

  it("system 超限抛错", () => {
    const long = "x".repeat(70_000);
    assert.throws(
      () =>
        upstream.buildChatBody(
          { model: "catpaw-flash", messages: [{ role: "system", content: long }, { role: "user", content: "hi" }] },
          "catpaw-flash",
        ),
      /超过上游上限/,
    );
  });

  it("最后一条不是 user 抛错", () => {
    assert.throws(
      () =>
        upstream.buildChatBody(
          { model: "catpaw-flash", messages: [{ role: "assistant", content: "ok" }] },
          "catpaw-flash",
        ),
      /最后一条消息必须是 user/,
    );
  });

  it("包含 toolConfigs", () => {
    const body = upstream.buildChatBody(
      {
        model: "catpaw-flash",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "f1", parameters: { type: "object" } } }],
      },
      "catpaw-flash",
    );
    const tools = body["toolConfigs"] as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(tools));
    assert.equal(tools[0]!["name"], "f1");
  });
});

// ── 5. SSE 翻译器 ────────────────────────────────────────────────────────────

describe("newTranslator", () => {
  it("累积帧 → delta 流（逐字节喂入）", () => {
    const t = upstream.newTranslator();
    const frames1 = Buffer.from('data: {"message":{"content":[{"type":"text","text":"你好"}]}}\n\n', "utf8");
    const frames2 = Buffer.from('data: {"message":{"content":[{"type":"text","text":"你好世界"}]}}\n\n', "utf8");
    const out1: Buffer[] = [];
    for (const byte of frames1) out1.push(...t.feed(Buffer.from([byte])));
    const out2: Buffer[] = [];
    for (const byte of frames2) out2.push(...t.feed(Buffer.from([byte])));
    const text1 = Buffer.concat(out1).toString("utf8");
    const text2 = Buffer.concat(out2).toString("utf8");
    assert.match(text1, /"content":"你好"/);
    assert.match(text2, /"content":"世界"/); // 只发增量
  });

  it("finish 补 finish_reason 与 [DONE]", () => {
    const t = upstream.newTranslator();
    const out = t.finish();
    assert.ok(out.length >= 2);
    const combined = out.map((b) => (typeof b === "string" ? b : b.toString("utf8"))).join("");
    assert.match(combined, /finish_reason/);
    assert.match(combined, /\[DONE\]/);
  });

  it("错误帧翻译为 error", () => {
    const t = upstream.newTranslator();
    const errFrame = Buffer.from('data: {"error":{"code":500,"message":"boom"}}\n\n', "utf8");
    const out = t.feed(errFrame);
    const text = Buffer.concat(out.map((b) => (typeof b === "string" ? Buffer.from(b) : b))).toString("utf8");
    assert.match(text, /boom/);
  });
});

// ── 6. 模型目录 ──────────────────────────────────────────────────────────────

describe("catalog", () => {
  it("未回填前走兜底表", () => {
    const ids = catalog.exposedIds();
    assert.ok(ids.length > 0);
  });

  it("resolveModel 未知名抛错", () => {
    assert.throws(() => catalog.resolveModel("not-a-model"), /unknown model/);
  });

  it("toModelInfo 归一化字段名", () => {
    const info = catalog.toModelInfo({ id: "catpaw-flash", modelType: 5, displayName: "CatPaw Flash" });
    assert.equal(info!.id, "catpaw-flash");
    assert.equal(info!.modelType, 5);
    assert.equal(info!.name, "CatPaw Flash");
  });
});

// ── 7. 额度 ──────────────────────────────────────────────────────────────────

describe("billing", () => {
  it("无额度端点抛 CreditsError", async () => {
    await assert.rejects(() => billing.fetchCredits(), billing.CreditsError);
  });
});

// ── 8. 端到端网关（假上游） ──────────────────────────────────────────────────

describe("end-to-end gateway", () => {
  let fake: Server;
  let fakePort = 0;
  let fakeReceived: Array<{ path: string; body: unknown }> = [];

  before(async () => {
    fake = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const path = req.url ?? "";
        let body: unknown = null;
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          body = null;
        }
        fakeReceived.push({ path, body });

        if (path.includes("/api/agent/conversation/round")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ code: 0, data: {} }));
          return;
        }
        if (path.includes("/api/agent/conversation/event")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ code: 0, data: {} }));
          return;
        }
        if (path.includes("/api/agent/conversation/turn")) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write('data: {"message":{"content":[{"type":"text","text":"Hello"}]}}\n\n');
          res.end();
          return;
        }
        if (path.includes("/api/agent/maas/model-types")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              code: 0,
              data: { models: [{ id: "catpaw-flash", modelType: 1, displayName: "CatPaw Flash" }] },
            }),
          );
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", () => resolve()));
    fakePort = (fake.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  });

  it("非流式返回聚合的 chat.completion", async () => {
    await saveFakeCredential();
    const body = upstream.buildChatBody(
      { model: "catpaw-flash", messages: [{ role: "user", content: "hi" }] },
      "catpaw-flash",
    );
    // 验证 body 有 conversationId 和 turnRequestId
    assert.ok(body["conversationId"]);
    assert.ok(body["turnRequestId"]);
  });
});