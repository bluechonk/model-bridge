/**
 * 存储落点：统一存储根 + cid 分层、历史顶层目录收拢（含新旧并存补齐）、
 * 文件级收敛（见 docs/STORAGE-CONVENTION.md）。
 *
 * 全程在 mkdtemp 的临时根下进行，绝不碰真实主目录。
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { clearChannels, setChannel, type BridgeConfig, type Channel } from "../dist/channel.js";
import * as paths from "../dist/paths.js";

/** 造一个只关心落点的假渠道（不注册 4 个模块 —— 本测试不走它们）。 */
function useChannel(cid: string, extra: Partial<BridgeConfig> = {}): BridgeConfig {
  const config: BridgeConfig = {
    cid,
    display: cid,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    legacyDirs: [`.${cid}-bridge`, `.${cid}2api`],
    legacyEnvVars: [`${cid.toUpperCase()}_HOME`],
    debugDumpEnv: `${cid.toUpperCase()}_DEBUG_DUMP`,
    ...extra,
  };
  // 注册表是进程级的：本文件反复用不同 cid，先清空以保持「单渠道模式」语义
  clearChannels();
  setChannel({ config } as Channel);
  return config;
}

/** 每个用例一个独立存储根（paths 按 (root,cid) 缓存收拢结果）。 */
function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "mb-storage-"));
  const saved = process.env["MODEL_BRIDGE_HOME"];
  process.env["MODEL_BRIDGE_HOME"] = root;
  try {
    fn(root);
  } finally {
    if (saved === undefined) delete process.env["MODEL_BRIDGE_HOME"];
    else process.env["MODEL_BRIDGE_HOME"] = saved;
    rmSync(root, { recursive: true, force: true });
  }
}

const write = (path: string, body: string): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf8");
};

describe("1. 分层：单根 + <cid>", () => {
  it("storage 根来自 MODEL_BRIDGE_HOME，渠道层是 <root>/<cid>", () => {
    withRoot((root) => {
      useChannel("alpha");
      assert.equal(paths.rootDir(), root);
      assert.equal(paths.channelDir(), join(root, "alpha"));
      assert.equal(paths.channelDirFor(useChannel("beta")), join(root, "beta"));
    });
  });

  it("旧的 <CID>_HOME 仍按存储根处理（兼容）", () => {
    const alt = mkdtempSync(join(tmpdir(), "mb-legacy-env-"));
    const savedNew = process.env["MODEL_BRIDGE_HOME"];
    const savedOld = process.env["ALPHA_HOME"];
    delete process.env["MODEL_BRIDGE_HOME"];
    process.env["ALPHA_HOME"] = alt;
    try {
      assert.equal(paths.rootDirFor(useChannel("alpha")), alt);
    } finally {
      if (savedNew !== undefined) process.env["MODEL_BRIDGE_HOME"] = savedNew;
      if (savedOld === undefined) delete process.env["ALPHA_HOME"];
      else process.env["ALPHA_HOME"] = savedOld;
      rmSync(alt, { recursive: true, force: true });
    }
  });

  it("channelFile 拒绝非法文件名，固定文件路径都在渠道层内", () => {
    withRoot((root) => {
      useChannel("alpha");
      assert.throws(() => paths.channelFile("Credential_Bad.json"), /非法文件名/);
      assert.equal(paths.credentialsPath(), join(root, "alpha", "credentials.json"));
      assert.equal(paths.pidPath(), join(root, "alpha", "gateway.pid"));
      assert.equal(paths.cacheDir(), join(root, "alpha", "cache"));
    });
  });
});

