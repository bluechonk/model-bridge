/**
 * Loomy 模型目录：倍率归一化、远端目录缓存与档位注册。
 *
 * ## 本模块承载的渠道知识（见 docs/protocols/loomy/PROTOCOL.md §5）
 *
 * 1. **倍率在 `name` 字符串里**（没有独立字段），且三种括号风格混用，必须规范化：
 *      `MiniMax M3 （x4.0）` / `Qwen 3.8 Max (x12.0)` / `GLM 5.3 Flash(x0.8)`
 *    ⚠ 只认**末尾**的倍率（中间的括号属于模型名本身）；本函数**幂等**；
 *    主体为空（畸形数据）时原样保留；倍率必须拼进 `name`（**不是** `description`）。
 * 2. **过滤判据是 `type === 'chat'`，不能看 `input_modalities`**（后者只管图片能力）。
 * 3. **远端档位要清洗**（去重、丢弃不在词表里的脏数据），**默认档用本插件自己的
 *    `high`**，不采信远端的 `default_reasoning_effort`（它声明的是 `low`）；
 *    默认档必须落在该模型的 `efforts` 内。
 * 4. **只缓存真实远端目录**，兜底表每次现算，并用冷却闸门挡住「每模型重试一次」的放大
 *    —— 早期实现把兜底表当成「已加载」记下，一次瞬时失败会让该 provider
 *    **整个进程生命周期**只剩兜底模型。
 *
 * ## 为什么目录是「快照 + 异步刷新」
 *
 * 契约要求 `exposedIds()` 是**同步**函数（网关的 `/v1/models` 处理器同步），而零依赖
 * 约束下 Node 没有同步 HTTP。故维护内存快照：同步访问返回当前快照，首次访问触发
 * **后台刷新**；未刷新完成时返回兜底表（否则渠道会在选择器里凭空消失）。
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";
import { isAllowedFamily, readCatalogCache, writeCatalogCache } from "@model-bridge/gateway";

/** 档位词表（展示名必须与官方 IDE 一致 —— Loomy 基于 opencode 构建）。 */
export const EFFORT_VOCABULARY = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 档位 id → 中文展示名。 */
export const EFFORT_NAMES: Record<string, string> = {
  none: "关闭思考",
  minimal: "最小",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
};

/** 本插件自己的默认档（**不采信**远端的 `default_reasoning_effort`）。 */
export const DEFAULT_EFFORT = "high";

/** 档位排序（用于挑「最接近 high」的档位）。 */
const EFFORT_RANK: string[] = [...EFFORT_VOCABULARY];

/** 兜底表的档位（8 条全部相同）。 */
export const FALLBACK_EFFORTS = ["none", "low", "medium", "high", "xhigh"];

/** 远端目录成功结果的缓存时长。 */
const REMOTE_TTL_MS = 5 * 60 * 1000;
/** 远端失败/空结果的冷却时长。 */
const REMOTE_FAIL_COOLDOWN_MS = 30 * 1000;

export interface FallbackModel {
  id: string;
  name: string;
  contextWindow: number;
  efforts: string[];
  defaultEffort: string;
}

/**
 * 兜底静态模型表（8 条，源：2026-09-26 实测 `GET /api/v1/models` 的 `type === 'chat'`）。
 *
 * ⚠ `spark-x` 是**已知分歧**：远端声明 1048576，而 Loomy 客户端用本地表
 * `MODEL_CONTEXT_OVERRIDES = { 'spark-x': 262144 }` 强制降到 262144。
 * 本表**先采信远端**；若实测长上下文被拒，改为 262144。
 */
