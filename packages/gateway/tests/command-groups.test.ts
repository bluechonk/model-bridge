/**
 * 命令分组：`<cid> <动词>` 与 `model <子命令>`，以及 `checkin` 的能力分发。
 *
 * 用两个**合成渠道**（一个声明了 signin 能力、一个没有）验证：
 * 路由分发、模型池列表、签到状态/领取、以及"没有端点"的明确报错。
 * 全程离线，存储根指向临时目录。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearChannels, setChannel, type BridgeConfig, type Channel } from "../dist/channel.js";
import * as groups from "../dist/command-groups.js";
import * as signinCli from "../dist/signin-cli.js";

const CTX: groups.CommandContext = {
  json: true,
  quiet: true,
  addr: "127.0.0.1:1",
  uiPort: 1,
  realm: "auto",
  force: false,
  statusOnly: false,
  lines: 5,
};

/** 记录调用的假 signin 能力。 */
const calls = { status: 0, claim: 0, claimed: false };

function makeChannel(cid: string, withSignin: boolean): Channel {
  const config: BridgeConfig = {
    cid,
    display: cid.toUpperCase(),
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    legacyDirs: [`.${cid}`],
    debugDumpEnv: `${cid.toUpperCase()}_DEBUG_DUMP`,
  };
  const billing: Record<string, unknown> = {
    CreditsError: class CreditsError extends Error {},
    fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
  };
  // 契约要求**每个**渠道都给 signin：有端点的真查真领，没端点的返回一句自己的说明
  billing["signin"] = withSignin
    ? {
        status: async () => {
          calls.status += 1;
          return { claimable: !calls.claimed, summary: calls.claimed ? "今天已签到" : "今天未签到" };
        },
        claim: async () => {
          calls.claim += 1;
          calls.claimed = true;
          return { ok: true, summary: "签到成功，+5", detail: { points: 5 } };
        },
      }
    : {
        status: async () => ({ claimable: false, summary: `${cid} 没有签到端点 —— 说明文字` }),
        claim: async () => ({ ok: true, summary: `${cid} 没有签到端点 —— 说明文字` }),
      };
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      load: () => ({ accessToken: "t", uid: "u", domain: "" }),
      save: async () => {},
      login: async () => ({ accessToken: "t", uid: "u", domain: "" }),
      refresh: async (c: unknown) => c,
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "openai" as const,
      DISPLAY_NAME: cid.toUpperCase(),
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      loadConfig: () => [{ baseUrl: "http://127.0.0.1:1" }, false],
      saveConfig: async () => {},
      chatUrl: () => "http://127.0.0.1:1/chat",
      modelsUrl: () => "http://127.0.0.1:1/models",
      buildHeaders: () => ({}),
      buildChatBody: (r: Record<string, unknown>) => r,
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
    },
    catalog: {
      // 一个渠道给两个模型（含大小写混排）验证池子输出
      exposedIds: () => (cid === "alpha" ? ["model-one", "Mixed-Two"] : ["solo"]),
      resolveModel: (n: string) => n,
    },
    billing,
  } as unknown as Channel;
}

let root = "";
let savedRoot: string | undefined;

before(() => {
  root = mkdtempSync(join(tmpdir(), "mb-groups-"));
  savedRoot = process.env["MODEL_BRIDGE_HOME"];
  process.env["MODEL_BRIDGE_HOME"] = root;
  clearChannels();
  setChannel(makeChannel("alpha", true)); // 有签到能力
  setChannel(makeChannel("beta", false)); // 没有
});

after(() => {
  clearChannels();
  if (savedRoot === undefined) delete process.env["MODEL_BRIDGE_HOME"];
  else process.env["MODEL_BRIDGE_HOME"] = savedRoot;
  rmSync(root, { recursive: true, force: true });
});

