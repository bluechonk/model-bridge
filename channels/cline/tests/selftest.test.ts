/**
 * cline-bridge 自检（**完全离线**，不出网、不需要真实凭据）。
 *
 * 覆盖协议的关键结论：
 *  1. 路径与旧目录迁移
 *  2. `workos:` 前缀幂等补齐（本渠道最大的坑）
 *  3. 凭据落盘/读取/损坏容忍
 *  4. 设备码授权状态机（`authorization_pending` 不误判失败 / `slow_down` 累积退避 /
 *     2xx 缺 token 视为服务端异常 / 终态错误）
 *  5. 注册与续期的响应判据（`success && data.accessToken`）与**驼峰**字段名
 *  6. 请求体改写（system 提升、`enum` 清洗、`max_tokens` 夹取、档位原样透传）
 *  7. 请求头（Bearer 保留前缀 + 4 条伪装头）与 429 时长解析、403 地域限制识别
 *  8. 模型目录合并（free 权威、兜底下架、models.dev 两种形态、失败不抛）
 *  9. 额度（余额用 account_id 而非 JWT sub、窗口用字面量 users/me、不显示成 0）
 * 10. 端到端网关（假上游 + 真实网关）：流式/非流式正文、上游真实收到的头与体、
 *     错误路径（400 统一信封 / 5xx → 502 且不回传上游原文）
 *
 * 数据目录用 CLINE_HOME 指向临时目录，绝不碰真实凭据。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const HOME = mkdtempSync(join(tmpdir(), "cline-selftest-"));
process.env["MODEL_BRIDGE_HOME"] = HOME;
process.env["CLINE_NO_BROWSER"] = "1"; // 测试里绝不真开浏览器

// ── 假上游（同时扮演 WorkOS 与 Cline 两个域）──────────────────────────────────

interface FakeState {
  deviceCalls: number;
  deviceForm: string;
  authenticateCalls: number;
  authenticateScript: Array<{ status: number; body: unknown }>;
  registerMode: string;
  registerBody: Record<string, unknown> | null;
  refreshMode: string;
  refreshBody: Record<string, unknown> | null;
  balanceMode: string;
  balancePaths: string[];
  limitsMode: string;
  limitsPaths: string[];
  chatHeaders: Record<string, string | string[] | undefined>;
  chatBody: Record<string, unknown> | null;
}

const st: FakeState = {
  deviceCalls: 0,
  deviceForm: "",
  authenticateCalls: 0,
  authenticateScript: [],
  registerMode: "ok",
  registerBody: null,
  refreshMode: "ok",
  refreshBody: null,
  balanceMode: "ok",
  balancePaths: [],
  limitsMode: "ok",
  limitsPaths: [],
  chatHeaders: {},
  chatBody: null,
};

const ACCOUNT_ID = "usr-01M3BCV4FYCGJKAWD3MJG3DBQM";

function json(res: import("node:http").ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function handleFake(req: IncomingMessage, res: import("node:http").ServerResponse): void {
  let raw = "";
  req.on("data", (c) => {
    raw += String(c);
  });
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    if (!routeFake(path, raw, req, res)) json(res, 404, { error: "not found" });
  });
}

function routeFake(
  path: string,
  raw: string,
  req: IncomingMessage,
  res: import("node:http").ServerResponse,
): boolean {
  if (path === "/user_management/authorize/device") {
    st.deviceCalls += 1;
    st.deviceForm = raw;
    json(res, 200, {
      device_code: "dev-code-1",
      user_code: "ABCD-EFGH",
      verification_uri: `${fakeBase()}/device`,
      verification_uri_complete: `${fakeBase()}/device?user_code=ABCD-EFGH`,
      expires_in: 300,
      interval: 1,
    });
    return true;
  }
  if (path === "/user_management/authenticate") {
    const idx = st.authenticateCalls;
    st.authenticateCalls += 1;
    const item = st.authenticateScript[idx];
    if (item) {
      json(res, item.status, item.body);
      return true;
    }
    json(res, 400, { error: "expired_token" });
    return true;
  }
  if (path === "/api/v1/auth/register") {
    st.registerBody = JSON.parse(raw || "{}") as Record<string, unknown>;
    if (st.registerMode === "biz_fail") {
      json(res, 200, { success: false, error: "channel error" });
      return true;
    }
    if (st.registerMode === "no_token") {
      json(res, 200, { success: true, data: {} });
      return true;
    }
    if (st.registerMode === "bare") {
      json(res, 200, { accessToken: "workos:bare-token" });
      return true;
    }
    if (st.registerMode === "expired") {
      json(res, 401, { error: "Unauthorized" });
      return true;
    }
    json(res, 200, {
      success: true,
      data: {
        accessToken: "workos:eyJ-test",
        refreshToken: "tmgEeM-test",
        expiresAt: "2026-09-25T05:23:47.000Z",
        tokenType: "Bearer",
        userInfo: {
          clineUserId: ACCOUNT_ID,
          email: "whale@example.com",
          firstName: "Whale",
          lastName: "Girl",
        },
      },
    });
    return true;
  }
  if (path === "/api/v1/auth/refresh") {
    st.refreshBody = JSON.parse(raw || "{}") as Record<string, unknown>;
    if (st.refreshMode === "expired") {
      json(res, 401, { error: "Unauthorized: token expired" });
      return true;
    }
    if (st.refreshMode === "no_token") {
      json(res, 200, { success: true, data: {} });
      return true;
    }
    if (st.refreshMode === "server_error") {
      json(res, 503, { error: "boom" });
      return true;
    }
    // 实测续期响应不带 userInfo → 验证 account_id 等字段被保留
    json(res, 200, { success: true, data: { accessToken: "eyJ-refreshed", refreshToken: "tmgNew" } });
    return true;
  }
  if (path === "/api/v1/models") {
    json(res, 200, {
      data: [
        { id: "z-ai/glm-4.7", object: "model", created: 1, owned_by: "z-ai" },
        { id: "cline-free/downed-model", object: "model", created: 1 },
        { id: "openrouter/free", object: "model", created: 1 },
      ],
    });
    return true;
  }
  if (path === "/api/v1/ai/cline/recommended-models") {
    json(res, 200, {
      free: [
        { id: "stealth/space-bunny-alpha", name: "Space Bunny Alpha" },
        { id: "cline-free/mimo-v2.6-flash", name: "MiMo V2.6 Flash" },
      ],
      recommended: [{ id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek" }],
      clinePass: [{ id: "cline-pass/claude-opus-4", name: "Opus" }],
    });
    return true;
  }
  if (path === "/models-dev.json") {
    json(res, 200, {
      "cline-pass": {
        models: {
          "claude-opus-4": {
            name: "Claude Opus 4",
            // limit.output 存在，但**不应**被采信（会变成请求体的 max_tokens）
            limit: { context: 200_000, output: 8_192 },
            modalities: { input: ["text", "image", "pdf"] },
          },
        },
      },
    });
    return true;
  }
  if (path === "/models-dev-nested.json") {
    json(res, 200, {
      providers: { "cline-pass": { models: [{ id: "nested-model", limit: { context: 4096 } }] } },
    });
    return true;
  }
  if (path === "/api/v1/users/me/plan/usage-limits") {
    st.limitsPaths.push(path);
    if (st.limitsMode === "fail") {
      json(res, 500, { error: "Internal Server Error" });
      return true;
    }
    json(res, 200, {
      success: true,
      data: {
        limits: [
          { type: "five_hour", percentUsed: 120, resetsAt: "2026-09-25T05:23:47.123456789Z" },
          { type: "weekly", percentUsed: 0, resetsAt: "" },
        ],
      },
    });
    return true;
  }
  if (path.startsWith("/api/v1/users/") && path.endsWith("/balance")) {
    st.balancePaths.push(path);
    if (st.balanceMode === "unauthorized") {
      // 网关层失败形态：HTTP 401 且**没有 success 字段**
      json(res, 401, { error: "Unauthorized: invalid token" });
      return true;
    }
    if (st.balanceMode === "biz_fail") {
      json(res, 200, { success: false, error: "balance unavailable" });
      return true;
    }
    if (st.balanceMode === "bad_format") {
      json(res, 400, { error: "Invalid request format" });
      return true;
    }
    json(res, 200, { data: { userId: ACCOUNT_ID, balance: 500000 }, success: true });
    return true;
  }
  if (path === "/api/v1/chat/completions") {
    st.chatHeaders = { ...req.headers };
    st.chatBody = JSON.parse(raw || "{}") as Record<string, unknown>;
    const frames = [
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "cline-free/mimo-v2.6-flash",
        // ⚠ Cline 专属差异：思考增量字段是 delta.reasoning（不是 reasoning_content）
        choices: [{ index: 0, delta: { reasoning: "思考" }, finish_reason: null }],
      },
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        // 空 tool_calls 会被网关规范化剔除
        choices: [{ index: 0, delta: { content: "网关通了", tool_calls: [] }, finish_reason: null }],
      },
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    ];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return true;
  }
  return false;
}

let fakePort = 0;
function fakeBase(): string {
  return `http://127.0.0.1:${fakePort}`;
}

const fakeServer: Server = createServer(handleFake);
await new Promise<void>((resolve) => {
  fakeServer.listen(0, "127.0.0.1", () => {
    fakePort = (fakeServer.address() as { port: number }).port;
    resolve();
  });
});

process.env["CLINE_WORKOS_BASE_URL"] = fakeBase();
process.env["CLINE_API_BASE_URL"] = fakeBase();

// 被测模块（设置 env 后再 import）
// 共享层来自工作区包；先注册本渠道（副作用）再引渠道模块
const { paths, sseStream: sse, gateway, isAllowedFamily } = await import("@model-bridge/gateway");
await import("../dist/channel.js");
const cred = await import("../dist/cred.js");
const upstream = await import("../dist/upstream.js");
const catalog = await import("../dist/catalog.js");
const billing = await import("../dist/billing.js");

await upstream.saveConfig({ baseUrl: fakeBase(), chatPath: "/api/v1/chat/completions" });

/** 写一份假凭据（默认带 `workos:` 前缀）。 */
async function saveFakeCreds(overrides: Partial<cred.Credentials> = {}): Promise<cred.Credentials> {
  const payload = Buffer.from(JSON.stringify({ sub: "user_01M3BCQ86DV4S9KKBT85X4GKTV" })).toString(
    "base64url",
  );
  const c: cred.Credentials = {
    ...cred.EMPTY_CREDENTIALS,
    accessToken: `workos:eyJ.${payload}.sig`,
    refreshToken: "tmgOld",
    accountId: ACCOUNT_ID,
    uid: ACCOUNT_ID,
    expireTime: Date.now() + 3600_000,
    nickname: "E2E",
    ...overrides,
  };
  await cred.save(c);
  return cred.load();
}

