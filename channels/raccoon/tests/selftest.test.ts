/**
 * raccoon-bridge 自检（**完全离线**，不出网、不需要真实凭据）。
 *
 * 覆盖协议的关键结论：
 *  1. 手机号 **AES-128-CFB** 加密（密钥 16 字节 ⇒ aes-128-cfb；输出 base64(iv‖密文)）
 *  2. 凭据：**JWT `exp` 回退**（只读 `expires_at` 会让过期判定恒为 false）、
 *     `expires_at` 优先、老凭据补 `device_id` 并写回、损坏容忍
 *  3. 扫码登录流（**code 本地生成**）：`logging` 不中断、`canceled` 换新码、
 *     异常降级 `pending`、缺 token 的 `success` 视为未完成
 *  4. 续期：只回 access_token 时**保留旧 refresh_token**；200003 / 401 是终态
 *  5. 请求体：`extra_body.thinking` 是**唯一**思考通道（`reasoning_effort` 被接受但无效）、
 *     `max_tokens` 安全整数、`tools` 在顶层
 *  6. 请求头：对话 / 目录 / 领取三种形态（platform 的有无是硬约束）
 *  7. 模型目录：兜底表、**tags 不是图片能力契约**（白名单覆盖）、**1 倍也要显示倍率**、
 *     远端 `name` 才是模型 id
 *  8. 额度：余额只读（**从不触碰写端点**）、缺 `available_points` 不显示成 0、
 *     登录奖励幂等（`granted`）、**没有每日签到端点**
 *  9. 端到端网关（假上游 + 真实网关）：流式/非流式、思考通道、错误路径
 *
 * 数据目录用 RACCOON_HOME 指向临时目录，绝不碰真实凭据。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const HOME = mkdtempSync(join(tmpdir(), "raccoon-selftest-"));
process.env["MODEL_BRIDGE_HOME"] = HOME;

const PHONE = "13800138000";

function b64url(raw: Buffer): string {
  return raw.toString("base64url");
}

/** 造一个仅供本地解码的 JWT（`exp` 用秒，与服务端一致）。 */
function fakeJwt(exp?: number, claims: Record<string, unknown> = {}): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload: Record<string, unknown> = { ...claims };
  if (exp !== undefined) payload["exp"] = exp;
  return `${header}.${b64url(Buffer.from(JSON.stringify(payload)))}.signature`;
}

interface FakeState {
  qrCalls: number;
  refreshCalls: number;
  grantCalls: number;
  grantMode: string;
  chatHeaders: Record<string, string | string[] | undefined>;
  chatBody: Record<string, unknown> | null;
  sentModels: number;
  balanceMode: string;
  billsWithReward: boolean;
  smsSent: Array<Record<string, unknown>>;
  smsCalls: number;
  grantHeaders: Record<string, string | string[] | undefined>;
}

const st: FakeState = {
  qrCalls: 0,
  refreshCalls: 0,
  grantCalls: 0,
  grantMode: "sequence",
  chatHeaders: {},
  chatBody: null,
  sentModels: 0,
  balanceMode: "ok",
  billsWithReward: false,
  smsSent: [],
  smsCalls: 0,
  grantHeaders: {},
};

let fakePort = 0;
function fakeBase(): string {
  return `http://127.0.0.1:${fakePort}`;
}

