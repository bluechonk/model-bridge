/**
 * qodercn-bridge 自检（**完全离线**，不出网）。
 *
 * 覆盖四块实现里最容易悄悄写错、又最难在真机上定位的部分：
 *
 * 1. **COSY 签名与自定义 Base64** —— 算法是从参考实现复刻的，必须用固定向量锁死
 *    （`temp_key` 与 `requestId` 随机，所以锁的是编码/排序/派生这类**确定性**环节）。
 * 2. **设备指纹** —— 必须按 uid 稳定派生；随机化会触发上游风控。
 * 3. **流式信封解包** —— 心跳帧误判成错误是最典型的坑（正常回完内容却报失败）。
 * 4. **模型映射** —— `dfmodel`/`gfmodel` 进池、`dmodel`/`gmodel` 不进，决定本渠道
 *    能不能给公共模型池贡献模型。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearChannels, getChannel, paths, setChannel } from "@model-bridge/gateway";

import * as catalog from "../dist/catalog.js";
import * as channelModule from "../dist/channel.js";
import * as cred from "../dist/cred.js";
import * as upstream from "../dist/upstream.js";

let root = "";
let savedRoot: string | undefined;

before(() => {
  root = mkdtempSync(join(tmpdir(), "mb-qoder-"));
  savedRoot = process.env["MODEL_BRIDGE_HOME"];
  process.env["MODEL_BRIDGE_HOME"] = root;
});

after(() => {
  if (savedRoot === undefined) delete process.env["MODEL_BRIDGE_HOME"];
  else process.env["MODEL_BRIDGE_HOME"] = savedRoot;
  rmSync(root, { recursive: true, force: true });
});

// ── 1. 自定义 Base64 ─────────────────────────────────────────────────────────

describe("1. Qoder 自定义 Base64 变体", () => {
  it("固定向量：{} 编码为 $kwm", () => {
    assert.equal(upstream.qoderEncode("{}"), "$kwm");
  });

  it("往返一致（含多字节中文）", () => {
    for (const text of ["", "a", "hello world", '{"a":1}', "中文测试 · emoji 🐋"]) {
      const encoded = upstream.qoderEncode(text);
      assert.equal(upstream.qoderDecode(encoded).toString("utf8"), text, text);
    }
  });

  it("填充符是 $ 而不是 =（服务端按自定义字母表校验）", () => {
    const encoded = upstream.qoderEncode("a"); // 1 字节 → 必有填充
    assert.ok(encoded.includes("$"), encoded);
    assert.ok(!encoded.includes("="), encoded);
  });

  it("用私有字母表，不是标准 base64 字符集", () => {
    // "hello world" 的标准 base64 是 aGVsbG8gd29ybGQ=；编码后不应出现 '='
    const encoded = upstream.qoderEncode("hello world");
    assert.notEqual(encoded, Buffer.from("hello world").toString("base64"));
    assert.ok(!/[=+/]/.test(encoded), encoded);
  });
});

describe("2. 紧凑排序 JSON 与签名 path", () => {
  it("键排序 + null 视作空串 + 无空白", () => {
    assert.equal(
      upstream.sortedCompactJson({ b: 1, a: "x", c: null }),
      '{"a":"x","b":1,"c":""}',
    );
  });

  it("签名用的 path 去掉 /algo 前缀（服务端就是这么算的）", () => {
    assert.equal(
      upstream.signPathOf("https://api1.qoder.sh/algo/api/v2/model/list?Encode=1"),
      "/api/v2/model/list",
    );
    assert.equal(
      upstream.signPathOf(
        "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1",
      ),
      "/api/v2/service/pro/sse/agent_chat_generation",
    );
    // 不带 /algo 的路径原样保留
    assert.equal(upstream.signPathOf("https://x/y/z"), "/y/z");
  });
});

// ── 2. 设备指纹 ──────────────────────────────────────────────────────────────

describe("3. 设备指纹：按 uid 稳定派生", () => {
  it("固定向量", () => {
    assert.equal(cred.machineIdOf("uid-1"), "1b196e499e3cd32e36358cb5450a9914");
    assert.equal(cred.machineTypeOf("uid-1"), "8a96d80e2a78b00839");
    assert.equal(cred.machineTokenOf("uid-1"), "32Ugo4rViVtY4Ssqidb_KmmueV0j5CqfTmMtmmIuj-4");
  });

  it("幂等：同一 uid 永远同一台虚拟设备", () => {
    assert.equal(cred.machineIdOf("u"), cred.machineIdOf("u"));
    assert.equal(cred.machineTypeOf("u"), cred.machineTypeOf("u"));
    assert.equal(cred.machineTokenOf("u"), cred.machineTokenOf("u"));
  });

  it("不同账号之间隔离", () => {
    assert.notEqual(cred.machineIdOf("a"), cred.machineIdOf("b"));
    assert.notEqual(cred.machineTokenOf("a"), cred.machineTokenOf("b"));
  });

  it("长度符合上游预期（machineid 32 / machinetype 18 / machinetoken 43）", () => {
    assert.equal(cred.machineIdOf("u").length, 32);
    assert.equal(cred.machineTypeOf("u").length, 18);
    assert.equal(cred.machineTokenOf("u").length, 43);
    assert.ok(!cred.machineTypeOf("u").includes("-"), "machinetype 不能带横线");
  });
});

// ── 3. COSY 会话与头 ─────────────────────────────────────────────────────────

describe("4. COSY 会话与签名头", () => {
  const identity = {
    name: "",
    uid: "uid-1",
    nickname: "鲸鱼",
    userType: cred.DEFAULT_USER_TYPE,
    accessToken: "dt-token",
    refreshToken: "drt-token",
    realm: "cn" as const,
  };

  it("bearer 形态是 `Bearer COSY.<payload>.<md5>`", () => {
    const session = new upstream.CosySession(identity);
    const { authorization, date } = session.bearer(upstream.emptyEncodedBody(), "https://x/algo/a/b");
    const parts = authorization.split(" ");
    assert.equal(parts[0], "Bearer");
    const token = parts[1]!.split(".");
    assert.equal(token.length, 3);
    assert.equal(token[0], "COSY");
    // payload 是 base64，sig 是 32 位 hex md5
    assert.match(token[2]!, /^[0-9a-f]{32}$/);
    assert.match(date, /^\d{10}$/);
  });

  it("同一会话签名稳定可复算（body/path/date 相同则 sig 只差 payload 里的 requestId）", () => {
    const session = new upstream.CosySession(identity);
    const a = session.bearer("body", "https://x/algo/p");
    const b = session.bearer("body", "https://x/algo/p");
    // requestId 随机 → payload 不同 → 签名不同；但 payload 结构一致
    assert.notEqual(a.authorization, b.authorization);
    assert.equal(a.authorization.split(".").length, b.authorization.split(".").length);
  });

  it("头集合含全部必需项，且 machineid 与派生值一致", () => {
    const session = new upstream.CosySession(identity);
    const headers = session.headers("body", "https://x/algo/p", "dfmodel");
    for (const key of [
      "authorization",
      "cosy-version",
      "cosy-key",
      "cosy-date",
      "cosy-user",
      "cosy-machineid",
      "cosy-machinetoken",
      "cosy-machinetype",
      "cosy-clienttype",
      "cosy-data-policy",
      "login-version",
      "x-model-key",
    ]) {
      assert.ok(headers[key], `缺头：${key}`);
    }
    assert.equal(headers["cosy-machineid"], cred.machineIdOf("uid-1"));
    assert.equal(headers["cosy-machinetoken"], cred.machineTokenOf("uid-1"));
    assert.equal(headers["cosy-user"], "uid-1");
    // 推理走 CLI 身份（5），不是桌面身份（10）
    assert.equal(headers["cosy-clienttype"], "5");
    assert.equal(headers["x-model-source"], "system");
    assert.equal(headers["cosy-version"], upstream.COSY_VERSION);
  });

  it("access token 变化会让会话重建（cosy-key 随之改变）", () => {
    const first = new upstream.CosySession(identity);
    const second = new upstream.CosySession({ ...identity, accessToken: "dt-2" });
    assert.notEqual(first.cosyKey, second.cosyKey, "会话密钥每次重建都不同");
  });
});

// ── 4. 流式信封 ──────────────────────────────────────────────────────────────

describe("5. SSE 信封解包", () => {
  /** 跑一遍翻译器，收集输出。 */
  function feedAll(chunks: string[]): string {
    const translator = upstream.newTranslator();
    const out: string[] = [];
    for (const chunk of chunks) {
      for (const frame of translator.feed(Buffer.from(chunk, "utf8"))) out.push(String(frame));
    }
    for (const frame of translator.finish()) out.push(String(frame));
    return out.join("");
  }

  const envelope = (body: unknown): string =>
    `data:${JSON.stringify({ headers: {}, body: typeof body === "string" ? body : JSON.stringify(body), statusCodeValue: 200 })}\n\n`;

  it("内层 chunk 原样透传为标准 OpenAI SSE", () => {
    const chunk = { choices: [{ index: 0, delta: { content: "鲸" } }] };
    const out = feedAll([envelope(chunk)]);
    assert.ok(out.includes('"content":"鲸"'), out);
    assert.ok(out.startsWith("data: "), out);
  });

  it("心跳帧（body 为 null / 空串 / {}）整帧跳过，不当错误", () => {
    const out = feedAll([envelope(null), envelope(""), envelope({})]);
    assert.equal(out, "", "心跳不该产出任何帧");
  });

  it("[DONE] 原样传递", () => {
    const out = feedAll(["data: [DONE]\n\n"]);
    assert.ok(out.includes("[DONE]"));
  });

  it("信封 statusCodeValue != 200 → 产出 error 帧", () => {
    const bad = `data:${JSON.stringify({ headers: {}, body: "", statusCodeValue: 418 })}\n\n`;
    const out = feedAll([bad]);
    assert.ok(out.includes('"error"'), out);
    assert.ok(out.includes("418"), out);
  });

  it("内层业务错误保真 code（下游靠 code=10605 识别排队）", () => {
    const inner = { code: "10605", message: JSON.stringify({ isQueued: true, retryAfterSeconds: 30 }) };
    const out = feedAll([envelope(inner)]);
    assert.ok(out.includes("10605"), out);
  });

  it("非 200 信封内嵌的业务错误要保真（真机：403 裹 10605 排队）", () => {
    // 实测原帧：statusCodeValue=403，body 里再套一层 {"code":"403","message":"{…10605…isQueued…}"}。
    // 修前只回通用文案「Qoder upstream returned 403」，共享层认不出排队 →
    // 非流式聚合出空 completion。这里锁死「内层信息必须活着出来」。
    const inner = JSON.stringify({
      code: "10605",
      message: JSON.stringify({ isQueued: true, retryAfterSeconds: 30, serviceAvailable: false }),
    });
    const body = JSON.stringify({ code: "403", message: inner });
    const frame = `data:${JSON.stringify({
      headers: { "Content-Type": ["application/json"] },
      body,
      statusCodeValue: 403,
      statusCode: "FORBIDDEN",
    })}\n\n`;
    const out = feedAll([frame]);
    const line = out.split("\n").find((l) => l.startsWith("data: "));
    assert.ok(line, `非 200 信封必须产出 error 帧：${JSON.stringify(out)}`);
    const payload = JSON.parse(line.slice(6)) as Record<string, unknown>;
    assert.equal(upstream.isQueueError(payload), true, `排队帧必须被识别：${out}`);
  });

  it("跨 chunk 切断的行能拼回来（增量解析）", () => {
    const whole = envelope({ choices: [{ index: 0, delta: { content: "OK" } }] });
    const half = Math.floor(whole.length / 2);
    const out = feedAll([whole.slice(0, half), whole.slice(half)]);
    assert.ok(out.includes('"content":"OK"'), out);
  });

  it("统计帧（既无 choices 也无 usage）必须跳过，不能透传", () => {
    // Qoder 的流里会混进这种帧；原样透传会让 OpenAI 客户端校验失败
    // （ZCode 报 Type validation failed: expected array, received undefined）
    const out = feedAll([
      envelope({ firstTokenDuration: 185, totalDuration: 926, serverDuration: 296 }),
    ]);
    assert.equal(out, "", "统计帧必须丢弃");
  });

  it("裸的统计帧（没套信封）也必须丢弃", () => {
    const out = feedAll(['data: {"firstTokenDuration":136,"totalDuration":678,"serverDuration":94}\n\n']);
    assert.equal(out, "", "裸统计帧同样要丢弃");
  });

  it("usage-only 帧要透传（有 usage 就算 chunk）", () => {
    const out = feedAll([
      envelope({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
    ]);
    assert.ok(out.includes("prompt_tokens"), out);
  });

  it("choices 为空数组也算 chunk（结束帧）", () => {
    const out = feedAll([envelope({ choices: [] })]);
    assert.ok(out.includes('"choices":[]'), out);
  });

  it("非信封帧（有些渠道直发标准 chunk）原样透传", () => {
    const out = feedAll(['data: {"choices":[{"delta":{"content":"x"}}]}\n\n']);
    assert.ok(out.includes('"content":"x"'), out);
  });
});