/** 拿一个确定没人监听的端口（连接被立即拒绝）。 */
async function deadBase(): Promise<string> {
  const srv = createServer();
  const port = await new Promise<number>((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve((srv.address() as { port: number }).port));
  });
  await new Promise<void>((r) => srv.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

after(() => {
  fakeServer.close();
  rmSync(HOME, { recursive: true, force: true });
});

// ── 1. 路径 ───────────────────────────────────────────────────────────────────

describe("1. 路径", () => {
  it("数据目录名固定，受 MODEL_BRIDGE_HOME 覆盖，渠道层是 <root>/cline", () => {
    assert.equal(paths.rootDir(), HOME);
    assert.equal(paths.channelDir(), join(HOME, "cline"));
    assert.ok(paths.credentialsPath().endsWith("credentials.json"));
    assert.ok(paths.upstreamPath().endsWith("upstream.json"));
    assert.ok(paths.pidPath().endsWith("gateway.pid"));
  });

  it("旧目录存在时整目录迁移（保留凭据）", () => {
    const alt = mkdtempSync(join(tmpdir(), "cline-legacy-"));
    const legacy = join(alt, ".cline2api");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "credentials.json"), '{"access_token":"legacy"}', "utf8");

    const saved = process.env["MODEL_BRIDGE_HOME"];
    process.env["MODEL_BRIDGE_HOME"] = alt;
    try {
      assert.equal(paths.channelDir(), join(alt, "cline"));
      assert.equal(
        readFileSync(paths.credentialsPath(), "utf8"),
        '{"access_token":"legacy"}',
        "旧目录的凭据应随目录一起迁移",
      );
    } finally {
      process.env["MODEL_BRIDGE_HOME"] = saved;
      rmSync(alt, { recursive: true, force: true });
    }
  });
});

// ── 2. workos: 前缀（幂等补齐）────────────────────────────────────────────────

