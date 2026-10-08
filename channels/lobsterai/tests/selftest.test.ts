/**
 * lobsterai-bridge 自检（**完全离线**，不出网）。
 *
 * 覆盖：
 *  1. 路径与目录迁移
 *  2. 模型目录（兜底 19 条、远端解析、level/openclawLevel 分离、可达性由远端决定）
 *  3. 凭据落盘/读取/损坏容忍、uuid/firstKeyfrom/latestKeyfrom 必须持久化
 *  4. 上游：URL、能力头（准入条件）、请求体改写（恒流式/图片形态/工具配对/不发 prompt_cache_key）
 *  5. 错误分类：**顺序不可重排** + 中文关键词（额度已用完/升级套餐）
 *  6. 客户端版本号（动态拉取、TTL 缓存、非法值兜底）
 *  7. 登录（本地回调 + state 校验）与续期（latestKeyfrom 用存储值）
 *  8. 额度查询与签到三步
 *  9. 端到端网关（假上游）：流式、非流式聚合、上游真实收到的头与体、错误信封
 *
 * 数据目录用 LOBSTERAI_HOME 隔离，绝不碰真实凭据。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// 必须在 import 被测模块之前设置（隔离真实凭据目录）
const HOME = mkdtempSync(join(tmpdir(), "lb-selftest-"));
process.env["MODEL_BRIDGE_HOME"] = HOME;

// 共享层来自工作区包；先注册本渠道（副作用）再引渠道模块
const { paths, sseStream: sse, gateway } = await import("@model-bridge/gateway");
await import("../dist/channel.js");
const cred = await import("../dist/cred.js");
const upstream = await import("../dist/upstream.js");
const catalog = await import("../dist/catalog.js");
const billing = await import("../dist/billing.js");

// ── 假上游 ───────────────────────────────────────────────────────────────────

interface Captured {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown> | null;
  raw: string;
}

type Route = (req: Captured) => { status: number; body?: unknown; contentType?: string; noJson?: boolean };

interface FakeUpstream {
  server: Server;
  port: number;
  base: string;
  captured: Captured[];
  routes: Map<string, Route>;
}

/** 起一个假 LobsterAI 上游（按路径路由，记录全部请求）。 */
async function startFakeUpstream(): Promise<FakeUpstream> {
  const captured: Captured[] = [];
  const routes = new Map<string, Route>();
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += String(c);
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        parsed = null;
      }
      const record: Captured = {
        method: req.method ?? "",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: { ...req.headers },
        body: parsed,
        raw,
      };
      captured.push(record);
      const route = routes.get(url.pathname);
      if (!route) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 404, message: "not found" }));
        return;
      }
      const out = route(record);
      if (out.noJson) {
        res.writeHead(out.status, { "Content-Type": out.contentType ?? "text/plain" });
        res.end(String(out.body ?? ""));
        return;
      }
      res.writeHead(out.status, { "Content-Type": out.contentType ?? "application/json" });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return { server, port, base: `http://127.0.0.1:${port}`, captured, routes };
}

/** 读 SSE 正文（`data:` 后有无空格都认，提取 choices[].delta.content）。 */
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
    const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown } }> };
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta?.content;
      if (typeof delta === "string") content += delta;
    }
  }
  return content;
}

function lastAt(fake: FakeUpstream, path: string): Captured | undefined {
  return [...fake.captured].reverse().find((r) => r.path === path);
}

/** 一份「有效」假凭据（含续期所需的三个 keyfrom 字段）。 */
async function seedCredentials(token = "tok-live"): Promise<void> {
  await cred.save({
    ...cred.EMPTY_CREDENTIALS,
    accessToken: token,
    refreshToken: "rt-live",
    uid: "u-live",
    userId: "yid-live",
    uuid: "uuid-live",
    firstKeyfrom: "111",
    latestKeyfrom: "222",
    obtainedAt: "2026-10-08T00:00:00.000Z",
    source: "selftest",
  });
}

async function pointUpstreamAt(base: string): Promise<void> {
  await upstream.saveConfig({ baseUrl: base });
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

describe("1. 路径", () => {
  it("数据目录名固定，受 MODEL_BRIDGE_HOME 覆盖，渠道层是 <root>/lobsterai", () => {
    assert.equal(paths.rootDir(), HOME);
    assert.equal(paths.channelDir(), join(HOME, "lobsterai"));
    assert.ok(paths.credentialsPath().endsWith("credentials.json"));
    assert.ok(paths.upstreamPath().endsWith("upstream.json"));
  });

  it("旧目录存在时迁移（保留凭据）", () => {
    const alt = mkdtempSync(join(tmpdir(), "lb-legacy-"));
    const legacy = join(alt, ".lobsterai2api");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "credentials.json"), '{"access_token":"legacy"}', "utf8");
    const saved = process.env["MODEL_BRIDGE_HOME"];
    process.env["MODEL_BRIDGE_HOME"] = alt;
    try {
      assert.equal(paths.channelDir(), join(alt, "lobsterai"));
      assert.ok(paths.credentialsPath().includes("lobsterai"));
    } finally {
      process.env["MODEL_BRIDGE_HOME"] = saved;
      rmSync(alt, { recursive: true, force: true });
    }
  });
});

