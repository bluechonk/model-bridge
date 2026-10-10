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

import { clearChannels, setChannel, type Channel } from "../dist/channel.js";
import { poolUsagePath } from "../dist/paths.js";
import * as poolUsage from "../dist/pool-usage.js";
import { asPoolModel, canonicalModelId, POOL_MODELS, poolCandidates } from "../dist/pool-targets.js";

let root = "";
let savedRoot: string | undefined;

before(() => {
  root = mkdtempSync(join(tmpdir(), "mb-poolroute-"));
  savedRoot = process.env["MODEL_BRIDGE_HOME"];
  process.env["MODEL_BRIDGE_HOME"] = root;
});

after(() => {
  if (savedRoot === undefined) delete process.env["MODEL_BRIDGE_HOME"];
  else process.env["MODEL_BRIDGE_HOME"] = savedRoot;
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
    // 大小写混排（trae / loomy）
    ["DeepSeek-V4-Flash", "deepseek-v4-flash"],
    ["DeepSeek-V4-Flash-Official", "deepseek-v4-flash"],
    ["GLM-5.3-Flash", "glm-5.3-flash"],
    // 连字符版本号（raccoon）
    ["sn-deepseek-v4-1-flash", "deepseek-v4.1-flash"],
    ["sn-glm-5-3-flash", "glm-5.3-flash"],
    // 日期后缀（loomy / codearts）
    ["deepseek-v4-flash-0731", "deepseek-v4-flash"],
    // 厂商路径段（cline）
    ["deepseek/deepseek-v4.1-flash", "deepseek-v4.1-flash"],
    ["z-ai/glm-5.3-flash", "glm-5.3-flash"],
    // 不进池的（归一化后仍不等于两个目标）
    ["glm-5.3-flashx", "glm-5.3-flashx"],
    ["deepseek-v4-flash-vision-exp", "deepseek-v4-flash-vision-exp"],
    ["deepseek-flash", "deepseek-flash"],
    ["cline-free/mimo-v2.6-flash", "mimo-v2.6-flash"],
  ];

  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, () => {
      assert.equal(canonicalModelId(input), expected);
    });
  }

  it("幂等：规范名再归一化不变", () => {
    for (const id of POOL_MODELS) assert.equal(canonicalModelId(id), id);
  });
});

describe("2. asPoolModel：命中/不命中", () => {
  it("两个池内目标（含大小写变体）都命中", () => {
    assert.equal(asPoolModel("deepseek-v4.1-flash"), "deepseek-v4.1-flash");
    assert.equal(asPoolModel("DEEPSEEK-V4.1-FLASH"), "deepseek-v4.1-flash");
    assert.equal(asPoolModel("Glm-5.3-Flash"), "glm-5.3-flash");
    // 4.0 已移出池：归一化仍正确，但不再是可路由的池模型
    assert.equal(asPoolModel("deepseek-v4-flash"), null);
    assert.equal(asPoolModel("DEEPSEEK-V4-FLASH"), null);
  });

  it("近亲不命中（4.0 vs 4.1、flashx、vision-exp、无版本）", () => {
    assert.equal(asPoolModel("deepseek-v4-flashx"), null);
    assert.equal(asPoolModel("glm-5.3-flashx"), null);
    assert.equal(asPoolModel("deepseek-v4-flash-vision-exp"), null);
    assert.equal(asPoolModel("deepseek-flash"), null);
    assert.equal(asPoolModel("alpha/deepseek-v4-flash"), null, "渠道前缀形态不再被接受");
  });
});

describe("3. poolCandidates：渠道目录 → 候选", () => {
  it("归一化命中才算候选，顺序 = 注册顺序", () => {
    clearChannels();
    setChannel(stubChannel("alpha", ["DeepSeek-V4.1-Flash", "glm-5.3-flashx"]));
    setChannel(stubChannel("beta", ["sn-deepseek-v4-1-flash", "deepseek-v4.1-flash"]));
    setChannel(stubChannel("gamma", ["qwen3.8-flash"]));

    assert.deepEqual(
      poolCandidates("deepseek-v4.1-flash").map((c) => [c.cid, c.exposedId]),
      [
        ["alpha", "DeepSeek-V4.1-Flash"],
        ["beta", "sn-deepseek-v4-1-flash"],
      ],
      "exposedId 保留目录里的原始写法（上游 slug 可能大小写敏感）",
    );
    assert.deepEqual(poolCandidates("glm-5.3-flash"), [], "flashx 不算");
    clearChannels();
  });

  it("同一渠道多条命中同一目标时取目录里第一条", () => {
    clearChannels();
    setChannel(stubChannel("alpha", ["sn-deepseek-v4-1-flash", "deepseek-v4.1-flash"]));
    assert.deepEqual(
      poolCandidates("deepseek-v4.1-flash").map((c) => c.exposedId),
      ["sn-deepseek-v4-1-flash"],
    );
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
