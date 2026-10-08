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

import { isAllowedFamily, readCatalogCache, writeCatalogCache } from "@model-bridge/gateway";

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
 * ⚠ **内容取自一次真实的上游 `/model-types` 返回**（2026-10-08 实测，见
 * `docs/protocols/catpaw/PROTOCOL.md`），只留池策略放行的那些
 * （`(deepseek|glm) && flash`，判据在共享 `isAllowedFamily()`）。
 *
 * ⚠ 曾被写成占位名 `catpaw-flash` —— 那个 id 上游**根本不存在**，
 * 池策略改成「家族 + flash」后它必然被过滤，于是「未回填前」池子是空的。
 * 兜底表要能真的兜住，就得用真实 id。
 */
const FALLBACK_MODELS: CatalogEntry[] = [
  {
    id: "glm-5.3-flashx",
    name: "GLM-5.3-FlashX",
    modelType: 1,
    reasoning: true,
    contextWindow: 0,
    description: "fallback (upstream unavailable)",
    supportsImages: false,
  },
  {
    id: "glm-5.3-flash",
    name: "GLM-5.3-Flash",
    modelType: 1,
    reasoning: true,
    contextWindow: 0,
    description: "fallback (upstream unavailable)",
    supportsImages: false,
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek-V4-Flash",
    modelType: 1,
    reasoning: true,
    contextWindow: 0,
    description: "fallback (upstream unavailable)",
    supportsImages: false,
  },
];

/** 上游目录缓存（由 upstream.fetchModels() 成功时回填）。 */
let _remote: CatalogEntry[] | null = null;
let cacheLoaded = false;

/** 回填上游模型目录（由 upstream.fetchModels 成功后调用），并落盘。 */
export function setCatalog(entries: CatalogEntry[]): void {
  _remote = entries.length > 0 ? entries : null;
  cacheLoaded = true;
  if (entries.length > 0) writeCatalogCache(entries);
}

/**
 * 首次使用时把**磁盘缓存**（`cache/models.json`）读进来。
 *
 * 惰性而非模块加载时读：`channelFile()` 依赖渠道已注册（`setChannel`），
 * 而 `channel.ts` 是在 import 本模块**之后**才注册的 —— 模块加载时读会抛错。
 */
function ensureCachedModels(): void {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const cached = readCatalogCache<CatalogEntry>();
    if (cached) _remote = cached;
  } catch {
    /* 读不到就回落兜底表 */
  }
}

/** 当前目录（上游缓存优先，缺则兜底）。 */
export function loadCatalog(): CatalogEntry[] {
  ensureCachedModels();
  if (_remote && _remote.length > 0) return [..._remote];
  return FALLBACK_MODELS.map((e) => ({ ...e }));
}

/**
 * 强制从上游重拉目录并落盘（CLI `--refresh` / `model refresh`）。
 *
 * 解析与落盘已在 `upstream.fetchModels()` 里完成（它调 `setCatalog()`），
 * 这里只负责「要一次真实的拉取，并且失败要抛出去」。
 */
export async function refresh(): Promise<void> {
  // 动态 import：避免 catalog ↔ upstream/cred 的静态环
  const [upstream, cred] = await Promise.all([import("./upstream.js"), import("./cred.js")]);
  const c = cred.load();
  const data = await upstream.fetchModels(c);
  const models = data["models"];
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error("上游返回的模型目录为空");
  }
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