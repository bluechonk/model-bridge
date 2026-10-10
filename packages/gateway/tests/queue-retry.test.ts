/**
 * 排队重试：上游回 HTTP 200 + SSE 里投递排队帧（`code:"10605"`）时，
 * 共享层在**响应头发出前**等待并重开上游，直到出内容或预算耗尽。
 *
 * 假上游用计数器控制行为：前 N 次请求只发排队帧，之后发正常 chunk。
 * 渠道声明 `isQueueError`（模拟 qoder），退避时间通过排队帧里的
 * `retryAfterSeconds` 控制（测试里给 1s，避免拖慢套件）。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearChannels, setChannel, type BridgeConfig, type Channel } from "../dist/channel.js";
import * as gateway from "../dist/gateway.js";
import * as paths from "../dist/paths.js";

const CID = "queuechan";

interface Captured {
  authorization: string;
}

/** 假上游：前 `queuedTimes` 次回排队帧，之后回正常 chunk。 */
async function fakeUpstream(queuedTimes: number): Promise<{ server: Server; url: string; captured: Captured[] }> {
  let calls = 0;
  const captured: Captured[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += String(c);
    });
    req.on("end", () => {
      captured.push({ authorization: String(req.headers["authorization"] ?? "") });
      calls += 1;
      if (calls <= queuedTimes) {
        // 排队帧：信封 statusCodeValue=200，内层是业务错误 code=10605
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const envelope = JSON.stringify({
          headers: {},
          body: JSON.stringify({ code: "10605", message: 'model is queued, retryAfterSeconds: 1' }),
          statusCodeValue: 200,
        });
        res.write(`data:${envelope}\n\n`);
        res.end();
        return;
      }
      // 正常 chunk（content 用 ASCII，避免编码歧义）
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = JSON.stringify({
        id: "c",
        model: "m",
        created: 1,
        choices: [{ index: 0, delta: { content: "queued-ok" }, finish_reason: null }],
      });
      const envelope = JSON.stringify({ headers: {}, body: chunk, statusCodeValue: 200 });
      res.write(`data:${envelope}\n\n`);
      const done = JSON.stringify({
        id: "c",
        model: "m",
        created: 1,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      res.write(`data:${JSON.stringify({ headers: {}, body: done, statusCodeValue: 200 })}\n\n`);
      res.write("data:[DONE]\n\n");
      res.end();
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return { server, url: `http://127.0.0.1:${port}`, captured };
}

/** 合成渠道：custom 线型 + 翻译器解信封 + isQueueError（模拟 qoder）。 */
function makeChannel(): Channel {
  const config: BridgeConfig = {
    cid: CID,
    display: "Queue Chan",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "QUEUECHAN_DUMP",
  };
  const load = (): Record<string, unknown> =>
    JSON.parse(readFileSync(paths.credentialsPath(CID), "utf8")) as Record<string, unknown>;

  // 极简信封翻译器：与 qoder 同构（data:{headers,body,statusCodeValue} → 内层 chunk / error）
  const translator = () => {
    let buffer = "";
    const decoder = new TextDecoder("utf-8");
    const processLine = (line: string): string[] => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) return [];
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") return [`data: ${data || "[DONE]"}\n\n`];
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return [`data: ${data}\n\n`];
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [`data: ${data}\n\n`];
      const envelope = parsed as { body?: unknown; statusCodeValue?: unknown };
      if (typeof envelope.body === "string") {
        let inner: unknown;
        try {
          inner = JSON.parse(envelope.body);
        } catch {
          return [];
        }
        if (inner && typeof inner === "object" && !Array.isArray(inner)) {
          const obj = inner as Record<string, unknown>;
          if (obj["code"] !== undefined && obj["choices"] === undefined) {
            return [
              `data: ${JSON.stringify({ error: { code: String(obj["code"]), message: String(obj["message"] ?? "") } })}\n\n`,
            ];
          }
          if (Array.isArray(obj["choices"]) || obj["usage"] !== undefined) {
            return [`data: ${JSON.stringify(obj)}\n\n`];
          }
        }
        return [];
      }
      return [];
    };
    return {
      feed(chunk: Buffer): Array<Buffer | string> {
        buffer += decoder.decode(chunk, { stream: true });
        const out: string[] = [];
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          for (const frame of processLine(line)) out.push(frame);
          index = buffer.indexOf("\n");
        }
        return out;
      },
      finish(): Array<Buffer | string> {
        buffer += decoder.decode();
        const rest = buffer;
        buffer = "";
        return rest ? processLine(rest) : [];
      },
    };
  };

  return {
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      load,
      save: async (c: Record<string, unknown>) => {
        writeFileSync(paths.credentialsPath(CID), JSON.stringify(c, null, 2), "utf8");
      },
      login: async () => load(),
      refresh: async () => load(),
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "custom" as const,
      DISPLAY_NAME: "Queue Chan",
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      loadConfig: () => [{ baseUrl: "http://127.0.0.1:1" }, false],
      saveConfig: async () => {},
      chatUrl: () => `${process.env["MB_TEST_UPSTREAM"] ?? "http://127.0.0.1:1"}/chat`,
      modelsUrl: () => "http://127.0.0.1:1/models",
      buildHeaders: (credential: { accessToken: string }) => ({
        Authorization: `Bearer ${credential.accessToken}`,
      }),
      isQueueError: (frame: Record<string, unknown>) => {
        const err = frame["error"] as { code?: unknown } | undefined;
        return err?.code === "10605";
      },
      buildChatBody: (req: Record<string, unknown>, upstreamModel: string) => ({ ...req, model: upstreamModel }),
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      newTranslator: translator,
    },
    catalog: { exposedIds: () => ["glm-5.3-flash"], resolveModel: (n: string) => n },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

async function chat(addr: string, stream: boolean): Promise<{ status: number; text: string }> {
  const resp = await fetch(`http://${addr}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }], stream }),
  });
  return { status: resp.status, text: await resp.text() };
}

describe("排队重试（10605）", () => {
  let root = "";
  let upstream: Awaited<ReturnType<typeof fakeUpstream>>;
  let gw: gateway.RunningGateway;
  const logs: string[] = [];

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "mb-queue-"));
    process.env["MODEL_BRIDGE_HOME"] = root;
    upstream = await fakeUpstream(2); // 前 2 次排队，第 3 次成功
    process.env["MB_TEST_UPSTREAM"] = upstream.url;

    clearChannels();
    setChannel(makeChannel());
    mkdirSync(paths.channelDir(CID), { recursive: true });
    writeFileSync(
      paths.credentialsPath(CID),
      JSON.stringify({ accessToken: "tok-q", uid: "u-q", domain: "" }, null, 2),
      "utf8",
    );
    gw = await gateway.start("127.0.0.1:0", { logger: (m) => logs.push(m) });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => upstream.server.close(() => r()));
    delete process.env["MB_TEST_UPSTREAM"];
    delete process.env["MODEL_BRIDGE_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("流式：前两次排队帧被吞掉，第三次出内容；客户端只看到一次完整响应", async () => {
    upstream.captured.length = 0;
    logs.length = 0;
    const { status, text } = await chat(gw.addr, true);
    assert.equal(status, 200, `排队重试后应当成功（日志: ${logs.join(" | ")}）`);
    assert.ok(text.includes("queued-ok"), `最终返回的是成功那次的内容（实际: ${text.slice(0, 300)}）`);
    assert.ok(!text.includes("10605"), "排队帧不能透传给客户端");
    assert.equal(upstream.captured.length, 3, `上游被打了 3 次（2 次排队 + 1 次成功），日志: ${logs.join(" | ")}`);
  });

  it("非流式：同样能穿过排队帧拿到聚合结果", async () => {
    // 计数器已耗尽排队次数，这次直接成功——验证非流式路径不破坏正常流程
    const { status, text } = await chat(gw.addr, false);
    assert.equal(status, 200, `非流式应当成功（日志: ${logs.join(" | ")}）`);
    const payload = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
    assert.ok(payload.choices?.[0]?.message?.content?.includes("queued-ok"));
  });
});

describe("上游 HTTP 200 + 流内业务错误帧（非排队）", () => {
  // 回归：修前非流式会**二次探测**同一条已消费的流，把第一次探测吞掉的错误帧丢掉，
  // 最终聚合成空 completion（content:""、usage 全 0、finish_reason:"stop"）。
  let root = "";
  let upstream: Awaited<ReturnType<typeof fakeUpstreamError>>;
  let gw: gateway.RunningGateway;
  const logs: string[] = [];

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "mb-instream-err-"));
    process.env["MODEL_BRIDGE_HOME"] = root;
    upstream = await fakeUpstreamError();
    process.env["MB_TEST_UPSTREAM"] = upstream.url;

    clearChannels();
    setChannel(makeChannel());
    mkdirSync(paths.channelDir(CID), { recursive: true });
    writeFileSync(
      paths.credentialsPath(CID),
      JSON.stringify({ accessToken: "tok-q", uid: "u-q", domain: "" }, null, 2),
      "utf8",
    );
    gw = await gateway.start("127.0.0.1:0", { logger: (m) => logs.push(m) });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => upstream.server.close(() => r()));
    delete process.env["MB_TEST_UPSTREAM"];
    delete process.env["MODEL_BRIDGE_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("非流式：报错而不是回空 completion", async () => {
    const { status, text } = await chat(gw.addr, false);
    assert.equal(status, 502, `流内业务错误应报 502（实际 ${status}: ${text.slice(0, 300)}）`);
    const payload = JSON.parse(text) as { error?: { code?: string; message?: string } };
    assert.equal(payload.error?.code, "429", `保留上游错误码（实际: ${text}）`);
    assert.ok(payload.error?.message?.includes("rate limited"), text);
  });

  it("流式：错误帧透传给客户端（data: {\"error\":…}）", async () => {
    const { status, text } = await chat(gw.addr, true);
    assert.equal(status, 200, `流式仍按上游状态码透传（实际 ${status}: ${text.slice(0, 300)}）`);
    assert.ok(text.includes('"error"'), `流内错误帧要透传（实际: ${text}）`);
    assert.ok(text.includes("429"), text);
  });
});

describe("排队探测消费掉的帧一个都不能丢（回归）", () => {
  // 症状：ZCode 报 `model.tool_input.normalize_failed`（Bash 工具参数 JSON 语法错误）
  // —— tool_call 的 arguments 分片在流中被吞掉一段，拼出来就是坏 JSON。
  // 两个丢帧向量都出在 `consumeQueueProbe` 退出点（qoder/qodercn 专用路径）：
  //   A. 同一 TCP 块里多帧，探测在第一帧（内容）处 return，同块剩余帧被丢；
  //   B. 翻译器缓冲里的**半行**随探测实例一起丢弃，转发层换了新实例接不上残行，整帧丢失。
  let root = "";
  let upstream: Awaited<ReturnType<typeof fakeUpstreamFrameSplit>>;
  let gw: gateway.RunningGateway;
  const logs: string[] = [];

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "mb-frame-split-"));
    process.env["MODEL_BRIDGE_HOME"] = root;
    upstream = await fakeUpstreamFrameSplit();
    process.env["MB_TEST_UPSTREAM"] = upstream.url;

    clearChannels();
    setChannel(makeChannel());
    mkdirSync(paths.channelDir(CID), { recursive: true });
    writeFileSync(
      paths.credentialsPath(CID),
      JSON.stringify({ accessToken: "tok-q", uid: "u-q", domain: "" }, null, 2),
      "utf8",
    );
    gw = await gateway.start("127.0.0.1:0", { logger: (m) => logs.push(m) });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => upstream.server.close(() => r()));
    delete process.env["MB_TEST_UPSTREAM"];
    delete process.env["MODEL_BRIDGE_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("流式：同块多帧 + 跨块半行，三段内容都要到客户端", async () => {
    const { status, text } = await chat(gw.addr, true);
    assert.equal(status, 200, `流式应当成功（日志: ${logs.join(" | ")}）`);
    for (const part of ["AAA", "BBB", "CCC"]) {
      assert.ok(text.includes(part), `内容 ${part} 不能丢（实际: ${text.slice(0, 400)}）`);
    }
  });

  it("非流式：聚合结果同样不能缺段", async () => {
    const { status, text } = await chat(gw.addr, false);
    assert.equal(status, 200, `非流式应当成功（日志: ${logs.join(" | ")}）`);
    const payload = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content ?? "";
    for (const part of ["AAA", "BBB", "CCC"]) {
      assert.ok(content.includes(part), `聚合内容 ${part} 不能丢（实际: ${content}）`);
    }
  });
});

/**
 * 假上游：把多个信封塞进**同一个 TCP 块**，并在第二帧中间切成两半跨块发送。
 *
 * - 块 1 = 帧1 完整 + 帧2 前半（探测在第一帧处停下，帧2 前半留在翻译器缓冲里）
 * - 块 2 = 帧2 后半 + 帧3 完整
 * - 块 3 = finish 帧 + [DONE]
 *
 * 间隔 40ms 是为了让块边界在真网络/undici 下稳定成立。
 */
async function fakeUpstreamFrameSplit(): Promise<{ server: Server; url: string }> {
  const env = (payload: Record<string, unknown>): string =>
    `data:${JSON.stringify({ headers: {}, body: JSON.stringify(payload), statusCodeValue: 200 })}\n\n`;
  const chunk = (content: string): Record<string, unknown> => ({
    id: "c",
    model: "m",
    created: 1,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const server = createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const e1 = env(chunk("AAA"));
      const e2 = env(chunk("BBB"));
      const e3 = env(chunk("CCC"));
      const done = env({
        id: "c",
        model: "m",
        created: 1,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      const half = Math.floor(e2.length / 2);
      res.write(e1 + e2.slice(0, half)); // 同块多帧 + 半行
      await sleep(40);
      res.write(e2.slice(half) + e3); // 残行收尾 + 第三帧
      await sleep(40);
      res.write(done + "data:[DONE]\n\n");
      res.end();
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return { server, url: `http://127.0.0.1:${port}` };
}

/** 假上游：恒回 HTTP 200 + 一个流内业务错误帧（非排队），然后结束。 */
async function fakeUpstreamError(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const envelope = JSON.stringify({
        headers: {},
        body: JSON.stringify({ code: "429", message: "rate limited" }),
        statusCodeValue: 200,
      });
      res.write(`data:${envelope}\n\n`);
      res.end();
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return { server, url: `http://127.0.0.1:${port}` };
}
