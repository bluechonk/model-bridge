/**
 * CLI 表层（通过 `main(argv)` 驱动，不直接调内部函数）。
 *
 * 为什么这么测：命令解析、路由（`<cid> <动词>` / `model 分组` / 顶层）、退出码、
 * 中英文案、以及"失败要非零"这些**都只有走 CLI 才测得到**。直接调
 * `groups.runChannelCommand()` 之类的内部函数会把这些全绕过去。
 *
 * 覆盖不到的两类，仍在别处单测（CLI 到不了）：
 * - 进程守护：`start` 会 spawn 分离子进程，测试里跑它会真的起进程（见 daemon 的烟测）；
 * - 渠道内部：凭证格式解析、PKCE/DPoP 签名、SSE 翻译等 —— 在各自 selftest 里单测。
 *
 * 全程离线：合成渠道 + 临时存储根（不碰真实主目录、不出网）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearChannels, setChannel, type BridgeConfig, type Channel } from "../dist/channel.js";
import { main } from "../dist/cli.js";

/** 跑一次 CLI，收 stdout/stderr 与退出码。 */
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => void out.push(args.join(" "));
  console.error = (...args: unknown[]) => void err.push(args.join(" "));
  try {
    const code = await main(argv);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

const signinCalls = { status: 0, claim: 0, claimed: false };

interface FakeSigninSpec {
  /** 有真实端点（false = 返回文本说明的那种）。 */
  signin: boolean;
  /** 上游给的"今天签没签"；不给 = 上游答不了这个问题。 */
  claimedToday?: boolean | null;
  /** 是否每日语义（false = 一次性奖励）。 */
  daily?: boolean;
  /** 让 status() 抛错（模拟未登录 / 上游拒绝）。 */
  statusThrows?: boolean;
}

function makeChannel(cid: string, opts: FakeSigninSpec): Channel {
  const config: BridgeConfig = {
    cid,
    display: cid === "alpha" ? "Alpha 池" : "Beta 池",
    version: "9.9.9",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    legacyDirs: [`.${cid}`],
    debugDumpEnv: `${cid.toUpperCase()}_DEBUG_DUMP`,
  };
  const billing: Record<string, unknown> = {
    CreditsError: class CreditsError extends Error {},
    fetchCredits: async () => ({
      ok: true,
      total: { remain: 12.5, size: 100, used: 87.5, unit: "credits", remain_percent: 12.5 },
      packages: [],
    }),
    // 契约要求每个渠道都给 signin
    signin: opts.signin
      ? {
          status: async () => {
            signinCalls.status += 1;
            if (opts.statusThrows) throw new Error("上游拒绝");
            return {
              claimable: !signinCalls.claimed,
              summary: signinCalls.claimed ? "今天已签到" : "今天未签到",
              ...(opts.claimedToday !== undefined ? { claimedToday: opts.claimedToday } : {}),
              ...(opts.daily !== undefined ? { daily: opts.daily } : {}),
            };
          },
          claim: async () => {
            signinCalls.claim += 1;
            signinCalls.claimed = true;
            return { ok: true, summary: "签到成功，+5" };
          },
        }
      : {
          status: async () => ({ claimable: false, summary: `${cid} 没有签到端点 —— 说明文字` }),
          claim: async () => ({ ok: true, summary: `${cid} 没有签到端点 —— 说明文字` }),
        },
  };
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      load: () => ({ accessToken: "tok", uid: `${cid}-user`, domain: "" }),
      save: async () => {},
      login: async () => ({ accessToken: "tok", uid: `${cid}-user`, domain: "" }),
      refresh: async (c: unknown) => c,
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "openai" as const,
      DISPLAY_NAME: config.display,
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      loadConfig: () => [{ baseUrl: "http://127.0.0.1:1" }, false],
      saveConfig: async () => {},
      chatUrl: () => "http://127.0.0.1:1/chat",
      modelsUrl: () => "http://127.0.0.1:1/models",
      buildHeaders: () => ({}),
      buildChatBody: (r: Record<string, unknown>) => r,
      fetchModels: async () => ({ models: [] }),
      resolveConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
    },
    catalog: {
      exposedIds: () => (cid === "alpha" ? ["model-one", "Mixed-Two"] : ["solo"]),
      resolveModel: (n: string) => n,
    },
    billing,
  } as unknown as Channel;
}

