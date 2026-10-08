/**
 * 模型池策略：**只放行「deepseek 系 / glm 系」的 flash 模型**。
 *
 * 即 `(deepseek | glm) && flash` 两条闸门同时成立。
 *
 * 为什么值得单独锁死：这是**唯一的池子策略**，所有渠道的 `exposedIds()` 都调它。
 * 判据写宽一点（比如改成 `includes("flash")` 之外再加家族）就会把别家的模型漏进
 * 用户的模型选择器 —— 而那种错误在单渠道测试里看不出来（每个渠道只看到自己那几条），
 * 只有在这里用**真实命名变体**逐条断言才拦得住。
 *
 * 全部用例的 id 都取自各渠道实测目录（见 `docs/POOL-ARCHITECTURE.md`）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  allowlistSummary,
  FAMILY_ALLOWLIST,
  filterAllowedFamily,
  isAllowedFamily,
  REQUIRED_ALLOWLIST,
} from "../dist/model-family.js";

/** 放行的真实命名变体（各渠道实测形态）。 */
const ALLOWED: ReadonlyArray<readonly [string, string]> = [
  // deepseek 系（id 里带家族）
  ["deepseek-v4.1-flash", ""],
  ["deepseek-v4-flash", ""],
  ["deepseek-flash", ""],
  ["deepseek-v4-flash-vision-exp", ""],
  ["deepseek-v4-flash-0731", ""],
  // raccoon：带渠道前缀
  ["sn-deepseek-v4-1-flash", ""],
  // trae：大小写混排 + 后缀
  ["DeepSeek-V4-Flash", ""],
  ["DeepSeek-V4-Flash-Official", ""],
  // cline：斜杠前缀 + `~` 别名 + `:batch` 后缀
  ["deepseek/deepseek-v4.1-flash", ""],
  ["deepseek/deepseek-v4.1-flash:batch", ""],
  ["~deepseek/deepseek-flash-latest", ""],
  ["~deepseek/deepseek-v4-flash-latest", ""],
  // glm 系
  ["glm-5.3-flash", ""],
  ["glm-5.3-flashx", ""],
  ["GLM-5.3-Flash", "GLM 5.3 Flash · x0.8"],
  ["sn-glm-5-3-flash", "GLM-5-3-Flash · x0.2→x0.1"],
  ["z-ai/glm-5.3-flash", ""],
  ["z-ai/glm-4.7-flash", ""],
  ["~z-ai/glm-flash-latest", ""],
];

/** 必须挡下的：同家族非 flash + 别家 flash 混排。 */
const BLOCKED: ReadonlyArray<readonly [string, string]> = [
  // 同家族但非 flash
  ["deepseek-v4-pro", ""],
  ["glm-5.2", "GLM-5.2"],
  ["glm-5.3", ""],
  ["z-ai/glm-5.3-prime", ""],
  ["kimi-k3", ""],
  // 别家的 flash（这是本次策略的关键：以前它们能进池）
  ["qwen3.8-flash", "Qwen3.8-Flash"],
  ["qwen3.8-flash", ""],
  ["qwen3.8-flash-max", ""],
  ["MiniMax-M3.1-Flash-Preview", ""],
  ["cline-free/mimo-v2.6-flash", ""],
  ["inclusionai/ling-3.0-flash", ""],
  ["xiaomi/mimo-v2.6-flash", ""],
  ["stepfun/step-3.5-flash", ""],
  ["rekaai/reka-flash-3", ""],
  ["catpaw-flash", "CatPaw Flash"],
  ["sn-sensenova-6-8-flash-lite", ""],
  // 别家且非 flash
  ["llama-4-scout", "Llama 4 Scout"],
];