describe("2. 模型目录", () => {
  it("兜底 30 条（对齐一次真实上游拉取）、窗口 131072、底层表含 kimi-k2.7-code（池策略过滤后 5 条）、不含价格快照", () => {
    catalog.resetRemoteCache();
    assert.equal(catalog.FALLBACK_MODELS.length, 30);
    assert.equal(catalog.FALLBACK_MODELS[0]!.context_window, 131_072);
    const ids = catalog.exposedIds();
    // 池策略 =(deepseek|glm) × flash：30 条兜底里 3 条 deepseek + 2 条 glm
    assert.equal(ids.length, 5, `池内应 5 条，实际: ${ids.join(", ")}`);
    assert.ok(ids.includes("deepseek-v4-flash"), "含上游真名 deepseek-v4-flash");
    assert.ok(ids.includes("glm-5.3-flash") && ids.includes("glm-5.3-flashx"), "含 glm 系 flash");
    assert.ok(ids.every((id) => /flash/i.test(id)), "池子里必须带 flash");
    assert.ok(ids.every((id) => /deepseek|glm/i.test(id)), "且必须属于 deepseek 或 glm 家族");
    assert.ok(!ids.some((id) => /^kimi-k2\.7-code$/.test(id)), "非 flash 被过滤");
    assert.ok(!ids.includes("deepseek-v4-pro") && !ids.includes("glm-5.2"), "同家族的非 flash 型号也挡在池外");
    // 别家的 flash 同样挡下（本次策略收窄的关键）
    assert.ok(
      !ids.includes("qwen3.8-flash"),
      "别家 flash（qwen 等）不进池",
    );
    // 过滤只发生在呈现层：底层表/合并逻辑仍保留被过滤的条目
    const underlying = catalog.details().map((r) => r["id"]);
    assert.equal(underlying.length, 30, "details 仍给出全部 30 条兜底");
    assert.ok(underlying.includes("kimi-k2.7-code"), "底层表含被过滤的 kimi（数据没丢）");
    assert.equal(catalog.FALLBACK_MODELS[0]!.cost_multiplier, undefined);
  });

  it("拉到远端即落盘 cache/models.json；新进程（全新实例）读到真实目录而不是兜底表", async () => {
    catalog.resetRemoteCache();
    catalog.setRemoteModels([
      {
        id: "seeded-deepseek-flash-xyz",
        name: "seeded-deepseek-flash-xyz",
        context_window: 131_072,
        source: "remote",
      },
    ]);

    // 落点固定为 <root>/<cid>/cache/models.json（见 docs/STORAGE-CONVENTION.md §4.5）
    const file = join(paths.cacheDir(), "models.json");
    assert.ok(existsSync(file), "成功拉到远端目录必须落盘，否则新进程只剩兜底表");
    const envelope = JSON.parse(readFileSync(file, "utf8")) as {
      version: number;
      fetched_at: string;
      models: Array<{ id: string }>;
    };
    assert.equal(envelope.version, 1);
    assert.ok(envelope.fetched_at, "信封带拉取时刻，便于排查「这份目录是什么时候的」");
    assert.deepEqual(
      envelope.models.map((m) => m.id),
      ["seeded-deepseek-flash-xyz"],
    );

    // 模拟新进程：重新求值模块（内存状态全空），只该看到磁盘上那份目录
    const fresh = (await import("../dist/catalog.js?cache-seed")) as typeof catalog;
    assert.deepEqual(
      fresh.remoteModels()!.map((m) => m.id),
      ["seeded-deepseek-flash-xyz"],
    );
    // 池策略 (deepseek|glm)×flash：这个种子 id 同时命中两者，才会出现在池里
    assert.deepEqual(fresh.exposedIds(), ["seeded-deepseek-flash-xyz"]);
    assert.equal(fresh.details().length, 1, "磁盘缓存优先于兜底表：不是 30 条");

    rmSync(file, { force: true });
    catalog.resetRemoteCache();
  });

  it("远端行解析：level 与 openclawLevel 分离，裸数字 costMultiplier 也认", () => {
    const parsed = catalog.parseRemoteModels([
      {
        modelId: "kimi-k3",
        modelName: "Kimi K3",
        contextWindow: 1_000_000,
        maxTokens: 65_536,
        supportsImage: true,
        supportsThinking: true,
        thinkingConfig: {
          options: [
            { level: "low", openclawLevel: "low" },
            { level: "max", openclawLevel: "xhigh" },
          ],
          defaultLevel: "low",
        },
        costMultiplier: 1.08,
        description: "d",
        requestCapabilities: ["tools"],
        provider: "x",
        apiFormat: "y",
        runtimeProfile: "z",
      },
      { modelId: "plain", costMultiplier: "x0.05" },
    ]);
    const entry = parsed[0]!;
    assert.equal(entry.id, "kimi-k3");
    assert.equal(entry.context_window, 1_000_000);
    assert.equal(entry.max_output, 65_536);
    assert.equal(entry.supports_image, true);
    assert.deepEqual(entry.efforts, ["low", "max"]);
    assert.deepEqual(entry.efforts_wire, { low: "low", max: "xhigh" });
    assert.equal(entry.cost_multiplier, 1.08);
    assert.equal(parsed[1]!.cost_multiplier, 0.05);
    assert.equal((entry as Record<string, unknown>)["provider"], undefined);
  });

  it("reasoning_effort 用 wire 值（max → xhigh），未知名原样透传", () => {
    catalog.setRemoteModels(
      catalog.parseRemoteModels([
        {
          modelId: "kimi-k3",
          thinkingConfig: { options: [{ level: "max", openclawLevel: "xhigh" }] },
        },
      ]),
    );
    assert.equal(catalog.reasoningEffortWire("kimi-k3", "max"), "xhigh");
    assert.equal(catalog.resolveModel("no-such-model"), "no-such-model");
    catalog.resetRemoteCache();
  });
});

