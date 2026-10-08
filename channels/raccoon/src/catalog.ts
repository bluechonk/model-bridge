/**
 * Raccoon 模型目录：兜底表、图片能力白名单、倍率展示与远端解析。
 *
 * ## 本模块承载的渠道知识（见 docs/protocols/raccoon/PROTOCOL.md §5）
 *
 * 1. **模型 id 在远端的 `name` 字段里，不是 `id`**（`id` 是另一个无关字段）。
 * 2. ⚠⚠ **`tags` 不是图片能力契约**（真实缺陷 2026-10-03）：`tags` 的真实用途是
 *    客户端「Raccoon-Auto 选模」的偏好标签，回答的是「适不适合处理这类任务」，
 *    **不是**「能不能吃图」。曾把「tags 含 vision」当成能力声明，结果
 *    `sn-deepseek-v4-1-flash`（tags 无 vision）被播报成纯文本 → **DSH 在
 *    `LlmRuntime` 里把图片替换成文本占位符** → 图片根本没发出去，用户却看到
 *    「模型读不到图片」。带图实测 6/6 全读对（`sn-deepseek-v4-1-flash` 5/5）。
 *    故判定 = **显式白名单覆盖实测确认的个案** + tags 含 vision/image/…
 *    ⚠ 兜底表路径**不走本函数**：它的真相源是 `FALLBACK_MODELS[].supportsImage`。
 * 3. **展示名规则：1 倍也要显示**（真实报障：Kimi-K3 看起来没有计费信息）：
 *    生效价 0 → 「免费」（**不是** `x0`）；生效价 < 原价 → `x原价→x折后价`；
 *    其余（**含 1 倍**）→ `x生效价`。
 * 4. 兜底表**不含** `Raccoon-Auto`：它是客户端 i18n 条目渲染的「自动选模」入口，
 *    不是远端模型 —— 直接发给 `chat/completions` 会 404。
 */

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";
import { isAllowedFamily } from "@model-bridge/gateway";

/** 实测确认能读图、但远端未声明 vision 的个案（显式白名单，不是「恒 true」）。 */
export const IMAGE_CAPABILITY_OVERRIDES: ReadonlySet<string> = new Set([
  "sn-deepseek-v4-1-flash",
  "sn-glm-5-3-flash",
]);

/** 远端 tags 的图片特征词。 */
const IMAGE_TAGS = ["vision", "image", "image-understanding"];

/** 远端目录成功结果的缓存时长。 */
const REMOTE_TTL_MS = 5 * 60 * 1000;
/** 远端失败/空结果的冷却时长。 */
const REMOTE_FAIL_COOLDOWN_MS = 30 * 1000;

export interface ModelEntry {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  supportsImage: boolean;
  /** 当前生效倍率；null = 未知。 */
  effectiveMultiplier: number | null;
  /** 原价倍率；null = 未知。 */
  multiplier: number | null;
  billingStatus: string;
  billingStatusNote: string;
  source: "remote" | "fallback";
}

/**
 * 兜底静态模型表（6 个 `visible: true` 的模型）。
 *
 * 来源：2026-09-26 实测 `GET /api/web/llm/v2/model_catalog`。
 * ⚠ 不含 `Raccoon-Auto`（发给 chat 会 404），也不含 3 个 `visible:false` 的内部模型。
 */
