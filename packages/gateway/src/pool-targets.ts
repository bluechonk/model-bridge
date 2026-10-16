/**
 * 公共模型池：对外暴露**全部渠道能提供的真实模型**。
 *
 * 客户端看到的 id 是归一化后的模型名（如 `deepseek-v4.1-flash`、`glm-5.3-flash`、
 * `qwen3-coder` 等），**不带渠道前缀**；请求落到哪家渠道由网关按账本决定
 * （见 `pool-usage.ts`）。客户端不需要、也无法指定渠道。
 *
 * ## 为什么要归一化
 *
 * 各渠道目录里的写法完全不同（实测）：
 *
 * | 渠道 | exposedId | 归一化后 |
 * |---|---|---|
 * | catpaw | `deepseek-v4-flash` | `deepseek-v4-flash` |
 * | raccoon | `sn-deepseek-v4-1-flash` | `deepseek-v4.1-flash` |
 * | traecn | `DeepSeek-V4-Flash-Official` | `deepseek-v4-flash` |
 * | loomy | `deepseek-v4-flash-0731` | `deepseek-v4-flash` |
 *
 * 归一化之后做**精确相等**比较 —— 这是 4.0 与 4.1 不互相串号的唯一保证
 * （用包含匹配就会让 `deepseek-v4-flash` 也命中 `deepseek-v4.1-flash`）。
 *
 * ## 全模型池
 *
 * 不再限制只暴露 `deepseek-v4.1-flash` / `glm-5.3-flash` 两个 flash 模型，
 * 而是**动态收集**全部渠道 `exposedIds()` 归一化后的去重结果。
 * 模型元数据从渠道 catalog 缓存中提取（contextWindow / name 等）。
 */

import { channels, type Channel } from "./channel.js";
import { runInChannel } from "./channel-context.js";
import { readCatalogCache } from "./catalog-cache.js";

/** 对外暴露的模型 id（恒小写，也是客户端应使用的写法）。动态从全部渠道收集。 */
export function getPoolModels(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const channel of channels()) {
    const cid = channel.config.cid;
    const ids = runInChannel(cid, () => {
      try {
        return channel.catalog.exposedIds();
      } catch {
        return [] as string[];
      }
    });
    for (const id of ids) {
      const canonical = canonicalModelId(id);
      if (!seen.has(canonical)) {
        seen.add(canonical);
        out.push(canonical);
      }
    }
  }
  // 无渠道注册时返回默认模型列表（保持向后兼容）
  if (out.length === 0) {
    return ["deepseek-v4-flash", "deepseek-v4.1-flash", "glm-5.3-flash"];
  }
  return out.sort();
}

/** 兼容旧代码的常量形式（只读快照）。 */
export const POOL_MODELS: readonly string[] = new Proxy([] as string[], {
  get(_target, prop) {
    const models = getPoolModels();
    if (prop === "length") return models.length;
    if (prop === "join") return models.join.bind(models);
    if (prop === "filter") return models.filter.bind(models);
    if (prop === "flatMap") return models.flatMap.bind(models);
    if (prop === "map") return models.map.bind(models);
    if (prop === "includes") return models.includes.bind(models);
    if (prop === "slice") return models.slice.bind(models);
    if (prop === Symbol.iterator) return models[Symbol.iterator].bind(models);
    if (typeof prop === "string" && /^\d+$/.test(prop)) return models[parseInt(prop)];
    return (models as any)[prop];
  },
});

export type PoolModel = string;

/**
 * 池模型的对外元数据 —— **字段结构对齐 DeepSeek 官方 `GET /models`**。
 *
 * 官方（实测 `https://api.deepseek.com/models`）每条长这样：
 *
 * ```json
 * {"id":"deepseek-flash","object":"model","owned_by":"deepseek","name":"DeepSeek-V4.1-Flash",
 *  "context_window":1048576,"max_output_tokens":393216,
 *  "input_modalities":["text","image"],"output_modalities":["text"],
 *  "effort":{"supported_levels":["low","high","max"],"default_level":"high"},
 *  "api_capabilities":{...}}
 * ```
 *
 * 注意官方**没有 `created` 字段**，且 `name` 是展示名而不是 id 的副本 —— 我们照此对齐。
 * `api_capabilities` 是官方 Anthropic 兼容层的私有描述，与我们的转发语义无关，故不输出。
 */
export interface PoolModelMeta {
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputModalities: string[];
  outputModalities: string[];
  effort: { supportedLevels: string[]; defaultLevel: string };
}

/** 默认元数据（从渠道 catalog 中提取不到时的兜底）。 */
const DEFAULT_META: PoolModelMeta = {
  name: "Unknown",
  contextWindow: 128_000,
  maxOutputTokens: 4_096,
  inputModalities: ["text"],
  outputModalities: ["text"],
  effort: { supportedLevels: ["low", "high"], defaultLevel: "high" },
};

/** 动态元数据：从渠道 catalog 缓存（models.json）中提取。 */
export function getPoolModelMeta(model: string): PoolModelMeta {
  for (const channel of channels()) {
    const cid = channel.config.cid;
    const cache = runInChannel(cid, () => {
      try {
        return readCatalogCache(cid) ?? [];
      } catch {
        return [];
      }
    });
    const entry = cache.find((d: any) => canonicalModelId(d.id) === model) as any;
    if (entry) {
      return {
        name: entry.name ?? model,
        contextWindow: entry.contextWindow ?? entry.context_window ?? DEFAULT_META.contextWindow,
        maxOutputTokens: entry.maxOutputTokens ?? entry.max_output_tokens ?? DEFAULT_META.maxOutputTokens,
        inputModalities: entry.inputModalities ?? entry.input_modalities ?? DEFAULT_META.inputModalities,
        outputModalities: entry.outputModalities ?? entry.output_modalities ?? DEFAULT_META.outputModalities,
        effort: entry.effort ?? DEFAULT_META.effort,
      };
    }
  }
  return DEFAULT_META;
}

