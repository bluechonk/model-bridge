/**
 * 账号池：一个渠道下多个账号的收进 / 切换 / 删除 / 对账。
 *
 * 用**合成渠道**，但凭证走**真实文件系统**（临时存储根）—— 账号池的全部动作
 * 都是文件操作，这样才能真验到（凭证文件复制、mtime 对账、权限）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";

import {
  accountKey,
  activateAccount,
  captureActive,
  listAccounts,
  markActiveHealth,
  readAccountCredential,
  removeAccount,
  syncPool,
} from "../dist/account-pool.js";
import { clearChannels, setChannel, type BridgeConfig, type Channel } from "../dist/channel.js";
import * as paths from "../dist/paths.js";

/** 合成渠道：cred 只认 uid/domain/accessToken（契约字段），落盘在 credentials.json。 */
function makeChannel(cid: string): Channel {
  const config: BridgeConfig = {
    cid,
    display: `Synth ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    legacyDirs: [`.${cid}-bridge`],
    debugDumpEnv: `${cid.toUpperCase()}_DEBUG_DUMP`,
  };
  const load = (): Record<string, unknown> => {
    const raw = readFileSync(paths.credentialsPath(cid), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  };
  const save = async (c: Record<string, unknown>): Promise<void> => {
    mkdirSync(paths.channelDir(cid), { recursive: true });
    writeFileSync(paths.credentialsPath(cid), `${JSON.stringify(c, null, 2)}\n`, "utf8");
  };
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      load,
      save,
      login: async () => load(),
      refresh: async (c: Record<string, unknown>) => {
        const next = { ...c, accessToken: `${String(c["accessToken"])}-refreshed` };
        await save(next);
        return next;
      },
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "openai" as const,
      DISPLAY_NAME: `Synth ${cid}`,
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      loadConfig: () => [{ baseUrl: "http://127.0.0.1:1" }, false],
      saveConfig: async () => {},
      chatUrl: () => "http://127.0.0.1:1/chat",
      modelsUrl: () => "http://127.0.0.1:1/models",
      buildHeaders: () => ({}),
      buildChatBody: (req: Record<string, unknown>) => req,
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
    },
    catalog: { exposedIds: () => [], resolveModel: (n: string) => n },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

const CID = "alpha";

/** 在独立临时根里跑一段用例（池子按路径缓存，故每例一个新根）。 */
function withRoot(fn: (root: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "mb-accounts-"));
    const saved = process.env["MODEL_BRIDGE_HOME"];
    process.env["MODEL_BRIDGE_HOME"] = root;
    clearChannels();
    setChannel(makeChannel(CID));
    try {
      await fn(root);
    } finally {
      if (saved === undefined) delete process.env["MODEL_BRIDGE_HOME"];
      else process.env["MODEL_BRIDGE_HOME"] = saved;
      clearChannels();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

/** 写一份"登录成果"到 credentials.json。 */
function seedCredential(uid: string, accessToken = `tok-${uid}`): Record<string, unknown> {
  mkdirSync(paths.channelDir(CID), { recursive: true });
  const cred = { accessToken, refreshToken: `r-${uid}`, uid, domain: "example.com", nickname: uid };
  writeFileSync(paths.credentialsPath(CID), `${JSON.stringify(cred, null, 2)}\n`, "utf8");
  return cred;
}

describe("1. 池子文件布局", () => {
  it("空池：不无端创建索引", withRoot(async () => {
    assert.deepEqual(listAccounts(CID), { version: 1, active: null, accounts: [] });
    assert.equal(existsSync(join(paths.channelDir(CID), "accounts.json")), false, "没有账号就不该有索引文件");
  }));

  it("captureActive：收进 accounts/<key>.json，元信息取自契约字段", withRoot(async () => {
    const cred = seedCredential("user-1");
    const account = captureActive(CID)!;
    const key = accountKey(cred);
    assert.equal(account.key, key);
    assert.equal(account.uid, "user-1");
    assert.equal(account.domain, "example.com");
    assert.equal(account.label, "user-1");

    // 池内文件与 credentials.json 逐字节一致（共享层不解释格式，只复制）
    const poolFile = join(paths.channelDir(CID), "accounts", `${key}.json`);
    assert.ok(existsSync(poolFile), "账号文件应存在");
    assert.equal(readFileSync(poolFile, "utf8"), readFileSync(paths.credentialsPath(CID), "utf8"));

    const index = listAccounts(CID);
    assert.equal(index.active, key);
    assert.equal(index.accounts.length, 1);
  }));

  it("key 稳定：同一账号重登（换 token）不新增条目", withRoot(async () => {
    seedCredential("user-1", "tok-old");
    const first = captureActive(CID)!;
    seedCredential("user-1", "tok-new"); // 重登 / 刷新，token 变了
    const second = captureActive(CID)!;
    assert.equal(second.key, first.key, "key 只由 domain+uid 决定");
    assert.equal(listAccounts(CID).accounts.length, 1, "池里仍只有一条");
    assert.equal(second.added_at, first.added_at, "added_at 保持不变");
  }));
});

describe("2. 切换与删除", () => {
  it("activateAccount：把池内那份复制回 credentials.json", withRoot(async () => {
    seedCredential("user-1");
    const one = captureActive(CID)!;
    seedCredential("user-2");
    captureActive(CID); // user-2 成为 active
    assert.equal(listAccounts(CID).accounts.length, 2);

    activateAccount(one.key, CID);
    const live = JSON.parse(readFileSync(paths.credentialsPath(CID), "utf8")) as Record<string, unknown>;
    assert.equal(live["uid"], "user-1", "生效凭证换成了 user-1");
    assert.equal(listAccounts(CID).active, one.key);
  }));

  it("activateAccount：key 不存在时明确报错", withRoot(async () => {
    seedCredential("user-1");
    captureActive(CID);
    assert.throws(() => activateAccount("deadbeefdeadbeef", CID), /account not found/);
  }));

  it("removeAccount：删的是 active 时同时登出，且不会被同步再收回来", withRoot(async () => {
    seedCredential("user-1");
    const one = captureActive(CID)!;
    const result = removeAccount(one.key, CID);
    assert.deepEqual(result, { removed: true, wasActive: true, loggedOut: true });
    assert.equal(existsSync(join(paths.channelDir(CID), "accounts", `${one.key}.json`)), false, "池内文件已删");
    assert.equal(existsSync(paths.credentialsPath(CID)), false, "生效凭证一并删除（= 登出）");
    const index = listAccounts(CID);
    assert.equal(index.active, null);
    assert.equal(index.accounts.length, 0, "不会因为凭证还在又被收回来");
  }));

  it("removeAccount：删非 active 账号不动生效凭证", withRoot(async () => {
    seedCredential("user-1");
    const one = captureActive(CID)!;
    seedCredential("user-2");
    const two = captureActive(CID)!; // user-2 生效
    const result = removeAccount(one.key, CID);
    assert.deepEqual(result, { removed: true, wasActive: false, loggedOut: false });
    assert.ok(existsSync(paths.credentialsPath(CID)), "生效凭证不受影响");
    const index = listAccounts(CID);
    assert.equal(index.active, two.key);
    assert.deepEqual(index.accounts.map((a) => a.uid), ["user-2"]);
  }));
});

describe("3. 与渠道写盘对账", () => {
  it("渠道自己刷新写新 credentials.json → 池内那份被回灌", withRoot(async () => {
    seedCredential("user-1", "tok-1");
    const account = captureActive(CID)!;
    const before = readAccountCredential(account.key, CID);

    // 模拟渠道 refresh()：只写 credentials.json
    const refreshed = { ...before, accessToken: "tok-1-refreshed" };
    writeFileSync(paths.credentialsPath(CID), `${JSON.stringify(refreshed, null, 2)}\n`, "utf8");

    listAccounts(CID); // 触发对账
    const after = readAccountCredential(account.key, CID);
    assert.equal(after["accessToken"], "tok-1-refreshed", "池内副本被回灌");
  }));

  it("syncPool：池子空但已有凭证 → 自动入池；已有 active → 只对账", withRoot(async () => {
    seedCredential("user-1");
    syncPool(CID);
    const index = listAccounts(CID);
    assert.equal(index.accounts.length, 1, "登录即入池");

    const key = index.accounts[0]!.key;
    writeFileSync(paths.credentialsPath(CID), JSON.stringify({ ...readAccountCredential(key, CID), accessToken: "tok-2" }), "utf8");
    syncPool(CID);
    assert.equal(listAccounts(CID).accounts.length, 1, "不会重复入池");
    assert.equal(readAccountCredential(key, CID)["accessToken"], "tok-2", "回灌生效");
  }));
});

describe("4. 健康度与权限", () => {
  it("markActiveHealth 写进索引；同值不重复写", withRoot(async () => {
    seedCredential("user-1");
    captureActive(CID);
    const indexFile = join(paths.channelDir(CID), "accounts.json");
    const stampBefore = statSync(indexFile).mtimeMs;

    markActiveHealth("ok", CID); // 无变化 → 不写
    assert.equal(statSync(indexFile).mtimeMs, stampBefore, "同值不该写盘");

    markActiveHealth("unauthorized", CID);
    const index = listAccounts(CID);
    assert.equal(index.accounts[0]!.health, "unauthorized");
    assert.ok(index.accounts[0]!.health_at.length > 0);
  }));

  it("池内账号文件是 0600（POSIX）", withRoot(async () => {
    if (process.platform === "win32") return;
    seedCredential("user-1");
    const account = captureActive(CID)!;
    const poolFile = join(paths.channelDir(CID), "accounts", `${account.key}.json`);
    assert.equal(statSync(poolFile).mode & 0o777, 0o600);
    assert.equal(statSync(paths.credentialsPath(CID)).mode & 0o777, 0o600);
    assert.equal(basename(paths.channelDir(CID)), CID);
  }));
});
