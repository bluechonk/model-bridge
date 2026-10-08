/**
 * 模型目录。
 *
 * **对外暴露的 id 就是上游模型名**（`models.json` 的 `slug`，如 `deepseek-v4.1-flash`）——
 * 不做短名花活：客户端看到的与服务端实际收到的保持一致，排查时少一层心算。
 * 若某条模型显式给了 `alias` / `short` / `shortName` / `exposed_id`，则用该字段作对外名。
 *
 * `LEGACY_ALIASES`：**只用于输入兼容**。早期版本对外用过 `deepseek-flash` 这个短名，
 * 老客户端配置里若还写着它，进来仍能解析到 slug；但它**不会**出现在 `/v1/models` 里。
 *
 * 配置来源是渠道根目录的 `models.json`；文件缺失 / 损坏时用内置兜底，**不阻塞启动**。
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAllowedFamily } from "@model-bridge/gateway";

/**
 * 历史短名 → 上游 slug（**仅输入兼容**，不作为对外名）。
 *
 * 改名的理由：短名让「列表里的 id」和「上游收到的 model」不一致，出问题时得多查一层。
 */
export const LEGACY_ALIASES: Record<string, string> = {
  "deepseek-flash": "deepseek-v4.1-flash",
};

/** models.json 缺失 / 损坏时的兜底目录：对外名 = 上游名。 */
const FALLBACK: Array<[string, string]> = Object.values(LEGACY_ALIASES).map((slug) => [slug, slug]);

/** models.json 中可用的对外名字段名（按优先级；都不给就用 slug）。 */
const EXPOSED_FIELDS = ["alias", "short", "shortName", "exposed_id"] as const;

interface CacheEntry {
  key: string;
  catalog: Array<[string, string]>;
}

let cache: CacheEntry | null = null;

function candidatePaths(): string[] {
  const paths: string[] = [];
  const env = process.env["WB_MODELS_FILE"];
  if (env) paths.push(env);
  paths.push(join(process.cwd(), "models.json"));
  // dist/catalog.js → 上两级是项目根
  const here = fileURLToPath(import.meta.url);
  paths.push(join(here, "..", "..", "models.json"));
  return paths;
}

function parseCatalogFile(path: string): Array<[string, string]> {
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

    let exposed = "";
    for (const field of EXPOSED_FIELDS) {
      const value = rec[field];
      if (typeof value === "string" && value.trim()) {
        exposed = value.trim();
        break;
      }
    }
    // 没显式给对外名 → 就用上游名（不再反查短名表）
    if (!exposed) exposed = slug;
    if (seen.has(exposed)) continue;
    seen.add(exposed);
    entries.push([exposed, slug]);
  }
  return entries;
}

/**
 * 返回 `[(对外名, 上游 slug)]`；缓存键为 (路径, mtime, 大小)。
 *
 * 先 stat 比对缓存键，未变化直接返回缓存（不读盘不解析）。
 * 文件缺失/损坏、或文件里没有任何可用模型时，退回内置兜底。
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
    const catalog = entries.length > 0 ? entries : [...FALLBACK];
    cache = { key, catalog };
    return [...catalog];
  }
  return [...FALLBACK];
}

/** 对外暴露的模型 ID 列表（= 上游名，已过 flash 白名单）。 */
export function exposedIds(): string[] {
  // 模型池策略：只放行白名单内的家族（见 model-family.ts）。
  // 对外名即上游名（deepseek-v4.1-flash），家族信息就在 id 里。
  return loadCatalog()
    .map(([exposed]) => exposed)
    .filter((id) => isAllowedFamily(id));
}

/**
 * 把客户端请求里的模型名解析为上游名。
 *
 * 顺序：目录命中（对外名 === 请求名 → 用 slug）→ 历史短名（`LEGACY_ALIASES`）→ 原样透传。
 */
export function resolveModel(name: string): string {
  for (const [exposed, slug] of loadCatalog()) {
    if (exposed === name) return slug;
  }
  const legacy = LEGACY_ALIASES[name];
  if (legacy) return legacy;
  return name;
}

/** 仅供测试：清空目录缓存。 */
export function clearCache(): void {
  cache = null;
}
