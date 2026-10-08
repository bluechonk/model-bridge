/**
 * loomy-bridge 自检（**完全离线**，不出网、不需要真实凭据）。
 *
 * 覆盖协议的关键结论：
 *  1. HMAC-SHA1 账号签名（9 段、**恒以两个换行结尾**、空 body 的 MD5 为空、golden 值）
 *  2. 「签名 = 发送的字节」（假上游用收到的原始 body 字节重算签名并比对）
 *  3. 两套认证头（chat 两个都发 / 业务端点只发 `token`）+ 交叉验证
 *  4. 业务失败恒 HTTP 200：成败只能读 body 的 `code`（100002 / 100001）
 *  5. 短信登录与微信扫码（**405 = 已确认、404 = 已扫码待确认**，绝不能读反）
 *  6. 续期 = 有效性探测（无 refresh 端点）+ 有效期对账 + 老凭据补字段
 *  7. 目录（倍率归一化幂等、type=chat 过滤、档位清洗、只缓存真实远端目录）
 *  8. 请求体改写（system 先拼再放、档位校验不过静默不下发）
 *  9. 额度（两个积分池、任务直领、100002 立即终止）
 * 10. 端到端网关（假上游 + 真实网关）：流式/非流式、思考透传、错误路径
 *
 * 数据目录用 LOOMY_HOME 指向临时目录，绝不碰真实凭据。
 */

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const HOME = mkdtempSync(join(tmpdir(), "loomy-selftest-"));
process.env["MODEL_BRIDGE_HOME"] = HOME;

const SESSION = "0123456789abcdef0123456789abcdef"; // 32 位小写 hex（实测形态）
const USERID = "123456789012345678"; // 18 位数字串（实测形态）
const PHONE = "13800138000";

interface FakeState {
  accountRequests: Array<{ path: string; raw: string; headers: Record<string, string | string[] | undefined> }>;
  signatureOk: boolean;
  modelsMode: string;
  modelsCalls: number;
  pointsMode: string;
  pointsQuery: Record<string, string>;
  firstLoginMode: string;
  firstLoginCalls: number;
  tasksMode: string;
  completeMode: string;
  completeKeys: string[];
  bindMode: number;
  businessHeaders: Array<{ path: string; headers: Record<string, string | string[] | undefined> }>;
  chatHeaders: Record<string, string | string[] | undefined>;
  chatBody: Record<string, unknown> | null;
  wechatFrames: string[];
  wechatQueries: Array<Record<string, string>>;
}

const st: FakeState = {
  accountRequests: [],
  signatureOk: true,
  modelsMode: "ok",
  modelsCalls: 0,
  pointsMode: "ok",
  pointsQuery: {},
  firstLoginMode: "ok",
  firstLoginCalls: 0,
  tasksMode: "ok",
  completeMode: "ok",
  completeKeys: [],
  bindMode: 1,
  businessHeaders: [],
  chatHeaders: {},
  chatBody: null,
  wechatFrames: [],
  wechatQueries: [],
};

let fakePort = 0;
function fakeBase(): string {
  return `http://127.0.0.1:${fakePort}`;
}

