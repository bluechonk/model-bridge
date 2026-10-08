/**
 * 远端目录的磁盘缓存（`cache/models.json`）。
 *
 * 为什么要有它：渠道拉到的远端目录默认只进内存，换个新进程就没了 → `model list`
 * 回落到随包兜底表（实测 lobsterai 因此只显示 1 条，而真实是 8 条）。
 *
 * 全程离线：临时存储根 + 合成渠道。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  catalogCacheFetchedAt,
  catalogCachePath,
  readCatalogCache,
  writeCatalogCache,
} from "../dist/catalog-cache.js";
import { clearChannels, setChannel, type BridgeConfig, type Channel } from "../dist/channel.js";

function useChannel(cid: string): void {
  const config: BridgeConfig = {
    cid,
    display: cid,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    legacyDirs: [`.${cid}`],
    debugDumpEnv: `${cid.toUpperCase()}_DEBUG_DUMP`,
  };
  clearChannels();
  setChannel({ config } as Channel);
}

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "mb-catalog-cache-"));
  const saved = process.env["MODEL_BRIDGE_HOME"];
  process.env["MODEL_BRIDGE_HOME"] = root;
  try {
    fn(root);
  } finally {
    if (saved === undefined) delete process.env["MODEL_BRIDGE_HOME"];
    else process.env["MODEL_BRIDGE_HOME"] = saved;
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("目录磁盘缓存", () => {
  it("落在渠道层内的 cache/models.json（不是根、也不是别的地方）", () => {
    withRoot((root) => {
      useChannel("alpha");
      assert.equal(catalogCachePath(), join(root, "alpha", "cache", "models.json"));
    });
  });

  it("写入后原样读回，含渠道自有字段与 fetched_at", () => {
    withRoot(() => {
      useChannel("alpha");
      const entries = [
        { id: "model-a", name: "A", context_window: 1000, source: "remote", capabilities: ["x"] },
        { id: "model-b", name: "B", custom: { nested: true } },
      ];
      assert.equal(writeCatalogCache(entries), true, "写入应成功");

      const back = readCatalogCache<Record<string, unknown>>();
      assert.deepEqual(back, entries, "字段原样往返（共享层不解释渠道字段）");

      const at = catalogCacheFetchedAt();
      assert.ok(at && !Number.isNaN(Date.parse(at)), `fetched_at 应是合法时间: ${String(at)}`);

      const raw = JSON.parse(readFileSync(catalogCachePath(), "utf8")) as {
        version: number;
        models: unknown[];
      };
      assert.equal(raw.version, 1);
      assert.equal(raw.models.length, 2);
    });
  });

  it("没有缓存 → null（不抛错，也不虚构）", () => {
    withRoot(() => {
      useChannel("alpha");
      assert.equal(readCatalogCache(), null);
      assert.equal(catalogCacheFetchedAt(), null);
    });
  });

  it("空数组不写（避免用空目录覆盖好的缓存）", () => {
    withRoot(() => {
      useChannel("alpha");
      assert.equal(writeCatalogCache([]), false);
      assert.equal(existsSync(catalogCachePath()), false);
    });
  });

  it("损坏 / 形状不对 → null（不抛错）", () => {
    withRoot(() => {
      useChannel("alpha");
      writeCatalogCache([{ id: "a" }]);
      const path = catalogCachePath();

      writeFileSync(path, "{ 不是 JSON", "utf8");
      assert.equal(readCatalogCache(), null);

      writeFileSync(path, JSON.stringify({ version: 1, models: "不是数组" }), "utf8");
      assert.equal(readCatalogCache(), null);

      // 条目里没有 id 的会被丢掉；一个都不剩 → null
      writeFileSync(path, JSON.stringify({ version: 1, models: [{ name: "无 id" }] }), "utf8");
      assert.equal(readCatalogCache(), null);
    });
  });

  it("通道层内路径由 cid 推导（缓存不会串到别的渠道）", () => {
    withRoot((root) => {
      useChannel("alpha");
      writeCatalogCache([{ id: "a" }]);
      useChannel("beta");
      assert.equal(readCatalogCache(), null, "beta 不该看到 alpha 的缓存");
      assert.ok(existsSync(join(root, "alpha", "cache", "models.json")));
    });
  });

  it("POSIX 下缓存文件是 0600", () => {
    if (process.platform === "win32") return;
    withRoot(() => {
      useChannel("alpha");
      writeCatalogCache([{ id: "a" }]);
      assert.equal(statSync(catalogCachePath()).mode & 0o777, 0o600);
    });
  });
});