describe("3. 凭据", () => {
  it("未登录时抛 NotLoggedInError", () => {
    rmSync(paths.credentialsPath(), { force: true });
    assert.throws(() => cred.load(), cred.NotLoggedInError);
  });

  it("落盘为 snake_case 且 uuid/first_keyfrom/latest_keyfrom 一并保留", async () => {
    await seedCredentials();
    const raw = readFileSync(paths.credentialsPath(), "utf8");
    const disk = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ["uuid", "first_keyfrom", "latest_keyfrom", "user_id", "access_token"]) {
      assert.ok(key in disk, `磁盘必须保留 ${key}（丢了只能重新登录）`);
    }
    const c = cred.load();
    assert.equal(c.accessToken, "tok-live");
    assert.equal(c.uuid, "uuid-live");
    assert.equal(c.latestKeyfrom, "222");
    assert.equal(c.domain, "", "本渠道无域概念");
  });

  it("老凭据缺 uid 时用 sha256(token)[:16] 补齐（不拒绝整条凭据）", () => {
    writeFileSync(
      paths.credentialsPath(),
      JSON.stringify({ access_token: "legacy-token" }),
      "utf8",
    );
    const c = cred.load();
    assert.equal(c.uid, cred.uidFallbackHash("legacy-token"));
    assert.equal(c.uid.length, 16);
  });

  it("凭据损坏 / access_token 为空时按未登录处理", () => {
    writeFileSync(paths.credentialsPath(), "{ not json", "utf8");
    assert.throws(() => cred.load(), cred.NotLoggedInError);
    writeFileSync(paths.credentialsPath(), JSON.stringify({ access_token: "" }), "utf8");
    assert.throws(() => cred.load(), cred.NotLoggedInError);
  });

  it("昵称掩码归一化到末 2 位且幂等", () => {
    assert.equal(cred.normalizeNickname("130****1100"), "130******00");
    assert.equal(cred.normalizeNickname("130******00"), "130******00");
    assert.equal(cred.normalizeNickname("小明"), "小明");
    assert.equal(cred.normalizeNickname("用户130****1100"), "用户130****1100");
  });

  it("uid 四级回退：user.id → user.userId → user.yid → 哈希", () => {
    assert.equal(cred.uidFromUser({ id: "a", userId: "b", yid: "c" }, "t"), "a");
    assert.equal(cred.uidFromUser({ userId: "b", yid: "c" }, "t"), "b");
    assert.equal(cred.uidFromUser({ yid: "c" }, "t"), "c");
    assert.equal(cred.uidFromUser({}, "t"), cred.uidFallbackHash("t"));
  });

  it("resolveBaseUrl 跟随已保存的上游配置", async () => {
    await pointUpstreamAt("http://127.0.0.1:1");
    try {
      assert.equal(cred.resolveBaseUrl("auto"), "http://127.0.0.1:1");
      assert.throws(() => cred.resolveBaseUrl("mars"));
    } finally {
      await upstream.saveConfig(upstream.defaultConfig());
    }
  });
});