describe("2. workos: 前缀不可剥", () => {
  it("幂等补齐：缺了加上、有了原样、空串保持", () => {
    assert.equal(cred.ensureTokenPrefix("eyJabc"), "workos:eyJabc");
    assert.equal(cred.ensureTokenPrefix("workos:eyJabc"), "workos:eyJabc");
    assert.equal(cred.ensureTokenPrefix(cred.ensureTokenPrefix("x")), "workos:x");
    assert.equal(cred.ensureTokenPrefix(""), "");
    assert.equal(cred.stripTokenPrefix("workos:eyJ"), "eyJ", "剥前缀只用于解码 JWT");
  });

  it("load 补齐老凭据缺的前缀（不拒绝整条凭据）", () => {
    writeFileSync(
      paths.credentialsPath(),
      JSON.stringify({ access_token: "eyJplain", account_id: "usr-x" }),
      "utf8",
    );
    const c = cred.load();
    assert.equal(c.accessToken, "workos:eyJplain");
    assert.equal(c.uid, "usr-x", "uid 用 account_id");
    assert.equal(c.domain, "", "Cline 无域概念");
  });

  it("落盘往返：令牌带前缀、account_id 保留、无临时文件残留", async () => {
    await cred.save({
      ...cred.EMPTY_CREDENTIALS,
      accessToken: "workos:eyJround",
      refreshToken: "tmgR",
      accountId: "usr-round",
      email: "w@example.com",
      nickname: "Whale",
      expireTime: 1790313827000,
      obtainedAt: "2026-10-08T00:00:00.000Z",
    });
    const c = cred.load();
    assert.equal(c.accessToken, "workos:eyJround");
    assert.equal(c.refreshToken, "tmgR");
    assert.equal(c.accountId, "usr-round");
    assert.equal(c.email, "w@example.com");
    assert.equal(c.nickname, "Whale");
    assert.equal(c.expireTime, 1790313827000);
    assert.ok(!readFileSync(paths.credentialsPath(), "utf8").includes("workos:workos:"), "不重复补前缀");
    assert.throws(() => readFileSync(`${paths.credentialsPath()}.tmp`), "不留临时文件");
  });

  it("裸令牌落盘时被补前缀（本模块绝不发送裸令牌）", async () => {
    await cred.save({ ...cred.EMPTY_CREDENTIALS, accessToken: "eyJbare", accountId: "usr-b" });
    const onDisk = JSON.parse(readFileSync(paths.credentialsPath(), "utf8")) as Record<string, unknown>;
    assert.equal(onDisk["access_token"], "workos:eyJbare");
    assert.equal(cred.load().accessToken, "workos:eyJbare");
  });

  it("文件缺失 / 损坏 / 缺 access_token → NotLoggedInError", () => {
    rmSync(paths.credentialsPath(), { force: true });
    assert.throws(() => cred.load(), cred.NotLoggedInError);

    writeFileSync(paths.credentialsPath(), "{ not json", "utf8");
    assert.throws(() => cred.load(), cred.NotLoggedInError);

    writeFileSync(paths.credentialsPath(), "{}", "utf8");
    assert.throws(() => cred.load(), cred.NotLoggedInError);
  });

  it("resolveBaseUrl 走 CLINE_API_BASE_URL（单域渠道，无 realm）", () => {
    assert.equal(cred.resolveBaseUrl("auto"), fakeBase());
    assert.equal(cred.resolveBaseUrl(), fakeBase());
  });
});

// ── 3. 设备码授权状态机 ───────────────────────────────────────────────────────

