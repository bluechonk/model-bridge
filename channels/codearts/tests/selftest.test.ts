/**
 * codearts-bridge 自检（**完全离线**，不出网）。
 *
 * 覆盖：
 *  1. 路径与目录迁移
 *  2. 模型目录（归一化去 `-NNNN`、VL 过滤、两目录合并、benefit 集合判定）
 *  3. 凭据（PKCE / DPoP JWS 可验签 / 落盘读回 / 旧式 ticket 两种形状）
 *  4. **SDK-HMAC-SHA256 签名**：固定输入断言 canonical 与签名 hex；
 *     `Agent-Type` / `X-Language` 绝不进 SignedHeaders，而 `maas_type` 必须进
 *  5. 请求体（恒流式、reasoning_content 恒带、工具配对、DSML 切换、上游键集合）
 *  6. 错误分类（`4291` 额度码不被 `429` 边界误判、benefit 缺失、auth）
 *  7. 续期（STS form 体 + DPoP；`InvalidDPoPHeader` **不是**终态）
 *  8. 额度与活动（裸对象、总额不累加分类、数字 campaignId、benefitAmount、claim+confirm）
 *  9. 端到端网关（假上游）：真实签名头、`x-sdk-content-sha256` 与 body 一致、流式/非流式
 *
 * 数据目录用 MODEL_BRIDGE_HOME 隔离；缓存目录用 DSH_CODEARTS_CACHE_DIR 隔离。
 */

import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// 必须在 import 被测模块之前设置（隔离真实凭据与缓存）
const HOME = mkdtempSync(join(tmpdir(), "ca-selftest-"));
const CACHE = mkdtempSync(join(tmpdir(), "ca-cache-"));
process.env["MODEL_BRIDGE_HOME"] = HOME;
process.env["DSH_CODEARTS_CACHE_DIR"] = CACHE;

// 共享层来自工作区包；先注册本渠道（副作用）再引渠道模块
const { paths, sseStream: sse, gateway, accounts } = await import("@model-bridge/gateway");
await import("../dist/channel.js");
const cred = await import("../dist/cred.js");
const upstream = await import("../dist/upstream.js");
const catalog = await import("../dist/catalog.js");
const billing = await import("../dist/billing.js");

const AK = "AKIDEXAMPLE";
const SK = "SECRETEXAMPLE";
const ST = "TOKENEXAMPLE";

const FAKE_CREDENTIAL = {
  accessToken: ST,
  uid: "u-test",
  domain: "",
  accessKeyId: AK,
  secretAccessKey: SK,
  securityToken: ST,
  expiresAt: "",
  domainId: "",
  userId: "u-test",
  userName: "tester",
  refreshToken: "rt-test",
  codeVerifier: "cv-test",
  dpopPrivateKeyJwk: null,
  obtainedAt: "2026-10-08T00:00:00.000Z",
  source: "selftest",
} satisfies cred.Credentials;

// ── refresh token 的 JWT 夹具 ────────────────────────────────────────────────

/** base64url（无 padding），与 JWT 的编码一致。 */
function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** 真实结构（2026-10-08 实测）的 `user_profile` 载荷。 */
const USER_PROFILE = {
  account_id: "019fb1171afe7d21a114c649628b72e1",
  account_name: "hid_2p1fajwaqpov_95",
  features_switches: { enable_pdp5: true },
  principal_id: "019fb1171afe782f9ecf38e4299658b7",
  principal_is_root_user: true,
  principal_urn: "iam::019fb1171afe7d21a114c649628b72e1:user:hid_2p1fajwaqpov_95",
};

/** 造一个 refresh token JWT：`user_profile` 是**再编码一次**的 base64url JSON。 */
function refreshTokenJwt(overrides: Record<string, unknown> = {}): string {
  const payload = {
    exp: 1794054685,
    iat: 1791463234,
    iss: "cn-north-4",
    type: "refreshToken",
    user_profile: b64url(USER_PROFILE),
    client_id: "codearts-agent",
    jti: "40a1d80d-3e51-4bfb-9ef7-24eff64d9762",
    ...overrides,
  };
  return `${b64url({ typ: "JWT", alg: "RS256" })}.${b64url(payload)}.fakesig`;
}

// ── 假上游 ───────────────────────────────────────────────────────────────────

interface Captured {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  raw: string;
  body: Record<string, unknown> | null;
}

type Route = (req: Captured) => { status: number; body?: unknown; raw?: string; contentType?: string };

async function startFakeUpstream(): Promise<{
  server: Server;
  port: number;
  base: string;
  captured: Captured[];
  routes: Map<string, Route>;
}> {
  const captured: Captured[] = [];
  const routes = new Map<string, Route>();
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += String(c);
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      let body: Record<string, unknown> | null = null;
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
      const record: Captured = {
        method: req.method ?? "",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: { ...req.headers },
        raw,
        body,
      };
      captured.push(record);
      const route = routes.get(url.pathname);
      if (!route) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error_code: "APIG.0301", error_msg: "not found" }));
        return;
      }
      const out = route(record);
      if (out.raw !== undefined) {
        res.writeHead(out.status, { "Content-Type": out.contentType ?? "text/event-stream" });
        res.end(out.raw);
        return;
      }
      res.writeHead(out.status, { "Content-Type": out.contentType ?? "application/json" });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
  );
  return { server, port, base: `http://127.0.0.1:${port}`, captured, routes };
}

function lastAt(
  fake: { captured: Captured[] },
  path: string,
): Captured | undefined {
  return [...fake.captured].reverse().find((r) => r.path === path);
}

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
      if (typeof choice.delta?.content === "string") content += choice.delta.content;
    }
  }
  return content;
}