describe("4. 上游请求头与请求体", () => {
  it("URL 组装", () => {
    const cfg = upstream.defaultConfig();
    assert.equal(
      upstream.chatUrl(cfg),
      "https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions",
    );
    assert.equal(upstream.modelsUrl(cfg), "https://lobsterai-server.youdao.com/api/models/available");
  });

  it("能力头是准入条件，且不带 CodeBuddy 归属头", () => {
    const headers = upstream.buildHeaders({ accessToken: "tok-1", uid: "u-1" });
    assert.equal(headers["Authorization"], "Bearer tok-1");
    assert.equal(headers["User-Agent"], "LobsterAI/0.1.0");
    assert.equal(headers["Accept"], "text/event-stream, application/json");
    assert.equal(headers["X-LobsterAI-Client-Capabilities"], "kimi-k3-agentic-v1,thinking-level-control-v1");
    assert.ok(headers["X-LobsterAI-Client-Version"], "版本头非空");
    // 带上 CodeBuddy 那套归属头会让服务端按错误客户端形态归因
    assert.ok(!Object.keys(headers).some((k) => k.startsWith("X-Domain") || k.startsWith("X-Product")));
    const models = upstream.modelsHeaders({ accessToken: "tok-1" }, "2026.9.10");
    assert.equal(models["X-LobsterAI-Client-Version"], "2026.9.10");
    assert.equal(models["Accept"], "application/json");
  });

  it("模型 query 带 keyfrom 但不含 refreshToken", () => {
    const query = upstream.modelsQuery(
      { accessToken: "t", firstKeyfrom: "1", latestKeyfrom: "2", uuid: "uu", userId: "yy" },
      "2026.9.10",
    );
    assert.equal(query["firstKeyfrom"], "1");
    assert.equal(query["latestKeyfrom"], "2");
    assert.equal(query["version"], "2026.9.10");
    assert.equal(query["uuid"], "uu");
    assert.equal(query["userId"], "yy");
    assert.ok(!("refreshToken" in query), "refreshToken 不进 query（泄露且非预期输入）");
    const empty = upstream.modelsQuery({ accessToken: "t" }, "v");
    assert.ok(!("uuid" in empty) && !("userId" in empty), "空值删键而不是写空串");
  });

  it("请求体：恒流式、不发 prompt_cache_key/tool_choice、工具配对自愈、图片统一形态", () => {
    const body = upstream.buildChatBody(
      {
        model: "kimi-k3",
        messages: [
          { role: "system", content: "你是助手" },
          { role: "user", content: "看图" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } },
              { id: "call_2", type: "function", function: { arguments: "{}" } },
              { id: "call_orphan", type: "function", function: { name: "bash", arguments: "{}" } },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_2",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_1",
            content: [
              { type: "text", text: "结果" },
              { type: "image_url", image_url: { url: "data:image/png;base64,BBB" } },
            ],
          },
        ],
        max_tokens: 1024,
        temperature: 0.3,
        stop: ["END"],
        reasoning_effort: "max",
        prompt_cache_key: "should-not-send",
        tool_choice: "auto",
      },
      "kimi-k3",
    );

    assert.equal(body["stream"], true, "stream:false 会返回 500，必须恒 true");
    assert.equal(body["prompt_cache_key"], undefined);
    assert.equal(body["tool_choice"], undefined);
    assert.equal(body["temperature"], 0.3);
    assert.equal(body["max_tokens"], 1024);
    assert.deepEqual(body["stop"], ["END"]);
    assert.equal(body["model"], "kimi-k3");

    const messages = body["messages"] as Array<Record<string, unknown>>;
    assert.deepEqual(
      messages.map((m) => m["role"]),
      ["system", "user", "assistant", "tool", "user"],
      "孤儿 tool_result / tool_call 必须剔除，工具结果图片挂到独立 user 消息",
    );
    const assistant = messages[2]!;
    assert.deepEqual(
      (assistant["tool_calls"] as Array<{ id: string }>).map((c) => c.id),
      ["call_1"],
      "无 name 的 tool_call 与孤儿 tool_call 都要剔除",
    );
    assert.equal(assistant["content"], null, "有 tool_calls 时空 content 必须是 null");
    assert.equal(messages[3]!["content"], "结果", "tool 的 content 只能是字符串");
    const carrier = messages[4]!["content"] as Array<Record<string, unknown>>;
    assert.deepEqual(carrier[0], { type: "text", text: "Attached image(s) from tool result:" });
    assert.equal(carrier[1]!["type"], "image_url");
    assert.ok(String((carrier[1]!["image_url"] as { url: string }).url).startsWith("data:image/png"));
  });

  it("请求体：{type:'image'} 转 image_url；system 前置；空 tools 不发", () => {
    const body = upstream.buildChatBody(
      {
        model: "kimi-k3",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "图" },
              { type: "image", source: { media_type: "image/jpeg", data: "CCC" } },
            ],
          },
        ],
        system: "sys",
        tools: [{ type: "function", function: { name: "bash" } }],
      },
      "kimi-k3",
    );
    const messages = body["messages"] as Array<Record<string, unknown>>;
    assert.equal(messages[0]!["role"], "system");
    const block = (messages[1]!["content"] as Array<Record<string, unknown>>)[1]!;
    assert.equal(block["type"], "image_url");
    assert.equal((block["image_url"] as { url: string }).url, "data:image/jpeg;base64,CCC");
    assert.equal(body["system"], undefined, "system 已并入 messages，不再顶层重复");
    assert.ok(Array.isArray(body["tools"]));

    const none = upstream.buildChatBody({ model: "x", messages: [], tools: [] }, "x");
    assert.equal(none["tools"], undefined, "空 tools 不带");
    const stopEmpty = upstream.buildChatBody({ model: "x", messages: [], stop: [] }, "x");
    assert.equal(stopEmpty["stop"], undefined, "空 stop 不带");
  });

  it("模型声明不支持图片时显式报错（不静默丢弃）", () => {
    catalog.setRemoteModels(
      catalog.parseRemoteModels([{ modelId: "no-image-model", supportsImage: false }]),
    );
    try {
      assert.throws(
        () =>
          upstream.buildChatBody(
            {
              model: "no-image-model",
              messages: [
                {
                  role: "user",
                  content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }],
                },
              ],
            },
            "no-image-model",
          ),
        (err: unknown) => err instanceof upstream.UnsupportedContentError,
      );
    } finally {
      catalog.resetRemoteCache();
    }
  });
});

