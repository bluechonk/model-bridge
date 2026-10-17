/**
 * 模型池策略：**全模型池**（放行全部渠道的真实模型）。
 *
 * 历史：曾限制为 `(deepseek | glm) && flash`，现已放宽为全部模型。
 * 如需重新限制，往 `FAMILY_ALLOWLIST` 里加正则（如 `/deepseek/i`）。
 *
 * 为什么值得单独锁死：这是**唯一的池子策略**，所有渠道的 `exposedIds()` 都调它。
 * 判据写宽一点就会把别家的模型漏进用户的模型选择器 —— 而那种错误在单渠道测试里
 * 看不出来（每个渠道只看到自己那几条），只有在这里用**真实命名变体**逐条断言才拦得住。
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
} from "../dist/pool/model-family.js";

/** 全模型池：全部放行。 */
const ALLOWED: ReadonlyArray<readonly [string, string]> = [
  // deepseek 系（id 里带家族）
  ["deepseek-v4.1-flash", ""],
  ["deepseek-v4-flash", ""],
  ["deepseek-flash", ""],
  ["deepseek-v4-flash-vision-exp", ""],
  ["deepseek-v4-flash-0731", ""],
  // raccoon：带渠道前缀
  ["sn-deepseek-v4-1-flash", ""],
  // traecn：大小写混排 + 后缀
  ["DeepSeek-V4-Flash", ""],
  ["DeepSeek-V4-Flash-Official", ""],
  // 斜杠前缀 + `~` 别名 + `:batch` 后缀（历史 id 形态）
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
  // 别家的模型（全模型池：也放行）
  ["qwen3.8-flash", "Qwen3.8-Flash"],
  ["qwen3-coder", ""],
  ["llama-4-scout", "Llama 4 Scout"],
  ["kimi-k3", ""],
];

describe("模型池策略：全模型池", () => {
  it("家族白名单为空（放行全部）", () => {
    assert.equal(FAMILY_ALLOWLIST.length, 0, `应放行全部，实际: ${FAMILY_ALLOWLIST.map((re) => re.source).join(" | ")}`);
    assert.equal(REQUIRED_ALLOWLIST.length, 0, `应不强制型号，实际: ${REQUIRED_ALLOWLIST.map((re) => re.source).join(" | ")}`);
  });

  it("放行：全部真实命名变体", () => {
    for (const [id, name] of ALLOWED) {
      assert.equal(isAllowedFamily(id, name), true, `应放行: ${id}${name ? ` / ${name}` : ""}`);
    }
  });

  it("filterAllowedFamily 与 isAllowedFamily 口径一致", () => {
    const entries = [
      { id: "deepseek-v4-flash", name: "" },
      { id: "qwen3.8-flash", name: "" },
      { id: "glm-5.3-flash", name: "" },
      { id: "llama-4-scout", name: "" },
    ];
    const kept = filterAllowedFamily(entries, (e) => [e.id, e.name]).map((e) => e.id);
    assert.deepEqual(kept, ["deepseek-v4-flash", "qwen3.8-flash", "glm-5.3-flash", "llama-4-scout"]);
  });

  it("排查开关 MODELMUX_ALLOW_ALL_MODELS=1 绕过白名单（不改代码）", () => {
    const saved = process.env["MODELMUX_ALLOW_ALL_MODELS"];
    process.env["MODELMUX_ALLOW_ALL_MODELS"] = "1";
    try {
      assert.equal(isAllowedFamily("qwen3.8-flash"), true, "开关打开时别家模型也放行");
      assert.equal(allowlistSummary(), "all (MODELMUX_ALLOW_ALL_MODELS=1)");
    } finally {
      if (saved === undefined) delete process.env["MODELMUX_ALLOW_ALL_MODELS"];
      else process.env["MODELMUX_ALLOW_ALL_MODELS"] = saved;
    }
  });

  it("策略摘要可读（状态页展示用）", () => {
    // 全模型池：摘要应为 "all"
    const summary = allowlistSummary();
    assert.equal(summary, "all");
  });
});
