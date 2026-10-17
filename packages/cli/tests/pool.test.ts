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

  it("/v1/models 动态返回全模型池，不带渠道前缀", async () => {
    const resp = await fetch(`http://${running.addr}/v1/models`);
    assert.equal(resp.status, 200);
    const payload = (await resp.json()) as { data: Array<{ id: string; owned_by: string }> };
    const ids = payload.data.map((m) => m.id).sort();
    // 全模型池：11 个渠道能提供的全部模型，去重后应包含 deepseek-v4-flash 与 glm-5.3-flash
    assert.ok(ids.includes("deepseek-v4-flash"), "应包含 deepseek-v4-flash");
    assert.ok(ids.includes("glm-5.3-flash"), "应包含 glm-5.3-flash");
    assert.ok(ids.length > 2, `应多于 2 个模型，实际 ${ids.length}`);
    assert.ok(
      payload.data.every((m) => !m.id.includes("/")),
      "不再暴露 <cid>/<模型> 形态",
    );
    assert.ok(payload.data.every((m) => m.owned_by === "modelmux"), "池身份");
  });

  it("每个池模型都有**跨渠道**候选（不是某个渠道私有）", () => {
    const cidsOf = (model: string) =>
      gw.poolCandidates(model as (typeof gw.POOL_MODELS)[number]).map((c) => c.cid);

    const four1 = cidsOf("deepseek-v4.1-flash");
    assert.ok(four1.includes("workbuddyai"), `4.1 候选: ${four1.join(", ")}`);
    assert.ok(four1.includes("codearts"), `4.1 候选: ${four1.join(", ")}`);
    assert.ok(four1.length >= 3, `4.1 至少 3 家，实际 ${four1.length}`);

    const glm = cidsOf("glm-5.3-flash");
    assert.ok(glm.includes("catpaw"), `glm 候选: ${glm.join(", ")}`);
    assert.ok(glm.includes("raccoon"), `glm 候选: ${glm.join(", ")}`);

    // 两个模型的候选集合互不相同（否则归一化把它们串在一起了）
    assert.notDeepEqual([...four1].sort(), [...glm].sort());
  });

  it("旧的 `<cid>/<模型>` 形态 → 400 unknown_model", async () => {
    const resp = await fetch(`http://${running.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "workbuddyai/deepseek-v4.1-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 400);
    const payload = (await resp.json()) as { error: { code: string } };
    assert.equal(payload.error.code, "unknown_model");
  });

  it("渠道一览：桩渠道不贡献模型，也不拖垮整表", () => {
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
      gw.POOL_MODELS.filter((model) => gw.poolCandidates(model).some((c) => c.cid === cid));

    assert.ok(
      contributed("workbuddyai").includes("deepseek-v4.1-flash"),
      "workbuddyai 应贡献 deepseek-v4.1-flash",
    );
    // qoder 的上游 key 是短名（gfmodel），由渠道自己映射成池内名；
    // 全模型池：qoder 可能贡献多个模型（gfmodel / dfmodel 等）
    assert.ok(
      contributed("qoder").includes("glm-5.3-flash"),
      "qoder 应贡献 glm-5.3-flash",
    );

    const contributing = gw.channels().filter((c) => contributed(c.config.cid).length > 0);
    assert.ok(contributing.length >= 8, `至少 8 个渠道有贡献，实际 ${contributing.length}`);

    // 每条被贡献的模型都必须在池内（不在这里重写归一化，避免与共享层脱节）
    for (const row of rows) {
      for (const id of row.exposed) {
        const inPool = gw.asPoolModel(id) !== null;
        const listed = contributed(row.cid);
        if (inPool) {
          assert.ok(listed.length > 0, `${row.cid} 的 ${id} 在池内，却没人列出来`);
        }
      }
    }
  });
});