describe("5. 错误分类（顺序不可重排）", () => {
  it("402 → hard-credit；body 关键词排在状态码之前", () => {
    assert.equal(upstream.classifyError(402, ""), "hard-credit");
    assert.equal(upstream.classifyError(400, "积分不足，请充值"), "hard-credit");
    assert.equal(upstream.classifyError(400, "免费额度已用完，请升级套餐"), "hard-credit");
    assert.equal(upstream.classifyError(400, "请升级套餐"), "hard-credit");
    assert.equal(upstream.classifyError(400, "Out Of Credit"), "hard-credit");
    for (const marker of ["insufficient credit", "quota used up", "upgrade your plan", "free credits used"]) {
      assert.equal(upstream.classifyError(400, marker), "hard-credit", marker);
    }
  });

  it("session-dead 排在 429/404 之前", () => {
    assert.equal(upstream.classifyError(404, "40100"), "session-dead");
    assert.equal(upstream.classifyError(429, '{"code":"40101"}'), "session-dead");
    assert.equal(upstream.classifyError(400, "refresh token was rejected"), "session-dead");
  });

  it("其余按状态码：429/404/5xx/4xx/200", () => {
    assert.equal(upstream.classifyError(429, ""), "soft-rate");
    assert.equal(upstream.classifyError(404, ""), "not-found");
    assert.equal(upstream.classifyError(503, ""), "server");
    assert.equal(upstream.classifyError(400, "bad request"), "client");
    assert.equal(upstream.classifyError(200, "{}"), "none");
  });

  it("流内错误分类器：状态码失效，未命中 → client（可轮转）", () => {
    assert.equal(upstream.classifyStreamError("boom"), "client");
    assert.equal(upstream.classifyStreamError("积分不足"), "hard-credit");
    assert.equal(upstream.classifyStreamError("免费额度已用完，请升级套餐"), "hard-credit");
  });

  it("派生谓词与上限", () => {
    assert.deepEqual(
      (["none", "client", "server"] as const).map((k) => upstream.shouldRotateAccount(k)),
      [false, true, true],
    );
    assert.deepEqual(
      (["hard-credit", "soft-rate", "not-found", "client"] as const).map((k) =>
        upstream.recordsRateLimit(k),
      ),
      [true, true, true, false],
    );
    assert.equal(upstream.isTerminalError("session-dead"), true);
    assert.equal(upstream.isTerminalError("hard-credit"), false);
    assert.equal(upstream.MAX_ROTATE, 3);
    assert.equal(upstream.RATE_LIMIT_FALLBACK_MS, 3_600_000);
  });
});

