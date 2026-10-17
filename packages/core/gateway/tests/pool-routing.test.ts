/**
 * 公共模型池：**策略单元**（归一化匹配、候选收集、账本）。
 *
 * 端到端的请求路径见 `pool.test.ts`；这里只测纯逻辑与落盘，全部离线。
 * 归一化表里的每一条都取自各渠道的**实测目录写法**（见 docs/POOL-ARCHITECTURE.md §2）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearChannels, setChannel, type Channel } from "../dist/runtime/channel.js";
import { poolUsagePath } from "../dist/runtime/paths.js";
import * as poolUsage from "../dist/pool/pool-usage.js";
import { asPoolModel, canonicalModelId, POOL_MODELS, poolCandidates } from "../dist/pool/pool-targets.js";

let root = "";
let savedRoot: string | undefined;

before(() => {
  root = mkdtempSync(join(tmpdir(), "modelmux-poolroute-"));
  savedRoot = process.env["MODELMUX_HOME"];
  process.env["MODELMUX_HOME"] = root;
});

after(() => {
  if (savedRoot === undefined) delete process.env["MODELMUX_HOME"];
  else process.env["MODELMUX_HOME"] = savedRoot;
  rmSync(root, { recursive: true, force: true });
});

/** 只填池逻辑要用到的字段（其余按契约不会在候选收集里被碰到）。 */
function stubChannel(cid: string, exposed: string[]): Channel {
  return {
    config: {
      cid,
      display: `Stub ${cid}`,
      version: "0.0.0",
      defaultAddr: "127.0.0.1:1",
      uiPort: 2,
      debugDumpEnv: `${cid.toUpperCase()}_DUMP`,
    },
    upstream: { DISPLAY_NAME: `Stub ${cid}` },
    catalog: { exposedIds: () => exposed, resolveModel: (n: string) => n },
  } as unknown as Channel;
}

describe("1. 归一化：各渠道实测写法都能收敛", () => {
  const cases: Array<[string, string]> = [
    // 直白
    ["deepseek-v4-flash", "deepseek-v4-flash"],
    ["deepseek-v4.1-flash", "deepseek-v4.1-flash"],
    ["glm-5.3-flash", "glm-5.3-flash"],
    // 大小写混排（traecn / loomy）
    ["DeepSeek-V4-Flash", "deepseek-v4-flash"],
    ["DeepSeek-V4-Flash-Official", "deepseek-v4-flash"],
    ["GLM-5.3-Flash", "glm-5.3-flash"],
    // 连字符版本号（raccoon）
    ["sn-deepseek-v4-1-flash", "deepseek-v4.1-flash"],
    ["sn-glm-5-3-flash", "glm-5.3-flash"],
    // 日期后缀（loomy / codearts）
    ["deepseek-v4-flash-0731", "deepseek-v4-flash"],
    // 厂商路径段（历史 id 形态）
    ["deepseek/deepseek-v4.1-flash", "deepseek-v4.1-flash"],
    ["z-ai/glm-5.3-flash", "glm-5.3-flash"],
    // 不进池的（归一化后仍不等于两个目标）
    ["glm-5.3-flashx", "glm-5.3-flashx"],
    ["deepseek-v4-flash-vision-exp", "deepseek-v4-flash-vision-exp"],
    ["deepseek-flash", "deepseek-flash"],
    ["vendor-free/mimo-v2.6-flash", "mimo-v2.6-flash"],
  ];

  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, () => {
      assert.equal(canonicalModelId(input), expected);
    });
  }
});

describe("2. asPoolModel：`<cid>/<模型>` 形态", () => {
  it("带渠道前缀的请求名：渠道段小写化，模型段归一化", () => {
    assert.equal(asPoolModel("loomy/kimi-k2.6"), "loomy/kimi-k2.6");
    assert.equal(asPoolModel("Loomy/Kimi-k2.6"), "loomy/kimi-k2.6");
    assert.equal(asPoolModel("qodercn/DeepSeek-V4-Flash-Official"), "qodercn/deepseek-v4-flash");
    assert.equal(asPoolModel("alpha/sn-deepseek-v4-1-flash"), "alpha/deepseek-v4.1-flash");
    // 模型段内部的厂商路径也剥（渠道归属已由第一个 / 声明，不会串渠道）
    assert.equal(asPoolModel("loomy/deepseek/deepseek-v4.1-flash"), "loomy/deepseek-v4.1-flash");
  });

  it("裸模型名（无渠道前缀）判 null —— 渠道由请求方指定", () => {
    assert.equal(asPoolModel("deepseek-v4.1-flash"), null);
    assert.equal(asPoolModel("GLM-5.3-Flash"), null);
  });

  it("畸形形态判 null", () => {
    assert.equal(asPoolModel("loomy/"), null);
    assert.equal(asPoolModel("/kimi-k2.6"), null);
  });
});