let root = "";
let savedRoot: string | undefined;

function resetChannels(): void {
  clearChannels();
  setChannel(makeChannel("alpha", { signin: true }));
  setChannel(makeChannel("beta", { signin: false }));
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "mb-cli-"));
  savedRoot = process.env["MODEL_BRIDGE_HOME"];
  process.env["MODEL_BRIDGE_HOME"] = root;
  resetChannels();
});

after(() => {
  clearChannels();
  if (savedRoot === undefined) delete process.env["MODEL_BRIDGE_HOME"];
  else process.env["MODEL_BRIDGE_HOME"] = savedRoot;
  rmSync(root, { recursive: true, force: true });
});

describe("1. 常见命令与帮助", () => {
  it("--help / -h / help 三种写法等价，且是全中文帮助", async () => {
    for (const argv of [["--help"], ["-h"], ["help"]]) {
      const r = await run(argv);
      assert.equal(r.code, 0, argv.join(" "));
      assert.ok(r.out.includes("用法:"), "有用法说明");
      assert.ok(r.out.includes("按渠道操作"), "有按渠道操作一节");
      assert.ok(r.out.includes("示例:"), "有中文示例");
      assert.ok(r.out.includes("--channel <cid>"), "选项有中文说明");
    }
  });

  it("--version / -v / version 三种写法等价，并带上渠道数与 node 版本", async () => {
    for (const argv of [["--version"], ["-v"], ["version"]]) {
      const r = await run(argv);
      assert.equal(r.code, 0, argv.join(" "));
      assert.match(r.out, /^model-bridge \S+（2 个渠道；node v/, r.out);
    }
  });

  it("未知命令 → 退出码 2，并提示未知", async () => {
    const r = await run(["没有这个命令"]);
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("未知命令"));
  });
});

describe("2. 模型池（model 分组与兼容命令）", () => {
  it("model list 输出全部渠道与带前缀的小写模型 id", async () => {
    const r = await run(["model", "list", "--json"]);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.out) as Array<{ cid: string; models: string[] }>;
    assert.deepEqual(parsed.map((x) => x.cid), ["alpha", "beta"]);
    assert.deepEqual(parsed[0]!.models, ["alpha/model-one", "alpha/mixed-two"]);
  });

  it("channels 与 model list 等价（兼容保留）", async () => {
    const a = await run(["channels", "--json"]);
    const b = await run(["model", "list", "--json"]);
    assert.equal(a.code, 0);
    assert.equal(a.out, b.out);
  });

  it("model show <cid> 只看一个；缺 cid → 2（讲用法）", async () => {
    const one = await run(["model", "show", "beta"]);
    assert.equal(one.code, 0);
    assert.equal(one.out.trim(), "beta/solo");

    const missing = await run(["model", "show"]);
    assert.equal(missing.code, 2);
    assert.ok(missing.err.includes("用法"));
  });

  it("未知 model 子命令 → 2", async () => {
    const r = await run(["model", "乱写"]);
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("未知的 model 子命令"));
  });
});

describe("3. <cid> <动词> 路由", () => {
  it("<cid> models 只列该渠道（不需要网关）", async () => {
    const r = await run(["alpha", "models"]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.out.split("\n"), ["alpha/model-one", "alpha/mixed-two"]);
  });

  it("<cid> billing 打印额度（等价 credits --channel）", async () => {
    const r = await run(["alpha", "billing"]);
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("12.5 / 100 credits"), r.out);

    const alias = await run(["beta", "credits"]);
    assert.equal(alias.code, 0);
  });

  it("<cid> status 走 daemon（借假地址，不抛错）", async () => {
    const r = await run(["alpha", "status", "--addr", "127.0.0.1:1", "--ui-port", "1", "--json"]);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.out) as { gateway: { reachable: boolean }; credentials: unknown };
    assert.equal(parsed.gateway.reachable, false, "假地址当然不可达，但命令本身要成功");
  });

  it("扁平写法与 <cid> 写法等价：status --channel alpha", async () => {
    const a = await run(["alpha", "status", "--addr", "127.0.0.1:1", "--ui-port", "1", "--json"]);
    const b = await run(["status", "--channel", "alpha", "--addr", "127.0.0.1:1", "--ui-port", "1", "--json"]);
    assert.equal(a.code, 0);
    assert.equal(b.code, 0);
    assert.equal(a.out, b.out);
  });

  it("<cid> login 走无窗口登录流程（假渠道不联网）", async () => {
    const r = await run(["alpha", "login", "--json"]);
    assert.equal(r.code, 0);
    assert.ok(r.out.includes('"event":"start"'), r.out);
    assert.ok(r.out.includes('"event":"done"'), r.out);
  });

  it("<cid> 未知动词 → 2，并列出可用动词", async () => {
    const r = await run(["alpha", "乱写的动词"]);
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("可用动词"));
  });

  it("<cid> start 不静默做错事：明确指向单渠道 CLI", async () => {
    const r = await run(["alpha", "start"]);
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("仓库级"));
    assert.ok(r.err.includes("channels/alpha/dist/cli.js"));
  });
});