/** 兼容旧代码的常量形式。 */
export const POOL_MODEL_META: Record<string, PoolModelMeta> = new Proxy({} as Record<string, PoolModelMeta>, {
  get(_target, prop: string) {
    return getPoolModelMeta(prop);
  },
});

/** 渠道包装前缀（去掉后才可能命中池内模型）。 */
const WRAPPER_PREFIXES = ["sn-", "z-ai-", "bytedance-"];

/**
 * 归一化的共用实现。
 *
 * ⚠ `stripPath` 是**目录 id 与客户端请求名的分水岭**：
 * - 渠道目录里带厂商路径段是合法的（如 `deepseek/deepseek-v4.1-flash`），
 *   所以要取最后一段；
 * - 客户端请求名**不许**带渠道前缀（那是已取消的旧形态），带了一律判为未知 ——
 *   否则 `alpha/deepseek-v4-flash` 会被剥成 `deepseek-v4-flash` 而蒙混命中。
 *
 * ⚠ 其余步骤顺序也有讲究：先小写，再转版本号写法，最后去尾部修饰 ——
 * 反过来会把 `deepseek-v4-flash-0731` 里的版本段误当成修饰。
 */
function normalize(raw: string, stripPath: boolean): string {
  let id = raw.trim().toLowerCase();
  // 1. 厂商路径段：`deepseek/deepseek-v4.1-flash` → `deepseek-v4.1-flash`
  if (stripPath) {
    const slash = id.lastIndexOf("/");
    if (slash >= 0) id = id.slice(slash + 1);
  }
  // 2. 渠道包装前缀：`sn-deepseek-v4-1-flash` → `deepseek-v4-1-flash`
  for (const prefix of WRAPPER_PREFIXES) {
    if (id.startsWith(prefix)) {
      id = id.slice(prefix.length);
      break;
    }
  }
  // 3. 版本号的连字符写法 → 点：`v4-1` → `v4.1`、`5-3` → `5.3`。
  //    只匹配「数字-数字」，所以 `v4-flash` 里的 `4-f` 不会被碰。
  id = id.replace(/(\d)-(\d)/g, "$1.$2");
  // 4. 尾部修饰：`-official` / `-0731`（4 位日期） / `-latest`
  id = id.replace(/-official$/, "").replace(/-\d{4}$/, "").replace(/-latest$/, "");
  return id;
}

/** 渠道目录里的 exposedId → 规范名（会剥掉厂商路径段）。 */
export function canonicalModelId(exposedId: string): string {
  return normalize(exposedId, true);
}

/**
 * 客户端请求的模型名归一化；带渠道前缀（`<cid>/<模型>`）返回 null（已失效的旧形态）。
 *
 * 不做路径段剥离（见 `normalize` 的说明），所以 `<cid>/<模型>` 这类旧形态会
 * 直接判为未知 —— 这是刻意的破坏性行为。
 *
 * 全模型池：不再限制只匹配固定 2 个 flash，而是动态匹配全部渠道能提供的模型。
 * 无渠道注册时仍返回归一化后的模型名（由 poolCandidates 空检查兜底）。
 */
export function asPoolModel(name: string): PoolModel | null {
  const canonical = normalize(name, false);
  if (canonical.includes("/")) return null; // 渠道前缀形态不再被接受
  // 无渠道时仍返回归一化后的模型名（由 poolCandidates 空检查兜底）
  return canonical;
}

/** 一个候选：某渠道能提供该池模型（带渠道目录里的原始 exposedId）。 */
export interface PoolCandidate {
  cid: string;
  channel: Channel;
  /** 渠道目录里命中的那条（交给渠道自己的 `resolveModel()` 换成上游 slug）。 */
  exposedId: string;
}

/**
 * 收集某池模型的全部候选渠道，按**注册顺序**返回。
 *
 * 注册顺序即 Map 迭代顺序，是排序的兜底 tie-break（用量、冷却都相同时）。
 * 渠道目录读不出来（缓存损坏等）时跳过该渠道 —— 一个坏渠道不该拖垮整池。
 *
 * ⚠ 匹配用**目录里的原始写法**（不预先小写）：`exposedId` 要原样带回去给
 * 渠道自己的 `resolveModel()`，而上游 slug 可能大小写敏感（TRAE 认
 * `DeepSeek-V4-Flash`，不认全小写）。
 */
export function poolCandidates(model: PoolModel): PoolCandidate[] {
  const out: PoolCandidate[] = [];
  for (const channel of channels()) {
    const cid = channel.config.cid;
    const ids = runInChannel(cid, () => {
      try {
        return channel.catalog.exposedIds();
      } catch {
        return [] as string[];
      }
    });
    // 目录顺序里第一条命中的就是该渠道的对外名（渠道自己排的优先级）
    const hit = ids.find((id) => canonicalModelId(id) === model);
    if (hit !== undefined) out.push({ cid, channel, exposedId: hit });
  }
  return out;
}