// ── 5. 模型目录 ──────────────────────────────────────────────────────────────

describe("6. 模型目录映射（决定能否进公共模型池）", () => {
  it("兜底表只有进池的那一条（4.0 已出池）", () => {
    assert.deepEqual(catalog.exposedIds().sort(), ["glm-5.3-flash"]);
  });

  it("对外 id → 上游 key；三种输入形态都认", () => {
    assert.equal(catalog.resolveModel("glm-5.3-flash"), "gfmodel");
    assert.equal(catalog.resolveModel("gfmodel"), "gfmodel");
    assert.equal(catalog.resolveModel("GLM-5.3-Flash"), "gfmodel");
    assert.equal(
      catalog.resolveModel("deepseek-v4-flash"),
      "deepseek-v4-flash",
      "4.0 已出池，不再映射，原样返回",
    );
    assert.equal(catalog.resolveModel("未知模型"), "未知模型", "未命中原样返回");
  });

  it("同家族的非 flash 型号不进池（dmodel = V4-Pro、gmodel = GLM-5.3）", () => {
    const ids = catalog.exposedIds();
    assert.ok(!ids.includes("dmodel"));
    assert.ok(!ids.includes("gmodel"));
    assert.ok(!ids.some((id) => id.includes("pro")));
  });

  it("目录条目的元数据可用于请求体（reasoning / 上下文）", () => {
    const entry = catalog.entryOf("glm-5.3-flash");
    assert.ok(entry);
    assert.equal(entry.key, "gfmodel");
    assert.equal(entry.displayName, "GLM-5.3-Flash");
    assert.equal(entry.maxInputTokens, 1_000_000);
    assert.equal(catalog.entryOf("deepseek-v4-flash"), null, "已出池的 4.0 不在目录里");
  });
});

