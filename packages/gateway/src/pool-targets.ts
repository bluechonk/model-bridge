/**
 * 公共模型池：对外只有**三个跨渠道模型**。
 *
 * 客户端看到的 id 是固定的三个（`deepseek-v4.1-flash` / `deepseek-v4-flash` /
 * `glm-5.3-flash`），**不带渠道前缀**；请求落到哪家渠道由网关按账本决定
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
 * | trae | `DeepSeek-V4-Flash-Official` | `deepseek-v4-flash` |
 * | loomy | `deepseek-v4-flash-0731` | `deepseek-v4-flash` |
 * | cline | `deepseek/deepseek-v4.1-flash` | `deepseek-v4.1-flash` |
 *
 * 归一化之后做**精确相等**比较 —— 这是 4.0 与 4.1 不互相串号的唯一保证
 * （用包含匹配就会让 `deepseek-v4-flash` 也命中 `deepseek-v4.1-flash`）。
 *
 * ## 被收窄掉的模型
 *
 * `glm-5.3-flashx`（FlashX 变体）、`deepseek-v4-flash-vision-exp`、
 * 无版本号的 `deepseek-flash` 都**不**进池 —— 它们仍在渠道自己的目录里，
 * 经渠道 CLI 仍可用，只是不出现在 `/v1/models`。
 */

import { channels, type Channel } from "./channel.js";
import { runInChannel } from "./channel-context.js";

/** 对外暴露的三个模型 id（恒小写，也是客户端应使用的写法）。 */
export const POOL_MODELS = [
  "deepseek-v4.1-flash",
  "glm-5.3-flash",
] as const;

export type PoolModel = (typeof POOL_MODELS)[number];

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

/** 两个池模型的元数据（数值取各上游口径）。 */
export const POOL_MODEL_META: Record<PoolModel, PoolModelMeta> = {
  // 直接采官方 `deepseek-flash` 的数值（我们的 4.1 flash 就是它）
  "deepseek-v4.1-flash": {
    name: "DeepSeek-V4.1-Flash",
    contextWindow: 1_048_576,
    maxOutputTokens: 393_216,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    effort: { supportedLevels: ["low", "high", "max"], defaultLevel: "high" },
  },
  // GLM-5.3-Flash：上游目录口径（1M 上下文），无多模态输入
  "glm-5.3-flash": {
    name: "GLM-5.3-Flash",
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    inputModalities: ["text"],
    outputModalities: ["text"],
    effort: { supportedLevels: ["low", "high", "max"], defaultLevel: "high" },
  },
};

/** 渠道包装前缀（去掉后才可能命中池内模型）。 */
const WRAPPER_PREFIXES = ["sn-", "z-ai-", "bytedance-"];

/**
 * 归一化的共用实现。
 *
 * ⚠ `stripPath` 是**目录 id 与客户端请求名的分水岭**：
 * - 渠道目录里带厂商路径段是合法的（cline 的 `deepseek/deepseek-v4.1-flash`），
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
 * 客户端请求的模型名是否是池内模型；不是返回 null。
 *
 * 不做路径段剥离（见 `normalize` 的说明），所以 `<cid>/<模型>` 这类旧形态会
 * 直接判为未知 —— 这是刻意的破坏性行为。
 */
export function asPoolModel(name: string): PoolModel | null {
  const canonical = normalize(name, false);
  return (POOL_MODELS as readonly string[]).includes(canonical) ? (canonical as PoolModel) : null;
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
