/**
 * 模型目录与别名映射。
 *
 * 对客户端与 UI 暴露短名（如 `deepseek-flash`），转发上游时映射回真实 slug。
 * 配置来源是仓库根的 `models.json`：
 *   - 每条模型的 `slug` 字段是上游真实模型名
 *   - 可选 `alias`（或 `short`）字段指定对外短名；未提供时用内置 ALIASES 兜底
 *
 * 文件缺失 / 损坏时使用内置默认，**不阻塞启动**。
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAllowedFamily } from "@model-bridge/gateway";

/** 内置兜底映射：短名 → 上游 slug。 */
export const ALIASES: Record<string, string> = {
  "deepseek-flash": "deepseek-v4.1-flash",
};

/** models.json 中可用的短名字段名（按优先级）。 */
const ALIAS_FIELDS = ["alias", "short", "shortName", "exposed_id"] as const;

interface CacheEntry {
  key: string;
  catalog: Array<[string, string]>;
}

let cache: CacheEntry | null = null;

function candidatePaths(): string[] {
  const paths: string[] = [];
  const env = process.env["WBAI_MODELS_FILE"];
  if (env) paths.push(env);
  paths.push(join(process.cwd(), "models.json"));
  // dist/catalog.js → 上两级是项目根
  const here = fileURLToPath(import.meta.url);
  paths.push(join(here, "..", "..", "models.json"));
  return paths;
}

function parseCatalogFile(path: string): Array<[string, string]> {
  const reverse: Record<string, string> = {};
  for (const [short, slug] of Object.entries(ALIASES)) reverse[slug] = short;

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!data || typeof data !== "object") return [];
  const models = (data as Record<string, unknown>)["models"];
  if (!Array.isArray(models)) return [];

  const entries: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    const rec = model as Record<string, unknown>;
    const slug = rec["slug"];
    if (typeof slug !== "string" || !slug) continue;

    let short = "";
    for (const field of ALIAS_FIELDS) {
      const value = rec[field];
      if (typeof value === "string" && value.trim()) {
        short = value.trim();
        break;
      }
    }
    if (!short) short = reverse[slug] ?? "";
    if (!short || seen.has(short)) continue;
    seen.add(short);
    entries.push([short, slug]);
  }
  return entries;
}

/**
 * 返回 `[(短名, 上游 slug)]`；缓存键为 (路径, mtime, 大小)。
 *
 * 先 stat 比对缓存键，未变化直接返回缓存（不读盘不解析）。
 * 文件缺失/损坏、或文件里没有任何可用模型时，退回内置 ALIASES。
 */
export function loadCatalog(): Array<[string, string]> {
  for (const path of candidatePaths()) {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    const key = `${path}:${stat.mtimeMs}:${stat.size}`;
    if (cache && cache.key === key) return [...cache.catalog];
    const entries = parseCatalogFile(path);
    const catalog = entries.length > 0 ? entries : Object.entries(ALIASES);
    cache = { key, catalog };
    return [...catalog];
  }
  return Object.entries(ALIASES);
}

/** 对外暴露的模型 ID 列表（短名）。 */
export function exposedIds(): string[] {
  // 模型池策略：只放行白名单内的家族（见 model-family.ts）。
  // workbuddy 的短名即家族名（deepseek-flash），故只按 id 判定。
  return loadCatalog()
    .map(([short]) => short)
    .filter((id) => isAllowedFamily(id));
}

/** 把客户端请求中的短名映射为上游 slug；未知名称原样透传。 */
export function resolveModel(name: string): string {
  for (const [short, slug] of loadCatalog()) {
    if (short === name) return slug;
  }
  return name;
}

/** 仅供测试：清空目录缓存。 */
export function clearCache(): void {
  cache = null;
}