describe("4. checkin：走 CLI 的能力分发", () => {
  it("--status 只查不领；默认会领；已领后不再发领取", async () => {
    signinCalls.status = 0;
    signinCalls.claim = 0;
    signinCalls.claimed = false;

    const s = await run(["alpha", "checkin", "--status"]);
    assert.equal(s.code, 0);
    assert.ok(s.out.includes("[alpha] 今天未签到"), s.out);
    assert.equal(signinCalls.claim, 0, "--status 不该领");

    const c = await run(["alpha", "checkin"]);
    assert.equal(c.code, 0);
    assert.equal(signinCalls.claim, 1);
    assert.ok(c.out.includes("签到成功，+5"), c.out);

    const again = await run(["alpha", "checkin"]);
    assert.equal(again.code, 0);
    assert.equal(signinCalls.claim, 1, "无可领时不再发领取请求");
  });

  it("没有端点的渠道：打印渠道自己的说明文字，且**退出码 0**", async () => {
    const r = await run(["beta", "checkin", "--status"]);
    assert.equal(r.code, 0, "「没端点」不是失败");
    assert.ok(r.out.includes("beta 没有签到端点 —— 说明文字"), r.out);
  });

  it("仓库级 checkin 覆盖全部渠道（口径统一，不过滤）", async () => {
    const r = await run(["checkin", "--status"]);
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("[alpha]"), "有端点的报状态");
    assert.ok(r.out.includes("[beta]"), "没端点的也在，输出它自己的说明");
  });

  it("查询抛错 → 退出码非零（脚本能感知）", async () => {
    clearChannels();
    const broken = makeChannel("gamma", { signin: true });
    (broken.billing as unknown as { signin: { status: () => Promise<never> } }).signin = {
      status: async () => {
        throw new Error("上游拒绝");
      },
    } as never;
    setChannel(broken);
    try {
      const r = await run(["gamma", "checkin", "--status"]);
      assert.equal(r.code, 1);
      assert.ok(r.out.includes("上游查询失败"), r.out);
    } finally {
      resetChannels();
    }
  });
});

describe("5. 账号池与落点（也走 CLI）", () => {
  it("<cid> accounts 列出池子（首次查看会把现有凭证收进来）", async () => {
    const r = await run(["alpha", "accounts"]);
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("alpha"), r.out);
  });

  it("<cid> paths 打印该渠道落点，且是只读", async () => {
    const r = await run(["alpha", "paths", "--json"]);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.out) as { cid: string; dir: string };
    assert.equal(parsed.cid, "alpha");
    assert.ok(parsed.dir.endsWith("alpha"), parsed.dir);
  });

  it("paths --all 统计全部渠道", async () => {
    const r = await run(["paths", "--all", "--workspace", process.cwd()]);
    // 工作区里可能找不到（测试目录不是工作区）→ 报用法即可，不抛错
    assert.ok(r.code === 0 || r.code === 2, `退出码 ${r.code}`);
  });
});