// ── 6. 请求体构造 ────────────────────────────────────────────────────────────

describe("7. 推理请求体", () => {
  const body = () =>
    upstream.buildRequestBody(
      {
        model: "glm-5.3-flash",
        messages: [
          { role: "system", content: "你是助手" },
          { role: "user", content: "你好" },
        ],
        tools: [{ type: "function", function: { name: "Bash" } }],
        max_tokens: 128,
      },
      "dfmodel",
    );

  it("business 必填（缺了会被路由到故障节点）", () => {
    const b = body();
    assert.ok(b["business"], "business 必填");
    assert.equal((b["business"] as { type?: string }).type, "agent");
  });

  it("chat_context.text 是对象形态，不是字符串", () => {
    const b = body();
    const ctx = b["chat_context"] as Record<string, unknown>;
    assert.deepEqual(ctx["text"], { type: "text", text: "你好" });
    assert.equal(ctx["imageUrls"], null, "图片恒走 messages[].content，这里恒 null");
  });

  it("tools 顶层真发；无工具时是空数组而不是缺字段", () => {
    assert.equal((body()["tools"] as unknown[]).length, 1);
    const none = upstream.buildRequestBody({ messages: [{ role: "user", content: "hi" }] }, "dfmodel");
    assert.deepEqual(none["tools"], []);
  });

  it("system 抽成 messages 首条；三个 id 齐全且 stream 恒 true", () => {
    const b = body();
    const messages = b["messages"] as Array<{ role: string }>;
    assert.equal(messages[0]!.role, "system");
    assert.equal(messages[1]!.role, "user");
    assert.equal(b["stream"], true, "上游只支持流式");
    assert.ok(b["request_id"] && b["chat_record_id"] && b["session_id"]);
    assert.ok(b["model_config"], "model_config 必填");
  });

  it("会话类型按区域取（国内 qoder_work / 国际 qodercli）", () => {
    const cn = upstream.buildRequestBody({ messages: [] }, "dfmodel", {}, "cn");
    const intl = upstream.buildRequestBody({ messages: [] }, "dfmodel", {}, "intl");
    assert.equal(cn["session_type"], "qoder_work");
    assert.equal(intl["session_type"], "qodercli");
  });
});

