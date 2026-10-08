/**
 * ZCode 模型目录与别名映射。
 *
 * ⚠ **本模块只负责「目录（数据层）」，「池子（呈现层）」由共享层的白名单决定**。
 *
 * 目录层依据实测：上游清单里有 4 个
 * （`GLM-5-Turbo` / `GLM-5.2` / `GLM-5.3` / `GLM-5.3-Flash`），但前两个在
 * Start Plan 下**返回空响应**（实测 0/3 正确，GLM-5.3 是 3/3）——
 * 列一个用不了的模型比不列更糟（用户选中后拿到空回答，错误指向「模型」而非真实原因）。
 *
 * 呈现层再叠一层 **flash-only** 池策略（`@model-bridge/gateway` 的
 * `model-family.ts`）：`GLM-5.3` 虽实测可用，但不是 flash 家族，故不出现在
 * `/v1/models`。目录数据仍完整保留（`details()` 可见），只是不暴露。
 *
 * 目录来源：
 *   - 仓库根 `models.json`（可选，字段：`slug` = 上游真实模型名，`alias` = 对外短名）
 *   - 未提供 / 损坏 / 为空时退回内置兜底表（未登录或上游目录失败时用户仍应看到模型，
 *     否则渠道在选择器里凭空消失，用户以为插件坏了）
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAllowedFamily } from "@model-bridge/gateway";

export interface CatalogEntry {
  /** 对外暴露的 id（短名）。 */
  id: string;
  /** 上游真实模型名。 */
  slug: string;
  /** 展示名。 */
  name: string;
}

/**
 * 内置兜底表：实测可用的两个（数据层，不直接等于池子）。
 *
 * 顺序即展示顺序（GLM-5.3 在前）。
 * 池子由共享层白名单决定 —— 只有 `GLM-5.3-Flash` 会出现在 `/v1/models`。
 */
export const FALLBACK_MODELS: CatalogEntry[] = [
  { id: "GLM-5.3", slug: "GLM-5.3", name: "GLM-5.3" },
  { id: "GLM-5.3-Flash", slug: "GLM-5.3-Flash", name: "GLM-5.3-Flash" },
];

/** 大小写不敏感的别名（用户手打小写也能命中）。 */
const CASE_INSENSITIVE_ALIASES: Record<string, string> = {
  "glm-5.3": "GLM-5.3",
  "glm-5.3-flash": "GLM-5.3-Flash",
};

/** models.json 中可用的短名字段名（按优先级）。 */
const ALIAS_FIELDS = ["alias", "short", "shortName", "exposed_id"] as const;

interface CacheEntry {
  key: string;
  catalog: CatalogEntry[];
}

let cache: CacheEntry | null = null;

function candidatePaths(): string[] {
  const paths: string[] = [];
  const env = process.env["ZCODE_MODELS_FILE"];
  if (env) paths.push(env);
  paths.push(join(process.cwd(), "models.json"));
  // dist/catalog.js → 上两级是项目根（同目录的 models.json）
  const here = fileURLToPath(import.meta.url);
  paths.push(join(here, "..", "..", "models.json"));
  return paths;
}

function parseCatalogFile(path: string): CatalogEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!data || typeof data !== "object") return [];
  const models = (data as Record<string, unknown>)["models"];
  if (!Array.isArray(models)) return [];

  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    const rec = model as Record<string, unknown>;
    const slug = typeof rec["slug"] === "string" && rec["slug"] ? rec["slug"] : "";
    if (!slug) continue;
    let id = "";
    for (const field of ALIAS_FIELDS) {
      const value = rec[field];
      if (typeof value === "string" && value.trim()) {
        id = value.trim();
        break;
      }
    }
    if (!id) id = slug;
    if (seen.has(id)) continue;
    seen.add(id);
    const name = typeof rec["name"] === "string" && rec["name"] ? rec["name"] : slug;
    entries.push({ id, slug, name });
  }
  return entries;
}

/**
 * 返回目录条目；缓存键为 (路径, mtime, 大小)。
 *
 * 文件缺失/损坏/为空时退回内置兜底表。
 */
export function loadCatalog(): CatalogEntry[] {
  for (const path of candidatePaths()) {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    const key = `${path}:${stat.mtimeMs}:${stat.size}`;
    if (cache && cache.key === key) return cache.catalog.map((e) => ({ ...e }));
    const entries = parseCatalogFile(path);
    const catalog = entries.length > 0 ? entries : FALLBACK_MODELS;
    cache = { key, catalog };
    return catalog.map((e) => ({ ...e }));
  }
  return FALLBACK_MODELS.map((e) => ({ ...e }));
}

/** 对外暴露的模型 ID 列表（短名）。 */
export function exposedIds(): string[] {
  // 模型池策略：只放行白名单内的家族（见 model-family.ts）
  return loadCatalog()
    .filter((entry) => isAllowedFamily(entry.id, entry.slug))
    .map((entry) => entry.id);
}

/** 把客户端请求中的短名映射为上游 slug；未知名称原样透传。 */
export function resolveModel(name: string): string {
  for (const entry of loadCatalog()) {
    if (entry.id === name || entry.slug === name) return entry.slug;
  }
  // 大小写不敏感兜底：GLM-5.3 这类上游 id 手打小写很常见
  const folded = name.toLowerCase();
  const known = CASE_INSENSITIVE_ALIASES[folded];
  if (known) return known;
  for (const entry of loadCatalog()) {
    if (entry.slug.toLowerCase() === folded) return entry.slug;
  }
  return name;
}

/** 供状态页/UI 使用的目录详情。 */
export function details(): Array<Record<string, unknown>> {
  return loadCatalog().map((entry) => ({
    id: entry.id,
    name: entry.name,
    upstream: entry.slug,
  }));
}

/** 仅供测试：清空目录缓存。 */
export function clearCache(): void {
  cache = null;
}
