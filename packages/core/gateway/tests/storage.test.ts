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

import { clearChannels, setChannel, type ChannelConfig, type Channel } from "../dist/channel.js";
import * as paths from "../dist/paths.js";

/** 造一个只关心落点的假渠道（不注册 4 个模块 —— 本测试不走它们）。 */
function useChannel(cid: string, extra: Partial<ChannelConfig> = {}): ChannelConfig {
  const config: ChannelConfig = {
    cid,
    display: cid,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
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
  const root = mkdtempSync(join(tmpdir(), "modelmux-storage-"));
  const saved = process.env["MODELMUX_HOME"];
  process.env["MODELMUX_HOME"] = root;
  try {
    fn(root);
  } finally {
    if (saved === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = saved;
    rmSync(root, { recursive: true, force: true });
  }
}

const write = (path: string, body: string): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf8");
};

describe("1. 分层：单根 + <cid>", () => {
  it("storage 根来自 MODELMUX_HOME，渠道层是 <root>/<cid>", () => {
    withRoot((root) => {
      useChannel("alpha");
      assert.equal(paths.rootDir(), root);
      assert.equal(paths.channelDir(), join(root, "alpha"));
      assert.equal(paths.channelDirFor(useChannel("beta")), join(root, "beta"));
    });
  });

  it("channelFile 拒绝非法文件名，固定文件路径都在渠道层内", () => {
    withRoot((root) => {
      useChannel("alpha");
      assert.throws(() => paths.channelFile("Credential_Bad.json"), /invalid file name/);
      assert.equal(paths.credentialsPath(), join(root, "alpha", "credentials.json"));
      assert.equal(paths.pidPath(), join(root, "alpha", "gateway.pid"));
      assert.equal(paths.cacheDir(), join(root, "alpha", "cache"));
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