describe("6. 今日是否签到过（三层判定：上游 → 本地台账 → 不知道）", () => {
  const ledgerFile = (cid: string): string => join(root, cid, "state", "signin.json");

  it("上游说已签 → 依据上游，并**回填**台账；之后上游查不到也能答", async () => {
    clearChannels();
    setChannel(makeChannel("delta", { signin: true, claimedToday: true }));
    try {
      assert.equal(existsSync(ledgerFile("delta")), false, "跑之前没有台账");
      const r = await run(["delta", "checkin", "--status", "--json"]);
      assert.equal(r.code, 0);
      const parsed = JSON.parse(r.out) as { channels: Array<{ today: boolean | null; basis: string }> };
      assert.equal(parsed.channels[0]!.today, true);
      assert.equal(parsed.channels[0]!.basis, "upstream", "以上游为准");
      assert.ok(existsSync(ledgerFile("delta")), "上游说已签 → 回填台账（自愈）");

      clearChannels();
      setChannel(makeChannel("delta", { signin: true, statusThrows: true }));
      const again = await run(["delta", "checkin", "--status", "--json"]);
      assert.equal(again.code, 0, "有台账兜底 → 不算失败");
      const parsed2 = JSON.parse(again.out) as { channels: Array<{ today: boolean | null; basis: string }> };
      assert.equal(parsed2.channels[0]!.today, true);
      assert.equal(parsed2.channels[0]!.basis, "local", "依据：本地记录");
    } finally {
      resetChannels();
    }
  });

  it("上游说未签 → today=false；--fail-if-unclaimed 退出码 1", async () => {
    clearChannels();
    setChannel(makeChannel("epsilon", { signin: true, claimedToday: false }));
    try {
      const r = await run(["epsilon", "checkin", "--status", "--json"]);
      assert.equal(r.code, 0, "只是没签，不是失败");
      const parsed = JSON.parse(r.out) as { channels: Array<{ today: boolean | null; basis: string }> };
      assert.equal(parsed.channels[0]!.today, false);
      assert.equal(parsed.channels[0]!.basis, "upstream");
      assert.equal((await run(["epsilon", "checkin", "--status", "--fail-if-unclaimed"])).code, 1);
    } finally {
      resetChannels();
    }
  });

  it("上游查不到 + 无台账 → 未知且失败", async () => {
    clearChannels();
    setChannel(makeChannel("zeta", { signin: true, statusThrows: true }));
    try {
      const r = await run(["zeta", "checkin", "--status", "--json"]);
      assert.equal(r.code, 1, "既问不到又没有本地记录 → 失败");
      const parsed = JSON.parse(r.out) as { channels: Array<{ today: boolean | null; failed?: boolean }> };
      assert.equal(parsed.channels[0]!.today, null);
      assert.equal(parsed.channels[0]!.failed, true);
    } finally {
      resetChannels();
    }
  });

  it("一次性奖励（daily:false）不套「今天」，--daily-only 跳过它", async () => {
    clearChannels();
    setChannel(makeChannel("theta", { signin: true, daily: false }));
    try {
      const r = await run(["theta", "checkin", "--status", "--json"]);
      assert.equal(r.code, 0);
      const parsed = JSON.parse(r.out) as { channels: Array<{ today: boolean | null; daily: boolean }> };
      assert.equal(parsed.channels[0]!.today, null);
      assert.equal(parsed.channels[0]!.daily, false);

      const skipped = await run(["checkin", "--status", "--daily-only", "--json"]);
      const parsed2 = JSON.parse(skipped.out) as { channels: Array<{ cid: string }> };
      assert.equal(parsed2.channels.some((c) => c.cid === "theta"), false, "被 --daily-only 跳过");
    } finally {
      resetChannels();
    }
  });

  it("摘要行：今日已签 N/M", async () => {
    clearChannels();
    setChannel(makeChannel("delta", { signin: true, claimedToday: true }));
    setChannel(makeChannel("epsilon", { signin: true, claimedToday: false }));
    try {
      const r = await run(["checkin", "--status"]);
      assert.equal(r.code, 0);
      assert.match(r.out, /今日已签 1\/2/, r.out);
    } finally {
      resetChannels();
    }
  });

  it("status 带本地台账摘要（不发网络请求）", async () => {
    clearChannels();
    setChannel(makeChannel("delta", { signin: true, claimedToday: true }));
    try {
      await run(["delta", "checkin", "--status"]); // 回填台账
      const r = await run(["delta", "status", "--addr", "127.0.0.1:1", "--ui-port", "1", "--json"]);
      assert.equal(r.code, 0);
      const parsed = JSON.parse(r.out) as { signin: { claimed_today: number; tracked: number } };
      assert.equal(parsed.signin.tracked >= 1, true);
      assert.equal(parsed.signin.claimed_today, 1);
    } finally {
      resetChannels();
    }
  });
});
