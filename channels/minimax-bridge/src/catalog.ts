/**
 * MiniMax Code 模型目录与别名映射。
 *
 * 实现依据：`docs/protocols/minimax/PROTOCOL.md`（§5.2 兜底静态模型表）与 `../docs/CONTRACT-TS.md`（§4 模型池策略）。
 *
 * ⚠ **本模块只负责「目录（数据层）」，「池子（呈现层）」由共享层的白名单决定**。
 * `exposedIds()` 必须调用共享的 `isAllowedFamily()`，**不自行实现家族判据**。
 *
 * 白名单是 flash-only（`FAMILY_ALLOWLIST = [/flash/i]`）⇒ 目录里的四条只有
 * `MiniMax-M3.1-Flash-Preview` 进池，其余（M3 / M2.7-highspeed / M2.7）**不进**
 * —— 这是预期行为，不是渠道坏了。底层目录数据仍完整保留（`details()` 可见），
 * 各条目的 `resolveModel()` 对这些 id 仍能正常解析。
 *
 * ⚠ 兜底表路径**不调用归一函数**，直接搬运字面量（§5.2）；顺序照抄远端 `model_order`。
 */

import { isAllowedFamily } from "@model-bridge/gateway";

export interface CatalogEntry {
  /** 对外暴露的 id（= 远端目录对象 key，长名）。 */
  id: string;
  /** 上游真实模型名（本渠道 id 即 slug）。 */
  slug: string;
  /** 展示名（远端条目的 `name`，短名）。 */
  name: string;
  contextWindow: number;
  maxTokens: number;
  supportsImage: boolean;
  /** 思考档位（§5.2：只有 M3.1-Flash-Preview 有）。 */
  effortOptions: string[];
  defaultEffort: string | null;
  thinkingMode: string;
}

/**
 * 兜底静态模型表（§5.2，字面量照抄，顺序即远端 `model_order`）。
 *
 * - `MiniMax-M3.1-Flash-Preview` 的 `contextWindow` 取**档位表最大档** 1_000_000
 *   （其 `limit.context` 是 512000，但 `context_window_options` 最大档是 1M）
 * - 只有 M3.1-Flash-Preview 有 `effort_options`
 * - `thinkingMode`：M3.1 是 `forced_on`、M3 是 `switchable`、M2.7 系是 `forced_on`
 */
export const FALLBACK_MODELS: CatalogEntry[] = [
  {
    id: "MiniMax-M3.1-Flash-Preview",
    slug: "MiniMax-M3.1-Flash-Preview",
    name: "M3.1-Flash-Preview",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    supportsImage: true,
    effortOptions: ["default", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "default",
    thinkingMode: "forced_on",
  },
  {
    id: "MiniMax-M3",
    slug: "MiniMax-M3",
    name: "M3",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    supportsImage: true,
    effortOptions: [],
    defaultEffort: null,
    thinkingMode: "switchable",
  },
  {
    id: "MiniMax-M2.7-highspeed",
    slug: "MiniMax-M2.7-highspeed",
    name: "M2.7-highspeed",
    contextWindow: 200_000,
    maxTokens: 128_000,
    supportsImage: false,
    effortOptions: [],
    defaultEffort: null,
    thinkingMode: "forced_on",
  },
  {
    id: "MiniMax-M2.7",
    slug: "MiniMax-M2.7",
    name: "M2.7",
    contextWindow: 200_000,
    maxTokens: 128_000,
    supportsImage: false,
    effortOptions: [],
    defaultEffort: null,
    thinkingMode: "forced_on",
  },
];

/** 返回目录条目（本渠道兜底表即完整目录）。 */
export function loadCatalog(): CatalogEntry[] {
  return FALLBACK_MODELS.map((e) => ({ ...e, effortOptions: [...e.effortOptions] }));
}

/**
 * 对外暴露的模型 ID 列表（短名，已过白名单）。
 *
 * ⚠ 白名单是网关级策略（flash-only）：只有 `MiniMax-M3.1-Flash-Preview` 进池。
 * **只调用共享 `isAllowedFamily()`**，不自行实现家族判据（CONTRACT-TS §4）。
 */
export function exposedIds(): string[] {
  return loadCatalog()
    .filter((entry) => isAllowedFamily(entry.id, entry.slug, entry.name))
    .map((entry) => entry.id);
}

/**
 * 把客户端请求中的短名映射为上游 slug（本渠道 id 即 slug）。
 *
 * 支持大小写不敏感命中与展示短名（`M3.1-Flash-Preview`）；未知名称原样透传。
 */
export function resolveModel(name: string): string {
  for (const entry of loadCatalog()) {
    if (entry.id === name || entry.slug === name) return entry.slug;
  }
  const folded = name.toLowerCase();
  for (const entry of loadCatalog()) {
    if (entry.id.toLowerCase() === folded || entry.name.toLowerCase() === folded) {
      return entry.slug;
    }
  }
  return name;
}

/** 供状态页/UI 使用的目录详情（未过滤，含被挡在池外的模型）。 */
export function details(): Array<Record<string, unknown>> {
  return loadCatalog().map((entry) => ({
    id: entry.id,
    name: entry.name,
    upstream: entry.slug,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    supportsImage: entry.supportsImage,
    effortOptions: entry.effortOptions,
    defaultEffort: entry.defaultEffort,
    thinkingMode: entry.thinkingMode,
  }));
}