async function saveFakeCredential(): Promise<void> {
  await cred.save({ ...FAKE_CREDENTIAL });
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

describe("1. 路径", () => {
  it("数据目录名固定，受 MODEL_BRIDGE_HOME 覆盖，渠道层是 <root>/codearts", () => {
    assert.equal(paths.rootDir(), HOME);
    assert.equal(paths.channelDir(), join(HOME, "codearts"));
    assert.ok(paths.credentialsPath().endsWith("credentials.json"));
  });

  it("旧目录收拢进统一存储根", () => {
    const alt = mkdtempSync(join(tmpdir(), "ca-legacy-"));
    mkdirSync(join(alt, ".codearts2api"), { recursive: true });
    const saved = process.env["MODEL_BRIDGE_HOME"];
    process.env["MODEL_BRIDGE_HOME"] = alt;
    try {
      assert.equal(paths.channelDir(), join(alt, "codearts"));
    } finally {
      process.env["MODEL_BRIDGE_HOME"] = saved;
      rmSync(alt, { recursive: true, force: true });
    }
  });
});

describe("2. 模型目录", () => {
  it("归一化去掉末尾 -NNNN（只认 4 位数字）", () => {
    assert.equal(catalog.normalizeModelId("deepseek-v4-flash-0731"), "deepseek-v4-flash");
    assert.equal(catalog.normalizeModelId("deepseek-v4-pro-0813"), "deepseek-v4-pro");
    assert.equal(catalog.normalizeModelId("glm-5.3-flash"), "glm-5.3-flash");
    assert.equal(catalog.normalizeModelId("GLM-5.2"), "GLM-5.2");
  });

  it("远端解析：VL 模型过滤、按 id 去重、name 也归一化", () => {
    const seen = new Set<string>();
    const rows = [
      { model_id: "deepseek-v4-flash-0731", model_name: "DeepSeek-V4-Flash-0731" },
      { model_id: "deepseek-v4-flash-0731", model_name: "dup" },
      { model_id: "Qwen3-VL-235B", model_name: "Qwen3-VL-235B" },
      { model_id: "GLM-5.2-sft-harmony", model_name: "GLM-5.2-sft-harmony" },
    ];
    const entries = catalog.parseModelRows(rows, seen);
    assert.deepEqual(
      entries.map((e) => e.id),
      ["deepseek-v4-flash", "GLM-5.2-sft-harmony"],
      "VL 视觉模型必须过滤，重复 id 只留一条",
    );
    assert.equal(entries[0]!.name, "DeepSeek-V4-Flash");
  });

  it("benefit 集合：静态兜底 + 远端未改写 id；无后缀模型绝不带上", () => {
    assert.equal(catalog.isBenefitModel("glm-5.3-flash"), true);
    assert.equal(catalog.isBenefitModel("deepseek-v4.1-flash"), true);
    assert.equal(catalog.isBenefitModel("deepseek-v4-flash"), false);
    assert.equal(catalog.isBenefitModel("deepseek-v4-flash-0731"), false);
    assert.equal(catalog.isBenefitModel("GLM-5.2"), false);
    catalog.setRemoteModels([{ id: "glm-5.3-flash", name: "glm-5.3-flash", source: "remote" }], [
      "glm-5.3-flash",
      "some-new-benefit",
    ]);
    assert.equal(catalog.isBenefitModel("some-new-benefit"), true);
    // 磁盘缓存同步落盘（chat 签名前要读）；文件名已按存储规范收敛为 benefit-models.json
    const cacheFile = join(CACHE, "benefit-models.json");
    const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as string[];
    assert.ok(cached.includes("some-new-benefit"));
    catalog.resetRemoteCache();
    assert.equal(catalog.isBenefitModel("some-new-benefit"), false, "reset 后不再命中");
  });

  it("兜底表 9 条；exposedIds 只放行 (deepseek|glm)×flash（3 条）；resolveModel 归一化已知 id", () => {
    catalog.resetRemoteCache();
    assert.equal(catalog.FALLBACK_MODEL_IDS.length, 9);
    const ids = catalog.exposedIds();
    assert.deepEqual(
      ids,
      ["glm-5.3-flash", "deepseek-v4-flash", "deepseek-v4.1-flash"],
      "池策略 (deepseek|glm)×flash：9 条兜底里 3 条命中；openpangu 是 flash 但非 deepseek/glm → 挡下",
    );
    assert.ok(ids.every((id) => /flash/i.test(id)), "池子里必须带 flash");
    assert.ok(
      ids.every((id) => /deepseek|glm/i.test(id)),
      "且必须属于 deepseek 或 glm 家族",
    );
    // 过滤只发生在呈现层：底层表仍含非 flash 条目
    const underlying = catalog.details().map((e) => e["id"] as string);
    assert.equal(underlying.length, 9, "details 仍给出全部 9 条");
    assert.ok(underlying.includes("GLM-5.2") && underlying.includes("deepseek-v4-pro"));
    assert.equal(catalog.resolveModel("deepseek-v4-flash-0731"), "deepseek-v4-flash");
    assert.equal(catalog.resolveModel("no-such-model"), "no-such-model");
    assert.equal(catalog.entryFor("GLM-5.2")!.context_window, 202_752);
  });
});

describe("3. 凭据", () => {
  it("未登录抛 NotLoggedInError；损坏文件同样", () => {
    rmSync(paths.credentialsPath(), { force: true });
    assert.throws(() => cred.load(), cred.NotLoggedInError);
    mkdirSync(paths.channelDir(), { recursive: true });
    writeFileSync(paths.credentialsPath(), "{ not json", "utf8");
    assert.throws(() => cred.load(), cred.NotLoggedInError);
  });

  it("落盘读回（含 refresh_token / code_verifier / DPoP 私钥 JWK）", async () => {
    const keyPair = cred.generateDpopKeyPair();
    await cred.save({ ...FAKE_CREDENTIAL, dpopPrivateKeyJwk: keyPair.privateKeyJwk });
    const raw = JSON.parse(readFileSync(paths.credentialsPath(), "utf8")) as Record<string, unknown>;
    for (const key of ["access_key_id", "secret_access_key", "security_token", "refresh_token", "code_verifier", "dpop_private_key_jwk"]) {
      assert.ok(key in raw, `磁盘必须保留 ${key}`);
    }
    const c = cred.load();
    assert.equal(c.accessKeyId, AK);
    assert.equal(c.accessToken, ST, "契约 accessToken 映射 security_token");
    assert.equal(c.dpopPrivateKeyJwk!.crv, "P-256");
    assert.equal(c.domain, "");
  });

  it("uid 缺失时用 sha256(ak)[:16] 补齐", () => {
    writeFileSync(
      paths.credentialsPath(),
      JSON.stringify({ access_key_id: AK, secret_access_key: SK }),
      "utf8",
    );
    const c = cred.load();
    assert.equal(c.uid.length, 16);
    assert.equal(c.userId, "");
  });

  it("身份取自 refresh token 的 JWT：account_id 稳定，同一个人跨登录一致", () => {
    // 实测：STS 信封只给 credentials + refresh_token，从不给 user_id/domain_id。
    // 而华为每次签发都换一套新 AK —— 若拿 AK 派生 uid，同一个人会被记成多个账号。
    const tok = refreshTokenJwt();
    assert.equal(
      cred.identityFromRefreshToken(tok),
      "019fb1171afe7d21a114c649628b72e1",
      "取 account_id（账号级身份）",
    );

    // 两个「不同 AK、同一人」的 token 响应 → 必须得到同一个 uid
    const mk = (ak: string): cred.Credentials =>
      cred.credentialFromTokenResponse(
        {
          credentials: { access_key_id: ak, secret_access_key: SK, security_token: ST },
          refresh_token: tok,
        },
        { codeVerifier: "cv", codeChallenge: "" },
        cred.generateDpopKeyPair(),
        "codearts-oauth",
      );
    const a = mk("HSTANDPR0TVVRVICXOQS");
    const b = mk("HSTA5H4R3ML6WTZ8NRL5");
    assert.equal(a.uid, b.uid, "同一人的不同 AK 必须算出同一个 uid");
    assert.equal(a.uid, "019fb1171afe7d21a114c649628b72e1");
    assert.notEqual(
      createHash("sha256").update(a.accessKeyId).digest("hex").slice(0, 16),
      createHash("sha256").update(b.accessKeyId).digest("hex").slice(0, 16),
      "两个 AK 的哈希本来就不同 —— 这正是旧算法出错的原因",
    );
  });

  it("信封给了 user_id 时优先用它；JWT 解不开时退回 AK 哈希", () => {
    const withUserId = cred.credentialFromTokenResponse(
      {
        credentials: { access_key_id: AK, secret_access_key: SK, security_token: ST },
        refresh_token: refreshTokenJwt(),
        user_id: "from-envelope",
      },
      { codeVerifier: "cv", codeChallenge: "" },
      cred.generateDpopKeyPair(),
      "codearts-oauth",
    );
    assert.equal(withUserId.uid, "from-envelope", "上游真身份优先于 JWT 解析");

    // 非 JWT / 结构不符 → 空串（由调用方兜底，不抛错）
    assert.equal(cred.identityFromRefreshToken(""), "");
    assert.equal(cred.identityFromRefreshToken("not-a-jwt"), "");
    assert.equal(cred.identityFromRefreshToken("a.b.c"), "");
    assert.equal(cred.identityFromRefreshToken(refreshTokenJwt({ user_profile: undefined })), "");
    assert.equal(
      cred.identityFromRefreshToken(refreshTokenJwt({ user_profile: "%%%not-base64%%%" })),
      "",
    );
    // type 不是 refreshToken → 不认（access/id token 的身份口径未必相同）
    assert.equal(cred.identityFromRefreshToken(refreshTokenJwt({ type: "accessToken" })), "");
    // account_id 缺失 → 退到 principal_id
    assert.equal(
      cred.identityFromRefreshToken(
        refreshTokenJwt({ user_profile: b64url({ principal_id: "pid-only" }) }),
      ),
      "pid-only",
    );
  });

  it("旧凭据的伪 uid 在读取时自动纠正（不需要用户重登）", () => {
    const legacy = createHash("sha256").update(AK).digest("hex").slice(0, 16);
    writeFileSync(
      paths.credentialsPath(),
      JSON.stringify({
        access_key_id: AK,
        secret_access_key: SK,
        security_token: ST,
        refresh_token: refreshTokenJwt(),
        uid: legacy, // ← 老版本按 AK 派生出来的伪身份
      }),
      "utf8",
    );
    const c = cred.load();
    assert.equal(c.uid, "019fb1171afe7d21a114c649628b72e1", "伪 uid 被纠正为 account_id");

    // 已经是稳定身份的，不被二次改写
    writeFileSync(
      paths.credentialsPath(),
      JSON.stringify({
        access_key_id: AK,
        secret_access_key: SK,
        security_token: ST,
        refresh_token: refreshTokenJwt(),
        uid: "some-real-upstream-id",
      }),
      "utf8",
    );
    assert.equal(cred.load().uid, "some-real-upstream-id", "非伪 uid 原样保留");

    // 没有 refresh token 可解时，保持旧行为（不把 uid 弄空）
    writeFileSync(
      paths.credentialsPath(),
      JSON.stringify({ access_key_id: AK, secret_access_key: SK, uid: legacy }),
      "utf8",
    );
    assert.equal(cred.load().uid, legacy);
  });

  it("存量清理：池内同一人的多个伪账号被合并成一个（实测过一个人躺 3 条）", () => {
    // 造 3 条「按 AK 派生 uid」的历史伪账号 —— 与线上实测形状一致：
    // 同一个人、同一 account_id、但 AK 不同（华为每次签发都换）
    const aks = ["HSTANDPR0TVVRVICXOQS", "HSTA5H4R3ML6WTZ8NRL5", "HSTAQAB7VQOR2KKBUYG0"];
    rmSync(paths.credentialsPath(), { force: true });
    const poolRoot = join(paths.channelDir(), "accounts");
    rmSync(poolRoot, { recursive: true, force: true });
    rmSync(join(paths.channelDir(), "accounts.json"), { force: true });
    mkdirSync(poolRoot, { recursive: true });

    const keys: string[] = [];
    for (const [i, ak] of aks.entries()) {
      const uid = createHash("sha256").update(ak).digest("hex").slice(0, 16);
      const key = accounts.accountKey({ uid, domain: "" });
      keys.push(key);
      writeFileSync(
        join(poolRoot, `${key}.json`),
        JSON.stringify({
          access_key_id: ak,
          secret_access_key: SK,
          security_token: `ST-${i}`,
          refresh_token: refreshTokenJwt({ jti: `jti-${i}` }),
          uid,
        }),
        "utf8",
      );
    }
    writeFileSync(
      join(paths.channelDir(), "accounts.json"),
      JSON.stringify({
        version: 1,
        active: keys[0],
        accounts: keys.map((key, i) => ({
          key,
          uid: createHash("sha256").update(aks[i]!).digest("hex").slice(0, 16),
          domain: "",
          label: `legacy-${i}`,
          added_at: "2026-10-08T12:31:25.912Z",
          last_used_at: "2026-10-08T12:31:25.912Z",
          expires_at: null,
          health: "ok",
          health_at: "2026-10-08T12:31:25.912Z",
        })),
      }),
      "utf8",
    );
    assert.equal(accounts.readIndex().accounts.length, 3, "先确认池里确实是 3 条");

    const removed = cred.pruneLegacyAccounts();
    assert.equal(removed, 2, "同一人的 2 条伪账号应被清掉");
    const left = accounts.readIndex();
    assert.equal(left.accounts.length, 1, "同一个人只留一条");
    assert.equal(left.accounts[0]!.key, keys[0], "保留当前生效的那份");
    assert.ok(!existsSync(join(poolRoot, `${keys[1]}.json`)), "被清掉的账号文件也要删");

    // 幂等：再跑一次什么都不做
    assert.equal(cred.pruneLegacyAccounts(), 0, "幂等");
    assert.equal(accounts.readIndex().accounts.length, 1);

    // 另一个人（不同 account_id）绝不能被当成同一个人清掉
    const otherUid = "019fb1171afe7d21a114c649628b72e2";
    const otherKey = accounts.accountKey({ uid: otherUid, domain: "" });
    writeFileSync(
      join(poolRoot, `${otherKey}.json`),
      JSON.stringify({
        access_key_id: "HSTASTABLEKEYXXXXXXXX",
        secret_access_key: SK,
        security_token: ST,
        // 另一个人的 refresh token：account_id 不同
        refresh_token: refreshTokenJwt({
          user_profile: b64url({ ...USER_PROFILE, account_id: otherUid }),
        }),
        uid: otherUid,
      }),
      "utf8",
    );
    writeFileSync(
      join(paths.channelDir(), "accounts.json"),
      JSON.stringify({
        version: 1,
        active: otherKey,
        accounts: [
          ...left.accounts,
          {
            key: otherKey,
            uid: otherUid,
            domain: "",
            label: "other-person",
            added_at: "2026-10-08T12:31:25.912Z",
            last_used_at: "2026-10-08T12:31:25.912Z",
            expires_at: null,
            health: "ok",
            health_at: "2026-10-08T12:31:25.912Z",
          },
        ],
      }),
      "utf8",
    );
    assert.equal(cred.pruneLegacyAccounts(), 0, "另一个人的账号不参与清理");
    assert.equal(accounts.readIndex().accounts.length, 2, "两个人各留一条");
  });

  it("PKCE：verifier 48 字节 base64url，challenge = base64url(sha256(verifier))", () => {
    const pkce = cred.generatePkcePair();
    assert.match(pkce.codeVerifier, /^[A-Za-z0-9_-]{64}$/);
    assert.match(pkce.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(
      pkce.codeChallenge,
      createHash("sha256").update(pkce.codeVerifier).digest("base64url"),
    );
  });

  it("DPoP JWS：三段、ES256 + dpop+jwt + jwk 头、raw R||S 可验签、jti 随机", () => {
    const keyPair = cred.generateDpopKeyPair();
    const htu = "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens";
    const jws = cred.signDpopJws(keyPair, "POST", htu);
    const [h, p, s] = jws.split(".");
    assert.equal(jws.split(".").length, 3);
    const header = JSON.parse(Buffer.from(h!, "base64url").toString("utf8")) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString("utf8")) as Record<string, unknown>;
    assert.equal(header["alg"], "ES256");
    assert.equal(header["typ"], "dpop+jwt");
    assert.equal(header["d"], undefined, "头里只放公钥 JWK");
    assert.equal(payload["htm"], "POST");
    assert.equal(payload["htu"], htu, "htu 是完整 URL（含 path）");
    assert.ok(typeof payload["iat"] === "number");
    assert.match(String(payload["jti"]), /^[0-9a-f]{64}$/);

    const sig = Buffer.from(s!, "base64url");
    assert.equal(sig.length, 64, "JWS 的 ES256 必须是 raw R||S（64 字节），不是 DER");
    const publicKey = createPublicKey({
      key: header["jwk"] as unknown as import("node:crypto").JsonWebKey,
      format: "jwk",
    });
    assert.ok(
      verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, sig),
      "公钥必须能验签",
    );
    assert.notEqual(cred.signDpopJws(keyPair, "POST", htu).split(".")[2], s, "jti 随机 → 每次不同");
  });

  it("旧式 ticket 凭据兼容两种形状；expires_at 无法解析回退 24h", () => {
    const fromCredential = cred.credentialFromTicketPayload({
      data: {
        credential: { access: "ak1", secret: "sk1", securitytoken: "st1", expires_at: "2030-01-01T00:00:00Z" },
        user_id: "u1",
      },
    });
    assert.equal(fromCredential!.accessKeyId, "ak1");
    assert.equal(fromCredential!.securityToken, "st1");
    assert.equal(fromCredential!.uid, "u1");
    const fromResult = cred.credentialFromTicketPayload({
      data: { result: { accessKeyId: "ak2", secretAccessKey: "sk2", securityToken: "st2", expiration: "bad-date" } },
    });
    assert.equal(fromResult!.secretAccessKey, "sk2");
    assert.ok(Date.parse(fromResult!.expiresAt) > Date.now() + 20 * 3600_000, "回退 now+24h");
    assert.equal(cred.credentialFromTicketPayload({ data: {} }), null);
  });
});