export const FALLBACK_MODELS: FallbackModel[] = [
  { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash 0731 · x3.0", contextWindow: 1_048_576, efforts: FALLBACK_EFFORTS, defaultEffort: DEFAULT_EFFORT },
  { id: "MiniMax-M3", name: "MiniMax M3 · x4.0", contextWindow: 1_048_576, efforts: FALLBACK_EFFORTS, defaultEffort: DEFAULT_EFFORT },
  { id: "Kimi-k2.6", name: "Kimi k2.6 · x6.5", contextWindow: 262_144, efforts: FALLBACK_EFFORTS, defaultEffort: DEFAULT_EFFORT },
  { id: "qwen-3.8-max", name: "Qwen 3.8 Max · x12.0", contextWindow: 1_000_000, efforts: FALLBACK_EFFORTS, defaultEffort: DEFAULT_EFFORT },
  { id: "GLM-5.3-Flash", name: "GLM 5.3 Flash · x0.8", contextWindow: 1_048_576, efforts: FALLBACK_EFFORTS, defaultEffort: DEFAULT_EFFORT },
  { id: "qwen3.8-flash", name: "qwen 3.8 flash · x0.8", contextWindow: 1_000_000, efforts: FALLBACK_EFFORTS, defaultEffort: DEFAULT_EFFORT },
  { id: "spark-x", name: "Spark X2.5 · x0.1", contextWindow: 1_048_576, efforts: FALLBACK_EFFORTS, defaultEffort: DEFAULT_EFFORT },
  { id: "mimo-v2.5", name: "MiMo V2.5 · x3.3", contextWindow: 1_048_576, efforts: FALLBACK_EFFORTS, defaultEffort: DEFAULT_EFFORT },
];

const FALLBACK_BY_ID = new Map(FALLBACK_MODELS.map((m) => [m.id, m]));

export interface CatalogEntry {
  id: string;
  name: string;
  rate: string;
  contextWindow: number;
  reasoning: boolean;
  vision: boolean;
  efforts: string[];
  defaultEffort: string;
  /** 远端声明的默认档，仅留作排查（**不采信**）。 */
  remoteDefaultEffort: string;
  source: "remote" | "fallback";
}

interface Snapshot {
  entries: CatalogEntry[];
  catalogVersion: string;
}

let snapshot: Snapshot | null = null;
/** 本进程是否已自动刷过一次（保持「每进程只刷一次」的原有语义）。 */
let refreshAttempted = false;
let remoteCache: { entries: CatalogEntry[]; version: string; at: number } | null = null;
let refreshing = false;

/** 仅供测试：清空缓存。 */
export function clearCache(): void {
  snapshot = null;
  remoteCache = null;
  upstream.clearModelEfforts();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  return 0;
}

// ── 倍率归一化 ────────────────────────────────────────────────────────────────

const TRAILING_PAREN_RATE = /^(.*?)\s*[（(]\s*(x\s*[\d.]+)\s*[)）]\s*$/i;
const NORMALIZED_RATE = /^(.*?)\s*·\s*(x\s*[\d.]+)\s*$/i;

/** 拆分末尾倍率 → `[主体, 倍率]`（无倍率时倍率为空串）。 */
export function splitRate(name: string): [string, string] {
  const paren = TRAILING_PAREN_RATE.exec(name);
  if (paren?.[1]?.trim()) return [paren[1].trim(), paren[2]!.replace(/\s+/g, "")];
  const normalized = NORMALIZED_RATE.exec(name);
  if (normalized?.[1]?.trim()) return [normalized[1].trim(), normalized[2]!.replace(/\s+/g, "")];
  // 主体为空（畸形数据）→ 原样保留
  return [name, ""];
}

/** 展示名：`{name} · {rate}`（无倍率时不追加分隔符）；幂等。 */
export function displayName(name: string): string {
  const [base, rate] = splitRate(name);
  return rate ? `${base} · ${rate}` : name;
}

// ── 远端解析 ──────────────────────────────────────────────────────────────────

/** 清洗远端档位：只留词表内的字符串、去重、保持顺序。 */
export function cleanEfforts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    if (!(EFFORT_VOCABULARY as readonly string[]).includes(item)) continue;
    if (out.includes(item)) continue;
    out.push(item);
  }
  return out;
}

/** 默认档必须落在该模型的 efforts 内；efforts 为空时退回 `high`。 */
export function pickDefaultEffort(efforts: string[]): string {
  if (efforts.length === 0) return DEFAULT_EFFORT;
  if (efforts.includes(DEFAULT_EFFORT)) return DEFAULT_EFFORT;
  const highRank = EFFORT_RANK.indexOf(DEFAULT_EFFORT);
  let best = efforts[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const effort of efforts) {
    const distance = Math.abs(EFFORT_RANK.indexOf(effort) - highRank);
    if (distance < bestDistance) {
      best = effort;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * 解析 `GET /models` 的 `data`：**只保留 `type === 'chat'`**，过滤脏数据。
 *
 * ⚠ 图片能力来自 `capabilities.input_modalities` 含 `image`；`capabilities.reasoning`
 * 必须**严格 `=== true`**（字符串 `'yes'` 不算）；兜底表不声明图片能力（宁可少报）。
 */
export function parseRemoteModels(data: unknown): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  const models = isRecord(data) ? data["models"] : null;
  if (!Array.isArray(models)) return entries;

  for (const item of models) {
    if (!isRecord(item)) continue;
    // ⚠ 过滤判据是 type === 'chat'，不能看 input_modalities
    if (item["type"] !== "chat") continue;
    const id = str(item["id"]);
    if (!id) continue;
    const capabilities = isRecord(item["capabilities"]) ? item["capabilities"] : {};
    const modalities = capabilities["input_modalities"];
    const vision =
      Array.isArray(modalities) &&
      modalities.some((m) => String(m).toLowerCase() === "image");
    const remoteEfforts = cleanEfforts(item["reasoning_efforts"]);
    const fallback = FALLBACK_BY_ID.get(id);
    const efforts = remoteEfforts.length > 0 ? remoteEfforts : (fallback?.efforts ?? []);
    const rawName = str(item["name"]) || id;
    const [, rate] = splitRate(rawName);
    entries.push({
      id,
      name: displayName(rawName),
      rate,
      contextWindow: num(item["context_length"]) || fallback?.contextWindow || 0,
      reasoning: capabilities["reasoning"] === true,
      vision,
      efforts,
      defaultEffort: pickDefaultEffort(efforts),
      remoteDefaultEffort: str(item["default_reasoning_effort"]),
      source: "remote",
    });
  }
  return entries;
}

/** 兜底条目（每次现算，永不被当成「已加载的远端目录」）。 */
export function fallbackEntries(): CatalogEntry[] {
  return FALLBACK_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    rate: splitRate(m.name)[1],
    contextWindow: m.contextWindow,
    reasoning: true,
    vision: false, // 兜底表不声明图片能力（宁可少报）
    efforts: [...m.efforts],
    defaultEffort: m.defaultEffort,
    remoteDefaultEffort: "",
    source: "fallback" as const,
  }));
}