describe("1. 模型池分组", () => {
  it("model list 列出全部渠道（含多渠道路由前缀）", () => {
    const out: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => void out.push(args.join(" "));
    try {
      assert.equal(groups.listAllModels(true), 0);
    } finally {
      console.log = orig;
    }
    const parsed = JSON.parse(out.join("\n")) as Array<{ cid: string; models: string[] }>;
    assert.deepEqual(parsed.map((r) => r.cid), ["alpha", "beta"]);
    assert.deepEqual(parsed[0]!.models, ["alpha/model-one", "alpha/mixed-two"], "带 cid 前缀且小写");
    assert.deepEqual(parsed[1]!.models, ["beta/solo"]);
  });

  it("model show <cid> 只看一个；缺 cid 报用法", () => {
    assert.equal(groups.runModelGroup(["show", "alpha"], CTX), 0);
    assert.equal(groups.runModelGroup(["show"], CTX), 2);
    assert.equal(groups.runModelGroup(["nope"], CTX), 2);
  });
});

describe("2. 渠道动词路由", () => {
  it("<cid> models 列出该渠道池内模型", async () => {
    assert.equal(await groups.runChannelCommand("alpha", ["models"], CTX), 0);
  });

  it("<cid> status 走 daemon.status（不抛错）", async () => {
    const code = await groups.runChannelCommand("alpha", ["status"], CTX);
    assert.equal(code, 0);
  });

  it("未知动词 → 2，并提示可用动词", async () => {
    const err: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => void err.push(args.join(" "));
    try {
      assert.equal(await groups.runChannelCommand("alpha", ["没有这个动词"], CTX), 2);
    } finally {
      console.error = orig;
    }
    assert.ok(err.join("\n").includes("可用动词"));
  });

  it("渠道级 start 被明确引导到单渠道 CLI（不是静默跑错）", async () => {
    const err: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => void err.push(args.join(" "));
    try {
      assert.equal(await groups.runChannelCommand("alpha", ["start"], CTX), 2);
    } finally {
      console.error = orig;
    }
    assert.ok(err.join("\n").includes("仓库级"));
  });
});

describe("3. checkin：有端点/无端点", () => {
  it("有 signin 能力的渠道：--status 只查不领；默认会领", async () => {
    calls.status = 0;
    calls.claim = 0;
    calls.claimed = false;

    assert.equal(await signinCli.runCheckin({ cid: "alpha", json: true, statusOnly: true }), 0);
    assert.equal(calls.status, 1);
    assert.equal(calls.claim, 0, "--status 不该发领取");

    assert.equal(await signinCli.runCheckin({ cid: "alpha", json: true }), 0);
    assert.equal(calls.claim, 1, "默认要真的领");

    // 已领后再跑：status 说 claimable=false → 跳过领取
    const before = calls.claim;
    assert.equal(await signinCli.runCheckin({ cid: "alpha", json: true }), 0);
    assert.equal(calls.claim, before, "无可领时不再发领取请求");
  });

  it("没有端点的渠道：返回渠道自己的文本说明，且**不算失败**（退出码 0）", async () => {
    const out: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => void out.push(args.join(" "));
    let code: number;
    try {
      code = await signinCli.runCheckin({ cid: "beta", statusOnly: true });
    } finally {
      console.log = orig;
    }
    assert.equal(code, 0, "「没端点」是正常情况，不是失败");
    assert.ok(out.join("\n").includes("没有签到端点"), out.join("\n"));
  });

  it("查询/领取抛错 → 退出码非零（脚本能感知失败）", async () => {
    clearChannels();
    const broken = makeChannel("gamma", true);
    (broken.billing as { signin: { status: () => Promise<never> } }).signin = {
      status: async () => {
        throw new Error("上游拒绝");
      },
    } as never;
    setChannel(broken);
    try {
      assert.equal(await signinCli.runCheckin({ cid: "gamma", json: true, statusOnly: true }), 1);
    } finally {
      clearChannels();
      setChannel(makeChannel("alpha", true));
      setChannel(makeChannel("beta", false));
    }
  });

  it("仓库级 checkin：对所有渠道一视同仁（没端点的也出现，给文本说明）", async () => {
    const out: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => void out.push(args.join(" "));
    let code: number;
    try {
      code = await signinCli.runCheckin({ statusOnly: true });
    } finally {
      console.log = orig;
    }
    assert.equal(code, 0);
    const text = out.join("\n");
    assert.ok(text.includes("[alpha]"), "有端点的渠道报状态");
    assert.ok(text.includes("[beta]"), "没端点的渠道也在（口径统一，输出它自己的说明）");
  });
});