describe("4. SDK-HMAC-SHA256 签名（固定输入断言 canonical 与签名 hex）", () => {
  it("canonical 里**头行与 SignedHeaders 之间有一个空行**", () => {
    const headers = upstream.signRequest({
      method: "POST",
      url: "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions",
      body: '{"model":"deepseek-v4-flash"}',
      ak: AK,
      sk: SK,
      securityToken: ST,
      extraSignedHeaders: { maas_type: "benefit" },
      dateStamp: "20260102T030405Z",
    });
    // 逐字对照独立按 PROTOCOL 伪码算出的结果
    const canonical = upstream.buildCanonicalRequest(
      "POST",
      "/api/v2/chat/completions/",
      "",
      {
        "content-type": "application/json",
        host: "snap-access.cn-north-4.myhuaweicloud.com",
        maas_type: "benefit",
        "x-sdk-content-sha256": "0a6e3d9306f75719a23a8d036e6c67b851da1dc6e80f5fc5ef37395b54eb7dbf",
        "x-sdk-date": "20260102T030405Z",
        "x-security-token": ST,
      },
      "0a6e3d9306f75719a23a8d036e6c67b851da1dc6e80f5fc5ef37395b54eb7dbf",
    );
    assert.equal(
      canonical,
      "POST\n/api/v2/chat/completions/\n\n" +
        "content-type:application/json\n" +
        "host:snap-access.cn-north-4.myhuaweicloud.com\n" +
        "maas_type:benefit\n" +
        "x-sdk-content-sha256:0a6e3d9306f75719a23a8d036e6c67b851da1dc6e80f5fc5ef37395b54eb7dbf\n" +
        "x-sdk-date:20260102T030405Z\n" +
        "x-security-token:TOKENEXAMPLE\n" +
        "\n" +
        "content-type;host;maas_type;x-sdk-content-sha256;x-sdk-date;x-security-token\n" +
        "0a6e3d9306f75719a23a8d036e6c67b851da1dc6e80f5fc5ef37395b54eb7dbf",
    );
    assert.equal(
      headers["Authorization"],
      "SDK-HMAC-SHA256 Access=AKIDEXAMPLE," +
        "SignedHeaders=content-type;host;maas_type;x-sdk-content-sha256;x-sdk-date;x-security-token," +
        "Signature=079b37d29cf5adf1df404bcd8e6cf8db3412d0598cd98beb354a149a79d89044",
    );
    assert.equal(headers["x-sdk-content-sha256"], sha256HexExpectation('{"model":"deepseek-v4-flash"}'));
    assert.equal(headers["host"], "snap-access.cn-north-4.myhuaweicloud.com");
  });

  it("GET：无 content-type、空体哈希；签名 hex 固定", () => {
    const headers = upstream.signRequest({
      method: "GET",
      url: "https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin",
      ak: AK,
      sk: SK,
      securityToken: ST,
      dateStamp: "20260102T030405Z",
    });
    assert.equal(
      headers["x-sdk-content-sha256"],
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "GET 用空体哈希",
    );
    assert.equal(headers["content-type"], undefined, "GET 不带 content-type（也不进签名）");
    assert.equal(
      headers["Authorization"],
      "SDK-HMAC-SHA256 Access=AKIDEXAMPLE," +
        "SignedHeaders=host;x-sdk-content-sha256;x-sdk-date;x-security-token," +
        "Signature=555b641fc459227997002b865393d8fdb3a5bef6b4dbf0946bac289fd7606433",
    );
  });

  it("Agent-Type / X-Language 绝不参与签名；maas_type 必须参与（反例）", () => {
    const withExtras = upstream.signRequest({
      method: "GET",
      url: "https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin",
      ak: AK,
      sk: SK,
      securityToken: ST,
      dateStamp: "20260102T030405Z",
      extraSignedHeaders: { "Agent-Type": "PromptCenter", "X-Language": "zh-cn" },
    });
    // 只作为 extraSignedHeaders 传入才会进签名；调用方（billing / fetchModels）
    // 用 withoutHost + Object.assign 在**签名之后**追加，故签名里没有它们。
    const afterSign = upstream.withoutHost(
      upstream.signRequest({
        method: "GET",
        url: "https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin",
        ak: AK,
        sk: SK,
        securityToken: ST,
        dateStamp: "20260102T030405Z",
      }),
    );
    Object.assign(afterSign, { "Agent-Type": "PromptCenter", "X-Language": "zh-cn" });
    const signedHeaders = String(afterSign["Authorization"]).split("SignedHeaders=")[1]!.split(",")[0]!;
    assert.ok(!signedHeaders.includes("agent-type") && !signedHeaders.includes("x-language"));
    assert.ok(signedHeaders.includes("host"), "host 在 canonical 里是必需项（发送前才剔除）");
    assert.ok(withExtras["host"], "signRequest 返回里含 host，由 withoutHost 剔除");

    const benefit = upstream.signRequest({
      method: "POST",
      url: "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions",
      body: "{}",
      ak: AK,
      sk: SK,
      securityToken: ST,
      extraSignedHeaders: { maas_type: "benefit" },
      dateStamp: "20260102T030405Z",
    });
    assert.ok(
      String(benefit["Authorization"]).includes("maas_type"),
      "maas_type: benefit 是反例——必须参与签名，否则 404 未注册",
    );
    assert.equal(benefit["maas_type"], "benefit");
  });

  it("dateStamp 形如 YYYYMMDDTHHMMSSZ（毫秒截掉，保留 Z）", () => {
    const stamp = upstream.formatDateStamp(new Date("2026-01-02T03:04:05.678Z"));
    assert.equal(stamp, "20260102T030405Z");
  });
});

