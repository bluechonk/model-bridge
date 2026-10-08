/**
 * 签到台账（`state/signin.json`）：本地记「我们最后一次实际领到是什么时候」。
 *
 * 重点验三件容易错的事：**时区/跨零点**（日期怎么算）、**同日去重与历史上限**、
 * **损坏容忍**（台账坏了不能让"今天签没签"变成崩溃）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { clearChannels, setChannel, type BridgeConfig, type Channel } from "../dist/channel.js";
import * as paths from "../dist/paths.js";
import {
  claimedTodayPerLedger,
  currentTimezone,
  dateInTimezone,
  ledgerExists,
  readLedger,
  recordClaim,
  HISTORY_LIMIT,
} from "../dist/signin-ledger.js";

const CID = "alpha";

function withRoot(fn: (root: string) => void): () => void {
  return () => {
    const root = mkdtempSync(join(tmpdir(), "mb-ledger-"));
    const saved = process.env["MODEL_BRIDGE_HOME"];
    process.env["MODEL_BRIDGE_HOME"] = root;
    const config: BridgeConfig = {
      cid: CID,
      display: CID,
      version: "0.0.0",
      defaultAddr: "127.0.0.1:1",
      uiPort: 2,
      legacyDirs: [`.${CID}`],
      debugDumpEnv: "ALPHA_DEBUG_DUMP",
    };
    clearChannels();
    setChannel({ config } as Channel);
    try {
      fn(root);
    } finally {
      clearChannels();
      if (saved === undefined) delete process.env["MODEL_BRIDGE_HOME"];
      else process.env["MODEL_BRIDGE_HOME"] = saved;
      rmSync(root, { recursive: true, force: true });
    }
  };
}

/** 次日的同一时刻（避免用真实时钟）。 */
function plusDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * 86_400_000);
}

describe("1. 落点与形状", () => {
  it("写在 <root>/<cid>/state/signin.json；未写过时不存在", withRoot((root) => {
    assert.equal(ledgerExists(CID), false, "还没有台账");
    assert.deepEqual(readLedger(CID).history, []);
    assert.equal(claimedTodayPerLedger(CID), false);

    const at = new Date("2026-10-08T03:00:00.000Z");
    const record = recordClaim(CID, { now: at, via: "cli" });
    const file = join(root, CID, "state", "signin.json");
    assert.ok(existsSync(file), "台账落在 state/ 子目录里");
    assert.equal(ledgerExists(CID), true);

    const saved = JSON.parse(readFileSync(file, "utf8")) as {
      version: number;
      timezone: string;
      last_claim: { date: string; at: string; via: string };
      history: unknown[];
    };
    assert.equal(saved.version, 1);
    assert.equal(saved.timezone, currentTimezone());
    assert.equal(saved.last_claim.date, record.date);
    assert.equal(saved.last_claim.via, "cli");
    assert.equal(saved.history.length, 1);

    if (process.platform !== "win32") {
      assert.equal(statSync(file).mode & 0o777, 0o600, "含记录文件应当 0600");
    }
    assert.equal(paths.stateDir(CID).endsWith(join(CID, "state")), true);
  }));
});

describe("2. 「今天」怎么算（时区与跨零点）", () => {
  it("dateInTimezone：同一时刻在不同时区可能是不同日期", () => {
    const at = new Date("2026-10-08T17:30:00.000Z"); // 上海已是 10-09 01:30
    assert.equal(dateInTimezone(at, "Asia/Shanghai"), "2026-10-09");
    assert.equal(dateInTimezone(at, "UTC"), "2026-10-08");
  });

  it("claimedTodayPerLedger 跟着传入的时刻走（跨零点）", withRoot(() => {
    const at = new Date("2026-10-08T03:00:00.000Z");
    recordClaim(CID, { now: at });
    assert.equal(claimedTodayPerLedger(CID, at), true, "同一天算已签");
    assert.equal(claimedTodayPerLedger(CID, plusDays(at, 1)), false, "第二天就不算了");
  }));
});

describe("3. 同日去重与历史上限", () => {
  it("同一天重复记只留一条（内容取最新）", withRoot(() => {
    const at = new Date("2026-10-08T03:00:00.000Z");
    recordClaim(CID, { now: at, via: "cli" });
    recordClaim(CID, { now: new Date(at.getTime() + 3600_000), via: "upstream-backfill" });
    const ledger = readLedger(CID);
    assert.equal(ledger.history.length, 1, "同一天只留一条");
    assert.equal(ledger.last_claim?.via, "upstream-backfill");
  }));

  it(`history 最多 ${HISTORY_LIMIT} 条（新→旧）`, withRoot(() => {
    const base = new Date("2026-01-01T03:00:00.000Z");
    for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) recordClaim(CID, { now: plusDays(base, i) });
    const ledger = readLedger(CID);
    assert.equal(ledger.history.length, HISTORY_LIMIT);
    assert.equal(ledger.history[0]!.date > ledger.history.at(-1)!.date, true, "新在前");
  }));
});

describe("4. 损坏容忍", () => {
  it("台账损坏/形状不对 → 当空台账，不抛错", withRoot((root) => {
    const file = join(root, CID, "state", "signin.json");
    for (const bad of ["{ not json", "[]", '"字符串"', '{"history":"不是数组"}', "null"]) {
      rmSync(file, { force: true });
      paths.ensureStateDir(CID);
      writeFileSync(file, bad, "utf8");
      assert.deepEqual(readLedger(CID).history, [], `内容 ${bad}`);
      assert.equal(claimedTodayPerLedger(CID), false);
    }
  }));

  it("history 里的坏条目被跳过，好条目留下", withRoot((root) => {
    const file = join(root, CID, "state", "signin.json");
    paths.ensureStateDir(CID);
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        timezone: "Asia/Shanghai",
        history: [{ date: "2026-10-08", at: "x", via: "cli" }, { date: "" }, "垃圾", { at: "无 date" }],
      }),
      "utf8",
    );
    const ledger = readLedger(CID);
    assert.equal(ledger.history.length, 1);
    assert.equal(ledger.history[0]!.date, "2026-10-08");
    assert.equal(ledger.timezone, "Asia/Shanghai");
  }));
});