describe("6. 客户端版本号", () => {
  it("正则校验：合法通过，非法拒绝", () => {
    assert.equal(upstream.parseClientVersion("2026.9.4"), "2026.9.4");
    assert.equal(upstream.parseClientVersion(" 2026.9.4-beta.1 "), "2026.9.4-beta.1");
    assert.equal(upstream.parseClientVersion("not-a-version"), undefined);
    assert.equal(upstream.parseClientVersion(""), undefined);
    assert.equal(upstream.parseClientVersion(null), undefined);
  });

  it("动态拉取（data.value.version），非法值回退兜底常量", async () => {
    const fake = await startFakeUpstream();
    process.env["LOBSTERAI_VERSION_URL"] = `${fake.base}/version`;
    upstream.clearVersionCache();
    try {
      fake.routes.set("/version", () => ({
        status: 200,
        body: { code: 0, msg: "OK", data: { value: { version: "2026.9.10" } } },
      }));
      assert.equal(await upstream.resolveClientVersion({ force: true }), "2026.9.10");
      const before = fake.captured.length;
      assert.equal(await upstream.resolveClientVersion(), "2026.9.10");
      assert.equal(fake.captured.length, before, "TTL 内命中缓存，不再请求");

      fake.routes.set("/version", () => ({ status: 200, body: { data: { value: { version: "n/a" } } } }));
      assert.equal(
        await upstream.resolveClientVersion({ force: true }),
        upstream.FALLBACK_CLIENT_VERSION,
      );
      assert.equal(upstream.FALLBACK_CLIENT_VERSION, "2026.9.4");
    } finally {
      delete process.env["LOBSTERAI_VERSION_URL"];
      upstream.clearVersionCache();
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  });
});

describe("7. 登录与续期", () => {
  it("登录 URL 是 portal#/login 形态且 redirect_uri 指向本地回调", () => {
    const url = cred.buildLoginUrl(45_678, "st-1");
    assert.ok(url.startsWith("https://lobsterai.youdao.com/portal#/login?"), url);
    assert.ok(url.includes("redirect_uri=http%3A%2F%2F127.0.0.1%3A45678%2Fauth%2Fcallback"));
    assert.ok(url.includes("state=st-1"));
  });

  it("exchange 用当前时刻的 latestKeyfrom，并带 authCode/uuid/version", async () => {
    const fake = await startFakeUpstream();
    fake.routes.set("/api/auth/exchange", () => ({
      status: 200,
      body: {
        code: 0,
        data: {
          accessToken: "at-1",
          refreshToken: "rt-1",
          expiresIn: 7200,
          user: { id: "u-1", yid: "yid-1", nickname: "130****1100" },
        },
      },
    }));
    process.env["LOBSTERAI_VERSION_URL"] = `${fake.base}/version`;
    fake.routes.set("/version", () => ({
      status: 200,
      body: { code: 0, data: { value: { version: "2026.9.10" } } },
    }));
    upstream.clearVersionCache();
    try {
      const c = await cred.exchange(fake.base, "code-1", {
        uuid: "uuid-1",
        firstKeyfrom: "111",
        state: "st",
      });
      assert.equal(c.accessToken, "at-1");
      assert.equal(c.refreshToken, "rt-1");
      assert.equal(c.uid, "u-1");
      assert.equal(c.userId, "yid-1");
      assert.equal(c.nickname, "130******00");
      const sent = lastAt(fake, "/api/auth/exchange")!.body!;
      assert.equal(sent["authCode"], "code-1");
      assert.equal(sent["uuid"], "uuid-1");
      assert.equal(sent["firstKeyfrom"], "111");
      assert.ok(/^\d+$/.test(String(sent["latestKeyfrom"])), "登录时 latestKeyfrom 用当前时刻");
      assert.equal(sent["version"], "2026.9.10");
    } finally {
      delete process.env["LOBSTERAI_VERSION_URL"];
      upstream.clearVersionCache();
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  });

  it("续期：用存储的 latestKeyfrom、uuid/userId 仅非空时带、保旧 refreshToken", async () => {
    const fake = await startFakeUpstream();
    process.env["LOBSTERAI_VERSION_URL"] = `${fake.base}/version`;
    fake.routes.set("/version", () => ({
      status: 200,
      body: { code: 0, data: { value: { version: "2026.9.10" } } },
    }));
    fake.routes.set("/api/auth/refresh", () => ({
      status: 200,
      body: { code: 0, data: { accessToken: "at-2", expiresIn: 60, user: { id: "u-1" } } },
    }));
    upstream.clearVersionCache();
    await pointUpstreamAt(fake.base);
    await seedCredentials();
    try {
      const c = cred.load();
      const next = await cred.refresh(c);
      assert.equal(next.accessToken, "at-2");
      assert.equal(next.refreshToken, "rt-live", "服务端不返回新 refreshToken 时保留旧值");
      assert.equal(next.latestKeyfrom, "222", "latest_keyfrom 刻意不更新为当前时刻");
      const record = lastAt(fake, "/api/auth/refresh")!;
      assert.equal(record.body!["latestKeyfrom"], "222");
      assert.equal(record.body!["uuid"], "uuid-live");
      assert.equal(record.body!["userId"], "yid-live");
      assert.equal(record.headers["authorization"], undefined, "续期走匿名头（不带 Authorization）");

      // 空 uuid / 空 userId 时不带这两个键
      await upstream.saveConfig(upstream.defaultConfig());
      saveEmptyIdentityCredential();
      await pointUpstreamAt(fake.base);
      await cred.refresh(cred.load());
      const body2 = lastAt(fake, "/api/auth/refresh")!.body!;
      assert.ok(!("uuid" in body2) && !("userId" in body2));
    } finally {
      delete process.env["LOBSTERAI_VERSION_URL"];
      upstream.clearVersionCache();
      await pointUpstreamAt(upstream.defaultConfig().baseUrl);
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  });

  it("续期终态判定：401 → 终态；code:0 空 token → 终态；5xx → 可重试", async () => {
    const fake = await startFakeUpstream();
    process.env["LOBSTERAI_VERSION_URL"] = `${fake.base}/version`;
    fake.routes.set("/version", () => ({
      status: 200,
      body: { code: 0, data: { value: { version: "2026.9.10" } } },
    }));
    upstream.clearVersionCache();
    await pointUpstreamAt(fake.base);
    await seedCredentials();
    try {
      fake.routes.set("/api/auth/refresh", () => ({
        status: 401,
        body: { code: 40100, message: "token rejected" },
      }));
      await assert.rejects(() => cred.refresh(cred.load()), cred.RefreshTokenExpiredError);

      fake.routes.set("/api/auth/refresh", () => ({
        status: 200,
        body: { code: 0, data: { accessToken: "" } },
      }));
      await assert.rejects(() => cred.refresh(cred.load()), cred.RefreshTokenExpiredError);

      fake.routes.set("/api/auth/refresh", () => ({ status: 503, body: { code: 5001, message: "boom" } }));
      await assert.rejects(
        () => cred.refresh(cred.load()),
        (err: unknown) => err instanceof Error && !(err instanceof cred.RefreshTokenExpiredError),
      );
    } finally {
      delete process.env["LOBSTERAI_VERSION_URL"];
      upstream.clearVersionCache();
      await pointUpstreamAt(upstream.defaultConfig().baseUrl);
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  });

  it("回调服务器：state 不匹配 400，匹配则完成 exchange 并显示成功页", async () => {
    const fake = await startFakeUpstream();
    fake.routes.set("/api/auth/exchange", () => ({
      status: 200,
      body: { code: 0, data: { accessToken: "at-live", refreshToken: "rt-live" } },
    }));
    const session = { uuid: "uuid-x", firstKeyfrom: "111", state: "st-ok" };
    const srv = await cred.startCallbackServer(session, fake.base, { timeoutMs: 5_000 });
    try {
      const bad = await fetch(`http://127.0.0.1:${srv.port}/auth/callback?code=c1&state=wrong`);
      assert.equal(bad.status, 400, "state 不匹配必须 400（防 CSRF/串号）");
      assert.equal(lastAt(fake, "/api/auth/exchange"), undefined, "state 不通过不得发起 exchange");

      const good = await fetch(`http://127.0.0.1:${srv.port}/auth/callback?code=c1&state=st-ok`);
      assert.equal(good.status, 200);
      assert.ok((await good.text()).includes("登录成功，可以关闭此窗口了"));
      const c = await srv.result;
      assert.equal(c.accessToken, "at-live");
    } finally {
      await srv.close();
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  });

  function saveEmptyIdentityCredential(): void {
    writeFileSync(
      paths.credentialsPath(),
      JSON.stringify({
        access_token: "at",
        refresh_token: "rt",
        uid: "u",
        uuid: "",
        user_id: "",
        first_keyfrom: "1",
        latest_keyfrom: "2",
      }),
      "utf8",
    );
  }
});

describe("8. 额度与签到", () => {
  it("余额解析：负数 clamp、面值推断、到期天数、可领签到", async () => {
    const fake = await startFakeUpstream();
    process.env["LOBSTERAI_VERSION_URL"] = `${fake.base}/version`;
    fake.routes.set("/version", () => ({
      status: 200,
      body: { code: 0, data: { value: { version: "2026.9.10" } } },
    }));
    fake.routes.set("/api/user/profile-summary", () => ({
      status: 200,
      body: {
        code: 0,
        msg: "success",
        data: {
          totalCreditsRemaining: 5297.72,
          creditItems: [
            { type: "campaign", label: "每日登录奖励", creditsRemaining: 4997.72, expiresAt: "2026-10-23T01:21:23" },
            { type: "campaign", label: "每日登录奖励", creditsRemaining: -5, expiresAt: "2026-10-23T01:21:23" },
            { type: "free", label: "免费额度", creditsRemaining: 300, expiresAt: "2036-01-01T00:00:00" },
          ],
        },
      },
    }));
    fake.routes.set("/api/client-activities/slot", () => ({
      status: 200,
      body: {
        code: 0,
        data: { slotState: "visible", activity: { activityCode: "daily-checkin", configRevision: "rev-7" } },
      },
    }));
    fake.routes.set("/api/client-activities/daily-checkin/context", () => ({
      status: 200,
      body: { code: 0, data: { state: { claimedToday: false }, actions: [{ action: "check_in" }] } },
    }));
    fake.routes.set("/api/client-activities/daily-checkin/actions/check_in", () => ({
      status: 200,
      body: { code: 0, data: { result: { rewardCredits: 150 } } },
    }));
    upstream.clearVersionCache();
    await pointUpstreamAt(fake.base);
    await seedCredentials();
    try {
      const info = await billing.fetchCredits();
      assert.equal(info.total.remain, 5297.72);
      assert.equal(info.total.unit, "credits");
      assert.equal(info.packages.length, 3);
      assert.equal(info.packages[1]!.remain, 0, "负数 clamp 到 0");
      assert.equal(info.packages[0]!.size, 4997.72, "面值推断 = 同组最大剩余");
      assert.equal(info.packages[0]!.used, 0);
      assert.equal(typeof info.packages[0]!.days_left, "number");
      assert.equal(info.claimable![0]!["campaign_id"], "daily-checkin");

      const slotQuery = lastAt(fake, "/api/client-activities/slot")!.query;
      assert.equal(slotQuery["placement"], "desktop_sidebar");
      assert.equal(slotQuery["containerApiVersion"], "2");
      assert.equal(slotQuery["platform"], "win32", "伪装形态，与运行环境无关");
      assert.ok(slotQuery["clientVersion"], "clientVersion 是必填参数");
      assert.equal(
        lastAt(fake, "/api/client-activities/daily-checkin/context")!.query["configRevision"],
        "rev-7",
      );

      const claim = await billing.claimCheckin();
      assert.equal(claim.ok, true);
      assert.equal(claim.credits, 150, "三级回退 rewardCredits");
      const sent = lastAt(fake, "/api/client-activities/daily-checkin/actions/check_in")!.body!;
      assert.equal(sent["configRevision"], "rev-7");
      assert.deepEqual(sent["payload"], {});
      assert.equal(String(sent["idempotencyKey"]).length, 36, "uuid4 幂等键");

      // 预检：claimedToday 为真时不再发请求
      fake.routes.set("/api/client-activities/daily-checkin/context", () => ({
        status: 200,
        body: { code: 0, data: { state: { claimedToday: true }, actions: [{ action: "check_in" }] } },
      }));
      const before = fake.captured.filter((r) => r.path.endsWith("/check_in")).length;
      const again = await billing.claimCheckin();
      const after = fake.captured.filter((r) => r.path.endsWith("/check_in")).length;
      assert.equal(again.already, true);
      assert.equal(after, before, "已签到不得重复请求");

      // actions 不含 check_in → 不请求
      fake.routes.set("/api/client-activities/daily-checkin/context", () => ({
        status: 200,
        body: { code: 0, data: { state: { claimedToday: false }, actions: [{ action: "share" }] } },
      }));
      const none = await billing.claimCheckin();
      assert.equal(none.ok, false);

      // 查不到 ≠ 0
      fake.routes.set("/api/user/profile-summary", () => ({ status: 200, body: { code: 0, data: {} } }));
      await assert.rejects(() => billing.fetchCredits(), billing.CreditsError);
    } finally {
      delete process.env["LOBSTERAI_VERSION_URL"];
      upstream.clearVersionCache();
      await pointUpstreamAt(upstream.defaultConfig().baseUrl);
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  });
});

describe("9. 端到端网关（假上游）", () => {
  const fake = { current: null as FakeUpstream | null };
  let gw: gateway.RunningGateway;

  before(async () => {
    const server = await startFakeUpstream();
    fake.current = server;
    process.env["LOBSTERAI_VERSION_URL"] = `${server.base}/version`;
    server.routes.set("/version", () => ({
      status: 200,
      body: { code: 0, data: { value: { version: "2026.9.10" } } },
    }));
    server.routes.set("/api/proxy/v1/chat/completions", () => ({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      noJson: true,
      body: [
        `data:{"id":"c1","choices":[{"index":0,"delta":{"content":"网关"},"finish_reason":null}]}\n\n`,
        `data:{"id":"c1","choices":[{"index":0,"delta":{"content":"通了","reasoning_content":null}}]}\n\n`,
        `data:{"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
        "data: [DONE]\n\n",
      ].join(""),
    }));
    server.routes.set("/api/models/available", () => ({
      status: 200,
      body: {
        code: 0,
        message: "success",
        data: [
          { modelId: "kimi-k3", modelName: "Kimi K3", contextWindow: 1_000_000 },
          { modelId: "glm-5.2", modelName: "GLM-5.2", contextWindow: 1_000_000 },
          { modelId: "deepseek-v4-flash", modelName: "DeepSeek-V4-Flash", contextWindow: 1_000_000 },
        ],
      },
    }));
    upstream.clearVersionCache();
    await pointUpstreamAt(server.base);
    await seedCredentials("tok-b");
    // auth-flow 在真实启动时会调它（顺便把远端目录灌进缓存）
    await upstream.fetchModels(cred.load());
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    delete process.env["LOBSTERAI_VERSION_URL"];
    upstream.clearVersionCache();
    await pointUpstreamAt(upstream.defaultConfig().baseUrl);
    const server = fake.current;
    if (server) await new Promise<void>((r) => server.server.close(() => r()));
  });

  it("fetchModels 返回远端目录并带能力头/keyfrom query", async () => {
    const server = fake.current!;
    const record = lastAt(server, "/api/models/available")!;
    assert.equal(record.headers["x-lobsterai-client-capabilities"], upstream.CLIENT_CAPABILITIES);
    assert.equal(record.query["firstKeyfrom"], "111");
    assert.equal(record.query["latestKeyfrom"], "222");
    assert.equal(record.query["version"], "2026.9.10");
    assert.ok(!("refreshToken" in record.query));
    // 远端目录优先于兜底表：kimi-k3 只在远端列表里有，底层表必须含它
    const underlying = catalog.details().map((r) => r["id"]);
    assert.ok(underlying.includes("kimi-k3") && underlying.includes("glm-5.2"), "远端目录已灌入（优先于兜底表）");
    const ids = catalog.exposedIds();
    assert.deepEqual(ids, ["deepseek-v4-flash"], "白名单过滤后池内只剩带 flash 的那条");
    assert.ok(ids.every((id) => /flash/i.test(id)), "池子里只能有 flash 模型");
    assert.ok(!ids.includes("glm-5.2") && !ids.includes("kimi-k3"), "非 flash 被挡在池外");
  });

  it("/v1/models 暴露远端列表（白名单过滤），/health 报告登录状态", async () => {
    const models = (await (await fetch(`http://${gw.addr}/v1/models`)).json()) as {
      data: Array<{ id: string }>;
    };
    const ids = models.data.map((m) => m.id);
    assert.deepEqual(
      ids,
      ["deepseek-v4.1-flash", "deepseek-v4-flash", "glm-5.3-flash"],
      "对外只有三个池模型（不带渠道前缀）",
    );
    assert.ok(
      catalog.details().some((r) => r["id"] === "kimi-k3"),
      "被过滤的远端条目仍在底层目录（过滤在呈现层，不是丢数据）",
    );
    const health = (await (await fetch(`http://${gw.addr}/health`)).json()) as Record<string, unknown>;
    assert.equal(health["ok"], true);
    assert.equal(health["logged_in"], true);
  });

  it("流式对话：`data:` 无空格也认，上游收到能力头与恒流式 body", async () => {
    const server = fake.current!;
    server.captured.length = 0;
    const text = await readSseFrames(`http://${gw.addr}/v1/chat/completions`, {
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    assert.equal(text, "网关通了");
    const record = lastAt(server, "/api/proxy/v1/chat/completions")!;
    assert.equal(record.headers["authorization"], "Bearer tok-b");
    assert.equal(record.headers["x-lobsterai-client-capabilities"], upstream.CLIENT_CAPABILITIES);
    assert.ok(record.headers["x-lobsterai-client-version"], "上游必须收到版本头");
    assert.equal(record.body!["stream"], true);
    assert.equal(record.body!["model"], "deepseek-v4-flash", "池 id 即该渠道目录里的名字");
    assert.equal(record.body!["tool_choice"], undefined);
  });

  it("非流式：本层聚合成 chat.completion", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] }),
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
      body: JSON.stringify({ model: "kimi-k3" }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 400);
    const payload = (await resp.json()) as { error: { code: string } };
    assert.equal(payload.error.code, "invalid_request");
  });
});

describe("10. 上游错误处理", () => {
  it("上游 500 转成 502 upstream_error（不回传上游原文）", async () => {
    const failing = await startFakeUpstream();
    failing.routes.set("/api/proxy/v1/chat/completions", () => ({
      status: 500,
      body: { message: "internal detail leak" },
    }));
    const saved = upstream.loadConfig()[0];
    await pointUpstreamAt(failing.base);
    const gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
    try {
      const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(resp.status, 502);
      const payload = (await resp.json()) as { error: { code: string; message: string } };
      assert.equal(payload.error.code, "upstream_error");
      assert.ok(!payload.error.message.includes("internal detail leak"), "上游原文不得回传");
    } finally {
      await gw.close();
      await new Promise<void>((r) => failing.server.close(() => r()));
      await upstream.saveConfig(saved);
    }
  });
});