function sha256HexExpectation(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("5. 请求体改写", () => {
  it("顶层键集合与恒流式；assistant 的 reasoning_content 恒带", () => {
    const body = upstream.buildChatBody(
      {
        model: "GLM-5.2",
        messages: [
          { role: "system", content: "你是助手" },
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "先说一句",
            tool_calls: [
              { id: "c1", type: "function", function: { name: "read", arguments: "{}" } },
              { id: "c2", type: "function", function: { name: "bash", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "c1", content: "结果" },
        ],
        max_tokens: 1234,
        reasoning_effort: "off",
        temperature: 0.2,
      },
      "GLM-5.2",
    );
    assert.equal(body["model"], "GLM-5.2");
    assert.equal(body["stream"], true, "恒流式");
    assert.equal(body["include"][0 as never], "reasoning.encrypted_content");
    assert.equal(body["reasoning_summary"], "auto");
    assert.equal(body["tool_stream"], true);
    assert.equal(body["max_tokens"], 1234);
    assert.deepEqual(body["thinking"], { type: "disabled" }, "仅 off 时发顶层 thinking");
    assert.match(String(body["prompt_cache_key"]), /^[0-9a-f]{32}$/);
    // 协议 §3.1 的顶层键集合是**穷举**的：未列出的字段（如 temperature）不转发
    // ——与真实 IDE 请求体一致，避免上游收到未验证的参数。
    assert.equal(body["temperature"], undefined);

    const messages = body["messages"] as Array<Record<string, unknown>>;
    const assistant = messages[2]!;
    assert.equal(assistant["reasoning_content"], "", "无推理时空串也必须带该字段");
    // 孤儿 tool_call（c2 无结果）必须剔除
    assert.deepEqual((assistant["tool_calls"] as Array<{ id: string }>).map((c) => c.id), ["c1"]);
    assert.equal(messages[3]!["role"], "tool");
    assert.equal(messages[3]!["content"], "结果");
  });

  it("max_tokens 默认 65536；非 off 档位不发 thinking", () => {
    const body = upstream.buildChatBody({ model: "GLM-5.2", messages: [] }, "GLM-5.2");
    assert.equal(body["max_tokens"], 65_536);
    assert.equal(body["thinking"], undefined);
    const high = upstream.buildChatBody(
      { model: "GLM-5.2", messages: [], reasoning_effort: "high" },
      "GLM-5.2",
    );
    assert.equal(high["thinking"], undefined, "enabled 与不传等价，故不发");
  });

  it("DSML：deepseek-v4（无后缀）+ 大参数工具 → 不发 tools、注入 system（全角竖线 magic string）", () => {
    const tools = [
      { type: "function", function: { name: "write", description: "写文件", parameters: { type: "object" } } },
    ];
    const body = upstream.buildChatBody(
      { model: "deepseek-v4-flash", messages: [{ role: "user", content: "写文件" }], tools },
      "deepseek-v4-flash",
    );
    assert.equal(body["tools"], undefined, "DSML 模式下不发 tools 字段");
    const messages = body["messages"] as Array<Record<string, unknown>>;
    assert.equal(messages[0]!["role"], "system");
    assert.ok(String(messages[0]!["content"]).includes("<｜DSML｜tool_calls>"), "U+FF5C 全角竖线");
    assert.ok(String(messages[0]!["content"]).includes("<thought>"));
    // 小参数工具（read）不触发 DSML
    const normal = upstream.buildChatBody(
      {
        model: "deepseek-v4-flash",
        messages: [],
        tools: [{ type: "function", function: { name: "read", parameters: {} } }],
      },
      "deepseek-v4-flash",
    );
    assert.ok(Array.isArray(normal["tools"]));
    // 带日期后缀的模型不触发（chat 端点只认无后缀）
    assert.equal(upstream.needsDsmlToolMode("deepseek-v4-flash-0731", ["write"]), false);
  });

  it("session key 按对话首条 user 文本派生（同对话稳定，前缀缓存才能命中）", () => {
    const first = upstream.buildChatBody(
      { model: "GLM-5.2", messages: [{ role: "user", content: "同一个问题" }] },
      "GLM-5.2",
    );
    const second = upstream.buildChatBody(
      {
        model: "GLM-5.2",
        messages: [
          { role: "user", content: "同一个问题" },
          { role: "assistant", content: "答案" },
          { role: "user", content: "追问" },
        ],
      },
      "GLM-5.2",
    );
    const other = upstream.buildChatBody(
      { model: "GLM-5.2", messages: [{ role: "user", content: "另一个问题" }] },
      "GLM-5.2",
    );
    assert.equal(first["prompt_cache_key"], second["prompt_cache_key"]);
    assert.notEqual(first["prompt_cache_key"], other["prompt_cache_key"]);
  });

  it("buildHeaders：benefit 模型带 maas_type，非 benefit 不带；含 Chat-Id/Session-Id/lang", () => {
    upstream.buildChatBody(
      { model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] },
      "glm-5.3-flash",
    );
    const headers = upstream.buildHeaders(FAKE_CREDENTIAL);
    assert.equal(headers["maas_type"], "benefit");
    assert.equal(headers["host"], undefined, "host 发送前剔除");
    assert.equal(headers["lang"], "en");
    assert.match(headers["Chat-Id"]!, /^[0-9a-f]{32}$/);
    assert.equal(headers["Chat-Id"], headers["Session-Id"]);
    assert.ok(headers["Authorization"]!.includes("maas_type"), "maas_type 进签名");

    upstream.buildChatBody(
      { model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] },
      "deepseek-v4-flash",
    );
    const plain = upstream.buildHeaders(FAKE_CREDENTIAL);
    assert.equal(plain["maas_type"], undefined, "无后缀不是 benefit，带该头会 unsupported model");
  });

  it("**签名头不得重复**：content-type 只能出现一次（否则 fetch 拼成 'a, a' 导致签名失败）", () => {
    // 实测踩坑（2026-10-08）：`signRequest` 返回参与签名的 `content-type`，而
    // `buildHeaders` 又追加了一个 `Content-Type`。两者只在大小写上不同，Node 的
    // fetch 会**都发出去**并拼成 `application/json, application/json`；服务端按
    // 实际收到的值重算 canonical request，与签名时的值不符 →
    // `401 APIG.0301 verify ak sk signature fail`（chat 全挂，而 GET 目录正常，
    // 因为那条路径没有重复头）。
    upstream.buildChatBody(
      { model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] },
      "glm-5.3-flash",
    );
    const headers = upstream.buildHeaders(FAKE_CREDENTIAL);

    const ctKeys = Object.keys(headers).filter((k) => k.toLowerCase() === "content-type");
    assert.deepEqual(ctKeys, ["content-type"], "只能有一个 content-type 键，且是小写（参与签名那个）");
    assert.equal(headers["content-type"], "application/json");

    // 推广：任何「大小写不同但同名」的重复头都会踩同样的坑
    const lowered = Object.keys(headers).map((k) => k.toLowerCase());
    assert.equal(
      new Set(lowered).size,
      lowered.length,
      `头名不得大小写重复（实测 fetch 会合并成逗号串）：${lowered.join(", ")}`,
    );
  });
});

