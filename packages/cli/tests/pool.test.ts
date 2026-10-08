/**
 * 仓库级入口冒烟：注册全部渠道 → 一个网关对外暴露**模型池**。
 *
 * ⚠ 存储根指向临时目录：注册全部渠道后，任何 `paths.*` 调用都会解析到
 * `<root>/<cid>/`，本测试绝不碰真实主目录。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const HOME = mkdtempSync(join(tmpdir(), "mb-all-selftest-"));
process.env["MODEL_BRIDGE_HOME"] = HOME;
delete process.env["MODEL_BRIDGE_API_KEY"];

const gw = await import("@model-bridge/gateway");
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

  it("注册了全部 12 个渠道", () => {
    const cids = gw.channels().map((c) => c.config.cid).sort();
    assert.equal(cids.length, 12, `实际: ${cids.join(", ")}`);
    for (const cid of ["workbuddy", "catpaw", "trae", "codearts", "loomy", "qoder"]) {
      assert.ok(cids.includes(cid), `缺少渠道 ${cid}`);
    }
  });

  it("服务身份是仓库级 model-bridge（不是某个渠道）", async () => {
    const health = (await (await fetch(`http://${running.addr}/health`)).json()) as Record<string, unknown>;
    assert.equal(health["ok"], true);
    assert.equal(health["service"], "model-bridge");
    const per = health["channels"] as Array<{ cid: string }>;
    assert.equal(per.length, 12, "逐渠道报告");
  });

  it("/v1/models 暴露 <cid>/<模型> 形式的池子并集", async () => {
    const resp = await fetch(`http://${running.addr}/v1/models`);
    assert.equal(resp.status, 200);
    const payload = (await resp.json()) as { data: Array<{ id: string }> };
    const ids = payload.data.map((m) => m.id);
    assert.ok(ids.length >= 8, `池子里应有多个渠道的模型，实际 ${ids.length} 条`);
    assert.ok(ids.every((id) => id.includes("/")), "多渠道路由下每个 id 都带渠道前缀");
    assert.ok(
      ids.includes("workbuddy/deepseek-flash"),
      `应含 workbuddy 的短名；实际样例: ${ids.slice(0, 5).join(", ")}`,
    );
    // 渠道前缀都必须是已注册的 cid
    const cids = new Set(gw.channels().map((c) => c.config.cid));
    for (const id of ids) {
      assert.ok(cids.has(id.slice(0, id.indexOf("/"))), `未知前缀: ${id}`);
    }
  });

  it("模型池只放行 flash 家族（白名单是网关级策略）", async () => {
    const payload = (await (await fetch(`http://${running.addr}/v1/models`)).json()) as {
      data: Array<{ id: string }>;
    };
    for (const m of payload.data) {
      assert.match(m.id, /flash/i, `池子外的模型不该出现: ${m.id}`);
    }
  });

  it("按前缀路由到对应渠道；前缀未知 → 400", async () => {
    assert.equal(gw.resolveTarget("workbuddy/deepseek-flash").channel.config.cid, "workbuddy");
    assert.equal(gw.resolveTarget("cline/cline-free/mimo-v2.6-flash").upstreamModel, "cline-free/mimo-v2.6-flash");

    const resp = await fetch(`http://${running.addr}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "nope/x", messages: [{ role: "user", content: "hi" }] }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 400);
    const payload = (await resp.json()) as { error: { code: string } };
    assert.equal(payload.error.code, "unknown_channel");
  });

  it("渠道一览（channels 命令的数据源）：未实现的渠道不贡献模型，也不拖垮整表", () => {
    // 与 CLI 的 exposedIdsOf 同样的容错：桩渠道（qoder）抛错 → 视为空池
    const rows = gw.channels().map((c) => {
      let models: string[] = [];
      try {
        models = gw.runInChannel(c.config.cid, () => c.catalog.exposedIds());
      } catch {
        models = [];
      }
      return { cid: c.config.cid, models };
    });
    assert.equal(rows.length, 12);
    assert.ok(
      rows.find((r) => r.cid === "workbuddy")!.models.includes("deepseek-flash"),
      "workbuddy 池子里应有 deepseek-flash",
    );
    assert.deepEqual(rows.find((r) => r.cid === "qoder")!.models, [], "qoder 是桩 → 空池");
    assert.ok(
      rows.filter((r) => r.models.length > 0).length >= 8,
      "至少 8 个渠道有可用模型",
    );
  });
});