function json(res: import("node:http").ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

// 被测模块
// 共享层来自工作区包；先注册本渠道（副作用）再引渠道模块
const { paths, sseStream: sse, gateway } = await import("@model-bridge/gateway");
await import("../dist/channel.js");
const cred = await import("../dist/cred.js");
const upstream = await import("../dist/upstream.js");
const catalog = await import("../dist/catalog.js");
const billing = await import("../dist/billing.js");

function handleFake(req: IncomingMessage, res: import("node:http").ServerResponse): void {
  let raw = "";
  req.on("data", (c) => {
    raw += String(c);
  });
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const futureExp = Math.floor(Date.now() / 1000) + 3600;

    if (path === cred.QR_LOGIN_PATH) {
      st.qrCalls += 1;
      const call = st.qrCalls;
      if (call === 1) {
        json(res, 200, { code: 0, data: { status: "logging", expired_at: 1_700_000_000 } });
        return;
      }
      if (call === 2) {
        json(res, 200, { code: 0, data: { status: "canceled" } });
        return;
      }
      if (call === 3) {
        // 偶发失败必须降级为 pending，不能中断整个登录流程
        json(res, 500, { code: 0, message: "boom" });
        return;
      }
      if (call === 4) {
        // 缺 token 的 success 视为未完成
        json(res, 200, { code: 0, data: { status: "success" } });
        return;
      }
      json(res, 200, {
        code: 0,
        data: {
          status: "success",
          access_token: fakeJwt(futureExp, { sub: "u-1" }),
          refresh_token: "rt-1",
          office_identity: "personal",
        },
      });
      return;
    }
    if (path === cred.REFRESH_PATH) {
      st.refreshCalls += 1;
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      if (body["refresh_token"] === "rt-expired") {
        json(res, 200, { code: 200003, message: "登录态已过期" });
        return;
      }
      if (body["refresh_token"] === "rt-unauthorized") {
        json(res, 401, { code: 200003 });
        return;
      }
      // ⚠ 只回新 access_token，不回 refresh_token → 必须保留旧值
      json(res, 200, { code: 0, data: { access_token: fakeJwt(futureExp + 5, { sub: "u-1" }) } });
      return;
    }
    if (path === cred.USER_INFO_PATH) {
      json(res, 200, { code: 0, data: { id: 42, name: "RaccoonAva", phone: PHONE } });
      return;
    }
    if (path === cred.SEND_SMS_PATH) {
      st.smsCalls += 1;
      st.smsSent.push(JSON.parse(raw || "{}") as Record<string, unknown>);
      json(res, 200, { code: 0, data: {} });
      return;
    }
    if (path === upstream.MODEL_CATALOG_PATH) {
      st.sentModels += 1;
      json(res, 200, {
        code: 0,
        data: {
          categories: [
            { type: "image", models: [{ name: "ignored" }] },
            {
              type: "chat",
              models: [
                {
                  id: "wrong-key",
                  name: "sn-glm-5-3",
                  description: "GLM-5-3",
                  billing_multiplier: 0.75,
                  billing_effective_multiplier: 0.75,
                  billing_status: "limited_free",
                  params: { context_window: 1_000_000, max_tokens: 100_000 },
                  tags: ["general"],
                },
                {
                  id: "wrong-key",
                  name: "sn-glm-5-3-flash",
                  description: "GLM-5-3-Flash",
                  billing_multiplier: 0.2,
                  billing_effective_multiplier: 0.1,
                  billing_status: "discount",
                  params: { context_window: 1_000_000, max_tokens: 100_000 },
                  tags: ["general"],
                },
                { name: "sn-glm-5-3-hidden", visible: false },
                { name: "Raccoon-Auto", description: "自动选模" },
              ],
            },
          ],
        },
      });
      return;
    }
    if (path === "/api/web/llm/v2/chat/completions") {
      st.chatHeaders = { ...req.headers };
      st.chatBody = JSON.parse(raw || "{}") as Record<string, unknown>;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "sn-glm-5-3", choices: [{ index: 0, delta: { content: "网关" }, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "sn-glm-5-3", choices: [{ index: 0, delta: { content: "通了" }, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    if (path === "/api/web/points/v1/balance") {
      if (st.balanceMode === "bad") {
        json(res, 200, { code: 0, data: { reward_points: 10 } });
        return;
      }
      if (st.balanceMode === "unauthorized") {
        json(res, 401, { code: 200003 });
        return;
      }
      json(res, 200, {
        code: 0,
        data: {
          available_points: 3300,
          reward_points: 3000,
          daily_points: 300,
          monthly_points: 0,
          topup_points: 0,
        },
      });
      return;
    }
    if (path === "/api/web/points/v1/bills") {
      const items = st.billsWithReward
        ? [{ biz_type: "reward_grant", event_name: "桌面端登录奖励", points: 3000 }]
        : // 「新人注册礼包」也是 reward_grant → 不能只看 biz_type
          [{ biz_type: "reward_grant", event_name: "新人注册礼包", points: 3000 }];
      items.push({ biz_type: "daily_grant", event_name: "每日积分", points: 300 });
      json(res, 200, { code: 0, data: { items } });
      return;
    }
    if (path === "/api/web/desktop/v1/login/points/grant") {
      st.grantCalls += 1;
      st.grantHeaders = { ...req.headers };
      if (st.grantMode === "sequence") {
        if (st.grantCalls === 1) {
          json(res, 200, { code: 0, data: { granted: true, popup: { points: 3000 } } });
          return;
        }
        if (st.grantCalls === 2) {
          json(res, 200, { code: 0, data: { granted: false } });
          return;
        }
      }
      json(res, 200, { code: 500, message: "服务端故障" });
      return;
    }
    json(res, 404, { code: 200004, message: `未知路径 ${path}` });
  });
}

const fakeServer: Server = createServer(handleFake);
await new Promise<void>((resolve) => {
  fakeServer.listen(0, "127.0.0.1", () => {
    fakePort = (fakeServer.address() as { port: number }).port;
    resolve();
  });
});

process.env["RACCOON_API_BASE_URL"] = fakeBase();
await upstream.saveConfig({ baseUrl: fakeBase() });

/** 写一份假凭据。 */
async function saveFakeCreds(overrides: Partial<cred.Credentials> = {}): Promise<cred.Credentials> {
  const c: cred.Credentials = {
    ...cred.EMPTY_CREDENTIALS,
    accessToken: fakeJwt(Math.floor(Date.now() / 1000) + 3600, { sub: "u-1" }),
    refreshToken: "rt-1",
    officeIdentity: "",
    userId: "u-1",
    uid: "u-1",
    nickname: "RaccoonAva",
    phone: PHONE,
    deviceId: "d".repeat(32),
    ...overrides,
  };
  await cred.save(c);
  return cred.load();
}

after(() => {
  fakeServer.close();
  rmSync(HOME, { recursive: true, force: true });
});

// ── 1. 路径 ───────────────────────────────────────────────────────────────────

describe("1. 路径", () => {
  it("数据目录名固定，受 MODEL_BRIDGE_HOME 覆盖，渠道层是 <root>/raccoon", () => {
    assert.equal(paths.rootDir(), HOME);
    assert.equal(paths.channelDir(), join(HOME, "raccoon"));
    assert.ok(paths.credentialsPath().endsWith("credentials.json"));
  });

  it("旧目录存在时整目录迁移", () => {
    const alt = mkdtempSync(join(tmpdir(), "raccoon-legacy-"));
    mkdirSync(join(alt, ".raccoon-gateway"), { recursive: true });
    writeFileSync(join(alt, ".raccoon-gateway", "credentials.json"), '{"access_token":"legacy"}', "utf8");
    const saved = process.env["MODEL_BRIDGE_HOME"];
    process.env["MODEL_BRIDGE_HOME"] = alt;
    try {
      assert.equal(paths.channelDir(), join(alt, "raccoon"));
      assert.ok(readFileSync(paths.credentialsPath(), "utf8").includes("legacy"));
    } finally {
      process.env["MODEL_BRIDGE_HOME"] = saved;
      rmSync(alt, { recursive: true, force: true });
    }
  });
});

// ── 2. 手机号 AES-128-CFB ─────────────────────────────────────────────────────

describe("2. 手机号 AES-128-CFB（协议 §2.3）", () => {
  it("密钥 16 字节 ⇒ AES-128；密文可解回原文；IV 每次随机", () => {
    assert.equal(cred.PHONE_CIPHER_SECRET.length, 16, "密钥长度 16（写成 aes-256 会抛错）");
    assert.equal(cred.PHONE_CIPHER_SECRET.toString("utf8"), "senseraccoon2023");

    const blob1 = cred.encryptPhone(PHONE);
    const blob2 = cred.encryptPhone(PHONE);
    assert.equal(cred.decryptPhone(blob1), PHONE, "解密回原文");
    assert.notEqual(blob1, blob2, "IV 每次随机（同一明文两次密文不同）");
    assert.equal(Buffer.from(blob1, "base64").length, 16 + PHONE.length, "输出 = 16 字节 IV + 明文长度");
  });

  it("手机号校验", () => {
    assert.equal(cred.isValidPhone("13800138000"), true);
    assert.equal(cred.isValidPhone("19912345678"), true);
    assert.equal(cred.isValidPhone("12800138000"), false);
    assert.equal(cred.isValidPhone("1380013800"), false);
    assert.equal(cred.isValidPhone("138001380001"), false);
    assert.equal(cred.isValidPhone(""), false);
  });

  it("send_sms：手机号是密文、captcha_param 必需", async () => {
    st.smsSent.length = 0;
    await cred.sendSms(PHONE, "captcha-token", fakeBase());
    const body = st.smsSent.at(-1)!;
    assert.equal(body["nation_code"], "86");
    assert.equal(body["captcha_param"], "captcha-token");
    const encrypted = String(body["phone"]);
    assert.notEqual(encrypted, PHONE, "明文手机号不得出现在请求体里");
    assert.equal(cred.decryptPhone(encrypted), PHONE, "服务端能解出明文");
    await assert.rejects(() => cred.sendSms("123", "", fakeBase()), /phone number/i);
  });
});

// ── 3. 凭据 ───────────────────────────────────────────────────────────────────

describe("3. 凭据：过期判定与落盘", () => {
  it("expires_at 缺失 → 回退 JWT exp；坏 token / 非数字 exp → null（不编造）", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const c: cred.Credentials = { ...cred.EMPTY_CREDENTIALS, accessToken: fakeJwt(future) };
    assert.equal(cred.expiresAtMs(c), future * 1000);
    assert.equal(cred.isExpired(c), false);
    assert.equal(
      cred.expiresAtMs({ ...cred.EMPTY_CREDENTIALS, accessToken: "a.b.c" }),
      null,
      "无 exp 的 JWT → 不编造",
    );
    assert.equal(cred.expiresAtMs({ ...cred.EMPTY_CREDENTIALS, accessToken: "!!!.???" }), null);
    assert.equal(cred.expiresAtMs({ ...cred.EMPTY_CREDENTIALS, accessToken: fakeJwt(undefined, { exp: "soon" }) }), null);
    assert.equal(
      cred.isExpired({ ...cred.EMPTY_CREDENTIALS, accessToken: fakeJwt(Math.floor(Date.now() / 1000) - 10) }),
      true,
    );
  });

  it("显式 expires_at 优先于 JWT exp", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const c: cred.Credentials = {
      ...cred.EMPTY_CREDENTIALS,
      accessToken: fakeJwt(future),
      expiresAt: String((future + 10_000) * 1000),
    };
    assert.equal(cred.expiresAtMs(c), (future + 10_000) * 1000);
  });

  it("uid 优先 user_id（而不是自动生成的 nickname）", () => {
    const account: cred.Credentials = {
      ...cred.EMPTY_CREDENTIALS,
      accessToken: "t",
      nickname: "RaccoonAva",
      phone: PHONE,
      userId: "u-9",
      uid: "u-9",
    };
    assert.equal(account.uid, "u-9");
    const byPhone: cred.Credentials = {
      ...cred.EMPTY_CREDENTIALS,
      accessToken: "t",
      uid: PHONE,
    };
    assert.equal(byPhone.uid, PHONE, "uid 回退 phone（而非自动生成的 nickname）");
    assert.equal(account.domain, "", "domain 恒空（端点固定）");
  });

  it("落盘 / 读回 / 无临时文件残留 / camelCase 兼容", async () => {
    const account: cred.Credentials = {
      ...cred.EMPTY_CREDENTIALS,
      accessToken: "t",
      refreshToken: "r",
      nickname: "RaccoonAva",
      phone: PHONE,
      deviceId: "d".repeat(32),
      officeIdentity: "personal",
    };
    await cred.save(account);
    const loaded = cred.load();
    assert.equal(loaded.accessToken, "t");
    assert.equal(loaded.refreshToken, "r");
    assert.equal(loaded.phone, PHONE);
    assert.equal(loaded.nickname, "RaccoonAva");
    assert.equal(loaded.officeIdentity, "personal");
    assert.equal(loaded.deviceId, "d".repeat(32));
    assert.throws(() => readFileSync(`${paths.credentialsPath()}.tmp`), "不留临时文件");
  });

  it("老凭据缺 device_id → 补 32 位 hex 并写回磁盘", () => {
    writeFileSync(paths.credentialsPath(), JSON.stringify({ access_token: "old" }), "utf8");
    const old = cred.load();
    assert.equal(old.deviceId.length, 32);
    const onDisk = JSON.parse(readFileSync(paths.credentialsPath(), "utf8")) as Record<string, unknown>;
    assert.equal(onDisk["device_id"], old.deviceId, "补的 device_id 已写回磁盘");
  });

  it("损坏 / 缺 access_token / 缺失 → NotLoggedInError", () => {
    writeFileSync(paths.credentialsPath(), "{not json", "utf8");
    assert.throws(() => cred.load(), (err: unknown) => {
      assert.ok(err instanceof cred.NotLoggedInError);
      assert.match(String(err), /corrupted/i, "损坏提示可读");
      return true;
    });
    writeFileSync(paths.credentialsPath(), JSON.stringify({ refresh_token: "r" }), "utf8");
    assert.throws(() => cred.load(), cred.NotLoggedInError);
    rmSync(paths.credentialsPath(), { force: true });
    assert.throws(() => cred.load(), cred.NotLoggedInError);
  });

  it("resolveBaseUrl 恒为唯一域（或 RACCOON_API_BASE_URL 覆盖）", () => {
    assert.equal(cred.resolveBaseUrl("cn"), fakeBase());
  });
});

// ── 4. 扫码登录 ───────────────────────────────────────────────────────────────

describe("4. 扫码登录（code 本地生成 / canceled 换码 / 异常降级）", () => {
  it("轮询到 success，落盘 uid/office_identity/expires_at，login 页 URL 本地生成", async () => {
    st.qrCalls = 0;
    const seenUrls: string[] = [];
    const statuses: string[] = [];
    const c = await cred.login(fakeBase(), {
      onUrl: (u) => seenUrls.push(u),
      onStatus: (m) => statuses.push(m),
      sleep: async () => {},
      pollIntervalMs: 0,
      timeoutMs: 5000,
    });
    assert.equal(st.qrCalls, 5, "含 1 次 500 重试与 1 次空 token");
    // 只比 payload，不比整个 JWT 串：假上游签发用的 now 与这里重算的 now 可能跨过 1 秒边界
    // （曾因此偶发失败）。exp 允许 ±1s 误差。
    const payload = JSON.parse(
      Buffer.from(c.accessToken.split(".")[1]!, "base64url").toString("utf8"),
    ) as { sub: string; exp: number };
    assert.equal(payload.sub, "u-1");
    assert.ok(
      Math.abs(payload.exp - (Math.floor(Date.now() / 1000) + 3600)) <= 1,
      `exp 应为签发时刻 +3600s，实际 ${payload.exp}`,
    );
    assert.equal(c.refreshToken, "rt-1");
    assert.equal(c.officeIdentity, "personal");
    assert.equal(c.uid, "u-1", "uid 取 user_id（而非自动 nickname）");
    assert.ok(Number(c.expiresAt) > Date.now(), "expires_at 由 JWT 推算（毫秒时间戳，未来时刻）");
    assert.equal(cred.load().accessToken, c.accessToken, "从磁盘可读回");
    const first = seenUrls[0]!;
    const code = first.split("code=")[1]!.split("&")[0]!;
    assert.equal(code.length, 32, "本地 code 是 32 位 hex");
    assert.ok(first.startsWith("https://xiaohuanxiong.com/login/mp?code="));
    assert.ok(first.includes("appname=%E5%95%86%E6%B1%A4%E5%B0%8F%E6%B5%A3%E7%86%8A%E5%AE%98%E7%BD%91"));
    assert.equal(new Set(seenUrls).size >= 2, true, "canceled 后换了新 code");
    assert.ok(statuses.some((s) => s.includes("scanned")), "logging 阶段有进度输出");
  });
});

// ── 5. 续期 ───────────────────────────────────────────────────────────────────

describe("5. 续期", () => {
  it("只回新 access_token 时保留旧 refresh_token 与附加字段", async () => {
    const c = await saveFakeCreds();
    const fresh = await cred.refresh(c, fakeBase());
    assert.equal(fresh.accessToken, fakeJwt(Math.floor(Date.now() / 1000) + 3605, { sub: "u-1" }));
    assert.equal(fresh.refreshToken, "rt-1", "服务端未回 refresh_token → 保留旧值");
    assert.equal(fresh.officeIdentity, c.officeIdentity, "附加字段保留");
    assert.equal(fresh.deviceId, c.deviceId, "下载取得的 machine id 不丢");
    assert.equal(cred.load().accessToken, fresh.accessToken, "续期后已落盘");
    assert.notEqual(fresh.expiresAt, c.expiresAt, "expires_at 已更新");
  });

  it("业务码 200003 / HTTP 401 → 终态并提示重新登录", async () => {
    for (const token of ["rt-expired", "rt-unauthorized"]) {
      const c = await saveFakeCreds({ refreshToken: token });
      await assert.rejects(() => cred.refresh(c, fakeBase()), (err: unknown) => {
        assert.match(String(err), /log in again/);
        return true;
      });
    }
    await assert.rejects(
      () => cred.refresh({ ...cred.EMPTY_CREDENTIALS, accessToken: "a", refreshToken: "" }, fakeBase()),
      /refresh_token/,
    );
  });
});

// ── 6. 用户信息 ───────────────────────────────────────────────────────────────

describe("6. 用户信息（只用于展示，失败返回空对象）", () => {
  it("fetchUserInfo 取 name；syncProfile 幂等且不覆盖已有昵称", async () => {
    const c = await saveFakeCreds();
    const info = await cred.fetchUserInfo(c, fakeBase());
    assert.equal(info["name"], "RaccoonAva", "服务端 name 是自动生成的默认名");

    const partial = await saveFakeCreds({ nickname: "我", phone: "" });
    const synced = await cred.syncProfile(partial, fakeBase());
    assert.equal(synced.nickname, "我", "不覆盖已有 nickname");
    assert.equal(synced.phone, PHONE, "补出 phone");
    assert.equal(synced.userId, "u-1");

    // 已有 phone → 幂等：不再请求（fake 的 user_info 会回 name，若请求了 userId 会被补上）
    const idempotent = await cred.syncProfile(
      { ...cred.EMPTY_CREDENTIALS, accessToken: "t", nickname: "我", phone: PHONE },
      fakeBase(),
    );
    assert.equal(idempotent.userId, "");
  });
});

// ── 7. 请求体 ─────────────────────────────────────────────────────────────────

describe("7. 请求体：思考通道改写与安全化", () => {
  const baseReq: Record<string, unknown> = {
    model: "sn-glm-5-3",
    messages: [
      { role: "system", content: "你是助手" },
      { role: "user", content: "你好" },
    ],
    max_tokens: 4096,
    temperature: 0.7,
    stop: ["END"],
    tools: [{ type: "function", function: { name: "bash", parameters: {} } }],
  };

  it("原样透传 OpenAI 形状 + tools 在顶层 + 恒 stream", () => {
    const body = upstream.buildChatBody(baseReq, "sn-glm-5-3");
    assert.equal(body["model"], "sn-glm-5-3");
    assert.equal(body["stream"], true);
    assert.deepEqual(body["messages"], baseReq["messages"]);
    assert.equal(body["temperature"], 0.7);
    assert.deepEqual(body["stop"], ["END"]);
    assert.equal("tools" in body, true, "漏发 tools 会让模型臆造 XML 工具调用");
    assert.equal(body["max_tokens"], 4096);
    assert.equal("extra_body" in body, false, "无档位时不发 extra_body");
    assert.equal("thinking" in body, false, "顶层 thinking 不下发");
  });

  it("reasoning_effort 必须翻译（服务端接受但实测无效果），绝不通透", () => {
    const off = upstream.buildChatBody({ ...baseReq, reasoning_effort: "off" }, "m");
    assert.deepEqual(off["extra_body"], { thinking: { type: "disabled" } });
    assert.equal("reasoning_effort" in off, false);

    for (const value of ["on", "high", "max", "minimal", "weird-unknown", 3]) {
      const body = upstream.buildChatBody({ ...baseReq, reasoning_effort: value }, "m");
      assert.deepEqual(
        body["extra_body"],
        { thinking: { type: "enabled" } },
        `effort=${String(value)}（非明确关闭）→ enabled`,
      );
    }
    for (const value of ["none", "disabled", "false", false]) {
      const body = upstream.buildChatBody({ ...baseReq, reasoning_effort: value }, "m");
      assert.deepEqual(body["extra_body"], { thinking: { type: "disabled" } }, `effort=${String(value)} → disabled`);
    }
  });

  it("下游直接给合法枚举 / 顶层 thinking / 非法枚举", () => {
    const adaptive = upstream.buildChatBody(
      { ...baseReq, extra_body: { thinking: { type: "adaptive" } } },
      "m",
    );
    assert.deepEqual(adaptive["extra_body"], { thinking: { type: "adaptive" } });

    const top = upstream.buildChatBody({ ...baseReq, thinking: { type: "disabled" } }, "m");
    assert.deepEqual(top["extra_body"], { thinking: { type: "disabled" } }, "顶层 thinking 翻译进 extra_body");

    const illegal = upstream.buildChatBody({ ...baseReq, extra_body: { thinking: { type: "bogus" } } }, "m");
    assert.equal("extra_body" in illegal, false, "非法 thinking.type 不发该字段");
  });

  it("max_tokens 只放行安全正整数（0 / 负数 / NaN 会让上游硬校验崩掉）", () => {
    const cases: Array<[unknown, unknown]> = [
      [4096, 4096],
      [4096.0, 4096],
      [0, undefined],
      [-5, undefined],
      [Number.NaN, undefined],
      [Number.POSITIVE_INFINITY, undefined],
      [true, undefined],
      ["4096", undefined],
      [null, undefined],
    ];
    for (const [raw, want] of cases) {
      const body = upstream.buildChatBody({ ...baseReq, max_tokens: raw }, "m");
      assert.equal(body["max_tokens"], want, `max_tokens=${String(raw)}`);
    }
  });
});

// ── 8. 请求头（三种形态）─────────────────────────────────────────────────────

describe("8. 请求头：对话 / 目录 / 领取三种形态", () => {
  const c: cred.Credentials = {
    ...cred.EMPTY_CREDENTIALS,
    accessToken: "tok-1",
    deviceId: "d".repeat(32),
  };

  it("对话：SSE Accept + Content-Type + platform，且不含 version/device-id", () => {
    const chat = upstream.buildHeaders(c);
    assert.equal(chat["Authorization"], "Bearer tok-1");
    assert.equal(chat["X-Org-Code"], "", "个人账号为空串，但该头总是发送");
    assert.equal(chat["X-Raccoon-Language"], "zh");
    assert.equal(chat["X-Client-Platform"], "desktop-windows");
    assert.equal(chat["Accept"], "text/event-stream");
    assert.equal(chat["Content-Type"], "application/json");
    assert.equal("X-Client-Version" in chat, false);
    assert.equal("X-Client-Device-ID" in chat, false);
  });

  it("目录：内联头（无 platform、无 Content-Type）；领取：platform 必需", () => {
    const ls = upstream.buildHeaders(c, { jsonBody: false, platform: false });
    assert.equal("X-Client-Platform" in ls, false);
    assert.equal("Content-Type" in ls, false);
    assert.equal(ls["Accept"], "application/json");

    const grant = upstream.buildHeaders(c, { jsonBody: false, platform: true });
    assert.equal(grant["X-Client-Platform"], "desktop-windows");
    assert.equal("Content-Type" in grant, false);

    const org = upstream.buildHeaders({ ...c, officeIdentity: "org-1" });
    assert.equal(org["X-Org-Code"], "org-1");
  });
});

// ── 9. 模型目录（静态部分）───────────────────────────────────────────────────

describe("9. 模型目录：兜底表 / 图片能力 / 倍率规则", () => {
  it("兜底表 6 个模型，不含 Raccoon-Auto", () => {
    assert.equal(catalog.FALLBACK_MODELS.length, 6);
    assert.deepEqual(
      new Set(catalog.FALLBACK_MODELS.map((m) => m.id)),
      new Set([
        "sn-sensenova-6-8-flash",
        "sn-sensenova-6-8-flash-lite",
        "sn-glm-5-3",
        "sn-kimi-k3",
        "sn-glm-5-3-flash",
        "sn-deepseek-v4-1-flash",
      ]),
    );
    assert.equal(
      catalog.FALLBACK_MODELS.some((m) => m.id === "Raccoon-Auto"),
      false,
      "Raccoon-Auto 发给 chat 会 404",
    );
  });

  it("tags 不是图片能力契约：白名单覆盖实测个案", () => {
    assert.equal(
      catalog.supportsImage("sn-deepseek-v4-1-flash", ["general", "code", "reasoning"]),
      true,
      "tags 无 vision 也能读图（实测 5/5）",
    );
    assert.equal(catalog.supportsImage("sn-glm-5-3-flash", []), true);
    assert.equal(catalog.supportsImage("sn-sensenova-6-8-flash", ["VISION", "general"]), true);
    assert.equal(
      catalog.supportsImage("sn-some-new-model", ["general", "code"]),
      false,
      "未验证模型不推测",
    );
  });

  it("倍率展示规则（1 倍也要显示；0 → 免费）", () => {
    assert.equal(catalog.priceSuffix(0, 0.5), "免费");
    assert.equal(catalog.priceSuffix(0.1, 0.2), "x0.2→x0.1");
    assert.equal(catalog.priceSuffix(1, 1), "x1", "1 倍也要显示");
    assert.equal(catalog.priceSuffix(0.75, null), "x0.75");
    assert.equal(catalog.priceSuffix(-1, 2), "");
    assert.equal(catalog.priceSuffix(Number.NaN, 1), "");
    assert.equal(catalog.priceSuffix(null, 1), "");
    assert.equal(catalog.formatMultiplier(0.123456), "0.1235");
    assert.equal(catalog.formatMultiplier(1.0), "1");

    const byId = new Map(catalog.FALLBACK_MODELS.map((m) => [m.id, m]));
    assert.equal(catalog.displayName(byId.get("sn-kimi-k3")!), "Kimi-K3 · x1");
    assert.equal(catalog.displayName(byId.get("sn-sensenova-6-8-flash")!), "SenseNova-6.8-Flash · 免费");
    assert.equal(catalog.displayName(byId.get("sn-glm-5-3-flash")!), "GLM-5-3-Flash · x0.2→x0.1");
  });

  it("未登录时同样列出兜底表；未知模型原样透传", () => {
    catalog.clearCache();
    const ids = catalog.exposedIds();
    assert.deepEqual(
      ids,
      ["sn-glm-5-3-flash", "sn-deepseek-v4-1-flash"],
      "池策略 (deepseek|glm)×flash：6 条兜底里 2 条命中（命中 flash 但非 deepseek/glm 的挡下）",
    );
    assert.ok(ids.every((id) => /flash/i.test(id) && /deepseek|glm/i.test(id)), "两道闸门都要过");
    assert.equal(catalog.resolveModel("sn-brand-new"), "sn-brand-new");
    assert.equal(catalog.resolveModel("sn-glm-5-3"), "sn-glm-5-3");
  });

  it("远端解析：name 才是模型 id、visible 过滤、Raccoon-Auto 不暴露", () => {
    const payload = {
      categories: [
        { type: "image", models: [{ name: "should-be-ignored" }] },
        {
          type: "chat",
          models: [
            {
              id: "wrong-key",
              name: "sn-glm-5-3",
              description: "GLM-5-3",
              billing_multiplier: 0.75,
              billing_effective_multiplier: 0.75,
              billing_status: "normal",
              params: { context_window: 1_000_000, max_tokens: 100_000 },
              tags: ["General", "Vision"],
            },
            { name: "hidden-model", visible: false },
            { name: "visible-by-default" },
            { name: "sn-glm-5-3", description: "重复 id 应去重" },
          ],
        },
      ],
    };
    const parsed = catalog.parseRemoteModels(payload);
    assert.deepEqual(parsed.map((e) => e.id), ["sn-glm-5-3", "visible-by-default"]);
    assert.equal(parsed[0]!.contextWindow, 1_000_000);
    assert.equal(parsed[0]!.maxOutput, 100_000);
    assert.equal(parsed[0]!.supportsImage, true, "tags 小写化后判图片能力");
    assert.equal(parsed[0]!.billingStatus, "normal");
    assert.equal(catalog.displayName(parsed[0]!), "GLM-5-3 · x0.75");

    assert.deepEqual(
      catalog.parseRemoteModels({ categories: [{ type: "chat", models: [{ name: "Raccoon-Auto" }] }] }),
      [],
    );
  });
});

// ── 10. 模型目录（远端 + 缓存）───────────────────────────────────────────────

describe("10. 模型目录：远端优先与缓存", () => {
  it("远端生效（过滤 visible=false / Raccoon-Auto），命中缓存不重复请求", async () => {
    await saveFakeCreds();
    st.sentModels = 0;
    catalog.clearCache();
    await catalog.refreshCatalog();
    assert.deepEqual(
      catalog.exposedIds(),
      ["sn-glm-5-3-flash"],
      "远端 glm flash 进池；sn-deepseek-v4-1-flash 不在这个假上游里，别家 flash 被策略挡下",
    );
    assert.equal(st.sentModels, 1);
    await catalog.refreshCatalog();
    assert.equal(st.sentModels, 1, "远端命中缓存（不重复请求）");
    const byId = new Map(catalog.details().map((r) => [r["id"] as string, r]));
    const entry = byId.get("sn-glm-5-3-flash")!;
    assert.equal(entry["context_window"], 1_000_000);
    assert.equal(entry["billing_status"], "discount");
    assert.equal(
      entry["vision"],
      true,
      "sn-glm-5-3-flash 在 IMAGE_CAPABILITY_OVERRIDES 里（实测能读图）",
    );
    assert.equal(entry["name"], "GLM-5-3-Flash · x0.2→x0.1");
    const plain = byId.get("sn-glm-5-3")!;
    assert.equal(plain["vision"], false, "远端 tags 无 vision 且非覆盖白名单 → false（不凭空推测）");
    assert.ok(byId.has("sn-glm-5-3"), "非 flash 远端条目仍在底层目录（过滤在呈现层）");
  });
});

// ── 11. 额度 ─────────────────────────────────────────────────────────────────

describe("11. 额度：余额只读 / 登录奖励幂等 / 没有每日签到", () => {
  it("查额度从不触碰写端点；各池分开作 package", async () => {
    await saveFakeCreds();
    st.grantCalls = 0;
    st.balanceMode = "ok";
    st.billsWithReward = false;
    const info = await billing.fetchCredits();
    assert.equal(info.total.remain, 3300, "总额取 available_points");
    assert.equal(info.total.unit, "积分");
    assert.equal(info.total.size, 3300);
    assert.equal(info.total.used, 0, "上游只给剩余 → used 不编造");
    assert.equal(info.total.size_known, false);
    assert.deepEqual(info.packages.map((p) => p.name), ["奖励积分", "每日积分", "充值积分"]);
    assert.equal(info.packages[0]!.days_left, null, "无到期信息则 days_left=null");
    assert.deepEqual(
      info.claimable.map((c) => [c["campaign_id"], c["amount"]]),
      [[billing.LOGIN_REWARD_CAMPAIGN_ID, 3000]],
    );
    assert.equal(st.grantCalls, 0, "查额度**从不**触碰写端点");
  });

  it("账单里已有「桌面端登录奖励」→ 不再列为可领（新人礼包不算）", async () => {
    await saveFakeCreds();
    st.billsWithReward = true;
    const info = await billing.fetchCredits();
    assert.deepEqual(info.claimable, []);

    st.billsWithReward = false;
    assert.equal(await billing.loginRewardClaimed(cred.load()), false, "新人注册礼包也是 reward_grant");
  });

  it("缺 available_points → CreditsError；401/200003 → NotLoggedInError", async () => {
    await saveFakeCreds();
    st.balanceMode = "bad";
    await assert.rejects(() => billing.fetchCredits(), (err: unknown) => {
      assert.ok(err instanceof billing.CreditsError);
      assert.match(String(err), /available_points/);
      return true;
    });
    st.balanceMode = "unauthorized";
    await assert.rejects(() => billing.fetchCredits({ refreshOn401: false }), cred.NotLoggedInError);
    st.balanceMode = "ok";
  });

  it("登录奖励：granted=false → already-claimed；上游失败也不抛错", async () => {
    await saveFakeCreds();
    st.grantMode = "sequence";
    st.grantCalls = 0;
    const first = await billing.claimLoginReward();
    assert.equal(first.status, "claimed");
    assert.equal(first.points, 3000);
    assert.equal(st.grantHeaders["x-client-platform"], "desktop-windows", "platform 必需");

    const second = await billing.claimLoginReward();
    assert.equal(second.status, "already-claimed", "granted=false → already-claimed（不是 claimed）");

    const third = await billing.claimLoginReward();
    assert.equal(third.status, "failed", "上游失败也不抛错");
    assert.ok(third.error);
  });

  it("没有「每日签到」端点（服务端按日自动发放）", () => {
    const api = billing as unknown as Record<string, unknown>;
    assert.equal(api["claimDaily"], undefined);
    assert.equal(api["checkin"], undefined);
  });

  it("未登录 → NotLoggedInError", async () => {
    rmSync(paths.credentialsPath(), { force: true });
    await assert.rejects(() => billing.fetchCredits(), cred.NotLoggedInError);
  });
});

// ── 12. 端到端网关 ────────────────────────────────────────────────────────────

describe("12. 端到端网关（假上游 + 真实网关）", () => {
  let gw: gateway.RunningGateway;

  before(async () => {
    await saveFakeCreds({ officeIdentity: "", deviceId: "e2e".repeat(8) });
    await upstream.saveConfig({ baseUrl: fakeBase() });
    catalog.clearCache();
    await catalog.refreshCatalog();
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
  });

  it("WIRE 是 openai（不需要翻译器）；/health 已登录", async () => {
    assert.equal(upstream.WIRE, "openai");
    assert.equal(upstream.DISPLAY_NAME, "Raccoon");
    const health = (await (await fetch(`http://${gw.addr}/health`)).json()) as Record<string, unknown>;
    assert.equal(health["ok"], true);
    assert.equal(health["logged_in"], true);
  });

  it("流式：正文透传 + 思考通道走 extra_body.thinking（reasoning_effort 不发）", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "glm-5.3-flash",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        reasoning_effort: "off",
      }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 200);
    const text = await resp.text();
    let content = "";
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
        if (choice.finish_reason) finishes.push(choice.finish_reason);
      }
    }
    assert.equal(content, "网关通了");
    assert.deepEqual(finishes, ["stop"]);

    assert.equal(st.chatBody?.["stream"], true);
    assert.equal(st.chatBody?.["model"], "sn-glm-5-3-flash", "池 id 解析成该渠道目录里的名字");
    assert.deepEqual(st.chatBody?.["extra_body"], { thinking: { type: "disabled" } });
    assert.equal("reasoning_effort" in (st.chatBody ?? {}), false, "reasoning_effort 实测无效果 → 不原样透传");

    assert.equal(st.chatHeaders["authorization"]?.startsWith("Bearer "), true);
    assert.equal(st.chatHeaders["x-client-platform"], "desktop-windows");
    assert.equal(st.chatHeaders["x-raccoon-language"], "zh");
    assert.equal(st.chatHeaders["x-org-code"], "");
    assert.equal(st.chatHeaders["accept"], "text/event-stream");
  });

  it("非流式：本层聚合成 chat.completion（带 usage）", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 200);
    const payload = (await resp.json()) as {
      object: string;
      choices: Array<{ message: { content: string } }>;
      usage: { completion_tokens: number };
    };
    assert.equal(payload.object, "chat.completion");
    assert.equal(payload.choices[0]!.message.content, "网关通了");
    assert.equal(payload.usage.completion_tokens, 4);
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

// ── 13. 上游错误处理 ──────────────────────────────────────────────────────────

describe("13. 上游错误处理", () => {
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
          model: "glm-5.3-flash",
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