describe("3. poolCandidates：渠道由请求方指定，候选至多一条", () => {
  it("只有前缀指向的渠道参与匹配", () => {
    clearChannels();
    setChannel(stubChannel("alpha", ["DeepSeek-V4.1-Flash", "glm-5.3-flashx"]));
    setChannel(stubChannel("beta", ["sn-deepseek-v4-1-flash", "deepseek-v4.1-flash"]));
    setChannel(stubChannel("gamma", ["qwen3.8-flash"]));

    assert.deepEqual(
      poolCandidates("alpha/deepseek-v4.1-flash").map((c) => [c.cid, c.exposedId]),
      [["alpha", "DeepSeek-V4.1-Flash"]],
      "exposedId 保留目录里的原始写法（上游 slug 可能大小写敏感）",
    );
    // 同一渠道多条命中同一目标时取目录里第一条
    assert.deepEqual(
      poolCandidates("beta/deepseek-v4.1-flash").map((c) => c.exposedId),
      ["sn-deepseek-v4-1-flash"],
    );
    // 渠道段大小写不敏感
    assert.equal(poolCandidates("ALPHA/deepseek-v4.1-flash").length, 1);
    // 渠道没这个模型 / 渠道未注册 / 近亲不命中
    assert.deepEqual(poolCandidates("gamma/deepseek-v4.1-flash"), []);
    assert.deepEqual(poolCandidates("delta/deepseek-v4.1-flash"), []);
    assert.deepEqual(poolCandidates("alpha/glm-5.3-flash"), []);
  });

  it("池视图：对外 id 挂渠道前缀，且每个 id 都能反查回自己的渠道", () => {
    clearChannels();
    setChannel(stubChannel("alpha", ["DeepSeek-V4.1-Flash", "glm-5.3-flashx"]));
    setChannel(stubChannel("beta", ["sn-deepseek-v4-1-flash", "deepseek-v4.1-flash"]));
    setChannel(stubChannel("gamma", ["qwen3.8-flash"]));
    const pool = [...POOL_MODELS];
    assert.ok(pool.includes("alpha/deepseek-v4.1-flash"), "alpha 应贡献 4.1");
    assert.ok(pool.includes("beta/deepseek-v4.1-flash"), "beta 应贡献 4.1（不同渠道不互相去重）");
    assert.ok(pool.includes("gamma/qwen3.8-flash"));
    assert.ok(!pool.includes("deepseek-v4.1-flash"), "不再暴露裸模型名");
    for (const id of pool) {
      assert.equal(asPoolModel(id), id, "池 id 归一化后不变（自洽）");
      const cands = poolCandidates(id);
      assert.equal(cands.length, 1, `候选至多一条: ${id}`);
      assert.equal(cands[0]!.cid, id.split("/")[0], "候选渠道就是 id 前缀");
    }
    clearChannels();
  });
});

describe("4. 账本：得分、冷却、落盘", () => {
  it("得分 = 账单已用量；失败后当 0，成功即恢复", () => {
    poolUsage.resetPoolLedgerForTest();
    poolUsage.writeBilling("alpha", { total: { used: 42, unit: "credits" } });
    assert.equal(poolUsage.scoreOf("alpha"), 42);

    poolUsage.noteFailure("alpha");
    assert.equal(poolUsage.scoreOf("alpha"), 0, "冷却期内当 0");

    // 冷却延长到很远 → 仍然 0
    poolUsage.noteFailure("alpha", 3_600_000);
    assert.equal(poolUsage.scoreOf("alpha"), 0);

    poolUsage.noteSuccess("alpha");
    assert.equal(poolUsage.scoreOf("alpha"), 42, "成功即清冷却，恢复原用量");
    const entry = poolUsage.ledgerSnapshot().channels["alpha"]!;
    assert.equal(entry.ok, 1);
    assert.equal(entry.fail, 2);
  });

  it("isCooling：失败进冷却（下一次请求跳过它），成功即清、到期即恢复", () => {
    poolUsage.resetPoolLedgerForTest();
    assert.equal(poolUsage.isCooling("beta"), false, "没失败过就不冷却");

    poolUsage.noteFailure("beta");
    assert.equal(poolUsage.isCooling("beta"), true, "失败后冷却中（路由硬排除）");

    poolUsage.noteSuccess("beta");
    assert.equal(poolUsage.isCooling("beta"), false, "成功一次提前清冷却");

    poolUsage.noteFailure("beta", 60_000);
    assert.equal(poolUsage.isCooling("beta", Date.now() + 61_000), false, "冷却到期自动恢复候选");
  });

  it("没查过账单的渠道 → needsBillingRefresh 为 true", () => {
    poolUsage.resetPoolLedgerForTest();
    clearChannels();
    setChannel(stubChannel("alpha", []));
    assert.equal(poolUsage.needsBillingRefresh(), true, "从没查过");
    poolUsage.writeBilling("alpha", { total: { used: 1 } });
    assert.equal(poolUsage.needsBillingRefresh(), false, "刚查过");
    clearChannels();
  });

  it("落盘后重载仍在（<root>/pool-usage.json）", () => {
    poolUsage.resetPoolLedgerForTest();
    poolUsage.writeBilling("beta", { total: { used: 7, size: 100, remain: 93, unit: "credits" } });
    poolUsage.noteFailure("beta", 1000);
    poolUsage.flushLedger();
    assert.ok(existsSync(poolUsagePath()), "账本文件应已写出");

    poolUsage.resetPoolLedgerForTest(); // 丢掉内存缓存 → 下次读盘
    const entry = poolUsage.ledgerSnapshot().channels["beta"]!;
    assert.equal(entry.used, 7);
    assert.equal(entry.size, 100);
    assert.equal(entry.unit, "credits");
    assert.ok(entry.cooldown_until > 0, "冷却时刻也要落盘");
  });
});