describe("2. 历史顶层目录收拢", () => {
  it("~/.<cid>-bridge 整目录收拢进 <root>/<cid>/（凭证随之而来）", () => {
    withRoot((root) => {
      useChannel("alpha");
      write(join(root, ".alpha-bridge", "credentials.json"), '{"accessToken":"x"}');
      const dir = paths.channelDir();
      assert.equal(dir, join(root, "alpha"));
      assert.equal(readFileSync(join(dir, "credentials.json"), "utf8"), '{"accessToken":"x"}');
      assert.equal(existsSync(join(root, ".alpha-bridge")), false, "旧顶层目录应被搬走");
    });
  });

  it("新旧并存：补齐缺失文件，且不覆盖已有文件", () => {
    withRoot((root) => {
      useChannel("alpha");
      write(join(root, "alpha", "gateway.log"), "NEW");
      write(join(root, ".alpha-bridge", "gateway.log"), "OLD");
      write(join(root, ".alpha-bridge", "credentials.json"), "{}");
      const dir = paths.channelDir();
      assert.equal(readFileSync(join(dir, "gateway.log"), "utf8"), "NEW", "已有文件不被覆盖");
      assert.ok(existsSync(join(dir, "credentials.json")), "缺失文件被补齐");
    });
  });

  it("只收拢第一个存在的历史目录，更旧的原样不动", () => {
    withRoot((root) => {
      useChannel("alpha");
      write(join(root, ".alpha-bridge", "credentials.json"), "{}");
      write(join(root, ".alpha2api", "credentials.json"), "{\"old\":true}");
      paths.channelDir();
      assert.ok(existsSync(join(root, ".alpha2api", "credentials.json")), "更旧的历史目录不动");
      assert.equal(existsSync(join(root, "alpha", "credentials.json")), true);
    });
  });

  it("skipMerge：标记为删除的条目不会在补齐时被搬过来", () => {
    withRoot((root) => {
      useChannel("alpha", { fileMigrations: [{ from: "junk", action: "delete" }] });
      // 目标层已存在 → 走「补齐」分支（整体搬移失败时的路径）
      mkdirSync(join(root, "alpha"), { recursive: true });
      write(join(root, ".alpha-bridge", "junk", "big.bin"), "x");
      write(join(root, ".alpha-bridge", "credentials.json"), "{}");
      const dir = paths.channelDir();
      assert.equal(existsSync(join(dir, "junk")), false, "已知废弃物不补齐");
      assert.ok(existsSync(join(dir, "credentials.json")), "正常文件照常补齐");
    });
  });

  it("不认其它渠道的旧顶层目录（防止跨渠道劫持）", () => {
    withRoot((root) => {
      useChannel("alpha");
      write(join(root, ".other-bridge", "credentials.json"), "{}");
      const dir = paths.channelDir();
      assert.equal(dir, join(root, "alpha"));
      assert.ok(existsSync(join(root, ".other-bridge")), "别人的旧目录必须原地不动");
    });
  });
});

describe("3. 文件级收敛", () => {
  it("daemon.pid → gateway.pid", () => {
    withRoot((root) => {
      useChannel("alpha", { fileMigrations: [{ from: "daemon.pid", to: "gateway.pid" }] });
      mkdirSync(join(root, "alpha"), { recursive: true });
      writeFileSync(join(root, "alpha", "daemon.pid"), "123\n", "utf8");
      paths.channelDir();
      assert.equal(readFileSync(join(root, "alpha", "gateway.pid"), "utf8"), "123\n");
      assert.equal(existsSync(join(root, "alpha", "daemon.pid")), false);
    });
  });

  it("action=delete 只在目录为空时删除，非空保留", () => {
    withRoot((root) => {
      useChannel("alpha", { fileMigrations: [{ from: "webview", action: "delete" }] });
      mkdirSync(join(root, "alpha", "webview", "nested"), { recursive: true });
      writeFileSync(join(root, "alpha", "webview", "nested", "keep.txt"), "x", "utf8");
      paths.channelDir();
      assert.ok(existsSync(join(root, "alpha", "webview")), "非空目录不删");
    });

    withRoot((root) => {
      useChannel("alpha", { fileMigrations: [{ from: "webview", action: "delete" }] });
      mkdirSync(join(root, "alpha", "webview"), { recursive: true });
      paths.channelDir();
      assert.equal(existsSync(join(root, "alpha", "webview")), false, "空目录可清理");
    });
  });
});

describe("4. 权限基线", () => {
  it("ensureDir 建出渠道层，并在 POSIX 下设 0700/0600", () => {
    withRoot((root) => {
      useChannel("alpha");
      const dir = paths.ensureDir();
      assert.ok(existsSync(dir));
      if (process.platform !== "win32") {
        assert.equal(statSync(dir).mode & 0o777, 0o700);
        paths.channelFile("credentials.json");
        writeFileSync(join(dir, "credentials.json"), "{}", "utf8");
        paths.ensureDir();
        assert.equal(statSync(join(dir, "credentials.json")).mode & 0o777, 0o600);
      }
    });
  });
});