describe("3. 设备码授权（WorkOS）", () => {
  it("第 1 步：请求设备码带 client_id，三字段齐备", async () => {
    st.deviceCalls = 0;
    const device = await cred.requestDeviceCode();
    assert.equal(st.deviceCalls, 1);
    assert.equal(
      st.deviceForm,
      `client_id=${cred.WORKOS_CLIENT_ID}`,
      "设备码请求体应只带 client_id",
    );
    assert.equal(device.deviceCode, "dev-code-1");
    assert.equal(device.userCode, "ABCD-EFGH");
    assert.ok(device.verificationUri.endsWith("/device"));
    assert.ok(device.verificationUriComplete.includes("user_code=ABCD-EFGH"));
  });

  it("pending 不误判失败、slow_down 真正累积退避", async () => {
    const device = await cred.requestDeviceCode();
    st.authenticateCalls = 0;
    st.authenticateScript = [
      { status: 200, body: { error: "authorization_pending" } },
      { status: 200, body: { error: "slow_down" } },
      { status: 200, body: { access_token: "workos-at", refresh_token: "workos-rt" } },
    ];
    const slept: number[] = [];
    const tokens = await cred.pollDeviceToken(device, undefined, {
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    assert.equal(tokens["access_token"], "workos-at");
    // ⚠ 判据是 body.error 而非状态码；slow_down 必须真的 +1s（1s → 2s）
    assert.deepEqual(slept, [1000, 2000]);
    assert.equal(st.authenticateCalls, 3);
  });

  it("2xx 缺 token → 服务端异常（不是继续等用户）", async () => {
    const device = await cred.requestDeviceCode();
    st.authenticateCalls = 0;
    st.authenticateScript = [{ status: 200, body: { ok: true } }];
    await assert.rejects(
      () => cred.pollDeviceToken(device, undefined, { sleep: async () => {} }),
      /没有 access_token/,
    );
  });

  it("终态错误：access_denied / expired_token / invalid_grant / 5xx 立即失败", async () => {
    const device = await cred.requestDeviceCode();
    for (const err of ["access_denied", "expired_token", "invalid_grant"]) {
      st.authenticateCalls = 0;
      st.authenticateScript = [{ status: 200, body: { error: err } }];
      await assert.rejects(
        () => cred.pollDeviceToken(device, undefined, { sleep: async () => {} }),
        new RegExp(err),
      );
    }
    st.authenticateCalls = 0;
    st.authenticateScript = [{ status: 500, body: { message: "boom" } }];
    await assert.rejects(
      () => cred.pollDeviceToken(device, undefined, { sleep: async () => {} }),
      /HTTP 500/,
    );
  });

  it("轮询间隔下限 1 秒（服务端可能下发 0 或负数）", () => {
    assert.equal(cred.pollIntervalMs({ interval: 0 }), 1000);
    assert.equal(cred.pollIntervalMs({ interval: -5 }), 1000);
    assert.equal(cred.pollIntervalMs({ interval: 5 }), 5000);
  });

  it("完整登录：onUrl 立刻回调、落盘保留前缀、account_id 取 userInfo.clineUserId", async () => {
    st.authenticateCalls = 0;
    st.authenticateScript = [
      { status: 200, body: { error: "authorization_pending" } },
      { status: 200, body: { access_token: "workos-at", refresh_token: "workos-rt" } },
    ];
    st.registerMode = "ok";
    const urls: string[] = [];
    const statuses: string[] = [];
    const c = await cred.login(fakeBase(), {
      onUrl: (u) => urls.push(u),
      onStatus: (m) => statuses.push(m),
      sleep: async () => {},
    });
    assert.deepEqual(urls, [`${fakeBase()}/device?user_code=ABCD-EFGH`], "优先带 user_code 的完整链接");
    assert.ok(statuses.length > 0, "onStatus 应有进度输出");
    assert.equal(c.accessToken, "workos:eyJ-test");
    assert.equal(c.refreshToken, "tmgEeM-test");
    assert.equal(c.accountId, ACCOUNT_ID);
    assert.equal(c.email, "whale@example.com");
    assert.equal(c.nickname, "Whale Girl");
    assert.equal(c.expireTime, 1790313827000, "ISO 8601 → 毫秒时间戳");
    assert.equal(cred.load().accessToken, "workos:eyJ-test", "登录后已落盘");
    // 注册请求体必须是**驼峰**
    assert.deepEqual(Object.keys(st.registerBody ?? {}).sort(), ["accessToken", "refreshToken"]);
    assert.equal(st.registerBody?.["accessToken"], "workos-at");
  });
});

// ── 4. 注册 / 续期 ────────────────────────────────────────────────────────────

describe("4. 响应判据 success && data.accessToken", () => {
  it("失败信封 / 缺 token / 裸响应 / 401", async () => {
    st.registerMode = "biz_fail";
    await assert.rejects(() => cred.registerToken("a", "b", fakeBase()), /channel error/);

    st.registerMode = "no_token";
    await assert.rejects(() => cred.registerToken("a", "b", fakeBase()), /没有 accessToken/);

    st.registerMode = "bare";
    const bare = await cred.registerToken("a", "b", fakeBase());
    assert.equal(bare.accessToken, "workos:bare-token", "兼容裸响应（无 data 信封）");

    st.registerMode = "expired";
    await assert.rejects(
      () => cred.registerToken("a", "b", fakeBase()),
      cred.RefreshTokenExpiredError,
    );
    st.registerMode = "ok";
  });

  it("续期：字段名是驼峰 refreshToken + grantType，且保留附加字段", async () => {
    await cred.save({
      ...cred.EMPTY_CREDENTIALS,
      accessToken: "workos:old",
      refreshToken: "tmgOld",
      accountId: "usr-keep",
      email: "keep@example.com",
      nickname: "Keep",
    });
    const c = cred.load();
    st.refreshMode = "ok";
    const next = await cred.refresh(c);
    assert.deepEqual(Object.keys(st.refreshBody ?? {}).sort(), ["grantType", "refreshToken"]);
    assert.equal(st.refreshBody?.["refreshToken"], "tmgOld");
    assert.equal(st.refreshBody?.["grantType"], "refresh_token");
    assert.equal(next.accessToken, "workos:eyJ-refreshed", "新令牌保留前缀（缺失时补齐）");
    assert.equal(next.refreshToken, "tmgNew");
    assert.equal(next.accountId, "usr-keep", "续期响应不带 userInfo → 保留旧值");
    assert.equal(next.email, "keep@example.com");
    assert.equal(next.nickname, "Keep");
    assert.equal(cred.load().refreshToken, "tmgNew", "续期后磁盘同步");
  });

  it("续期终态与可重试错误区分清楚", async () => {
    const c = await (async () => {
      await cred.save({
        ...cred.EMPTY_CREDENTIALS,
        accessToken: "workos:old",
        refreshToken: "tmgOld",
        accountId: "usr-x",
      });
      return cred.load();
    })();
    st.refreshMode = "expired";
    await assert.rejects(() => cred.refresh(c), cred.RefreshTokenExpiredError);

    st.refreshMode = "no_token";
    await assert.rejects(() => cred.refresh(c), cred.RefreshTokenExpiredError);

    st.refreshMode = "server_error";
    let retryable: unknown = null;
    try {
      await cred.refresh(c);
    } catch (err) {
      retryable = err;
    }
    assert.ok(retryable instanceof Error);
    assert.ok(
      !(retryable instanceof cred.RefreshTokenExpiredError),
      "5xx 是普通错误（可重试），不是「令牌失效」",
    );
    st.refreshMode = "ok";

    await assert.rejects(
      () => cred.refresh({ ...c, refreshToken: "" }),
      /没有 refresh_token/,
      "无 refresh_token 即不可静默续期",
    );
  });
});

// ── 5. 上游 URL / 请求头 ──────────────────────────────────────────────────────

describe("5. 上游端点与请求头", () => {
  it("URL 组装", () => {
    const cfg = upstream.defaultConfig();
    assert.equal(upstream.chatUrl(cfg), "https://api.cline.bot/api/v1/chat/completions");
    assert.equal(upstream.modelsUrl(cfg), "https://api.cline.bot/api/v1/models");
    assert.equal(
      upstream.recommendedModelsUrl(cfg),
      "https://api.cline.bot/api/v1/ai/cline/recommended-models",
    );
    assert.equal(upstream.meUrl(cfg), "https://api.cline.bot/api/v1/users/me");
  });

  it("鉴权头保留 workos: 前缀 + 4 条伪装头", () => {
    const c: cred.Credentials = { ...cred.EMPTY_CREDENTIALS, accessToken: "workos:eyJtest" };
    const headers = upstream.buildHeaders(c);
    assert.equal(headers["Authorization"], "Bearer workos:eyJtest");
    assert.equal(headers["HTTP-Referer"], "https://cline.bot");
    assert.equal(headers["X-Title"], "Cline");
    assert.equal(headers["X-IS-MULTIROOT"], "false");
    assert.equal(headers["X-CLIENT-TYPE"], "cline-sdk");
    assert.equal(headers["Accept"], "text/event-stream");
    assert.equal(headers["Content-Type"], "application/json");

    const bare = upstream.buildHeaders({ ...cred.EMPTY_CREDENTIALS, accessToken: "eyJbare" });
    assert.equal(bare["Authorization"], "Bearer workos:eyJbare", "裸令牌在头里被补前缀");

    const json = upstream.buildHeaders(c, { chat: false });
    assert.equal(json["Accept"], "application/json");
    assert.equal(json["Content-Type"], undefined, "非对话端点不带 Content-Type");
  });

  it("403 地域限制必须先被识别（否则被误判成凭据问题）", () => {
    const sample =
      '{"error":"access forbidden: cline-free/muse-spark-1.3-contributor ' +
      'is not available in your region","success":false}';
    assert.equal(upstream.isRegionRestricted(sample), true);
    assert.equal(upstream.isRegionRestricted("Region not supported"), true);
    assert.equal(upstream.isRegionRestricted("not available in your country"), true);
    assert.equal(
      upstream.isRegionRestricted('{"error":"ENTITLEMENT_ERROR: not subscribed"}'),
      false,
      "普通 403 不误判",
    );
  });

  it("429 的等待时长只能从英文句子里取（402 / 无线索 → null）", () => {
    const real =
      '{"error":{"code":"INFERENCE_CAP_ERROR","message":"Error 429: Daily free limit ' +
      'reached on model deepseek/deepseek-v4.1-flash. Try again in 19h 39m"}}';
    assert.equal(upstream.parseRetryAfterSeconds(429, {}, real), 70740);
    assert.equal(upstream.parseRetryAfterSeconds(429, { "retry-after": "42" }, real), 42);
    assert.equal(upstream.parseRetryAfterSeconds(429, {}, "Try again in 2 minutes"), 120);
    assert.equal(upstream.parseRetryAfterSeconds(429, {}, "Try again in 1h 30m"), 5400);
    assert.equal(upstream.parseRetryAfterSeconds(429, {}, "try again in 45s"), 45);
    assert.equal(upstream.parseRetryAfterSeconds(429, {}, '{"error":"slow down. Try again in 5m"}'), 300);
    assert.equal(upstream.parseRetryAfterSeconds(429, {}, '{"message":"Try again in 3m"}'), 180);
    assert.equal(upstream.parseRetryAfterSeconds(429, {}, "{}"), null, "没有时长线索不猜");
    assert.equal(upstream.parseRetryAfterSeconds(402, { "retry-after": "9" }, real), null, "402 不适用");
  });

  it("fetchModels：401/403 → UpstreamUnauthorized，形状不对 → 报错", async () => {
    const c: cred.Credentials = { ...cred.EMPTY_CREDENTIALS, accessToken: "workos:x" };
    const data = await upstream.fetchModels(c);
    assert.ok(Array.isArray(data["data"]));

    const dead = await deadBase();
    await assert.rejects(
      () => upstream.fetchModels(c, 5000, { baseUrl: dead, chatPath: "/x" }),
      /models request failed/,
    );
  });
});

// ── 6. 请求体改写 ─────────────────────────────────────────────────────────────

describe("6. 请求体改写", () => {
  const req: Record<string, unknown> = {
    model: "cline-free/mimo-v2.6-flash",
    messages: [
      { role: "user", content: "你好" },
      { role: "system", content: "你是助手" },
      { role: "assistant", content: "你好！" },
    ],
    temperature: 0.7,
    max_tokens: 2_000_000,
    stop: "END",
    reasoning_effort: "banana", // ⚠ 未知档位必须原样透传（不校验）
    tools: [
      {
        type: "function",
        function: {
          name: "bash",
          description: "执行命令",
          parameters: {
            type: "object",
            properties: {
              permission: { type: "string", enum: ["allow", "", "  ", "deny"] },
              level: { type: "integer", enum: [1, 2] }, // 数值 enum 整段保留
              onlyEmpty: { type: "string", enum: [""] }, // 全空 → 整个键丢弃
              nested: { type: "array", items: { type: "string", enum: ["a", ""] } },
            },
          },
        },
      },
    ],
  };

  it("system 提升为 messages[0]、恒 stream、档位原样透传", () => {
    const body = upstream.buildChatBody(req, "cline-free/mimo-v2.6-flash");
    assert.equal(body["model"], "cline-free/mimo-v2.6-flash");
    assert.equal(body["stream"], true);
    assert.deepEqual(
      (body["messages"] as Array<{ role: string }>).map((m) => m.role),
      ["system", "user", "assistant"],
    );
    assert.equal((body["messages"] as Array<{ content: string }>)[0]!.content, "你是助手");
    assert.equal(body["temperature"], 0.7);
    assert.deepEqual(body["stop"], ["END"], "stop 单值归一成数组");
    assert.equal(body["reasoning_effort"], "banana", "未知档位原样透传（上游只是静默忽略）");
    assert.equal(body["max_tokens"], upstream.MAX_TOKENS_CAP, "max_tokens 夹到上界");
  });

  it("tools 的 enum 清洗：删空串、保留数值、全空丢键、递归下钻", () => {
    const body = upstream.buildChatBody(req, "m");
    const props = (
      (
        (body["tools"] as Array<Record<string, unknown>>)[0]!["function"] as Record<string, unknown>
      )["parameters"] as Record<string, unknown>
    )["properties"] as Record<string, Record<string, unknown>>;

    assert.deepEqual(props["permission"]!["enum"], ["allow", "deny"]);
    assert.deepEqual(props["level"]!["enum"], [1, 2]);
    assert.equal("enum" in props["onlyEmpty"]!, false, "全空的 enum 键丢弃（不留下 []）");
    assert.deepEqual(
      (props["nested"]!["items"] as Record<string, unknown>)["enum"],
      ["a"],
      "嵌套 items 里的 enum 同罪",
    );
    // 不改动调用方的对象（网关会复用请求体）
    const originalProps = (
      (
        (req["tools"] as Array<Record<string, unknown>>)[0]!["function"] as Record<string, unknown>
      )["parameters"] as Record<string, unknown>
    )["properties"] as Record<string, Record<string, unknown>>;
    assert.deepEqual(originalProps["permission"]!["enum"], ["allow", "", "  ", "deny"]);
  });

  it("max_tokens 边界：非有限值 / ≤0 不发该键；无 system 不插空 system", () => {
    for (const raw of [0, -5, Number.POSITIVE_INFINITY, Number.NaN, "abc", null]) {
      const body = upstream.buildChatBody({ messages: [], max_tokens: raw }, "m");
      assert.equal("max_tokens" in body, false, `max_tokens=${String(raw)} 不应发送`);
    }
    const minimal = upstream.buildChatBody({ messages: [{ role: "user", content: "hi" }] }, "m");
    assert.deepEqual(Object.keys(minimal).sort(), ["messages", "model", "stream"]);
    assert.deepEqual(
      (minimal["messages"] as Array<{ role: string }>).map((m) => m.role),
      ["user"],
    );
  });

  it("图片 part 原样透传（能力由模型决定，Cline 没有视觉 token 预算）", () => {
    const body = upstream.buildChatBody(
      {
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
      "m",
    );
    const parts = (body["messages"] as Array<{ content: Array<Record<string, unknown>> }>)[0]!
      .content;
    assert.deepEqual(
      parts.map((p) => p["type"]),
      ["text", "image_url"],
    );
  });
});

// ── 7. 模型目录 ───────────────────────────────────────────────────────────────

describe("7. 模型目录", () => {
  it("合并顺序：free → recommended/clinePass → /models 其余", async () => {
    await saveFakeCreds();
    catalog.setModelsDevUrl(`${await deadBase()}/api.json`); // models.dev 不可达
    catalog.clearCache();
    await catalog.refreshCatalog();
    const rows = catalog.details();
    assert.deepEqual(
      rows.map((r) => r["id"]),
      [
        "stealth/space-bunny-alpha",
        "cline-free/mimo-v2.6-flash",
        "deepseek/deepseek-v4.1-flash",
        "cline-pass/claude-opus-4",
        "z-ai/glm-4.7",
        "cline-free/downed-model",
        "openrouter/free",
      ],
    );
    const byId = new Map(rows.map((r) => [r["id"] as string, r]));
    assert.equal(
      byId.has("cline-free/muse-spark-1.3-contributor"),
      false,
      "远端已不认识的兜底条目被丢弃（下架模型不再挂着免费出现）",
    );
    assert.equal(
      byId.get("cline-free/mimo-v2.6-flash")!["context_window"],
      1_048_576,
      "兜底表为远端条目补元数据",
    );
    assert.equal(byId.get("cline-free/mimo-v2.6-flash")!["name"], "MiMo-V2.6-Flash · 免费");
    assert.equal(byId.get("stealth/space-bunny-alpha")!["is_free"], true);
    assert.equal(byId.get("deepseek/deepseek-v4.1-flash")!["is_free"], false);
    assert.equal(byId.get("cline-pass/claude-opus-4")!["is_free"], false, "clinePass 是订阅制，不是免费");
    assert.equal(byId.get("cline-free/downed-model")!["is_free"], true, "cline-free/ 前缀兜底算免费");
    assert.equal(byId.get("z-ai/glm-4.7")!["context_window"], 0, "models.dev 挂了窗口保持未知（不编造）");
    assert.deepEqual(byId.get("z-ai/glm-4.7")!["efforts"], ["none", "low", "medium", "high", "max"]);
    assert.equal(byId.get("z-ai/glm-4.7")!["default_effort"], "high");
    assert.equal(
      (byId.get("z-ai/glm-4.7")!["effort_names"] as Record<string, string>)["max"],
      "Extra",
      "档位展示名与 wire 值刻意不同",
    );
    // 模型池策略 =(deepseek|glm)×flash：只有 deepseek-v4.1-flash 两道闸门都过。
    // 被挡下的（含 glm-4.7 / space-bunny / cline-free/mimo）仍在上面的 details() 里 —— 数据没丢。
    const ids = catalog.exposedIds();
    assert.deepEqual(
      ids,
      ["deepseek/deepseek-v4.1-flash"],
      `池内应只剩 deepseek 系 flash；实际: ${ids.join(", ")}`,
    );
    assert.ok(
      ids.every((id) => isAllowedFamily(id)),
      "池内每一条都必须过共享池策略（避免在测试里重写一遍判据而与它脱节）",
    );
    assert.ok(!ids.includes("cline-free/mimo-v2.6-flash"), "别家 flash（mimo）不进池子");
    assert.ok(!ids.includes("stealth/space-bunny-alpha"), "非 flash 的免费条目不进池子");
    assert.ok(!ids.includes("z-ai/glm-4.7"), "同家族的非 flash 型号也挡在池外");
  });

  it("免费判定的后缀语义（不是 includes(':free')）", () => {
    assert.equal(catalog.isFree("openrouter/gpt:free"), true);
    assert.equal(catalog.isFree("vendor:free/legacy"), false);
    assert.equal(catalog.isFree("cli/claude-sonnet-4"), false);
    assert.equal(catalog.resolveModel("cli/claude-sonnet-4"), "cli/claude-sonnet-4", "未知原样透传");
  });

  it("models.dev：两种 provider 形态都认，且不采信 limit.output", async () => {
    catalog.setModelsDevUrl(`${fakeBase()}/models-dev.json`);
    catalog.clearCache();
    await catalog.refreshCatalog();
    const byId = new Map(catalog.details().map((r) => [r["id"] as string, r]));
    assert.equal(byId.get("cline-pass/claude-opus-4")!["context_window"], 200_000);
    assert.equal(byId.get("cline-pass/claude-opus-4")!["vision"], true, "只认 image（pdf/audio 忽略）");
    assert.equal(
      byId.get("cline-pass/claude-opus-4")!["max_output"],
      0,
      "limit.output 刻意不采信（否则会变成请求体的 max_tokens）",
    );

    catalog.setModelsDevUrl(`${fakeBase()}/models-dev-nested.json`);
    catalog.clearCache();
    await catalog.refreshCatalog();
    const meta = catalog.modelsDevMeta();
    assert.deepEqual(meta?.["cline-pass/nested-model"], { contextWindow: 4096 }, "裸 id 补 cline-pass/ 前缀");
  });

  it("远端整体不可用 → 兜底表整表（否则渠道在选择器里凭空消失）", async () => {
    const saved = upstream.loadConfig()[0];
    await upstream.saveConfig({ baseUrl: await deadBase(), chatPath: "/api/v1/chat/completions" });
    catalog.clearCache();
    await catalog.refreshCatalog();
    try {
      // 兜底表 3 条（space-bunny / mimo-v2.6-flash / muse-spark）**没有一条**属于
      // deepseek 或 glm 家族 —— 池策略 (deepseek|glm)×flash 下全被挡在池外，
      // 所以远端不可用时池子是**空的**。这是策略过滤，不是渠道坏了（底层表仍完整）。
      assert.deepEqual(
        catalog.exposedIds(),
        [],
        "兜底表 3 条都不是 deepseek/glm → 池子为空（预期行为）",
      );
      // 兜底表整表仍在底层（过滤只发生在呈现层），其免费元数据不受影响
      const byId = new Map(catalog.details().map((r) => [r["id"] as string, r]));
      assert.deepEqual(
        [...byId.keys()],
        [
          "stealth/space-bunny-alpha",
          "cline-free/mimo-v2.6-flash",
          "cline-free/muse-spark-1.3-contributor",
        ],
        "远端不可用时兜底表整表保底（仍含全部 3 条）",
      );
      assert.equal(byId.get("cline-free/muse-spark-1.3-contributor")!["is_free"], true);
      assert.ok([...byId.values()].every((r) => r["source"] === "fallback"));
    } finally {
      await upstream.saveConfig(saved);
      catalog.setModelsDevUrl(`${fakeBase()}/models-dev.json`);
      catalog.clearCache();
    }
  });

  it("models.json 别名：短名排在最前、原始 id 不重复暴露；非 DS/GLM 别名被策略过滤", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cline-models-"));
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        models: [
          { slug: "deepseek/deepseek-v4.1-flash", alias: "deepseek-v4.1-flash" },
          { slug: "cline-free/mimo-v2.6-flash", alias: "mimo" },
        ],
      }),
      "utf8",
    );
    process.env["CLINE_MODELS_FILE"] = join(dir, "models.json");
    try {
      catalog.clearCache();
      await catalog.refreshCatalog();
      const ids = catalog.exposedIds();
      assert.equal(ids[0], "deepseek-v4.1-flash", "DS/GLM 别名排在最前");
      assert.equal(catalog.resolveModel("deepseek-v4.1-flash"), "deepseek/deepseek-v4.1-flash");
      assert.equal(ids.includes("deepseek/deepseek-v4.1-flash"), false, "被别名覆盖的原始 id 不重复暴露");
      // 白名单同样作用于别名层：非 DS/GLM 别名不暴露，但映射仍可用（数据没丢）
      assert.equal(ids.includes("mimo"), false);
      assert.equal(catalog.resolveModel("mimo"), "cline-free/mimo-v2.6-flash");
    } finally {
      delete process.env["CLINE_MODELS_FILE"];
      rmSync(dir, { recursive: true, force: true });
      catalog.clearCache();
    }
  });
});

