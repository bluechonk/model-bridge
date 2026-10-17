/**
 * 公共模型池：对外暴露**全部渠道能提供的真实模型**，id 形态为 `<cid>/<模型>`。
 *
 * 客户端请求模型时**用渠道 id 选池子**：`loomy/kimi-k2.6` 走 loomy、
 * `qodercn/deepseek-flash` 走 qodercn —— 渠道由请求方显式指定，网关不再跨渠道
 * 改路由（见历史上「账本决定落到谁」的旧设计）；渠道内部的账号池轮换照旧。
 *
 * ## 为什么要归一化（模型段）
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
 * 归一化只作用于 `/` 之后的模型段（渠道 id 本身原样），归一化后做**精确相等**比较
 * —— 这是 4.0 与 4.1 不互相串号的唯一保证（用包含匹配就会让 `deepseek-v4-flash`
 * 也命中 `deepseek-v4.1-flash`）。**不同渠道的同名模型不再互相去重**：
 * `catpaw/glm-5.3-flash` 与 `raccoon/glm-5.3-flash` 是两个池 id，各归各家。
 *
 * ## 全模型池
 *
 * 不再限制只暴露 `deepseek-v4.1-flash` / `glm-5.3-flash` 两个 flash 模型，
 * 而是**动态收集**全部渠道 `exposedIds()` 归一化后的结果。
 * 模型元数据从渠道 catalog 缓存中提取（contextWindow / name 等）。
 */

import { channels, type Channel } from "../runtime/channel.js";
import { runInChannel } from "../runtime/channel-context.js";
import { readCatalogCache } from "../runtime/catalog-cache.js";

/**
 * 对外暴露的模型池（动态收集：各渠道 `exposedIds()` 归一化后挂上 `<cid>/` 前缀）。
 *
 * ⚠ 不做进程内缓存：渠道目录可随登录/刷新变化，每次调用重新收集是刻意的
 * （调用方若需在同一表达式里保持一致快照，应先取一次局部变量）。
 *
 * 空池返回 `[]`（**不硬编码兜底模型**）——共享层不持有任何渠道知识（AGENTS.md §仓库结构）；
 * 空池意味着所有渠道目录都读不出来，此时对外公布幻影模型只会让请求必然落空。
 */
export function poolModels(): string[] {
  const out: string[] = [];
  for (const channel of channels()) {
    const cid = channel.config.cid;
    const ids = runInChannel(cid, () => {
      try {
        return channel.catalog.exposedIds();
      } catch (err) {
        // 一个渠道的目录崩掉不该拖垮整池，但必须留痕（否则它只会从 /v1/models 静默消失）
        console.warn(`[pool] channel ${cid} exposedIds failed: ${String(err)}`);
        return [] as string[];
      }
    });
    // 渠道内先按规范名去重：同一渠道的不同原始写法收敛到同一个对外 id
    const seen = new Set<string>();
    for (const id of ids) {
      const canonical = canonicalModelId(id);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      out.push(`${cid}/${canonical}`);
    }
  }
  return out.sort();
}

/** 池模型 id 的拼装（`<cid>/<规范模型名>`）：渠道目录 → 对外 id 的唯一写法。 */
export function poolModelId(cid: string, exposedId: string): string {
  return `${cid}/${canonicalModelId(exposedId)}`;
}

/**
 * 拆解池模型 id：第一个 `/` 之前是渠道 id，其余是模型段。
 *
 * 渠道段**小写化**（cid 全为小写，请求方大小写笔误照收）；模型段按规范路径归一化
 * （可剥**模型段内部**的厂商路径段：`loomy/deepseek/deepseek-v4.1-flash` →
 * `loomy/deepseek-v4.1-flash`）。格式不合法（无 `/`、段为空）返回 null。
 *
 * ⚠ 只按**第一个** `/` 切：渠道 id 本身不含 `/`，模型段内部的 `/` 属于厂商路径。
 */
export function parsePoolModel(id: string): { cid: string; model: string } | null {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return null;
  const cid = id.slice(0, slash).trim().toLowerCase();
  const model = normalize(id.slice(slash + 1), true);
  if (!cid || !model) return null;
  return { cid, model };
}

/**
 * 池模型的只读快照（兼容旧调用形态）。
 *
 * 底层是**真实数组**：每次读属性时按当前渠道目录重建，因此 `Object.keys` /
 * `JSON.stringify` / 展开 / 迭代 / 数字索引天然一致（早期用空数组 + Proxy
 * 只会让 `keys` 与 `length` 互相矛盾，序列化时会静默丢内容）。
 */