// ── 7. 登录 URL 与 PKCE ──────────────────────────────────────────────────────

describe("8. 设备授权 URL 与 PKCE", () => {
  it("challenge = base64url(sha256(verifier))，且不带 = padding", () => {
    const { verifier, challenge } = cred.makePkce();
    assert.ok(verifier.length >= 43 && verifier.length <= 128, `verifier 长度 ${verifier.length}`);
    assert.ok(!challenge.includes("="), "challenge 不能带 padding");
    const expected = createHash("sha256").update(verifier, "utf8").digest("base64url");
    assert.equal(challenge, expected);
  });

  it("国内：带 redirect_uri + client_id + machine_id，nonce 是带横线 UUID", () => {
    const product = cred.PRODUCTS.cn;
    const url = cred.buildAuthUrl(product, "CH", "11111111-2222-3333-4444-555555555555", "MACHINE");
    const query = new URL(url).searchParams;
    assert.equal(query.get("challenge_method"), "S256");
    assert.equal(query.get("redirect_uri"), "qoder-work-cn://");
    assert.equal(query.get("client_id"), product.clientId);
    assert.equal(query.get("machine_id"), "MACHINE");
    assert.ok(url.startsWith("https://qoder.com.cn/device/selectAccounts?"));
  });

  it("国际：不带 redirect_uri，nonce 是 32 位 hex", () => {
    const product = cred.PRODUCTS.intl;
    const url = cred.buildAuthUrl(product, "CH", "a".repeat(32), "MACHINE");
    const query = new URL(url).searchParams;
    assert.equal(query.get("redirect_uri"), null, "国际版不带 redirect_uri");
    assert.equal(query.get("client_id"), product.clientId);
    assert.ok(url.startsWith("https://qoder.com/device/selectAccounts?"));
  });

  it("区域锁定：无论传什么参数，都返回本渠道的区域", () => {
    assert.equal(cred.CHANNEL_REALM, "cn", "国内版渠道固定 cn");
    assert.equal(cred.normalizeRealm("intl"), "cn", "--realm intl 不该让本渠道串到国际区");
    assert.equal(cred.normalizeRealm("auto"), "cn");
    assert.equal(cred.normalizeRealm(undefined), "cn");
    assert.equal(cred.productOf("intl").domain, "qoder.com.cn", "productOf 也只认本区");
    assert.equal(cred.DEFAULT_BASE_URL, "https://openapi.qoder.com.cn");
    assert.equal(cred.resolveBaseUrl("intl"), "https://openapi.qoder.com.cn");
  });

  it("两区端点互不相同", () => {
    assert.notEqual(cred.PRODUCTS.cn.openapi, cred.PRODUCTS.intl.openapi);
    assert.notEqual(cred.PRODUCTS.cn.clientId, cred.PRODUCTS.intl.clientId);
    assert.equal(cred.PRODUCTS.intl.gateway.length, 3, "国际版有 api1/api2/api3 三个候选");
  });
});

// ── 8. 渠道装配 ──────────────────────────────────────────────────────────────

describe("9. 渠道装配", () => {
  it("注册进共享层，静态配置就位", () => {
    clearChannels();
    setChannel(channelModule.channel);
    const channel = getChannel("qodercn");
    assert.equal(channel.config.cid, "qodercn");
    assert.equal(channel.config.display, "Qoder 国内版");
    assert.equal(channel.upstream.DISPLAY_NAME, "Qoder 国内版");
    assert.equal(channel.upstream.WIRE, "custom", "响应是信封，必须走翻译层");
    assert.ok(paths.channelDir("qodercn").startsWith(root));
  });

  it("凭据未登录时抛 NotLoggedInError", () => {
    assert.throws(() => cred.load(), cred.NotLoggedInError);
  });

  it("模型目录缓存落在渠道层内", () => {
    assert.ok(paths.cacheDir("qodercn").includes(join("qodercn", "cache")));
  });
});
