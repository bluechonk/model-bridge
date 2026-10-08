/**
 * CatPaw 模型目录：上游 `/api/agent/maas/model-types` 返回的模型表。
 *
 * ## 策略
 *
 * 1. **短名映射**：直接用上游 `id` 字段，不做短名映射（避免多层维护）。
 * 2. **池过滤**：只调用共享 `isAllowedFamily()`（flash-only），不自研判据。
 * 3. **同步接口**：`exposedIds()` / `resolveModel()` 必须同步返回 ——
 *    上游目录通过 `upstream.fetchModels()` 成功时经 `setCatalog()` 回填缓存；
 *    未回填前走兜底表。
 * 4. **兜底表**：未登录或上游目录未拉取时，仍能暴露 flash 模型。
 */

import { isAllowedFamily } from "@model-bridge/gateway";

/** 一条模型目录条目。 */
export interface CatalogEntry {
  /** 对外暴露的 id（= 上游 id）。 */
  id: string;
  /** 展示名（上游 displayName / name）。 */
  name: string;
  /** 上游 modelType（数值，turn 请求必填）。 */
  modelType: number;
  /** 是否支持推理。 */
  reasoning: boolean;
  /** 上下文窗口。 */
  contextWindow: number;
  /** 描述。 */
  description: string;
  /** 是否支持图片输入。 */
  supportsImages: boolean;
}

/**
 * 兜底表：上游模型目录不可用时仍可暴露的模型。
 *
 * ⚠ 只放 flash 家族（白名单 `/flash/i`）。catpaw 上游实际模型名以
 * `/model-types` 返回为准，兜底表是「未拉到上游也能看到模型」的保险。
 */
const FALLBACK_MODELS: CatalogEntry[] = [
  {
    id: "catpaw-flash",
    name: "CatPaw Flash",
    modelType: 1,
    reasoning: false,
    contextWindow: 0,
    description: "fallback (upstream unavailable)",
    supportsImages: false,
  },
];

/** 上游目录缓存（由 upstream.fetchModels() 成功时回填）。 */
let _remote: CatalogEntry[] | null = null;

/** 回填上游模型目录（由 upstream.fetchModels 成功后调用）。 */
export function setCatalog(entries: CatalogEntry[]): void {
  _remote = entries.length > 0 ? entries : null;
}

/** 当前目录（上游缓存优先，缺则兜底）。 */
export function loadCatalog(): CatalogEntry[] {
  if (_remote && _remote.length > 0) return [..._remote];
  return FALLBACK_MODELS.map((e) => ({ ...e }));
}

/**
 * 归一化上游模型行（字段名有多种历史写法，见 docs/protocols/catpaw/PROTOCOL.md）。
 * 供 upstream.fetchModels 调用。
 */
export function toModelInfo(row: Record<string, unknown>): CatalogEntry | null {
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const v = row[key];
      if (typeof v === "string" && v !== "") return v;
    }
    return "";
  };
  const id = pick("id", "modelId", "modelTypeName");
  if (!id) return null;
  const num = (...keys: string[]): number => {
    for (const key of keys) {
      const v = row[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return 0;
  };
  const modelType = num("modelType", "modelTypeId");
  if (modelType <= 0) return null;
  return {
    id,
    name: pick("displayName", "name") || id,
    modelType,
    reasoning:
      row["reasoning"] === true ||
      Array.isArray(row["parameterDefinitions"]) ||
      row["supportsReasoning"] === true,
    contextWindow: num("contextWindow", "maxContextLength"),
    description: pick("description"),
    supportsImages: row["supportsImages"] === true,
  };
}

/**
 * 对外暴露的模型 ID 列表（短名，已过 flash 白名单）。
 *
 * ⚠ 白名单是网关级策略：只调用共享 `isAllowedFamily()`，不自行实现家族判据。
 * 过滤只发生在呈现层 —— 被挡在池外的模型仍在 `details()` 里可见。
 */
export function exposedIds(): string[] {
  return loadCatalog()
    .filter((e) => isAllowedFamily(e.id, e.name))
    .map((e) => e.id);
}

/**
 * 短名 → 上游模型 id（字符串，本渠道 id 即上游标识）。
 *
 * 大小写不敏感匹配；未知名称抛错（让网关明确报错，不用错模型发请求）。
 * `buildChatBody` 再做 id → modelType 数值转换。
 */
export function resolveModel(name: string): string {
  const folded = name.toLowerCase();
  for (const entry of loadCatalog()) {
    if (entry.id === name || entry.name === name) return entry.id;
  }
  for (const entry of loadCatalog()) {
    if (entry.id.toLowerCase() === folded || entry.name.toLowerCase() === folded) {
      return entry.id;
    }
  }
  throw new Error(`unknown model: ${name}`);
}

/** 从模型 id 解析上游 modelType 数值（供 buildChatBody 使用）。 */
export function modelTypeOf(id: string): number {
  for (const entry of loadCatalog()) {
    if (entry.id === id) return entry.modelType;
  }
  throw new Error(`unknown model id: ${id}`);
}

/** 全量目录（不过滤家族），供状态页展示。 */
export function details(): Record<string, unknown>[] {
  return loadCatalog().map((e) => ({
    id: e.id,
    display_name: e.name,
    model_type: e.modelType,
    reasoning: e.reasoning,
    context_window: e.contextWindow,
    description: e.description,
    supports_images: e.supportsImages,
  }));
}