export const FALLBACK_MODELS: ModelEntry[] = [
  {
    id: "sn-sensenova-6-8-flash",
    name: "SenseNova-6.8-Flash",
    contextWindow: 256_000,
    maxOutput: 63_999,
    supportsImage: true,
    effectiveMultiplier: 0,
    multiplier: 0.5,
    billingStatus: "limited_free",
    billingStatusNote: "",
    source: "fallback",
  },
  {
    id: "sn-sensenova-6-8-flash-lite",
    name: "SenseNova-6.8-Flash-Lite",
    contextWindow: 256_000,
    maxOutput: 63_999,
    supportsImage: true,
    effectiveMultiplier: 0,
    multiplier: 0.5,
    billingStatus: "limited_free",
    billingStatusNote: "",
    source: "fallback",
  },
  {
    id: "sn-glm-5-3",
    name: "GLM-5-3",
    contextWindow: 1_000_000,
    maxOutput: 100_000,
    supportsImage: true,
    effectiveMultiplier: 0.75,
    multiplier: 0.75,
    billingStatus: "normal",
    billingStatusNote: "",
    source: "fallback",
  },
  {
    id: "sn-kimi-k3",
    name: "Kimi-K3",
    contextWindow: 1_000_000,
    maxOutput: 100_000,
    supportsImage: true,
    effectiveMultiplier: 1,
    multiplier: 1,
    billingStatus: "normal",
    billingStatusNote: "",
    source: "fallback",
  },
  {
    id: "sn-glm-5-3-flash",
    name: "GLM-5-3-Flash",
    contextWindow: 1_000_000,
    maxOutput: 100_000,
    supportsImage: true,
    effectiveMultiplier: 0.1,
    multiplier: 0.2,
    billingStatus: "discount",
    billingStatusNote: "",
    source: "fallback",
  },
  {
    id: "sn-deepseek-v4-1-flash",
    name: "DeepSeek-V4.1-Flash",
    contextWindow: 1_000_000,
    maxOutput: 100_000,
    supportsImage: true,
    effectiveMultiplier: 0.25,
    multiplier: 0.25,
    billingStatus: "normal",
    billingStatusNote: "",
    source: "fallback",
  },
];

/** 内部模型 / 自动选模入口：即使远端下发也不暴露。 */
const EXCLUDED_IDS = new Set(["Raccoon-Auto"]);

let snapshot: ModelEntry[] | null = null;
let remoteCache: { entries: ModelEntry[]; at: number } | null = null;
let refreshing = false;