/** 把档位登记进 upstream（避免 upstream ↔ catalog 循环依赖）。 */
function publish(entries: CatalogEntry[]): void {
  for (const entry of entries) {
    upstream.setModelEfforts(entry.id, entry.efforts, entry.defaultEffort);
  }
}

/**
 * 异步刷新远端目录。失败/空结果**保留上一次快照**（从未成功过 → 兜底表），
 * 并进入冷却，避免被逐模型放大成请求风暴。
 */
export async function refreshCatalog(): Promise<void> {
  const cfg = upstream.loadConfig()[0];
  const now = Date.now();
  const cached = remoteCache;
  if (!(cached && now - cached.at < (cached.entries.length > 0 ? REMOTE_TTL_MS : REMOTE_FAIL_COOLDOWN_MS))) {
    let entries: CatalogEntry[] = [];
    let version = "";
    try {
      const c = cred.load();
      const payload = await upstream.fetchModels(c, cfg);
      const env = upstream.parseEnvelope(payload);
      entries = parseRemoteModels(env.data);
      version = str(env.data["reasoning_catalog_version"]);
    } catch {
      // 远端不可用（未登录 / 网络 / 业务码）→ 整表保底，绝不抛到调用方
      entries = [];
      version = "";
    }
    remoteCache = { entries, version, at: now };
    if (entries.length > 0) writeCatalogCache(entries);
  }
  const fresh = remoteCache;
  if (!fresh) {
    snapshot = { entries: fallbackEntries(), catalogVersion: "" };
    publish(snapshot.entries);
    return;
  }
  const chosen = fresh.entries.length > 0 ? fresh.entries : fallbackEntries();
  snapshot = { entries: chosen, catalogVersion: fresh.version };
  publish(chosen);
}

/** 首次同步访问时触发后台刷新（不阻塞当前调用）。 */
/**
 * 磁盘缓存里的目录**先顶上**（新进程 / 离线 / 未登录时也能显示真实目录），
 * 随后的真实刷新会覆盖它 —— 所以这里只负责"有东西可显示"，不负责新鲜度。
 */
function seedFromDiskCache(): void {
  if (snapshot) return;
  try {
    const cached = readCatalogCache<CatalogEntry>();
    if (cached) {
      snapshot = { entries: cached, catalogVersion: "" };
      publish(cached);
    }
  } catch {
    /* 读不到就继续走兜底表 */
  }
}

/** 首次同步访问时触发后台刷新；返回**种入后的快照**（磁盘缓存可能已顶上）。 */
function ensureRefresh(): Snapshot | null {
  if (refreshAttempted) return snapshot; // 每进程只自动刷一次（原语义）
  refreshAttempted = true;
  seedFromDiskCache();
  refreshing = true;
  void refreshCatalog()
    .catch(() => {})
    .finally(() => {
      refreshing = false;
    });
  return snapshot;
}

function currentEntries(): CatalogEntry[] {
  if (!snapshot) {
    // ensureRefresh() 会先用磁盘缓存顶上；只有连磁盘缓存都没有时才退回内置表。
    // 直接 return fallbackEntries() 会让「新进程显示真实目录」失效 ——
    // 多数 CLI 调用只问一次目录，这一次就决定了用户看到什么。
    const seeded = ensureRefresh();
    if (seeded) return seeded.entries;
    const entries = fallbackEntries();
    publish(entries);
    return entries;
  }
  return snapshot.entries;
}