export const POOL_MODELS: readonly string[] = new Proxy([] as string[], {
  get(_target, prop, receiver) {
    const models = poolModels();
    if (prop === "length") return models.length;
    if (typeof prop === "string" && /^\d+$/.test(prop)) return models[Number(prop)];
    const value = (models as unknown as Record<string | symbol, unknown>)[prop];
    // 函数一律绑定到本次快照：避免 this 落到 Proxy 上导致 sort/push 之类静默失效
    return typeof value === "function" ? value.bind(models) : value;
  },
  has(_target, prop) {
    const models = poolModels();
    if (typeof prop === "string" && /^\d+$/.test(prop)) return Number(prop) < models.length;
    return prop in (models as unknown as object);
  },
  ownKeys() {
    // 让 Object.keys / JSON.stringify / spread 看到真实索引
    return poolModels().map((_, i) => String(i));
  },
  getOwnPropertyDescriptor(_target, prop) {
    const models = poolModels();
    if (typeof prop === "string" && /^\d+$/.test(prop)) {
      const i = Number(prop);
      if (i < models.length) {
        return { value: models[i], writable: false, enumerable: true, configurable: true };
      }
    }
    return undefined;
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

/** 动态元数据：从池模型 id 指向的渠道 catalog 缓存（models.json）中提取。 */
export function getPoolModelMeta(model: string): PoolModelMeta {
  const parsed = parsePoolModel(model);
  if (!parsed) return DEFAULT_META;
  const channel = findChannel(parsed.cid);
  if (!channel) return DEFAULT_META;
  const cache = runInChannel(channel.config.cid, () => {
    try {
      return readCatalogCache(channel.config.cid) ?? [];
    } catch {
      return [];
    }
  });
  const entry = cache.find((d: any) => canonicalModelId(d.id) === parsed.model) as any;
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
  return DEFAULT_META;
}

/** 按渠道 id（大小写不敏感）找已注册渠道（未注册返回 undefined）。 */
function findChannel(cid: string): Channel | undefined {
  const wanted = cid.toLowerCase();
  return channels().find((c) => c.config.cid.toLowerCase() === wanted);
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
 * ⚠ `stripPath` 只控制**模型段内部**的厂商路径：
 * - 渠道目录里的 id 可能带厂商路径段（如 `deepseek/deepseek-v4.1-flash`），
 *   所以规范名要取最后一段；
 * - 客户端请求的模型段同样允许带厂商路径（`loomy/deepseek/deepseek-v4.1-flash`
 *   也认）—— 渠道归属已由第一个 `/` 显式声明，模型段再剥一层不会串渠道。
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
 * 客户端请求的模型名归一化；**必须**是 `<cid>/<模型>` 形态，否则返回 null。
 *
 * 渠道段改小写、模型段走归一化路径（见上）。裸模型名（不带渠道前缀）判 null
 * —— 这是「渠道由请求方指定」的一面：网关不知道裸名该去哪家。
 *
 * 全模型池：不再限制只匹配固定 2 个 flash，而是动态匹配渠道目录里的一切。
 * 渠道未注册 / 目录未命中由 poolCandidates 的空检查兜底。
 */
export function asPoolModel(name: string): PoolModel | null {
  const parsed = parsePoolModel(name);
  if (!parsed) return null;
  return `${parsed.cid}/${parsed.model}`;
}

/** 一个候选：某渠道能提供该池模型（带渠道目录里的原始 exposedId）。 */
export interface PoolCandidate {
  cid: string;
  channel: Channel;
  /** 渠道目录里命中的那条（交给渠道自己的 `resolveModel()` 换成上游 slug）。 */
  exposedId: string;
}

/**
 * 收集某池模型 id（`<cid>/<模型>`）的候选渠道 —— **最多一条**：渠道已由请求方指定。
 *
 * 渠道按 id 大小写不敏感匹配；该渠道目录里第一条规范名命中的就是对外名
 * （渠道自己排的优先级）。渠道未注册 / 目录里没有这个模型 / 目录读不出来
 * （缓存损坏等）都返回空 —— 一个坏渠道只影响指向它的请求。
 *
 * ⚠ 匹配用**目录里的原始写法**（不预先小写）：`exposedId` 要原样带回去给
 * 渠道自己的 `resolveModel()`，而上游 slug 可能大小写敏感（TRAE 认
 * `DeepSeek-V4-Flash`，不认全小写）。
 */
export function poolCandidates(model: PoolModel): PoolCandidate[] {
  const parsed = parsePoolModel(model);
  if (!parsed) return [];
  const channel = findChannel(parsed.cid);
  if (!channel) return [];
  const cid = channel.config.cid;
  const ids = runInChannel(cid, () => {
    try {
      return channel.catalog.exposedIds();
    } catch {
      return [] as string[];
    }
  });
  const hit = ids.find((id) => canonicalModelId(id) === parsed.model);
  return hit === undefined ? [] : [{ cid, channel, exposedId: hit }];
}