function json(res: import("node:http").ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

// 被测模块（设 env 后 import）
// 共享层来自工作区包；先注册本渠道（副作用）再引渠道模块
const { paths, sseStream: sse, gateway } = await import("@model-bridge/gateway");
await import("../dist/channel.js");
const cred = await import("../dist/cred.js");
const upstream = await import("../dist/upstream.js");
const catalog = await import("../dist/catalog.js");
const billing = await import("../dist/billing.js");

const ACCOUNT_PATHS = new Set([
  cred.SEND_MSG_PATH,
  cred.CHECK_CODE_PATH,
  cred.BIND_AUTH_PATH,
  cred.BIND_SEND_MSG_PATH,
  cred.BIND_CHECK_CODE_PATH,
  cred.BIND_SKIP_PATH,
]);

/**
 * 账号端点处理器：**先用收到的原始 body 字节重算签名**，与请求头里的签名比对。
 *
 * 若客户端「签一个字符串、发另一个字符串」（二次序列化），签名不一致 → 测试红。
 */
function handleAccount(path: string, raw: string, headers: Record<string, string | string[] | undefined>, res: import("node:http").ServerResponse): void {
  st.accountRequests.push({ path, raw, headers });
  const date = String(headers["date"] ?? "");
  const nonce = String(headers["nonce"] ?? "");
  const stringToSign = cred.buildStringToSign("POST", path, {
    bodyStr: raw,
    contentType: String(headers["content-type"] ?? "application/json"),
    date,
    nonce,
  });
  const expected = createHmac("sha1", cred.ACCESS_KEY_SECRET).update(stringToSign, "utf8").digest("base64");
  if (headers["authorization"] !== `account ${cred.ACCESS_KEY_ID}:${expected}`) {
    st.signatureOk = false;
  }

  if (path === cred.SEND_MSG_PATH) {
    json(res, 200, { code: "000000", desc: "success", data: { msgid: "msg-1" } });
    return;
  }
  if (path === cred.CHECK_CODE_PATH) {
    const param = (JSON.parse(raw) as { param: Record<string, unknown> }).param;
    json(res, 200, { code: "000000", data: { session: SESSION, userid: USERID, phone: param["phone"] } });
    return;
  }
  if (path === cred.BIND_AUTH_PATH) {
    if (st.bindMode === 0) {
      json(res, 200, { code: "000000", data: { bind: 0, rcode: "rc-1", isnew: 1 } });
      return;
    }
    json(res, 200, { code: "000000", data: { bind: 1, rcode: "rc-1", nickname: "鲸鱼" } });
    return;
  }
  if (path === cred.BIND_SEND_MSG_PATH) {
    json(res, 200, { code: "000000", data: { msgid: "bmsg-1" } });
    return;
  }
  json(res, 200, { code: "000000", data: { session: SESSION, userid: USERID } });
}

/** 业务端点守卫：只认 `token` 头（带错 → 200 + 100002 缺少 token，与实测一致）。 */
function businessGuard(
  path: string,
  req: IncomingMessage,
  res: import("node:http").ServerResponse,
): boolean {
  st.businessHeaders.push({ path, headers: { ...req.headers } });
  if (req.headers["token"] !== SESSION) {
    json(res, 200, { code: "100002", desc: "缺少 token" });
    return true;
  }
  return false;
}

function handleFake(req: IncomingMessage, res: import("node:http").ServerResponse): void {
  let raw = "";
  req.on("data", (c) => {
    raw += String(c);
  });
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    if (ACCOUNT_PATHS.has(path)) {
      handleAccount(path, raw, { ...req.headers }, res);
      return;
    }
    if (path === "/api/v1/models") {
      st.modelsCalls += 1;
      if (businessGuard(path, req, res)) return;
      if (st.modelsMode === "fail") {
        json(res, 200, { code: "500000", desc: "模型列表暂不可用" });
        return;
      }
      json(res, 200, {
        code: "000000",
        data: {
          reasoning_catalog_version: "v-1",
          models: [
            {
              id: "GLM-5.3-Flash",
              name: "GLM 5.3 Flash(x0.8)",
              type: "chat",
              context_length: 800_000,
              capabilities: { reasoning: true, input_modalities: ["text", "image"] },
              // 重复项与脏数据都要被清洗掉
              reasoning_efforts: ["none", "low", "low", "bad item", "", "high", 7],
              default_reasoning_effort: "low",
            },
            { id: "embed-1", name: "Embedding", type: "embedding", context_length: 8192 },
            {
              id: "MiniMax-M3",
              name: "MiniMax M3 （x4.0）",
              type: "chat",
              context_length: 1_048_576,
              capabilities: {},
            },
            { id: "no-name-model", type: "chat", context_length: 4096 },
            { id: "risky", name: "Risky", type: "chat", capabilities: { reasoning: "yes" } },
          ],
        },
      });
      return;
    }
    if (path === "/api/v1/points/records") {
      st.pointsQuery = Object.fromEntries(url.searchParams);
      if (businessGuard(path, req, res)) return;
      if (st.pointsMode === "auth") {
        json(res, 200, { code: "100002", desc: "缺少 token" });
        return;
      }
      if (st.pointsMode === "no_balance") {
        json(res, 200, { code: "000000", data: { availableBalance: 19992 } });
        return;
      }
      if (st.pointsMode === "with_quota") {
        json(res, 200, {
          code: "000000",
          data: {
            balance: 15000,
            dailyBalance: 4992,
            availableBalance: 19992,
            dailyQuota: 5000,
            dailyConsumed: 8,
            dailyCycleDate: "2026-09-26",
          },
        });
        return;
      }
      json(res, 200, {
        code: "000000",
        data: { balance: 15000, dailyBalance: 4992, availableBalance: 19992, dailyCycleDate: "2026-09-26" },
      });
      return;
    }
    if (path === "/api/v1/points/first-login") {
      if (businessGuard(path, req, res)) return;
      st.firstLoginCalls += 1;
      if (st.firstLoginMode === "fail") {
        json(res, 200, { code: "500000", desc: "稍后再试" });
        return;
      }
      json(res, 200, {
        code: "000000",
        data: {
          alreadyProcessed: st.firstLoginMode === "already",
          currentBalance: 19992,
          permanentBalance: 15000,
          dailyBalance: 4992,
          dailyQuota: 5000,
          dailyConsumed: 8,
          dailyCycleDate: "2026-09-26",
        },
      });
      return;
    }
    if (path === "/api/v1/onboarding/tasks") {
      if (businessGuard(path, req, res)) return;
      if (st.tasksMode === "fail") {
        json(res, 200, { code: "500000", desc: "任务列表不可用" });
        return;
      }
      json(res, 200, {
        code: "000000",
        data: {
          tasks: { first_message: true, pick_skill: true },
          earned: 99999, // ⚠ 不采信服务端 earned，按本地表现算
          total: 10000,
        },
      });
      return;
    }
    if (path === "/api/v1/onboarding/tasks/complete") {
      if (businessGuard(path, req, res)) return;
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      st.completeKeys.push(String(body["key"]));
      // 上报 body 只允许有 key 一个字段（无设备指纹、无版本号、无渠道号）
      if (Object.keys(body).sort().join(",") !== "key") {
        json(res, 200, { code: "100001", desc: "参数错误" });
        return;
      }
      if (st.completeMode === "unknown_key") {
        json(res, 200, { code: "100001", desc: "未知任务" });
        return;
      }
      if (st.completeMode === "auth") {
        json(res, 200, { code: "100002", desc: "缺少 token" });
        return;
      }
      if (st.completeMode === "auth_on_ppt" && body["key"] === "generate_ppt") {
        json(res, 200, { code: "100002", desc: "缺少 token" });
        return;
      }
      json(res, 200, { code: "000000", data: { alreadyCompleted: false, balance: 19992 } });
      return;
    }
    if (path === "/api/v1/chat/completions") {
      st.chatHeaders = { ...req.headers };
      st.chatBody = JSON.parse(raw || "{}") as Record<string, unknown>;
      // chat 端点**只认** Authorization: Bearer
      if (req.headers["authorization"] !== `Bearer ${SESSION}`) {
        json(res, 200, { code: "100002", desc: "缺少 token" });
        return;
      }
      const frames = [
        { choices: [{ index: 0, delta: { reasoning_content: "想想" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: "你好" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: "世界" }, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        },
      ];
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const frame of frames) {
        res.write(
          `data: ${JSON.stringify({ id: "chatcmpl-loomy", object: "chat.completion.chunk", created: 1, ...frame })}\n\n`,
        );
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    // ── 微信（纯 HTTP 路线）──
    if (path === "/connect/qrconnect") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end('<html><body><img class="js_qrcode_img" src="/connect/qrcode/AbC-123_xyz789"/></body></html>');
      return;
    }
    if (path.startsWith("/connect/qrcode/")) {
      const uuid = path.slice("/connect/qrcode/".length);
      if (uuid === "tiny") {
        res.writeHead(200, { "Content-Type": "image/jpeg" });
        res.end("err");
        return;
      }
      if (uuid === "html") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html>redirect_uri 参数错误</html>${" ".repeat(300)}`);
        return;
      }
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 0x4a)]));
      return;
    }
    if (path === "/connect/l/qrconnect") {
      st.wechatQueries.push(Object.fromEntries(url.searchParams));
      const frame = st.wechatFrames.shift() ?? "";
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(frame);
      return;
    }
    json(res, 404, { code: "100001", desc: `未知路径 ${path}` });
  });
}

const fakeServer: Server = createServer(handleFake);
await new Promise<void>((resolve) => {
  fakeServer.listen(0, "127.0.0.1", () => {
    fakePort = (fakeServer.address() as { port: number }).port;
    resolve();
  });
});

process.env["LOOMY_ACCOUNT_BASE_URL"] = fakeBase();
process.env["LOOMY_WECHAT_BASE_URL"] = fakeBase();
process.env["LOOMY_WECHAT_LONG_POLL_URL"] = `${fakeBase()}/connect/l/qrconnect`;

await upstream.saveConfig({ baseUrl: fakeBase() });

/** 写一份假凭据（默认带 14 天有效期）。 */
async function saveFakeCredentials(overrides: Partial<cred.Credentials> = {}): Promise<cred.Credentials> {
  const c: cred.Credentials = {
    ...cred.EMPTY_CREDENTIALS,
    accessToken: SESSION,
    userid: USERID,
    uid: USERID,
    phone: PHONE,
    expiresAt: cred.computeExpiresAt(),
    obtainedAt: new Date().toISOString(),
    ...overrides,
  };
  await cred.save(c);
  return cred.load();
}

/** 拿一个确定没人监听的端口。 */
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
  it("数据目录名固定，受 MODEL_BRIDGE_HOME 覆盖，渠道层是 <root>/loomy", () => {
    assert.equal(paths.rootDir(), HOME);
    assert.equal(paths.channelDir(), join(HOME, "loomy"));
    assert.ok(paths.credentialsPath().endsWith("credentials.json"));
  });

  it("旧目录存在时整目录迁移", () => {
    const alt = mkdtempSync(join(tmpdir(), "loomy-legacy-"));
    const legacy = join(alt, ".loomy2api");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "credentials.json"), '{"access_token":"legacy"}', "utf8");
    const saved = process.env["MODEL_BRIDGE_HOME"];
    process.env["MODEL_BRIDGE_HOME"] = alt;
    try {
      assert.equal(paths.channelDir(), join(alt, "loomy"));
      assert.ok(readFileSync(paths.credentialsPath(), "utf8").includes("legacy"));
    } finally {
      process.env["MODEL_BRIDGE_HOME"] = saved;
      rmSync(alt, { recursive: true, force: true });
    }
  });
});

// ── 2. 签名 ───────────────────────────────────────────────────────────────────

describe("2. HMAC-SHA1 账号签名（9 段，恒以两个换行结尾）", () => {
  const FIXED_DATE = "Wed, 08 Oct 2026 12:34:56 GMT";
  const FIXED_NONCE = "11111111-2222-3333-4444-555555555555";

  it("9 段结构：后两段恒为空 → 字符串以两个换行结尾", () => {
    const sts = cred.buildStringToSign("POST", cred.SEND_MSG_PATH, {
      bodyStr: "",
      date: FIXED_DATE,
      nonce: FIXED_NONCE,
    });
    const segments = sts.split("\n");
    assert.equal(segments.length, 9);
    assert.equal(sts.slice(-2), "\n\n", "去掉尾随换行即签名不匹配");
    assert.deepEqual(segments.slice(7), ["", ""]);
    assert.deepEqual(segments.slice(0, 7), [
      "POST",
      cred.SEND_MSG_PATH,
      "",
      "", // 空 body → Content-MD5 段是空串，**不是**空串的 md5
      "application/json",
      FIXED_DATE,
      FIXED_NONCE,
    ]);
    // golden：手工拼的 9 段（不复用被测函数），锁定字节布局
    const literal = [
      "POST",
      "/login/phone/sendMsgCode",
      "",
      "",
      "application/json",
      FIXED_DATE,
      FIXED_NONCE,
      "",
      "",
    ].join("\n");
    assert.equal(sts, literal);
  });

  it("golden 签名连同密钥一起锁定", () => {
    const literal = [
      "POST",
      "/login/phone/sendMsgCode",
      "",
      "",
      "application/json",
      FIXED_DATE,
      FIXED_NONCE,
      "",
      "",
    ].join("\n");
    assert.equal(cred.sign(literal), "BA+iVMKQscng2k9D1VK3gZYex/o=");
    const trimmed = createHmac("sha1", cred.ACCESS_KEY_SECRET)
      .update(literal.replace(/\n+$/, ""), "utf8")
      .digest("base64");
    assert.notEqual(trimmed, "BA+iVMKQscng2k9D1VK3gZYex/o=", "去掉尾随换行即签名不匹配");
  });

  it("Content-MD5：空 body 为空串；非空 body 是 base64(md5)", () => {
    assert.equal(cred.contentMd5(""), "");
    const body = '{"base":{"appid":"GM3LOOMY"},"param":{"a":1}}';
    assert.equal(cred.contentMd5(body), createHash("md5").update(body, "utf8").digest("base64"));
  });

  it("路径转义：补前导 /、剥末尾 /、逐段转义、空段保留、补转保留字", () => {
    assert.equal(cred.escapedPath("login/phone/checkCode"), "/login/phone/checkCode");
    assert.equal(cred.escapedPath("/a/b/"), "/a/b");
    assert.equal(cred.escapedPath("/"), "/");
    assert.equal(cred.escapedPath("/a//b"), "/a//b", "空段保留");
    assert.equal(cred.escapedPath("/a b/c!d"), "/a%20b/c%21d");
    assert.equal(cred.escape("!'()*"), "%21%27%28%29%2A");
  });

  it("查询串：不排序、两侧转义、null → 空串", () => {
    assert.equal(cred.escapedQuery([["b", "2"], ["a", "1"]]), "b=2&a=1");
    assert.equal(cred.escapedQuery({ q: "a b&c" }), "q=a%20b%26c");
    assert.equal(cred.escapedQuery([["k", null]]), "k=");
    assert.equal(cred.escapedQuery(null), "");
  });

  it("请求头：前缀是 account、Content-MD5 仅当 body 非空、Date 是 GMT、Nonce 是 uuid", () => {
    const noBody = cred.signHeaders("POST", cred.SEND_MSG_PATH);
    assert.ok(noBody["Authorization"]!.startsWith("account "), "认证头前缀不是 Bearer");
    assert.equal("Content-MD5" in noBody, false);

    const body = '{"a":1}';
    const withBody = cred.signHeaders("POST", cred.SEND_MSG_PATH, { bodyStr: body });
    assert.equal(withBody["Content-MD5"], cred.contentMd5(body));
    assert.ok(withBody["Date"]!.endsWith("GMT"));
    assert.equal(withBody["Nonce"]!.length, 36);
    assert.equal(withBody["Content-Type"], "application/json");
  });
});

// ── 3. 账号信封与「签名 = 发送的字节」──────────────────────────────────────────

describe("3. 通用请求体信封与签名一致性", () => {
  it("base 段是客户端身份（ua 硬编码、traceid 每次重新生成）", () => {
    const body = cred.accountBody({ phone: PHONE }) as {
      base: Record<string, unknown>;
      param: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(body).sort(), ["base", "param"]);
    assert.deepEqual(Object.keys(body.base).sort(), ["appid", "devid", "modelid", "traceid", "ua", "version"]);
    assert.equal(body.base["appid"], "GM3LOOMY");
    assert.equal(body.base["modelid"], "Web");
    assert.equal(body.base["version"], "1.0.0");
    assert.equal(body.base["devid"], "web");
    assert.equal(body.base["ua"], "Loomy|Desktop|Electron|macOS", "Windows 上也发这个值");
    assert.equal(String(body.base["traceid"]).length, 32);
    const other = cred.accountBody({}) as { base: Record<string, unknown> };
    assert.notEqual(other.base["traceid"], body.base["traceid"]);
  });

  it("发一次验证码：msgid 原样带回，服务端重算签名一致", async () => {
    st.accountRequests.length = 0;
    st.signatureOk = true;
    const msgid = await cred.sendSmsCode(PHONE);
    assert.equal(msgid, "msg-1");
    assert.equal(st.accountRequests.length, 1);
    const seen = st.accountRequests[0]!;
    assert.equal(seen.path, cred.SEND_MSG_PATH);
    assert.deepEqual(
      Object.keys((JSON.parse(seen.raw) as { param: Record<string, unknown> }).param).sort(),
      ["ccode", "expire", "phone"],
    );
    assert.equal(seen.headers["content-type"], "application/json");
    assert.equal(st.signatureOk, true, "签发的必须是发出去的字节（不能二次序列化）");
  });
});

// ── 4. 两套认证头 ─────────────────────────────────────────────────────────────

describe("4. 两套认证头（chat 两个都发 / 业务端点只发 token）", () => {
  it("chat 头与业务头的构成", async () => {
    const c = await saveFakeCredentials();
    const chat = upstream.buildHeaders(c);
    assert.equal(chat["Authorization"], `Bearer ${SESSION}`);
    assert.equal(chat["token"], SESSION);
    assert.equal(chat["Accept"], "text/event-stream");
    assert.equal(chat["Content-Type"], "application/json");

    const biz = upstream.buildHeaders(c, { chat: false });
    assert.equal(biz["token"], SESSION);
    assert.equal("Authorization" in biz, false, "业务端点**不**发 Authorization");
    assert.equal(biz["Accept"], "application/json");
  });

  it("交叉验证（实测结论）：带错的那个头 → 200 + 100002 缺少 token", async () => {
    const biz = await fetch(`${fakeBase()}/api/v1/models`, {
      headers: { Authorization: `Bearer ${SESSION}` },
    });
    const bizPayload = (await biz.json()) as { code: string; desc: string };
    assert.equal(bizPayload.code, "100002");
    assert.equal(bizPayload.desc, "缺少 token");

    const chat = await fetch(`${fakeBase()}/api/v1/chat/completions`, {
      method: "POST",
      headers: { token: SESSION, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(((await chat.json()) as { code: string }).code, "100002");
  });

  it("fetchPointsRecords 的真实请求只带 token", async () => {
    const c = await saveFakeCredentials();
    st.businessHeaders.length = 0;
    await upstream.fetchPointsRecords(c);
    const sent = st.businessHeaders.at(-1)!;
    assert.equal(sent.headers["authorization"], undefined);
    assert.equal(sent.headers["token"], SESSION);
  });
});

// ── 5. 业务码 ─────────────────────────────────────────────────────────────────

describe("5. 业务失败恒 HTTP 200：只能读 code", () => {
  it("code 非 000000 → 报错（不是静默成功），报错带 desc", async () => {
    const c = await saveFakeCredentials();
    st.modelsMode = "fail";
    await assert.rejects(() => upstream.fetchModels(c), (err: unknown) => {
      assert.match(String(err), /模型列表暂不可用/);
      return true;
    });
    st.modelsMode = "ok";
  });

  it("parseEnvelope：code 归一成字符串、desc 优先于 message、data 原样", () => {
    const env = upstream.parseEnvelope({
      code: "100001",
      desc: "来自 desc",
      message: "来自 message",
      data: { x: 1 },
    });
    assert.equal(env.code, "100001");
    assert.equal(env.desc, "来自 desc");
    assert.deepEqual(env.data, { x: 1 });
    assert.equal(upstream.isAuthError("100002"), true);
    assert.equal(upstream.isAuthError("100001"), false);
  });

  it("100002 → UpstreamUnauthorized（登录失效，不重试）", async () => {
    const c = await saveFakeCredentials();
    st.pointsMode = "auth";
    await assert.rejects(() => upstream.fetchPointsRecords(c), upstream.UpstreamUnauthorized);
    st.pointsMode = "ok";
    await assert.rejects(
      () => upstream.fetchModels(cred.EMPTY_CREDENTIALS),
      upstream.UpstreamUnauthorized,
    );
  });
});

// ── 6. 登录（短信 + 微信）─────────────────────────────────────────────────────

describe("6a. 短信登录", () => {
  it("verifySmsCode：session/phone/expires_at（毫秒字符串）/uid/domain", async () => {
    const c = await cred.verifySmsCode(PHONE, "123456", "msg-1");
    assert.equal(c.accessToken, SESSION);
    assert.equal(c.userid, USERID);
    assert.equal(c.phone, PHONE);
    assert.equal(c.expiresAt.length, 13, "expires_at 是毫秒时间戳字符串");
    assert.equal(cred.isExpired(c), false);
    assert.equal(c.uid, USERID, "uid 用 userid");
    assert.equal(c.domain, "", "无域概念");
  });

  it("login() 走环境变量输入，且登录后触发每日额度初始化", async () => {
    process.env[cred.PHONE_ENV] = PHONE;
    process.env[cred.SMS_CODE_ENV] = "654321";
    st.firstLoginCalls = 0;
    try {
      const c2 = await cred.login(fakeBase(), { onStatus: () => {} });
      assert.equal(cred.isExpired(c2), false);
    } finally {
      delete process.env[cred.PHONE_ENV];
      delete process.env[cred.SMS_CODE_ENV];
    }
    assert.equal(cred.load().accessToken, SESSION, "login 后已落盘");
    assert.equal(st.firstLoginCalls, 1, "两条登录路径都调 first-login");
  });

  it("缺环境变量时给出可读报错（无窗口工程没有输入框）", async () => {
    await assert.rejects(() => cred.login(fakeBase()), new RegExp(cred.PHONE_ENV));
  });
});

describe("6b. 微信扫码（405 = 已确认，404 = 已扫码待确认）", () => {
  it("uuid 提取（两条路径互为兜底）+ 字符集校验", () => {
    assert.equal(
      cred.extractWechatUuid('<html><img class="js_qrcode_img" src="/connect/qrcode/UUID_1-abc"/></html>'),
      "UUID_1-abc",
    );
    assert.equal(
      cred.extractWechatUuid('var fordevtool = "https://x/connect/l/qrconnect?uuid=UUID_2-xyz";'),
      "UUID_2-xyz",
    );
    assert.equal(cred.extractWechatUuid('src="/connect/qrcode/a b"'), "");
    assert.equal(cred.extractWechatUuid("<html></html>"), "");
  });

  it("授权页 URL：官方 appid + 官方 redirect_uri（白名单）+ #wechat_redirect", () => {
    const url = cred.wechatAuthorizeUrl("state-1");
    assert.ok(url.includes(`appid=${cred.WECHAT_APP_ID}`));
    assert.ok(url.includes("loomy.xunfei.cn%2Foauth%2Fwechat%2Fcallback"));
    assert.ok(url.endsWith("#wechat_redirect"));
  });

  it("二维码：JPEG/PNG/GIF 魔数都认，字节数 < 200 视为错误页", async () => {
    assert.equal(cred.looksLikeImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), true);
    assert.equal(cred.looksLikeImage(Buffer.from([0x89, 0x50, 0x4e, 0x47])), true);
    assert.equal(cred.looksLikeImage(Buffer.from("GIF89a")), true);
    assert.equal(cred.looksLikeImage(Buffer.from("<html>")), false);

    const bytes = await cred.fetchWechatQr("AbC-123_xyz789");
    assert.ok(bytes.length > 200);
    await assert.rejects(() => cred.fetchWechatQr("tiny"), /错误页/);
    await assert.rejects(() => cred.fetchWechatQr("html"), /不是图片/);
  });

  it("长轮询状态机：408/404/405/403/402/未知，网络异常降级为 error", async () => {
    const cases: Array<[number, string, string]> = [
      [408, "", "waiting"],
      [404, "", "scanned"],
      [405, "the-code", "confirmed"],
      [405, "", "scanned"], // 405 但没带 code → 保守继续轮询
      [403, "", "cancelled"],
      [402, "", "expired"],
      [400, "", "waiting"],
      [999, "", "waiting"],
    ];
    st.wechatQueries.length = 0;
    for (const [errcode, code, want] of cases) {
      st.wechatFrames = [`window.wx_errcode=${errcode};window.wx_code='${code}';`];
      const frame = await cred.wechatPollOnce("UUID_1-abc");
      assert.equal(frame.status, want, `errcode ${errcode}`);
      if (want === "confirmed") assert.equal(frame.code, "the-code", "405 帧里带回 wx_code");
    }
    const query = st.wechatQueries.at(-1)!;
    assert.equal(query["uuid"], "UUID_1-abc");
    assert.ok(/^\d+$/.test(query["_"] ?? ""), "长轮询带毫秒时间戳 _");

    const saved = process.env["LOOMY_WECHAT_LONG_POLL_URL"];
    process.env["LOOMY_WECHAT_LONG_POLL_URL"] = `${await deadBase()}/connect/l/qrconnect`;
    try {
      const frame = await cred.wechatPollOnce("UUID_1-abc");
      assert.equal(frame.status, "error", "网络异常返回 error 而**不抛错**");
    } finally {
      process.env["LOOMY_WECHAT_LONG_POLL_URL"] = saved;
    }
  });

  it("完整扫码 + 已绑手机号（bind=1 → skip）", async () => {
    st.wechatFrames = [
      "window.wx_errcode=408;window.wx_code='';",
      "window.wx_errcode=404;window.wx_code='';",
      "window.wx_errcode=405;window.wx_code='wx-code-1';",
    ];
    st.bindMode = 1;
    const urls: string[] = [];
    const statuses: string[] = [];
    const code = await cred.wechatWaitForCode({
      onUrl: (u) => urls.push(u),
      onStatus: (m) => statuses.push(m),
      timeoutSec: 5,
      pollIntervalSec: 0,
    });
    assert.equal(code, "wx-code-1");
    assert.ok(urls[0]!.includes("/connect/qrconnect?"), "onUrl 立刻回调授权页");
    assert.ok(statuses.some((s) => s.includes("已扫码")), "404 阶段报「已扫码」");

    st.firstLoginCalls = 0;
    st.wechatFrames = ["window.wx_errcode=405;window.wx_code='wx-code-1';"];
    const c = await cred.loginWechat(fakeBase(), { onStatus: () => {}, pollIntervalSec: 0 });
    assert.equal(c.accessToken, SESSION);
    assert.equal(cred.load().userid, USERID, "凭据已落盘");
    assert.equal(st.firstLoginCalls, 1, "微信登录也触发每日额度初始化");
    assert.equal(c.source, "loomy-wechat");
  });

  it("未绑手机号（bind=0 → sendMsg + checkCode）；bind 缺失归 0", async () => {
    st.bindMode = 0;
    st.wechatFrames = ["window.wx_errcode=405;window.wx_code='wx-code-2';"];
    process.env[cred.PHONE_ENV] = PHONE;
    process.env[cred.SMS_CODE_ENV] = "111111";
    try {
      const c = await cred.loginWechat(fakeBase(), { onStatus: () => {}, pollIntervalSec: 0 });
      assert.equal(c.accessToken, SESSION);
      assert.equal(c.source, "loomy-wechat-bind");
    } finally {
      delete process.env[cred.PHONE_ENV];
      delete process.env[cred.SMS_CODE_ENV];
    }

    const bind = await cred.bindAuthThirdAccount("wxcode", fakeBase());
    assert.equal(bind.bind, 0, "bind 缺失/非 1 时归 0（走绑定流程，保守方向）");
    await assert.rejects(() => cred.bindSkip("", fakeBase()), /rcode 缺失/);
  });
});

// ── 7. refresh = 有效性探测 ───────────────────────────────────────────────────

describe("7. refresh()：无续期端点 → 只做有效性探测", () => {
  it("已过期的凭据探测通过后更正本地有效期（不再显示已过期）", async () => {
    const expired = await saveFakeCredentials({ expiresAt: String(Date.now() - 86_400_000) });
    assert.equal(cred.isExpired(expired), true);
    const back = await cred.refresh(expired);
    assert.equal(cred.isExpired(back), false);
    assert.equal(cred.load().expiresAt, back.expiresAt, "对账后落盘");
    assert.equal(back.accessToken, SESSION, "session 不变");
  });

  it("仍有效时不改动时间戳", async () => {
    const fresh = await saveFakeCredentials();
    assert.equal((await cred.refresh(fresh)).expiresAt, fresh.expiresAt);
  });

  it("探测失败 → 抛错并说明没有续期端点（不假装续期成功）", async () => {
    await saveFakeCredentials();
    st.pointsMode = "auth";
    await assert.rejects(() => cred.refresh(cred.load()), (err: unknown) => {
      assert.match(String(err), /续期/);
      assert.match(String(err), /重新登录/);
      return true;
    });
    st.pointsMode = "ok";
  });

  it("load 补老凭据缺的 expires_at（obtained_at + 14 天），损坏/缺失抛 NotLoggedInError", async () => {
    const legacyPath = paths.credentialsPath();
    mkdirSync(paths.channelDir(), { recursive: true });
    writeFileSync(
      legacyPath,
      JSON.stringify({ access_token: SESSION, userid: USERID, obtained_at: "2026-10-01T00:00:00.000Z" }),
      "utf8",
    );
    const loaded = cred.load();
    assert.equal(
      loaded.expiresAt,
      String(Date.parse("2026-10-01T00:00:00.000Z") + cred.SESSION_TTL_SECONDS * 1000),
    );

    writeFileSync(legacyPath, "{}", "utf8");
    assert.throws(() => cred.load(), cred.NotLoggedInError);
    writeFileSync(legacyPath, "{not json", "utf8");
    assert.throws(() => cred.load(), cred.NotLoggedInError);
    rmSync(legacyPath, { force: true });
    assert.throws(() => cred.load(), cred.NotLoggedInError);
  });
});

// ── 8. 目录 ───────────────────────────────────────────────────────────────────

describe("8. 模型目录（倍率归一化 / type=chat 过滤 / 档位清洗）", () => {
  it("倍率三种括号风格 + 幂等 + 只认末尾 + 主体为空原样保留", () => {
    assert.deepEqual(catalog.splitRate("MiniMax M3 （x4.0）"), ["MiniMax M3", "x4.0"]);
    assert.deepEqual(catalog.splitRate("Qwen 3.8 Max (x12.0)"), ["Qwen 3.8 Max", "x12.0"]);
    assert.deepEqual(catalog.splitRate("GLM 5.3 Flash(x0.8)"), ["GLM 5.3 Flash", "x0.8"]);
    assert.equal(catalog.displayName("Qwen 3.8 Max (x12.0)"), "Qwen 3.8 Max · x12.0");
    assert.equal(
      catalog.displayName(catalog.displayName("Qwen 3.8 Max (x12.0)")),
      "Qwen 3.8 Max · x12.0",
      "幂等",
    );
    assert.equal(catalog.displayName("Qwen (turbo) Max"), "Qwen (turbo) Max", "中间的括号不动");
    assert.equal(catalog.displayName("Spark X"), "Spark X", "无倍率不加分隔符");
    assert.deepEqual(catalog.splitRate("（x4.0）"), ["（x4.0）", ""], "主体为空时原样保留");
  });

  it("远端目录：过滤非 chat、清洗档位、默认档用我们自己的 high", async () => {
    await saveFakeCredentials();
    catalog.clearCache();
    await catalog.refreshCatalog();
    const rows = catalog.details();
    assert.deepEqual(
      rows.map((r) => r["id"]),
      ["GLM-5.3-Flash", "MiniMax-M3", "no-name-model", "risky"],
      "只保留 type === 'chat'",
    );
    const byId = new Map(rows.map((r) => [r["id"] as string, r]));
    const glm = byId.get("GLM-5.3-Flash")!;
    assert.equal(glm["name"], "GLM 5.3 Flash · x0.8");
    assert.equal(glm["rate"], "x0.8");
    assert.equal(glm["context_window"], 800_000);
    assert.equal(glm["vision"], true, "图片能力来自 capabilities.input_modalities");
    assert.equal(glm["reasoning"], true, "思考能力必须严格 === true");
    assert.deepEqual(glm["efforts"], ["none", "low", "high"], "去重 + 丢脏数据");
    assert.equal(glm["default_effort"], "high", "默认档用本插件的 high（不采信远端的 low）");
    assert.equal(glm["remote_default_effort"], "low", "远端声明的默认档仅留作排查");
    assert.equal(byId.get("no-name-model")!["name"], "no-name-model", "无 name 时退回 id");
    assert.equal(byId.get("risky")!["reasoning"], false, "reasoning 是字符串 'yes' → 不算思考");
    assert.equal(byId.get("risky")!["vision"], false, "远端条目不声明图片能力");
    assert.equal(catalog.catalogVersion(), "v-1");
    // 模型池策略：远端 4 条 chat 模型里只有 GLM 家族进池子；上面的 rows 断言
    // 已覆盖完整底层目录（非白名单条目只是不暴露，数据没丢）
    const ids = catalog.exposedIds();
    assert.deepEqual(ids, ["GLM-5.3-Flash"], "白名单过滤后只有 GLM 进池子");
    assert.ok(ids.every((id) => /deepseek|glm/i.test(id)), "池子里只能有 DeepSeek/GLM");
    assert.ok(!ids.includes("MiniMax-M3") && !ids.includes("risky"), "非 DS/GLM 被白名单过滤");
    assert.equal(catalog.resolveModel("unknown-x"), "unknown-x");
    assert.equal(catalog.resolveModel("MiniMax-M3"), "MiniMax-M3");
  });

  it("只缓存真实远端目录（第二次调用不再打网络）", async () => {
    catalog.clearCache();
    await catalog.refreshCatalog();
    const before = st.modelsCalls;
    await catalog.refreshCatalog();
    catalog.details();
    assert.equal(st.modelsCalls - before, 0);
  });

  it("远端不可用 → 8 条兜底表（档位用兜底表，不声明图片能力）", async () => {
    const saved = upstream.loadConfig()[0];
    await upstream.saveConfig({ baseUrl: await deadBase() });
    catalog.clearCache();
    await catalog.refreshCatalog();
    try {
      const ids = catalog.exposedIds();
      assert.deepEqual(
        ids,
        ["deepseek-v4-flash-0731", "GLM-5.3-Flash"],
        "池策略 (deepseek|glm)×flash：8 条兜底里 2 条命中；qwen3.8-flash 是 flash 但非 deepseek/glm → 挡下",
      );
      assert.ok(ids.every((id) => /flash/i.test(id)), "池子里必须带 flash");
      assert.ok(ids.every((id) => /deepseek|glm/i.test(id)), "且必须属于 deepseek 或 glm 家族");
      // 过滤只发生在呈现层：兜底表整表 8 条仍在 details 里（下面 spark-x 的断言依赖它）
      const detailRows = catalog.details();
      assert.equal(detailRows.length, 8, "details 仍给出全部 8 条兜底");
      assert.ok(detailRows.some((r) => r["id"] === "spark-x"), "非白名单条目仍在底层表（数据没丢）");
      const spark = new Map(detailRows.map((r) => [r["id"] as string, r])).get("spark-x")!;
      assert.equal(spark["name"], "Spark X2.5 · x0.1", "兜底条目的倍率在 name 里");
      assert.equal(spark["vision"], false);
      assert.deepEqual(catalog.effortsFor("spark-x"), ["none", "low", "medium", "high", "xhigh"]);
      assert.equal(catalog.defaultEffortFor("spark-x"), "high");
      assert.deepEqual(catalog.effortsFor("nope"), [], "未知模型的档位为空");
    } finally {
      await upstream.saveConfig(saved);
      catalog.clearCache();
      await catalog.refreshCatalog();
    }
  });

  it("models.json 短名（可选覆盖）：排在最前、映射到上游 id、原 id 不重复暴露；非 DS/GLM 别名被策略过滤", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loomy-models-"));
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        models: [
          { slug: "GLM-5.3-Flash", alias: "glm-5.3-flash" },
          { slug: "spark-x", alias: "spark" },
        ],
      }),
      "utf8",
    );
    process.env["LOOMY_MODELS_FILE"] = join(dir, "models.json");
    try {
      catalog.clearCache();
      await catalog.refreshCatalog();
      const ids = catalog.exposedIds();
      assert.equal(ids[0], "glm-5.3-flash", "DS/GLM 别名排在最前");
      assert.equal(catalog.resolveModel("glm-5.3-flash"), "GLM-5.3-Flash");
      assert.equal(ids.includes("GLM-5.3-Flash"), false, "被别名覆盖的原始 id 不重复暴露");
      // 白名单同样作用于别名层：非 DS/GLM 别名不暴露，但映射仍可用（数据没丢）
      assert.equal(ids.includes("spark"), false);
      assert.equal(catalog.resolveModel("spark"), "spark-x");
    } finally {
      delete process.env["LOOMY_MODELS_FILE"];
      rmSync(dir, { recursive: true, force: true });
      catalog.clearCache();
      await catalog.refreshCatalog();
    }
  });
});

// ── 9. 请求体改写 ─────────────────────────────────────────────────────────────

describe("9. 请求体（system 先拼再放 / 档位校验不过静默不下发）", () => {
  it("档位在 efforts 内才下发；未知模型也不下发", async () => {
    await saveFakeCredentials();
    catalog.clearCache();
    await catalog.refreshCatalog();

    const req: Record<string, unknown> = {
      model: "GLM-5.3-Flash",
      messages: [
        { role: "user", content: "你好" },
        { role: "system", content: "你是助手" },
      ],
      temperature: 0.3,
      max_tokens: 4096,
      reasoning_effort: "high",
      tools: [{ type: "function", function: { name: "bash", parameters: {} } }],
    };
    const body = upstream.buildChatBody(req, "GLM-5.3-Flash");
    assert.equal(body["model"], "GLM-5.3-Flash");
    assert.equal(body["stream"], true);
    assert.deepEqual(body["messages"], [
      { role: "system", content: "你是助手" },
      { role: "user", content: "你好" },
    ], "system 先拼再放进 messages[0]");
    assert.equal(body["reasoning_effort"], "high", "valid 档位下发");
    assert.equal(body["max_tokens"], 4096);
    assert.equal(body["temperature"], 0.3);
    assert.equal(Array.isArray(body["tools"]), true, "tools 必须在顶层");

    const bad = upstream.buildChatBody({ ...req, reasoning_effort: "banana" }, "GLM-5.3-Flash");
    assert.equal("reasoning_effort" in bad, false, "远端不认的档位静默不下发");
    const unknown = upstream.buildChatBody({ ...req, reasoning_effort: "high" }, "no-such-model");
    assert.equal("reasoning_effort" in unknown, false, "档位未知（模型未知）也不下发");

    const minimal = upstream.buildChatBody({ messages: [{ role: "user", content: "hi" }] }, "spark-x");
    assert.deepEqual(Object.keys(minimal).sort(), ["messages", "model", "stream"]);
  });
});

// ── 10. 额度 ──────────────────────────────────────────────────────────────────

describe("10. 额度（两个积分池 / 直领 / 100002 立即终止）", () => {
  it("只读端点参数、两个积分池、可领任务", async () => {
    await saveFakeCredentials();
    st.pointsMode = "ok";
    st.tasksMode = "ok";
    st.completeMode = "ok";
    const info = await billing.fetchCredits();
    assert.deepEqual(st.pointsQuery, { pageNo: "1", pageSize: "1", recordType: "all" });
    assert.equal(info.total.remain, 19992, "总量用 availableBalance");
    assert.equal(info.total.unit, "积分");
    assert.equal(info.total.daily_quota_known, false, "未签到时 dailyQuota 未知（不硬编码 5000）");
    assert.deepEqual(info.packages.map((p) => p.name), ["永久积分", "每日赠送"]);
    assert.equal(info.packages[0]!.remain, 15000);
    assert.equal(info.packages[1]!.remain, 4992);
    assert.equal(info.packages[1]!.days_left, null, "每日池不编造到期天数");
    assert.equal(info.claimable.length, 6, "可领任务 = 未完成的 6 个（前两个已完成）");
    assert.equal(
      info.claimable.reduce((sum, c) => sum + Number(c["amount"]), 0),
      8500,
      "可领合计 10000 - 1500 = 8500",
    );
    assert.equal(info.claimable[0]!["campaign_id"], "generate_ppt");
    assert.ok(String(info.claimable[0]!["label"]).includes("PPT"), "claimable 带中文标题");
  });

  it("拿到 dailyQuota 时算真实 size/used", async () => {
    await saveFakeCredentials();
    st.pointsMode = "with_quota";
    const info = await billing.fetchCredits();
    assert.equal(info.total.size, 20000, "总量 = 永久 + 配额");
    assert.equal(info.total.used, 8, "used = size - available");
    assert.equal(info.total.daily_quota_known, true);
    st.pointsMode = "ok";
  });

  it("失败路径：缺 balance → CreditsError；100002 → NotLoggedInError；未登录 → NotLoggedInError", async () => {
    await saveFakeCredentials();
    st.pointsMode = "no_balance";
    await assert.rejects(() => billing.fetchCredits(), billing.CreditsError);
    st.pointsMode = "auth";
    await assert.rejects(() => billing.fetchCredits(), cred.NotLoggedInError);
    st.pointsMode = "ok";

    rmSync(paths.credentialsPath(), { force: true });
    await assert.rejects(() => billing.fetchCredits(), cred.NotLoggedInError);
  });

  it("任务列表挂了不影响余额（claimable 空表）", async () => {
    await saveFakeCredentials();
    st.tasksMode = "fail";
    const info = await billing.fetchCredits();
    assert.deepEqual(info.claimable, []);
    assert.equal(info.total.remain, 19992);
    st.tasksMode = "ok";
  });

  it("直领：body 只有 key；未知 key → CreditsError", async () => {
    await saveFakeCredentials();
    st.completeKeys.length = 0;
    const result = await billing.claim("first_message");
    assert.equal(result.status, "completed");
    assert.equal(result.amount, 500);
    assert.equal(st.completeKeys.at(-1), "first_message");

    st.completeMode = "unknown_key";
    await assert.rejects(() => billing.claim("nope"), billing.CreditsError);
    st.completeMode = "ok";
  });

  it("每日额度初始化：alreadyProcessed → already-claimed；失败不抛错", async () => {
    await saveFakeCredentials();
    st.firstLoginMode = "already";
    const out = await billing.triggerDailyQuota();
    assert.equal(out.status, "already-claimed");
    assert.equal(out.daily_quota, 5000, "dailyQuota 从 first-login 拿");

    st.firstLoginMode = "fail";
    const failed = await billing.triggerDailyQuota();
    assert.equal(failed.status, "failed");
    assert.ok(failed.error);
    st.firstLoginMode = "ok";
  });

  it("claimAll：已完成跳过不发请求、本地算 earned、100002 立即终止", async () => {
    await saveFakeCredentials();
    st.completeKeys.length = 0;
    const result = await billing.claimAll();
    assert.equal(st.completeKeys[0], "generate_ppt", "first_message / pick_skill 不发请求");
    assert.equal(result.earned, 8500);
    assert.equal(result.results.length, 8);
    assert.deepEqual(result.results.slice(0, 2).map((r) => r.status), ["skipped", "skipped"]);

    st.completeKeys.length = 0;
    st.completeMode = "auth_on_ppt";
    await assert.rejects(() => billing.claimAll(), cred.NotLoggedInError);
    assert.deepEqual(st.completeKeys, ["generate_ppt"], "后续任务不再发请求");
    st.completeMode = "ok";
  });
});

// ── 11. 端到端网关 ────────────────────────────────────────────────────────────

describe("11. 端到端网关（假上游 + 真实网关）", () => {
  let gw: gateway.RunningGateway;

  before(async () => {
    await saveFakeCredentials();
    await upstream.saveConfig({ baseUrl: fakeBase() });
    catalog.clearCache();
    await catalog.refreshCatalog();
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
  });

  it("/v1/models 来自远端目录；/health 报告已登录", async () => {
    const payload = (await (await fetch(`http://${gw.addr}/v1/models`)).json()) as {
      data: Array<{ id: string }>;
    };
    assert.ok(payload.data.some((m) => m.id === "glm-5.3-flash"), "对外 id 恒小写");

    const health = (await (await fetch(`http://${gw.addr}/health`)).json()) as Record<string, unknown>;
    assert.equal(health["ok"], true);
    assert.equal(health["logged_in"], true);
  });

  it("流式：正文 + delta.reasoning_content + 上游两套认证头", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "GLM-5.3-Flash",
        messages: [
          { role: "system", content: "身份" },
          { role: "user", content: "hi" },
        ],
        reasoning_effort: "high",
        stream: true,
      }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 200);
    const text = await resp.text();
    let content = "";
    let reasoning = "";
    const finishes: string[] = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const item = line.slice(5).trim();
      if (!item || item === "[DONE]") continue;
      const chunk = JSON.parse(item) as {
        choices?: Array<{ delta?: Record<string, string>; finish_reason?: string | null }>;
      };
      for (const choice of chunk.choices ?? []) {
        if (choice.delta?.["content"]) content += choice.delta["content"];
        if (choice.delta?.["reasoning_content"]) reasoning += choice.delta["reasoning_content"];
        if (choice.finish_reason) finishes.push(choice.finish_reason);
      }
    }
    assert.equal(content, "你好世界");
    assert.equal(reasoning, "想想");
    assert.deepEqual(finishes, ["stop"]);

    assert.equal(st.chatHeaders["authorization"], `Bearer ${SESSION}`, "chat 端点只认 Bearer");
    assert.equal(st.chatHeaders["token"], SESSION, "官方客户端两个都发");
    assert.equal(st.chatBody?.["model"], "GLM-5.3-Flash");
    assert.equal(st.chatBody?.["stream"], true);
    assert.equal(st.chatBody?.["reasoning_effort"], "high");
    const messages = st.chatBody?.["messages"] as Array<{ role: string }>;
    assert.equal(messages[0]!.role, "system", "system 被提升为首条");
  });

  it("非流式：本层聚合成 chat.completion", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "GLM-5.3-Flash",
        messages: [{ role: "user", content: "hi" }],
      }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 200);
    const payload = (await resp.json()) as {
      object: string;
      choices: Array<{ message: { content: string } }>;
      usage: { completion_tokens: number };
    };
    assert.equal(payload.object, "chat.completion");
    assert.equal(payload.choices[0]!.message.content, "你好世界");
    assert.equal(payload.usage.completion_tokens, 3);
  });

  it("请求校验 400 / 未知路径 404", async () => {
    const bad = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "x" }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: { code: string } }).error.code, "invalid_request");
    const nope = await fetch(`http://${gw.addr}/nope`);
    assert.equal(nope.status, 404);
  });
});

// ── 12. 上游错误处理 ──────────────────────────────────────────────────────────

describe("12. 上游错误处理", () => {
  it("上游 500 转成 502 upstream_error（不回传上游原文）", async () => {
    const failing = createServer((req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("internal detail leak");
    });
    const port = await new Promise<number>((resolve) => {
      failing.listen(0, "127.0.0.1", () => resolve((failing.address() as { port: number }).port));
    });
    const saved = upstream.loadConfig()[0];
    await upstream.saveConfig({ baseUrl: `http://127.0.0.1:${port}` });
    const gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
    try {
      const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({
          model: "GLM-5.3-Flash",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(resp.status, 502);
      const payload = (await resp.json()) as { error: { code: string; message: string } };
      assert.equal(payload.error.code, "upstream_error");
      assert.ok(!payload.error.message.includes("internal detail leak"));
    } finally {
      await gw.close();
      await new Promise<void>((r) => failing.close(() => r()));
      await upstream.saveConfig(saved);
    }
  });
});
