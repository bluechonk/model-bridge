/**
 * 仓库级入口冒烟：注册全部渠道 → 一个网关对外暴露**两个公共模型**。
 *
 * ⚠ 存储根指向临时目录：注册全部渠道后，任何 `paths.*` 调用都会解析到
 * `<root>/<cid>/`，本测试绝不碰真实主目录。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const HOME = mkdtempSync(join(tmpdir(), "modelmux-all-selftest-"));
process.env["MODELMUX_HOME"] = HOME;

/**
 * 渠道清单的**来源真相**：`packages/core/channels/<cid>/package.json` 存在即算一个渠道
 * （与 `scripts/verify-contract.mjs` 同口径）。
 *
 * 刻意**不写死数量** —— 写死就要求「每加一个渠道都回来改测试」，而这里真正要
 * 断言的是「目录里的渠道都注册上了」，数量本身不是被测对象。
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHANNELS_DIR = join(REPO_ROOT, "packages", "core", "channels");
const EXPECTED_CIDS = readdirSync(CHANNELS_DIR)
  .filter((name) => existsSync(join(CHANNELS_DIR, name, "package.json")))
  .sort();

const gw = await import("@modelmux/gateway");
await import("../dist/channels.js");

describe("仓库级模型池", () => {
  let running: Awaited<ReturnType<typeof gw.gateway.start>>;

  before(async () => {
    running = await gw.gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await running?.close().catch(() => {});
    rmSync(HOME, { recursive: true, force: true });
  });

  it("注册了 packages/core/channels/ 下的全部渠道（数量由目录推导）", () => {
    const cids = gw.channels().map((c) => c.config.cid).sort();
    assert.deepEqual(cids, EXPECTED_CIDS, "注册清单与 packages/core/channels/ 目录不一致");
    assert.ok(!cids.includes("cline"), "cline 渠道已移除");
    assert.ok(!cids.includes("zcode"), "zcode 渠道已移除");
  });

  it("服务身份是仓库级 modelmux（不是某个渠道）", async () => {
    const health = (await (await fetch(`http://${running.addr}/health`)).json()) as Record<string, unknown>;
    assert.equal(health["ok"], true);
    assert.equal(health["service"], "modelmux");
    const per = health["channels"] as Array<{ cid: string }>;
    assert.equal(per.length, EXPECTED_CIDS.length, "逐渠道报告");
  });

  it("/v1/models 动态返回全模型池，id 为 <cid>/<模型> 形态", async () => {
    const resp = await fetch(`http://${running.addr}/v1/models`);
    assert.equal(resp.status, 200);
    const payload = (await resp.json()) as { data: Array<{ id: string; owned_by: string }> };
    const ids = payload.data.map((m) => m.id).sort();
    // 全模型池：11 个渠道能提供的全部模型，按渠道挂前缀（同名模型各归各家）
    assert.ok(ids.includes("workbuddyai/deepseek-v4.1-flash"), "应包含 workbuddyai/deepseek-v4.1-flash");
    assert.ok(ids.includes("codearts/deepseek-v4.1-flash"), "应包含 codearts/deepseek-v4.1-flash");
    assert.ok(ids.includes("catpaw/glm-5.3-flash"), "应包含 catpaw/glm-5.3-flash");
    assert.ok(ids.length > 2, `应多于 2 个模型，实际 ${ids.length}`);
    assert.ok(
      payload.data.every((m) => /^[a-z0-9-]+\/.+$/.test(m.id)),
      "全部对外 id 都是 <cid>/<模型> 形态",
    );
    assert.ok(
      payload.data.every((m) => m.owned_by === m.id.split("/")[0]),
      "owned_by 即 id 前缀里的渠道",
    );
  });

  it("每个池 id 的候选渠道就是它的前缀（渠道由请求方指定）", () => {
    const candsOf = (model: string) => gw.poolCandidates(model).map((c) => c.cid);
    assert.deepEqual(candsOf("workbuddyai/deepseek-v4.1-flash"), ["workbuddyai"]);
    assert.deepEqual(candsOf("catpaw/glm-5.3-flash"), ["catpaw"]);
    // 不同渠道的同名模型是独立 id，各自只指回自己
    const four1 = [...gw.POOL_MODELS].filter((m) => m.endsWith("/deepseek-v4.1-flash"));
    assert.ok(four1.length >= 3, `4.1 至少 3 个渠道各自暴露，实际 ${four1.join(", ")}`);
  });

  it("裸模型名与未知渠道 → 400 unknown_model", async () => {
    const post = (model: string) =>
      fetch(`http://${running.addr}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
        headers: { "Content-Type": "application/json" },
      });
    // 裸模型名（无渠道前缀）：渠道必须由请求方指定
    const bare = await post("deepseek-v4.1-flash");
    assert.equal(bare.status, 400);
    assert.equal(((await bare.json()) as { error: { code: string } }).error.code, "unknown_model");
    // 未注册的渠道前缀
    const unknownChan = await post("nonexistent/deepseek-v4.1-flash");
    assert.equal(unknownChan.status, 400);
    assert.equal(
      ((await unknownChan.json()) as { error: { code: string } }).error.code,
      "unknown_model",
    );
  });

  it("有效的 <cid>/<模型> 请求：测试环境无凭据 → 503 not_authenticated", async () => {
    const model = gw.POOL_MODELS[0];
    assert.ok(model, "池里有模型");
    const resp = await fetch(`http://${running.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 503);
  });

  it("渠道一览：池 id 与渠道目录一一对应", () => {
    const rows = gw.channels().map((c) => {
      // 与 CLI 同样的容错：桩渠道（orcaterm）抛错 → 视为空
      let exposed: string[] = [];
      try {
        exposed = gw.runInChannel(c.config.cid, () => c.catalog.exposedIds());
      } catch {
        exposed = [];
      }
      return { cid: c.config.cid, exposed };
    });
    assert.equal(rows.length, EXPECTED_CIDS.length);

    const contributed = (cid: string) =>
      [...gw.POOL_MODELS].filter((model) => model.split("/")[0] === cid);

    assert.ok(
      contributed("workbuddyai").includes("workbuddyai/deepseek-v4.1-flash"),
      "workbuddyai 应贡献 deepseek-v4.1-flash",
    );
    // qoder 的上游 key 是短名（gfmodel），由渠道自己映射成池内名
    assert.ok(
      contributed("qoder").includes("qoder/glm-5.3-flash"),
      "qoder 应贡献 glm-5.3-flash",
    );

    const contributing = gw.channels().filter((c) => contributed(c.config.cid).length > 0);
    assert.ok(contributing.length >= 8, `至少 8 个渠道有贡献，实际 ${contributing.length}`);

    // 每个目录条目都应出现在该渠道的对外池 id 里（规范名形态，不在这里重写归一化）
    for (const row of rows) {
      const listed = contributed(row.cid);
      for (const id of row.exposed) {
        const poolId = gw.poolModelId(row.cid, id);
        assert.ok(listed.includes(poolId), `${row.cid} 的 ${id} 应对外为 ${poolId}`);
      }
    }
  });
});
