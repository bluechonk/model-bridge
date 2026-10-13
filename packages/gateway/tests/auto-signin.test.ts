/**
 * 自动签到调度器测试（**完全离线**：mkdtemp 存储根 + mock 渠道注册）。
 *
 * 覆盖规则：
 * 1. 未登录 → 不触发（不发任何网络请求）
 * 2. 签到成功 → 台账登记今天已签（via=auto），第二轮跳过
 * 3. 连败 3 次 → 当日熔断，不再触发
 * 4. 上游已签 → 回填台账且不重复领取
 * 5. 上游无可领 → 跳过且不计失败
 *
 * ⚠ setChannel 的注册表跨测试共享（模块级单例）：每个测试用**唯一 cid**，
 * 断言只看自己渠道的计数器，避免相互污染。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { autoSignin, setChannel, signinLedger, type Channel } from "@model-bridge/gateway";

const { claimedTodayPerLedger, readLedger } = signinLedger;

async function withIsolatedRoot<T>(fn: () => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "mb-autosignin-"));
  const saved = process.env["MODELMUX_HOME"];
  process.env["MODELMUX_HOME"] = root;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = saved;
    rmSync(root, { recursive: true, force: true });
  }
}

interface Behavior {
  loggedIn?: boolean;
  statusError?: boolean;
  claimedToday?: boolean | null;
  claimable?: boolean | null;
  claimOk?: boolean;
  claimError?: boolean;
  /** 观测：status/claim 实际发出的次数（渠道私有，避免注册表共享导致的串扰）。 */
  statusCalls?: number;
  claimCalls?: number;
}

/** 构造一个签到可编程的 mock 渠道（status/claim 调用计数用于断言「没发请求」）。 */
function makeChannel(cid: string, behavior: Behavior): Channel {
  behavior.statusCalls = 0;
  behavior.claimCalls = 0;
  const credLoad = behavior.loggedIn === false
    ? (): never => {
        throw new Error("NotLoggedIn");
      }
    : () => ({ accessToken: "t", uid: "u", domain: "example.test" });
  return {
    config: { cid, display: cid, version: "0.0.0", legacyDirs: [] },
    cred: {
      DEFAULT_BASE_URL: "https://example.test",
      NotLoggedInError: class extends Error {},
      load: credLoad,
      save: async () => {},
      login: async () => ({}),
      refresh: async () => ({}),
      resolveBaseUrl: () => "https://example.test",
    },
    upstream: {
      DEFAULT_BASE_URL: "https://example.test",
      WIRE: "openai",
      DISPLAY_NAME: cid,
      chatUrl: () => "https://example.test/v1",
      modelsUrl: () => "https://example.test/models",
      buildHeaders: () => ({}),
      buildChatBody: () => ({}),
      newTranslator: () => ({ feed: () => [], finish: () => [] }),
      resolveConfig: () => ({ baseUrl: "https://example.test", chatPath: "/v1", modelsPath: "/models" }),
    } as unknown as Channel["upstream"],
    catalog: {
      exposedIds: () => [],
      resolveModel: () => null,
      entryFor: () => null,
    } as unknown as Channel["catalog"],
    billing: {
      fetchCredits: async () => ({
        total: { remain: 0, size: 0, unit: "", remain_percent: 0 },
        packages: [],
      }),
      signin: {
        daily: true,
        status: async () => {
          behavior.statusCalls = (behavior.statusCalls ?? 0) + 1;
          if (behavior.statusError) throw new Error("upstream down");
          return {
            daily: true,
            claimedToday: behavior.claimedToday ?? false,
            claimable: behavior.claimable ?? true,
            summary: "test",
          };
        },
        claim: async () => {
          behavior.claimCalls = (behavior.claimCalls ?? 0) + 1;
          if (behavior.claimError) throw new Error("claim failed");
          return { ok: behavior.claimOk ?? true, summary: "claimed" };
        },
      },
    },
  } as unknown as Channel;
}

test("auto signin: 未登录渠道不发任何网络请求", async () => {
  await withIsolatedRoot(async () => {
    const behavior: Behavior = { loggedIn: false };
    setChannel(makeChannel("autosign-loggedout", behavior));
    await autoSignin.runOnce();
    assert.equal(behavior.statusCalls, 0, "未登录不得查询上游状态");
    assert.equal(behavior.claimCalls, 0);
  });
});

test("auto signin: 领取成功后台账登记今天已签（via=auto），第二轮跳过", async () => {
  await withIsolatedRoot(async () => {
    const behavior: Behavior = { claimOk: true };
    setChannel(makeChannel("autosign-ok", behavior));
    const first = await autoSignin.runOnce();
    assert.equal(first.claimed, 1);
    assert.equal(behavior.claimCalls, 1);
    assert.equal(claimedTodayPerLedger("autosign-ok"), true, "台账必须登记今天已签");
    const ledger = readLedger("autosign-ok");
    assert.equal(ledger.last_claim?.via, "auto");

    // 第二轮：台账已签 → 不再问上游、不再领取
    const second = await autoSignin.runOnce();
    assert.equal(second.claimed, 0);
    assert.equal(behavior.statusCalls, 1, "台账已签的渠道第二轮不得再查上游");
    assert.equal(behavior.claimCalls, 1, "台账已签的渠道第二轮不得再领取");
  });
});

test("auto signin: 连败 3 次当日熔断，不再触发", async () => {
  await withIsolatedRoot(async () => {
    const behavior: Behavior = { claimError: true };
    setChannel(makeChannel("autosign-flaky", behavior));
    for (let i = 1; i <= 3; i++) {
      await autoSignin.runOnce();
      assert.equal(autoSignin.readFailures("autosign-flaky"), i, `第 ${i} 次失败后计数应为 ${i}`);
    }
    assert.equal(autoSignin.tripped("autosign-flaky"), true, "3 次失败必须熔断");

    // 熔断后：状态查询都不发
    const { claimed } = await autoSignin.runOnce();
    assert.equal(claimed, 0);
    assert.equal(behavior.statusCalls, 3, "熔断后不得再查上游（3 次都是熔断前发的）");
    assert.equal(behavior.claimCalls, 3);
  });
});

test("auto signin: 上游说已签 → 回填台账且不重复领取", async () => {
  await withIsolatedRoot(async () => {
    const behavior: Behavior = { claimedToday: true };
    setChannel(makeChannel("autosign-upstream", behavior));
    await autoSignin.runOnce();
    assert.equal(behavior.claimCalls, 0, "上游已签不得重复领取");
    assert.equal(claimedTodayPerLedger("autosign-upstream"), true, "回填台账");
    const ledger = readLedger("autosign-upstream");
    assert.equal(ledger.last_claim?.via, "auto-backfill");
  });
});

test("auto signin: 上游无可领 → 跳过且不计失败", async () => {
  await withIsolatedRoot(async () => {
    const behavior: Behavior = { claimable: false };
    setChannel(makeChannel("autosign-none", behavior));
    await autoSignin.runOnce();
    assert.equal(behavior.claimCalls, 0, "无可领不领取");
    assert.equal(autoSignin.readFailures("autosign-none"), 0, "无可领不算失败");
    assert.equal(autoSignin.tripped("autosign-none"), false);
  });
});