// ── 8. 额度 ───────────────────────────────────────────────────────────────────

describe("8. 额度（余额 + 订阅窗口）", () => {
  it("余额端点用 account_id（usr-…）而不是 JWT 的 sub（user_…）", async () => {
    await saveFakeCreds(); // JWT 里带一个很像账号的 sub（user_01M3…）
    st.balanceMode = "ok";
    st.limitsMode = "ok";
    st.balancePaths = [];
    st.limitsPaths = [];
    const info = await billing.fetchCredits();
    assert.deepEqual(st.balancePaths, [`/api/v1/users/${ACCOUNT_ID}/balance`]);
    assert.deepEqual(st.limitsPaths, ["/api/v1/users/me/plan/usage-limits"], "窗口端点用字面量 users/me");
    assert.equal(info.total.remain, 5, "500000 / 100000 = $5.00");
    assert.equal(info.total.unit, "USD");
    assert.equal(info.total.size_known, false, "上游只给剩余 → 显式标记总量是回填值");
    assert.equal(info.total.used, 0, "不编造已用量");
    assert.equal(info.packages.length, 1);
    assert.equal(info.packages[0]!.days_left, null, "不编造到期天数");
    assert.equal(info.usage_limits.ok, true);
    assert.equal(info.usage_limits.limits.length, 2);
    assert.equal(info.usage_limits.limits[0]!.percent_used, 120, "percentUsed 不做夹取");
    assert.equal(
      info.usage_limits.limits[0]!.resets_at,
      "2026-09-25T05:23:47.123456789Z",
      "纳秒 ISO 字符串原样上报",
    );
    assert.equal(info.usage_limits.limits[1]!.resets_at, "", "用量为 0 的窗口 resetsAt 是空串");
    assert.deepEqual(info.claimable, [], "Cline 没有签到端点 → claimable 恒空");
  });

  it("CLINE_BALANCE_SCALE 是 100000（全模块唯一的不确定点）", () => {
    assert.equal(billing.CLINE_BALANCE_SCALE, 100_000);
  });

  it("失败形态①业务失败 → CreditsError（带上游原因，不显示成 0）", async () => {
    st.balanceMode = "biz_fail";
    await assert.rejects(() => billing.fetchCredits(), (err: unknown) => {
      assert.ok(err instanceof billing.CreditsError);
      assert.match(String(err), /balance unavailable/);
      return true;
    });
  });

  it("失败形态②网关层 401（无 success 字段）→ NotLoggedInError", async () => {
    st.balanceMode = "unauthorized";
    await assert.rejects(
      () => billing.fetchCredits({ refreshOn401: false }),
      cred.NotLoggedInError,
    );
  });

  it("400 → CreditsError 且文案点明 account_id（传错 userId 的典型症状）", async () => {
    st.balanceMode = "bad_format";
    await assert.rejects(() => billing.fetchCredits(), (err: unknown) => {
      assert.ok(err instanceof billing.CreditsError);
      assert.match(String(err), /account_id/);
      return true;
    });
    st.balanceMode = "ok";
  });

  it("缺 account_id 时不瞎猜（既不用 sub，也不返回 0）", async () => {
    await saveFakeCreds({ accountId: "" });
    await assert.rejects(() => billing.fetchCredits(), (err: unknown) => {
      assert.ok(err instanceof billing.CreditsError);
      assert.match(String(err), /account_id/);
      return true;
    });
  });

  it("窗口查询失败只作为数据上报（ok:false），不影响余额", async () => {
    await saveFakeCreds();
    st.limitsMode = "fail";
    const info = await billing.fetchCredits();
    assert.equal(info.usage_limits.ok, false);
    assert.ok(info.usage_limits.error);
    assert.equal(info.total.remain, 5);
    st.limitsMode = "ok";
  });

  it("未登录 → NotLoggedInError（CLI 据此提示 cline login）", async () => {
    rmSync(paths.credentialsPath(), { force: true });
    await assert.rejects(() => billing.fetchCredits(), cred.NotLoggedInError);
  });
});