describe("模型池策略：(deepseek | glm) && flash", () => {
  it("家族白名单是 deepseek 与 glm；必需标记是 flash（带前置词边界）", () => {
    const families = FAMILY_ALLOWLIST.map((re) => re.source);
    const required = REQUIRED_ALLOWLIST.map((re) => re.source);
    assert.equal(families.length, 2, `实际: ${families.join(" | ")}`);
    assert.ok(families.some((s) => s.includes("deepseek")), `缺 deepseek: ${families.join(" | ")}`);
    assert.ok(families.some((s) => s.includes("glm")), `缺 glm: ${families.join(" | ")}`);
    assert.equal(required.length, 1);
    assert.match(required[0]!, /flash/);
    // 前置词边界是判据正确性的一部分（防止误命中 alglmx-flash 这类名字）
    const BOUNDARY = "\\b"; // TS 源码里写作双反斜杠
    assert.ok(
      families.every((s) => s.startsWith(BOUNDARY)),
      `家族判据须带前置边界: ${families.join(" | ")}`,
    );
    assert.ok(required[0]!.startsWith(BOUNDARY), `型号判据须带前置边界: ${required[0]}`);
  });

  it("放行：deepseek/glm 系的 flash（覆盖各渠道真实命名变体）", () => {
    for (const [id, name] of ALLOWED) {
      assert.equal(isAllowedFamily(id, name), true, `应放行: ${id}${name ? ` / ${name}` : ""}`);
    }
  });

  it("挡下：同家族的非 flash（策略边界，故意挡）", () => {
    for (const [id, name] of BLOCKED.slice(0, 5)) {
      assert.equal(isAllowedFamily(id, name), false, `应挡下: ${id}`);
    }
  });

  it("挡下：别家的 flash（本次策略收窄的关键）", () => {
    for (const [id, name] of BLOCKED.slice(5)) {
      assert.equal(isAllowedFamily(id, name), false, `应挡下: ${id}${name ? ` / ${name}` : ""}`);
    }
  });

  it("两条闸门缺一不可：只带家族 → 挡；只带 flash → 挡", () => {
    assert.equal(isAllowedFamily("deepseek-v4"), false, "只有家族没有 flash");
    assert.equal(isAllowedFamily("glm-5.3"), false, "只有家族没有 flash");
    assert.equal(isAllowedFamily("qwen3.8-flash"), false, "只有 flash 没有家族");
    assert.equal(isAllowedFamily("deepseek-v4-flash"), true, "两者都有");
  });

  it("家族信息只在展示名里也认（qoder 那类「目录 key 当 id」）", () => {
    assert.equal(isAllowedFamily("dfmodel", "DeepSeek-Flash"), true);
    assert.equal(isAllowedFamily("gfmodel", "GLM-5.3-Flash"), true);
    assert.equal(isAllowedFamily("dfmodel"), false, "只传 id（不含家族）→ 挡");
  });

  it("空/缺省输入一律挡下（不因缺信息而误放行）", () => {
    assert.equal(isAllowedFamily(), false);
    assert.equal(isAllowedFamily(undefined), false);
    assert.equal(isAllowedFamily("", ""), false);
  });

  it("`glm` 是宽匹配但不误伤：命中 glm 的都是真 GLM 型号", () => {
    // 反例：以下 id 含 "glm" 子串吗？不含 —— 防止将来有人把判据改成 includes 之类的更宽匹配。
    for (const id of ["glimmer-flash", "alglmx-flash", "g-l-m-flash"]) {
      assert.equal(isAllowedFamily(id), false, `不该被 glm 误命中: ${id}`);
    }
  });

  it("filterAllowedFamily 与 isAllowedFamily 口径一致", () => {
    const entries = [
      { id: "deepseek-v4-flash", name: "" },
      { id: "qwen3.8-flash", name: "" },
      { id: "glm-5.3-flash", name: "" },
      { id: "qwen3.8-flash", name: "" },
    ];
    const kept = filterAllowedFamily(entries, (e) => [e.id, e.name]).map((e) => e.id);
    assert.deepEqual(kept, ["deepseek-v4-flash", "glm-5.3-flash"]);
  });

  it("排查开关 BRIDGE_ALLOW_ALL_MODELS=1 绕过白名单（不改代码）", () => {
    const saved = process.env["BRIDGE_ALLOW_ALL_MODELS"];
    process.env["BRIDGE_ALLOW_ALL_MODELS"] = "1";
    try {
      assert.equal(isAllowedFamily("qwen3.8-flash"), true, "开关打开时别家模型也放行");
      assert.equal(allowlistSummary(), "all (BRIDGE_ALLOW_ALL_MODELS=1)");
    } finally {
      if (saved === undefined) delete process.env["BRIDGE_ALLOW_ALL_MODELS"];
      else process.env["BRIDGE_ALLOW_ALL_MODELS"] = saved;
    }
  });

  it("策略摘要可读（状态页展示用）", () => {
    // 摘要直接来自正则 source（`\b` 会如实出现），不手写死字符串 —— 免得改判据忘了改它
    const summary = allowlistSummary();
    assert.match(summary, /deepseek/);
    assert.match(summary, /glm/);
    assert.match(summary, /&&/);
    assert.match(summary, /flash/);
  });
});