/**
 * 强制从上游重拉目录并落盘（CLI `--refresh` / `model refresh`）。
 *
 * 与 `refreshCatalog()` 的两点不同，都是「用户显式要求」带来的：
 * 1. **绕过 TTL / 冷却**：不查 `remoteCache.at`，直接打一次上游；
 * 2. **失败抛错**：`refreshCatalog` 静默回落是为了不打扰自动路径，但用户敲了
 *    `--refresh` 却看到旧表会以为刷新成功 —— 必须让失败可见。
 *
 * 失败时**不写** `remoteCache`：否则会把一次失败记成冷却期，反而挡住后续自动刷新。
 */
export async function refresh(): Promise<void> {
  const cfg = upstream.loadConfig()[0];
  const c = cred.load();
  const payload = await upstream.fetchModels(c, cfg);
  const env = upstream.parseEnvelope(payload);
  const entries = parseRemoteModels(env.data);
  if (entries.length === 0) throw new Error("upstream returned an empty model catalog");
  const version = str(env.data["reasoning_catalog_version"]);
  remoteCache = { entries, version, at: Date.now() };
  writeCatalogCache(entries);
  snapshot = { entries, catalogVersion: version };
  publish(entries);
}

/** 远端 catalog 版本（`reasoning_catalog_version`）。 */
export function catalogVersion(): string {
  return snapshot?.catalogVersion ?? "";
}

/** 某模型的档位（未知模型 → []）。 */
export function effortsFor(model: string): string[] {
  for (const entry of currentEntries()) {
    if (entry.id === model) return [...entry.efforts];
  }
  return [];
}

/** 某模型的默认档（未知模型 → `high`）。 */
export function defaultEffortFor(model: string): string {
  for (const entry of currentEntries()) {
    if (entry.id === model) return entry.defaultEffort;
  }
  return DEFAULT_EFFORT;
}

// ── 别名（models.json 可选覆盖）───────────────────────────────────────────────

const ALIAS_FIELDS = ["alias", "short", "shortName", "exposed_id"] as const;

interface AliasCache {
  key: string;
  pairs: Array<[string, string]>;
}

let aliasCache: AliasCache | null = null;

function candidatePaths(): string[] {
  const paths: string[] = [];
  const env = process.env["LOOMY_MODELS_FILE"];
  if (env) paths.push(env);
  paths.push(join(process.cwd(), "models.json"));
  const here = fileURLToPath(import.meta.url);
  paths.push(join(here, "..", "..", "models.json"));
  return paths;
}

function loadAliases(): Array<[string, string]> {
  for (const path of candidatePaths()) {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    const key = `${path}:${stat.mtimeMs}:${stat.size}`;
    if (aliasCache && aliasCache.key === key) return aliasCache.pairs;
    const pairs: Array<[string, string]> = [];
    try {
      const data: unknown = JSON.parse(readFileSync(path, "utf8"));
      const models = isRecord(data) ? data["models"] : null;
      if (Array.isArray(models)) {
        for (const model of models) {
          if (!isRecord(model)) continue;
          const slug = str(model["slug"]);
          if (!slug) continue;
          let short = "";
          for (const field of ALIAS_FIELDS) {
            const value = str(model[field]).trim();
            if (value) {
              short = value;
              break;
            }
          }
          if (short) pairs.push([short, slug]);
        }
      }
    } catch {
      /* 文件损坏 → 无别名，不阻塞 */
    }
    aliasCache = { key, pairs };
    return pairs;
  }
  return [];
}

/** 对外暴露的模型 id（短名最前；被别名覆盖的原始 id 不再重复暴露）。 */
export function exposedIds(): string[] {
  const ids = currentEntries().map((e) => e.id);
  const aliases = loadAliases();
  const all =
    aliases.length === 0
      ? ids
      : (() => {
          const covered = new Set(aliases.map(([, slug]) => slug));
          return [...aliases.map(([short]) => short), ...ids.filter((id) => !covered.has(id))];
        })();
  // 模型池策略：只放行白名单内的家族（见 model-family.ts）
  return all.filter((id) => isAllowedFamily(id));
}

/** 短名 → 上游 slug；未知名称**原样返回**。 */
export function resolveModel(name: string): string {
  for (const [short, slug] of loadAliases()) {
    if (short === name) return slug;
  }
  return name;
}

/** 目录详情（供状态页）。 */
export function details(): Array<Record<string, unknown>> {
  return currentEntries().map((e) => ({
    id: e.id,
    name: e.name,
    rate: e.rate,
    context_window: e.contextWindow,
    vision: e.vision,
    reasoning: e.reasoning,
    efforts: [...e.efforts],
    default_effort: e.defaultEffort,
    remote_default_effort: e.remoteDefaultEffort,
    effort_names: EFFORT_NAMES,
    source: e.source,
  }));
}