// ── 9. 端到端网关 ─────────────────────────────────────────────────────────────

async function readSse(url: string, body: unknown): Promise<{
  status: number;
  content: string;
  reasoning: string;
  finishes: string[];
  sawEmptyToolCalls: boolean;
}> {
  const resp = await fetch(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  const text = await resp.text();
  let content = "";
  let reasoning = "";
  const finishes: string[] = [];
  let sawEmptyToolCalls = false;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const chunk = JSON.parse(payload) as {
      choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>;
    };
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {};
      if (typeof delta["content"] === "string") content += delta["content"];
      if (typeof delta["reasoning"] === "string") reasoning += delta["reasoning"];
      if (typeof delta["reasoning_content"] === "string") reasoning += delta["reasoning_content"];
      if ("tool_calls" in delta) sawEmptyToolCalls = true;
      if (choice.finish_reason) finishes.push(choice.finish_reason);
    }
  }
  return { status: resp.status, content, reasoning, finishes, sawEmptyToolCalls };
}

describe("9. 端到端网关（假上游 + 真实网关）", () => {
  let gw: gateway.RunningGateway;

  before(async () => {
    await saveFakeCreds();
    await upstream.saveConfig({ baseUrl: fakeBase(), chatPath: "/api/v1/chat/completions" });
    catalog.clearCache();
    await catalog.refreshCatalog(); // 预热远端目录（缓存命中后网关不再出网）
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
  });

  it("/v1/models 返回三个池模型；/health 报告 ok 与登录状态", async () => {
    const models = (await (await fetch(`http://${gw.addr}/v1/models`)).json()) as {
      data: Array<{ id: string }>;
    };
    const ids = models.data.map((m) => m.id);
    // 对外只有三个公共模型 id（不带渠道前缀），与「本渠道目录里有什么」无关
    assert.deepEqual(ids, ["deepseek-v4.1-flash", "deepseek-v4-flash", "glm-5.3-flash"]);
    assert.ok(
      ids.every((id) => !id.includes("/")),
      "不再暴露 <cid>/<模型> 形态",
    );
    assert.ok(
      catalog.details().some((r) => r["id"] === "z-ai/glm-4.7"),
      "被过滤的非 flash 模型仍在底层目录（过滤在呈现层，不是丢数据）",
    );

    const health = (await (await fetch(`http://${gw.addr}/health`)).json()) as Record<string, unknown>;
    assert.equal(health["ok"], true);
    assert.equal(health["logged_in"], true);
  });

  it("流式：正文 + delta.reasoning 透传 + 空 tool_calls 被剔除", async () => {
    const out = await readSse(`http://${gw.addr}/v1/chat/completions`, {
      model: "deepseek-v4.1-flash",
      messages: [
        { role: "system", content: "身份" },
        { role: "user", content: "hi" },
      ],
      stream: true,
    });
    assert.equal(out.status, 200);
    assert.equal(out.content, "网关通了");
    assert.equal(out.reasoning, "思考", "Cline 的思考增量字段是 delta.reasoning");
    assert.deepEqual(out.finishes, ["stop"]);
    assert.equal(out.sawEmptyToolCalls, false, "空 tool_calls 必须被规范化剔除");
  });

  it("上游真实收到的头与体（含 workos: 前缀与 4 条伪装头）", async () => {
    await readSse(`http://${gw.addr}/v1/chat/completions`, {
      model: "deepseek-v4.1-flash",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const expectedToken = cred.load().accessToken;
    assert.equal(st.chatHeaders["authorization"], `Bearer ${expectedToken}`);
    assert.ok(String(st.chatHeaders["authorization"]).startsWith("Bearer workos:"), "必须带 workos: 前缀");
    assert.equal(st.chatHeaders["x-client-type"], "cline-sdk");
    assert.equal(st.chatHeaders["accept"], "text/event-stream");
    assert.equal(st.chatBody?.["model"], "deepseek/deepseek-v4.1-flash", "池 id 解析成目录里的上游 slug");
    assert.equal(st.chatBody?.["stream"], true);
    const messages = st.chatBody?.["messages"] as Array<{ role: string }>;
    // Cline 没有「首条必须 system」的硬约束 → 客户端没给 system 就不注入
    assert.deepEqual(messages.map((m) => m.role), ["user"]);
  });

  it("非流式：本层聚合成 chat.completion", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 200);
    const payload = (await resp.json()) as {
      object: string;
      choices: Array<{ message: { content: string; reasoning_content?: string } }>;
    };
    assert.equal(payload.object, "chat.completion");
    assert.equal(payload.choices[0]!.message.content, "网关通了");
    assert.equal(payload.choices[0]!.message.reasoning_content, "思考");
  });

  it("请求校验 400 统一信封 / 未知路径 404", async () => {
    const bad = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "x" }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: { code: string } }).error.code, "invalid_request");

    const broken = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      body: "{ not json",
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(broken.status, 400);
    assert.equal(((await broken.json()) as { error: { code: string } }).error.code, "invalid_json");

    const nope = await fetch(`http://${gw.addr}/nope`);
    assert.equal(nope.status, 404);
    assert.equal(((await nope.json()) as { error: { code: string } }).error.code, "not_found");
  });
});

// ── 10. 上游错误处理 ──────────────────────────────────────────────────────────

describe("10. 上游错误处理", () => {
  it("上游 500 转成 502 upstream_error（不回传上游原文）", async () => {
    const failing = createServer((req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("internal detail leak");
    });
    const port = await new Promise<number>((resolve) => {
      failing.listen(0, "127.0.0.1", () => resolve((failing.address() as { port: number }).port));
    });
    const saved = upstream.loadConfig()[0];
    await upstream.saveConfig({ baseUrl: `http://127.0.0.1:${port}`, chatPath: "/api/v1/chat/completions" });
    const gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
    try {
      const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({
          model: "deepseek-v4.1-flash",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(resp.status, 502);
      const payload = (await resp.json()) as { error: { code: string; message: string } };
      assert.equal(payload.error.code, "upstream_error");
      assert.ok(!payload.error.message.includes("internal detail leak"), "上游原文不应回传客户端");
    } finally {
      await gw.close();
      await new Promise<void>((r) => failing.close(() => r()));
      await upstream.saveConfig(saved);
    }
  });
});