describe("6. 错误分类", () => {
  it("额度码 InferHub.4291.200 命中额度（不被 429 边界误判成排队）", () => {
    assert.equal(upstream.isQuotaExhaustedError("InferHub.4291.200", ""), true);
    assert.equal(upstream.classifyStreamError("InferHub.4291.200", "quota"), "quota-exhausted");
    assert.equal(
      upstream.classifyStreamError("InferHub.ModelArts.81111", "insufficient_quota"),
      "quota-exhausted",
    );
  });

  it("429 必须锚定为独立数字", () => {
    assert.equal(upstream.isQueueRetryableError(429, "429 Too Many Requests"), true);
    assert.equal(upstream.isQueueRetryableError(0, "error 429 happened"), true);
    assert.equal(upstream.isQueueRetryableError(0, "code=4291.200"), false, "4291 不能被当成 429");
    assert.equal(upstream.isQueueRetryableError(0, "InferHub.4291.200"), false);
    assert.equal(upstream.classifyStreamError("InferHub.4291.200", ""), "quota-exhausted");
    assert.equal(upstream.isQueueRetryableError(0, "TM.00001041 排队"), true);
    assert.equal(upstream.classifyStreamError("", "TPM 超限，请排队"), "queue-retry");
  });

  it("benefit 缺失与 HTTP 分类", () => {
    assert.equal(upstream.isBenefitNotFoundError("InferHub.4004.200"), true);
    assert.equal(upstream.classifyStreamError("InferHub.4004.200", "benefit not found"), "benefit-missing");
    assert.equal(upstream.classifyStreamError("Other", "boom"), "invalid-request");
    assert.equal(upstream.classifyHttpError(401, ""), "auth");
    assert.equal(upstream.classifyHttpError(200, "APIG.0602 invalid token"), "auth");
    assert.equal(upstream.classifyHttpError(429, ""), "rate-limit");
    assert.equal(upstream.classifyHttpError(400, "context length exceeded"), "context-window");
    assert.equal(upstream.classifyHttpError(400, "bad request"), "invalid-request");
    assert.equal(upstream.classifyHttpError(503, ""), "server");
  });
});

