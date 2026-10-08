/**
 * Gemini Code Assist 模型目录：**静态表**（Cloud Code 没有模型列表端点，PROTOCOL §5）
 * + 呈现层的 flash-only 池策略。
 *
 * ## 静态表只有 1 条
 *
 * | id | name | contextWindow | maxTokens | supportsImage | efforts | default |
 * |---|---|---|---|---|---|---|
 * | `gemini-3.8-flash` | `Gemini 3.8 Flash` | 1_000_000 | 64_000 | true | low/medium/high/tiered | medium |
 *
 * - **不暴露 4 个带后缀的模型名**（档位走 efforts 下拉框，加后缀的是上游准入钥匙）
 * - **不暴露 lite**：真机实测 `gemini-3.8-flash-lite` 在两端点上**恒 404**
 * - 模型 id 归一：剥掉已知档位后缀 `-low/-medium/-high/-tiered`
 * - 静态表**每次现算**，不做任何缓存
 *
 * ## 池子策略
 *
 * `exposedIds()` **只**调用共享的 `isAllowedFamily()` 做过滤（flash-only），
 * 不自行实现家族判据（CONTRACT-TS §4）。被判据覆盖的完整条目仍从 `details()` 给出。
 */

import { isAllowedFamily } from "@model-bridge/gateway";

import { stripTierSuffix } from "./upstream.js";

export interface CatalogEntry {
  /** 对外暴露的 id（短名）。 */
  id: string;
  /** 上游裸模型名（档位由 buildChatBody 追加后缀）。 */
  slug: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  supportsImage: boolean;
  efforts: string[];
  defaultEffort: string;
}

/**
 * 内置兜底表（编译期快照，PROTOCOL §5）。
 *
 * ⚠ 静态表**必须存在**：未登录时用户仍应看到模型，否则渠道在选择器里凭空消失。
 */
export const FALLBACK_MODELS: CatalogEntry[] = [
  {
    id: "gemini-3.8-flash",
    slug: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    supportsImage: true,
    efforts: ["low", "medium", "high", "tiered"],
    defaultEffort: "medium",
  },
];

/** 静态表每次现算（不做缓存，PROTOCOL §5）。 */
export function loadCatalog(): CatalogEntry[] {
  return FALLBACK_MODELS.map((e) => ({ ...e, efforts: [...e.efforts] }));
}

/**
 * 对外暴露的模型 id（池内短名）。
 *
 * 归一去后缀后再过共享白名单（flash-only）—— `gemini-3.8-flash` 命中 `/flash/i`。
 */
export function exposedIds(): string[] {
  return loadCatalog()
    .map((entry) => stripTierSuffix(entry.id))
    .filter((id) => isAllowedFamily(id))
    .filter((id, index, arr) => arr.indexOf(id) === index); // 去重
}

/**
 * 短名 → 上游裸模型名（档位后缀由 `buildChatBody` 追加）；**未知原样返回**。
 *
 * 已知档位后缀会被剥掉（`gemini-3.8-flash-high` → `gemini-3.8-flash`）。
 */
export function resolveModel(name: string): string {
  const normalized = stripTierSuffix(name);
  for (const entry of loadCatalog()) {
    if (entry.id === name || entry.slug === name || entry.id === normalized || entry.slug === normalized) {
      return entry.slug;
    }
    if (entry.id.toLowerCase() === name.toLowerCase() || entry.slug.toLowerCase() === normalized.toLowerCase()) {
      return entry.slug;
    }
  }
  return name; // 未知原样透传（契约要求）
}

/** 目录详情（供状态页）。 */
export function details(): Array<Record<string, unknown>> {
  return loadCatalog().map((entry) => ({
    id: entry.id,
    name: entry.name,
    upstream: entry.slug,
    context_window: entry.contextWindow,
    max_output: entry.maxOutput,
    vision: entry.supportsImage,
    efforts: [...entry.efforts],
    default_effort: entry.defaultEffort,
  }));
}