/** 仅供测试：清空缓存。 */
export function clearCache(): void {
  snapshot = null;
  remoteCache = null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// ── 图片能力 ──────────────────────────────────────────────────────────────────

/**
 * 图片能力判定（见文件头注释 2）。
 *
 * ⚠ 用**显式白名单**而不是「恒 true」：只覆盖**实测确认**的个案。
 */
export function supportsImage(modelId: string, tags: unknown): boolean {
  if (IMAGE_CAPABILITY_OVERRIDES.has(modelId)) return true;
  if (!Array.isArray(tags)) return false;
  return tags.some((tag) => IMAGE_TAGS.includes(String(tag).toLowerCase()));
}

// ── 倍率展示 ──────────────────────────────────────────────────────────────────

/** 倍率格式化：最多 4 位小数并去掉尾随 0。 */
export function formatMultiplier(value: number): string {
  return String(Number(value.toFixed(4)));
}

/**
 * 倍率后缀（三条规则见文件头注释 3）。
 *
 * ⚠ 非有限数 / 负数 / 缺失 → 不追加后缀（宁可不显示，也不显示假的）。
 */
export function priceSuffix(effective: number | null, original: number | null): string {
  if (effective === null || !Number.isFinite(effective) || effective < 0) return "";
  if (effective === 0) return "免费"; // 不是 x0
  if (
    original !== null &&
    Number.isFinite(original) &&
    original > 0 &&
    effective < original
  ) {
    return `x${formatMultiplier(original)}→x${formatMultiplier(effective)}`;
  }
  return `x${formatMultiplier(effective)}`; // ⚠ 1 倍也要显示
}

/** 展示名：`{name} · {suffix}`（无后缀时不追加分隔符）。 */
export function displayName(entry: Pick<ModelEntry, "name" | "effectiveMultiplier" | "multiplier">): string {
  const suffix = priceSuffix(entry.effectiveMultiplier, entry.multiplier);
  return suffix ? `${entry.name} · ${suffix}` : entry.name;
}

// ── 远端解析 ──────────────────────────────────────────────────────────────────

/** `billing_status` 三态映射：`discount` / `limited_free` / 其它 → `normal`。 */
export function mapBillingStatus(value: unknown): string {
  const text = str(value);
  return text === "discount" || text === "limited_free" ? text : "normal";
}

/**
 * 解析 `model_catalog` 的 `data`。
 *
 * 规则：只取 `categories[].type === 'chat'`，过滤 `visible === false`（**缺省视为可见**），
 * 按 id（即 `name` 字段）去重，**剔除 `Raccoon-Auto`**。
 */
export function parseRemoteModels(data: unknown): ModelEntry[] {
  const out: ModelEntry[] = [];
  const seen = new Set<string>();
  const categories = isRecord(data) ? data["categories"] : null;
  if (!Array.isArray(categories)) return out;

  for (const category of categories) {
    if (!isRecord(category) || category["type"] !== "chat") continue;
    const models = category["models"];
    if (!Array.isArray(models)) continue;
    for (const item of models) {
      if (!isRecord(item)) continue;
      if (item["visible"] === false) continue; // 缺省视为可见
      const id = str(item["name"]); // ⚠ 模型 id 在 name 字段里，不是 id
      if (!id || seen.has(id) || EXCLUDED_IDS.has(id)) continue;
      seen.add(id);
      const params = isRecord(item["params"]) ? item["params"] : {};
      const effectiveMultiplier = num(item["billing_effective_multiplier"]);
      const multiplier = num(item["billing_multiplier"]);
      const fallback = FALLBACK_MODELS.find((m) => m.id === id);
      out.push({
        id,
        name: str(item["description"]) || fallback?.name || id,
        contextWindow: num(params["context_window"]) ?? num(item["context_window"]) ?? fallback?.contextWindow ?? 0,
        maxOutput: num(params["max_tokens"]) ?? fallback?.maxOutput ?? 0,
        // ⚠ tags 不是能力契约：白名单 + tags 特征词（见文件头注释 2）
        supportsImage: supportsImage(id, item["tags"]),
        effectiveMultiplier,
        multiplier,
        billingStatus: mapBillingStatus(item["billing_status"]),
        billingStatusNote: str(item["billing_status_note"]),
        source: "remote",
      });
    }
  }
  return out;
}

/** 兜底表（每次现算）。 */
export function fallbackEntries(): ModelEntry[] {
  return FALLBACK_MODELS.map((m) => ({ ...m }));
}

/**
 * 异步刷新远端目录。失败/空结果保留上一次快照（从未成功 → 兜底表），并进入冷却
 * （与 Loomy 同构：只缓存**真实远端目录**，兜底表每次现算）。
 */
export async function refreshCatalog(): Promise<void> {
  const cfg = upstream.loadConfig()[0];
  const now = Date.now();
  const cached = remoteCache;
  if (!(cached && now - cached.at < (cached.entries.length > 0 ? REMOTE_TTL_MS : REMOTE_FAIL_COOLDOWN_MS))) {
    let entries: ModelEntry[] = [];
    try {
      const c = cred.load();
      const payload = await upstream.fetchModels(c, cfg);
      const data = isRecord(payload["data"]) ? payload["data"] : {};
      entries = parseRemoteModels(data);
    } catch {
      entries = []; // 远端不可用 → 整表保底，绝不抛到调用方
    }
    remoteCache = { entries, at: now };
  }
  const fresh = remoteCache;
  if (!fresh) {
    snapshot = fallbackEntries();
    return;
  }
  snapshot = fresh.entries.length > 0 ? fresh.entries : fallbackEntries();
}

function ensureRefresh(): void {
  if (snapshot || refreshing) return;
  refreshing = true;
  void refreshCatalog()
    .catch(() => {})
    .finally(() => {
      refreshing = false;
    });
}

function currentEntries(): ModelEntry[] {
  if (!snapshot) {
    ensureRefresh();
    return fallbackEntries();
  }
  return snapshot;
}

/** 对外暴露的模型 id。 */
export function exposedIds(): string[] {
  // 模型池策略：只放行白名单内的家族（见 model-family.ts）。
  // Raccoon 的 id 带渠道前缀（`sn-glm-5-3`），但家族名仍在 id 里。
  return currentEntries()
    .filter((e) => isAllowedFamily(e.id, e.name))
    .map((e) => e.id);
}

/** 模型 id → 上游 slug：Raccoon 的 id 就是 slug，**未知原样返回**。 */
export function resolveModel(name: string): string {
  return name;
}

/** 目录详情（供状态页）。 */
export function details(): Array<Record<string, unknown>> {
  return currentEntries().map((e) => ({
    id: e.id,
    name: displayName(e),
    description: "",
    context_window: e.contextWindow,
    max_output: e.maxOutput,
    vision: e.supportsImage,
    billing_status: e.billingStatus,
    billing_status_note: e.billingStatusNote,
    multiplier: e.multiplier,
    effective_multiplier: e.effectiveMultiplier,
    source: e.source,
  }));
}