describe("7. 续期（STS + DPoP）", () => {
  it("form 体正确、带 DPoP 头、rotate 后落盘", async () => {
    const fake = await startFakeUpstream();
    process.env["CODEARTS_STS_URL"] = `${fake.base}/v1/oauth2/tokens`;
    fake.routes.set("/v1/oauth2/tokens", (req) => {
      assert.ok(String(req.headers["dpop"] ?? "").split(".").length === 3, "必须带 DPoP JWS");
      assert.equal(req.headers["content-type"], "application/x-www-form-urlencoded");
      return {
        status: 200,
        body: {
          credentials: {
            access_key_id: AK,
            secret_access_key: SK,
            security_token: "ST-NEW",
            expiration: "2030-01-01T00:00:00Z",
          },
          refresh_token: "rt-rotated",
        },
      };
    });
    const keyPair = cred.generateDpopKeyPair();
    await cred.save({
      ...FAKE_CREDENTIAL,
      dpopPrivateKeyJwk: keyPair.privateKeyJwk,
      codeVerifier: "cv-1",
      refreshToken: "rt-1",
    });
    cred.resetRefreshQueue();
    try {
      const next = await cred.refresh(cred.load());
      const form = new URLSearchParams(lastAt(fake, "/v1/oauth2/tokens")!.raw);
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.equal(form.get("client_id"), "codearts-agent");
      assert.equal(form.get("refresh_token"), "rt-1");
      assert.equal(form.get("code_verifier"), "cv-1");
      assert.equal(next.securityToken, "ST-NEW");
      assert.equal(next.refreshToken, "rt-rotated", "refresh_token 一次性轮换必须落盘");
      assert.equal(cred.load().refreshToken, "rt-rotated");
    } finally {
      delete process.env["CODEARTS_STS_URL"];
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  });

  it("续期**不拿新 AK 的哈希覆盖稳定 uid**（否则每次续期都换一个账号身份）", async () => {
    const fake = await startFakeUpstream();
    process.env["CODEARTS_STS_URL"] = `${fake.base}/v1/oauth2/tokens`;
    fake.routes.set("/v1/oauth2/tokens", () => ({
      status: 200,
      body: {
        credentials: {
          // ⚠ 换了一套新 AK —— 旧算法会据此算出**不同**的伪 uid
          access_key_id: "HSTANEWKEYAFTERREFRESH",
          secret_access_key: SK,
          security_token: "ST-NEW",
          expiration: "2030-01-01T00:00:00Z",
        },
        // ⚠ 关键：返回一个**解不出身份**的 refresh token（非 JWT）。
        // 这种信封下 `credentialFromTokenResponse` 只能退到「新 AK 的哈希」，
        // 于是 `next.uid` 是个伪身份 —— 续期路径必须**不采信**它，否则
        // 每次续期都会把账号身份换掉，账号池随之把同一个人记成新账号。
        refresh_token: "opaque-token-not-a-jwt",
      },
    }));
    const keyPair = cred.generateDpopKeyPair();
    const stableUid = "019fb1171afe7d21a114c649628b72e1";
    await cred.save({
      ...FAKE_CREDENTIAL,
      uid: stableUid, // 已修正的稳定身份
      accessKeyId: AK,
      dpopPrivateKeyJwk: keyPair.privateKeyJwk,
      codeVerifier: "cv-1",
      refreshToken: refreshTokenJwt({ jti: "old" }),
    });
    cred.resetRefreshQueue();
    try {
      const next = await cred.refresh(cred.load());
      assert.equal(next.accessKeyId, "HSTANEWKEYAFTERREFRESH", "AK 确实换了");
      assert.equal(
        next.uid,
        stableUid,
        "uid 必须仍是那个人的 account_id，不能被新 AK 的哈希顶掉",
      );
      assert.equal(cred.load().uid, stableUid, "落盘同样保持");
      assert.notEqual(
        next.uid,
        createHash("sha256").update("HSTANEWKEYAFTERREFRESH").digest("hex").slice(0, 16),
        "尤其不能等于新 AK 的哈希",
      );
    } finally {
      delete process.env["CODEARTS_STS_URL"];
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  });

  it("终态只认 invalid_grant / ExpiredRefreshToken；InvalidDPoPHeader 不是终态", async () => {
    const fake = await startFakeUpstream();
    process.env["CODEARTS_STS_URL"] = `${fake.base}/v1/oauth2/tokens`;
    const keyPair = cred.generateDpopKeyPair();
    await cred.save({
      ...FAKE_CREDENTIAL,
      dpopPrivateKeyJwk: keyPair.privateKeyJwk,
      refreshToken: "rt-1",
      codeVerifier: "cv-1",
    });
    cred.resetRefreshQueue();
    try {
      fake.routes.set("/v1/oauth2/tokens", () => ({
        status: 400,
        body: { error: "invalid_grant", error_msg: "refresh token expired" },
      }));
      await assert.rejects(() => cred.refresh(cred.load()), cred.RefreshTokenExpiredError);

      fake.routes.set("/v1/oauth2/tokens", () => ({
        status: 400,
        body: { error_code: "STS.5.ExpiredRefreshToken" },
      }));
      await assert.rejects(() => cred.refresh(cred.load()), cred.RefreshTokenExpiredError);

      fake.routes.set("/v1/oauth2/tokens", () => ({
        status: 401,
        body: { error: "InvalidDPoPHeader", error_msg: "proof expired" },
      }));
      await assert.rejects(
        () => cred.refresh(cred.load()),
        (err: unknown) => err instanceof Error && !(err instanceof cred.RefreshTokenExpiredError),
        "InvalidDPoPHeader 是一次请求层面的拒绝，不能把账号标死",
      );
    } finally {
      delete process.env["CODEARTS_STS_URL"];
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  });

  it("缺 DPoP / code_verifier / refresh_token 时明确抛错（不假装续期）", async () => {
    await cred.save({ ...FAKE_CREDENTIAL, dpopPrivateKeyJwk: null });
    cred.resetRefreshQueue();
    await assert.rejects(() => cred.refresh(cred.load()), /无法静默续期/);
  });
});

describe("8. 登录 URL 与回调", () => {
  it("授权 URL：SHA-256（非 S256）、无 auth_callback_url、插件常量逐字", () => {
    const pkce = cred.generatePkcePair();
    process.env["CODEARTS_PORTAL_BASE"] = "https://portal.example";
    try {
      const url = cred.buildLoginUrl(12345, pkce, "ticket-1");
      assert.ok(url.startsWith("https://portal.example/portal/authorize?theme=2&locale=zh-cn"));
      assert.ok(url.includes("uri_scheme=codearts-agent&client_id=codearts-agent"));
      assert.ok(url.includes("&port=12345"));
      assert.ok(url.includes("code_challenge_method=SHA-256"), "错值会静默回退旧 ticket 流程");
      assert.ok(!url.includes("S256&"), "不能是 RFC 缩写 S256");
      assert.ok(!url.includes("auth_callback_url"), "portal 只认 port 参数");
      assert.ok(url.includes("plugin-name=snap_AIIDE&plugin-version=5.2.0"));
      assert.ok(url.includes(`code_challenge=${pkce.codeChallenge}`));
    } finally {
      delete process.env["CODEARTS_PORTAL_BASE"];
    }
  });

  it("回调：端口 ≥10000、code 换取成功 → 307 到成功页；旧流程 secret → 307 + 轮询", async () => {
    const fake = await startFakeUpstream();
    process.env["CODEARTS_STS_URL"] = `${fake.base}/v1/oauth2/tokens`;
    fake.routes.set("/v1/oauth2/tokens", () => ({
      status: 200,
      body: {
        credentials: { access_key_id: "AK2", secret_access_key: "SK2", security_token: "ST2", expiration: "2030-01-01T00:00:00Z" },
        refresh_token: "rt2",
      },
    }));
    const pkce = cred.generatePkcePair();
    const keyPair = cred.generateDpopKeyPair();
    const srv = await cred.startCallbackServer({ pkce, keyPair, ticketId: "t1", timeoutMs: 5_000 });
    try {
      assert.ok(srv.port >= 10_000, "回调端口必须 ≥10000");
      const resp = await fetch(`http://127.0.0.1:${srv.port}${cred.REDIRECT_PATH}?code=code-1`, {
        redirect: "manual",
      });
      assert.equal(resp.status, 307);
      assert.ok(String(resp.headers.get("location")).includes("login_succeed=true"));
      const c = await srv.result;
      assert.equal(c.accessKeyId, "AK2");
      assert.equal(c.refreshToken, "rt2");

      // 旧流程：secret + redirect
      const legacy = await cred.startCallbackServer({
        pkce,
        keyPair,
        ticketId: "t2",
        timeoutMs: 2_000,
        pollTicket: async () => ({ ...FAKE_CREDENTIAL, accessKeyId: "AK-LEGACY" }),
      });
      try {
        const r2 = await fetch(
          `http://127.0.0.1:${legacy.port}${cred.REDIRECT_PATH}?secret=s1&redirect=https%3A%2F%2Fportal.example%2Fdone`,
          { redirect: "manual" },
        );
        assert.equal(r2.status, 307);
        assert.equal(r2.headers.get("location"), "https://portal.example/done");
        assert.equal((await legacy.result).accessKeyId, "AK-LEGACY");
      } finally {
        await legacy.close();
      }
    } finally {
      await srv.close();
      delete process.env["CODEARTS_STS_URL"];
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  });
});

describe("9. 额度与活动", () => {
  it("裸对象信封：总额取 usageTotalPackageCredit（不累加分类）", async () => {
    const fake = await startFakeUpstream();
    await upstream.saveConfig({ baseUrl: fake.base });
    await saveFakeCredential();
    fake.routes.set("/snap-manager/v1/statistics/plugin", () => ({
      status: 200,
      body: {
        // ⚠️ 裸对象：没有 {code,data} 信封
        package: {
          is_credit_package: true,
          is_token_package: false,
          spec_code: "codearts.agent.enterprise.ultimate_pro",
          package_name_cn: "专家版",
          status: "ACTIVE",
        },
        metrics: [
          { name: "usageTotalPackageCredit", package_credit_amount: 5000, package_credit_used: 1000, package_credit_remain: 4000 },
          { name: "usageBasicPackageCredit", package_credit_amount: 3000, package_credit_used: 1000, package_credit_remain: 2000 },
          { name: "usageBonusPackageCredit", package_credit_amount: 0, package_credit_used: 0, package_credit_remain: 0 },
        ],
      },
    }));
    fake.routes.set("/v1/ops/delivery", () => ({
      status: 200,
      body: {
        code: 0,
        message: "ok",
        data: {
          items: [
            // ⚠️ campaignId 是数字；可领积分是 benefitAmount；不可领取时 status 为 null
            { campaignId: 1, type: "USER_LOGIN", title: "每日登录", claimable: true, status: null, benefitAmount: 1000 },
            { campaignId: 2, type: "INVITE_USER", title: "邀请", claimable: true, benefitAmount: 500 },
          ],
        },
      },
    }));
    fake.routes.set("/v1/ops/claim", () => ({ status: 200, body: { code: 0, message: "ok", data: { id: 77 } } }));
    fake.routes.set("/v1/ops/confirm", () => ({ status: 200, body: { code: 0, message: "ok", data: {} } }));
    try {
      const info = await billing.fetchCredits();
      assert.equal(info.total.remain, 4000, "总额取总 metric，不累加分类");
      assert.equal(info.total.used, 1000);
      assert.equal(info.total.size, 5000);
      assert.equal(info.account!.isCreditPackage, true);
      assert.equal(info.packages.length, 2, "额度为 0 的分类不列");
      assert.equal(info.claimable!.length, 1, "只列每日签到活动");
      assert.equal(info.claimable![0]!["campaign_id"], "1");
      assert.equal(info.claimable![0]!["amount"], 1000);

      // 签名 GET 的附加头在签名之后追加
      const record = lastAt(fake, "/snap-manager/v1/statistics/plugin")!;
      assert.equal(record.headers["agent-type"], "PromptCenter");
      assert.equal(record.headers["x-language"], "zh-cn");
      const signedKeys = String(record.headers["authorization"]).split("SignedHeaders=")[1]!.split(",")[0]!;
      assert.ok(!signedKeys.includes("agent-type"), "Agent-Type 进签名会 401 APIG.0301");
      assert.ok(signedKeys.includes("x-security-token"));

      const activities = await billing.fetchActivities(FAKE_CREDENTIAL);
      assert.equal(activities[0]!.campaignId, "1");
      assert.equal(activities[0]!.amount, 1000);
      assert.equal(activities[0]!.status, "");
      assert.equal(activities[1]!.type, "INVITE_USER");
      assert.equal(lastAt(fake, "/v1/ops/delivery")!.query["channel"], "IDE");

      const outcomes = await billing.claimDailyLogin(FAKE_CREDENTIAL);
      assert.equal(outcomes.length, 1, "只领 USER_LOGIN");
      assert.equal(outcomes[0]!.confirmed, true, "claim 返回 data.id 非空 → 必须补 confirm");
      assert.equal(lastAt(fake, "/v1/ops/claim")!.body!["campaignId"], "1", "campaignId 回传字符串");
      assert.equal(lastAt(fake, "/v1/ops/claim")!.body!["channel"], "IDE");
      assert.equal(lastAt(fake, "/v1/ops/confirm")!.body!["campaignId"], "1");

      // claim 返回 id 为空 → 不补 confirm
      fake.captured.length = 0;
      fake.routes.set("/v1/ops/claim", () => ({ status: 200, body: { code: 0, data: { id: null } } }));
      await billing.claimDailyLogin(FAKE_CREDENTIAL);
      assert.equal(lastAt(fake, "/v1/ops/confirm"), undefined, "漏掉 confirm 会让积分停在待确认");
    } finally {
      await upstream.saveConfig(upstream.defaultConfig());
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  });

  it("Token 计费账户没有积分口径 → CreditsError（查不到不等于 0）", async () => {
    const fake = await startFakeUpstream();
    await upstream.saveConfig({ baseUrl: fake.base });
    await saveFakeCredential();
    fake.routes.set("/snap-manager/v1/statistics/plugin", () => ({
      status: 200,
      body: { package: { is_credit_package: false, is_token_package: true }, metrics: [] },
    }));
    try {
      await assert.rejects(() => billing.fetchCredits(), billing.CreditsError);
    } finally {
      await upstream.saveConfig(upstream.defaultConfig());
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  });

  it("401 → NotLoggedInError（带服务端 error_code 线索）", async () => {
    const fake = await startFakeUpstream();
    await upstream.saveConfig({ baseUrl: fake.base });
    await saveFakeCredential();
    fake.routes.set("/snap-manager/v1/statistics/plugin", () => ({
      status: 401,
      body: { error_code: "APIG.0301", error_msg: "verify ak sk signature fail" },
    }));
    try {
      await assert.rejects(
        () => billing.fetchCredits({ refreshOn401: false }),
        (err: unknown) => err instanceof cred.NotLoggedInError && String(err).includes("APIG.0301"),
      );
    } finally {
      await upstream.saveConfig(upstream.defaultConfig());
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  });
});

describe("10. 端到端网关（假上游）", () => {
  const holder: { fake: Awaited<ReturnType<typeof startFakeUpstream>> | null } = { fake: null };
  let gw: gateway.RunningGateway;

  before(async () => {
    const fake = await startFakeUpstream();
    holder.fake = fake;
    process.env["CODEARTS_OPENGW_URL"] = `${fake.base}/api/v1/gateway/config`;
    fake.routes.set("/api/v1/gateway/config", () => ({
      status: 200,
      body: {
        result: {
          models: [
            // gate 的 benefit 模型：未改写 id 记为 benefit
            { model_id: "glm-5.3-flash", model_name: "glm-5.3-flash" },
            // 带日期后缀：归一化后落到无后缀（非 benefit），**不得**标成 benefit
            { model_id: "deepseek-v4-flash-0731", model_name: "deepseek-v4-flash-0731" },
          ],
        },
      },
    }));
    fake.routes.set("/v1/model/builtin", () => ({
      status: 200,
      body: {
        count: 2,
        builtinModels: [
          { model_id: "GLM-5.2", model_name: "GLM-5.2" },
          { model_id: "deepseek-v4-flash-0731", model_name: "dup" },
        ],
      },
    }));
    fake.routes.set("/api/v2/chat/completions", () => ({
      status: 200,
      raw: [
        `data:{"id":"c1","choices":[{"index":0,"delta":{"content":"网关"},"finish_reason":null}]}\n\n`,
        `data:{"id":"c1","choices":[{"index":0,"delta":{"content":"通了","reasoning_content":null}}]}\n\n`,
        `data:{"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
        "data: [DONE]\n\n",
      ].join(""),
    }));
    await upstream.saveConfig({ baseUrl: fake.base });
    await saveFakeCredential();
    // auth-flow 在真实启动时会调它（顺便灌目录 + benefit 集合）
    await upstream.fetchModels(FAKE_CREDENTIAL);
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    delete process.env["CODEARTS_OPENGW_URL"];
    await upstream.saveConfig(upstream.defaultConfig());
    const fake = holder.fake;
    if (fake) await new Promise<void>((r) => fake.server.close(() => r()));
  });

  it("fetchModels 合并两目录并写 benefit 缓存", () => {
    const fake = holder.fake!;
    assert.deepEqual(
      catalog.exposedIds(),
      ["glm-5.3-flash", "deepseek-v4-flash"],
      "GLM-5.2 非 flash → 不进池；openpangu-2.0-flash 是 flash 但非 deepseek/glm → 也挡下（数据仍在底层目录）",
    );
    assert.equal(catalog.isBenefitModel("glm-5.3-flash"), true);
    assert.equal(
      catalog.isBenefitModel("deepseek-v4-flash"),
      false,
      "带后缀的 benefit id 归一化后不得把无后缀模型标成 benefit",
    );
    const builtin = lastAt(fake, "/v1/model/builtin")!;
    assert.equal(builtin.headers["agent-type"], "PromptCenter");
    const signedKeys = String(builtin.headers["authorization"]).split("SignedHeaders=")[1]!.split(",")[0]!;
    assert.ok(!signedKeys.includes("agent-type"));
    assert.equal(builtin.headers["x-security-token"], ST);
    // undici 会按实际连接目标生成 Host（我们签名时用的也是同一个 host ——
    // signRequest 从 URL 取值，故签名里的 host 与实际发送的一致）。
    assert.equal(builtin.headers["host"], `127.0.0.1:${fake.port}`);
    assert.ok(
      signedKeys.includes("host"),
      "host 在 canonical 里是必需项，只是不手工发送",
    );
    // 空体 GET：payload hash 为空串哈希
    assert.equal(builtin.headers["x-sdk-content-sha256"], "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    // benefit 目录不带任何额外未签名头
    assert.equal(lastAt(fake, "/api/v1/gateway/config")!.headers["agent-type"], undefined);
  });

  it("/v1/models 暴露目录，/health 报告登录状态", async () => {
    const models = (await (await fetch(`http://${gw.addr}/v1/models`)).json()) as {
      data: Array<{ id: string }>;
    };
    assert.deepEqual(
      models.data.map((m) => m.id),
      ["glm-5.3-flash", "deepseek-v4-flash"],
      "flash-only 池策略（GLM-5.2 非 flash）",
    );
    const health = (await (await fetch(`http://${gw.addr}/health`)).json()) as Record<string, unknown>;
    assert.equal(health["logged_in"], true);
  });

  it("流式对话：上游收到真实签名（payload hash 与 body 一致）+ benefit 头", async () => {
    const fake = holder.fake!;
    fake.captured.length = 0;
    const text = await readSseFrames(`http://${gw.addr}/v1/chat/completions`, {
      model: "glm-5.3-flash",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    assert.equal(text, "网关通了");

    const record = lastAt(fake, "/api/v2/chat/completions")!;
    // 签名自洽：x-sdk-content-sha256 == sha256(收到的原始 body)
    const expectedHash = sha256HexExpectation(record.raw);
    assert.equal(record.headers["x-sdk-content-sha256"], expectedHash, "签名必须覆盖真实请求体");
    assert.equal(record.headers["maas_type"], "benefit", "benefit 模型必须带 maas_type");
    assert.equal(record.headers["x-security-token"], ST);
    assert.ok(String(record.headers["authorization"]).startsWith("SDK-HMAC-SHA256 Access="));
    // Host 由运行时按实际连接目标生成，与我们签名时取值的来源（URL）一致。
    assert.equal(record.headers["host"], `127.0.0.1:${fake.port}`);
    assert.equal(record.headers["lang"], "en");
    assert.equal(record.headers["agent-type"], undefined, "chat 头不含 Agent-Type（它也不进签名）");
    assert.match(String(record.headers["chat-id"]), /^[0-9a-f]{32}$/);
    assert.equal(record.body!["stream"], true);
    assert.equal(record.body!["model"], "glm-5.3-flash");
    assert.equal(record.body!["prompt_cache_key"], record.headers["session-id"]);
  });

  it("非流式：本层聚合成 chat.completion；非 benefit 模型不带 maas_type", async () => {
    const fake = holder.fake!;
    fake.captured.length = 0;
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-v4-flash-0731", messages: [{ role: "user", content: "hi" }] }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 200);
    const payload = (await resp.json()) as { object: string; choices: Array<{ message: { content: string } }> };
    assert.equal(payload.object, "chat.completion");
    assert.equal(payload.choices[0]!.message.content, "网关通了");
    const record = lastAt(fake, "/api/v2/chat/completions")!;
    assert.equal(record.body!["model"], "deepseek-v4-flash", "短名归一化去后缀");
    assert.equal(record.headers["maas_type"], undefined);
  });

  it("上游 500 → 502 且不回传上游原文", async () => {
    const fake = holder.fake!;
    fake.routes.set("/api/v2/chat/completions", () => ({
      status: 500,
      body: { error_code: "APIG.9999", error_msg: "internal detail leak" },
    }));
    try {
      const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: "GLM-5.2", messages: [{ role: "user", content: "hi" }], stream: true }),
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(resp.status, 502);
      const payload = (await resp.json()) as { error: { code: string; message: string } };
      assert.equal(payload.error.code, "upstream_error");
      assert.ok(!payload.error.message.includes("internal detail leak"));
    } finally {
      fake.routes.set("/api/v2/chat/completions", () => ({
        status: 200,
        raw: "data: [DONE]\n\n",
      }));
    }
  });
});
