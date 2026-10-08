/**
 * CodeArts 模型目录与 benefit 集合。
 *
 * ## 两个端点合并去重
 *
 * | # | 端点 | 提取路径 | 条目字段 |
 * |---|---|---|---|
 * | 1 | `opengw.../api/v1/gateway/config` | `result.models[]` | `model_id` / `model_name` |
 * | 2 | `{snap}/v1/model/builtin` | `builtinModels[]` | `model_id` / `model_name` |
 *
 * 归一化：去掉末尾 `-` + 4 位数字（`deepseek-v4-flash-0731` → `deepseek-v4-flash`）——
 * chat 端点只认不带后缀的 id（`InferHub.002002009.404 model is not registered`）。
 * 视觉模型（id 含 `-VL-` 或以 `-VL` 结尾）过滤掉：上下文小、不支持工具调用，
 * 不适合当 agent 主模型。
 *
 * ## benefit 集合：`maas_type: benefit` 的判据
 *
 * gateway/config 返回的就是 benefit（免费额度）模型；这些模型 chat 时**必须**
 * 带 `maas_type: benefit`（且**参与签名**），否则 404 未注册。
 * 而 `/v1/model/builtin` 的模型带上该头反而 `unsupported model`。
 *
 * ⚠️ **只记录归一化未改写的 id**：带日期后缀的 `-0731` 与无后缀在后端是
 * **两个不同模型、benefit 属性相反**（实测：`-0731` 不带 maas_type → 404；
 * 无后缀的不带 → 成功、带上 → `unsupported model`）。记录被改写过的 id 会把
 * 无后缀模型错误标成 benefit，导致它反而调用失败。
 *
 * 缓存文件落在渠道层内：`<存储根>/codearts/cache/models.json` 与 `benefit-models.json`
 * （`DSH_CODEARTS_CACHE_DIR` / `CODEARTS_CACHE_DIR` 可显式覆盖），**同步读写**：chat 签名前要读它。
 * 旧位置 `~/.cache/deveco/codearts_*.json` 只作一次性兼容读（见 STORAGE-CONVENTION.md §3.4）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cacheDir as sharedCacheDir, isAllowedFamily } from "@model-bridge/gateway";

/** 一条目录条目。 */
export interface ModelEntry {
  id: string;
  name: string;
  /** 上下文窗口（仅静态表里有值；远端不下发时留 undefined 让后端默认裁剪）。 */
  context_window?: number;
  source: "fallback" | "remote";
}

/**
 * 静态兜底模型表（9 个）。
 *
 * 远端两个端点都拉不到时（未登录 / 网络问题）仍要让用户看到模型 ——
 * 否则渠道在选择器里凭空消失。
 */
export const FALLBACK_MODEL_IDS: readonly string[] = [
  "GLM-5.2",
  "GLM-5.1",
  "GLM-5",
  "glm-5.3-flash",
  "openpangu-2.0-flash",
  "openpangu-2.0-pro",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4.1-flash",
];

/** 上下文窗口表（仅这几个模型公开了容量；其余留 undefined 让后端默认裁剪）。 */
export const CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ["GLM-5.2", 202_752],
  ["glm-5.3-flash", 1_048_576],
  ["deepseek-v4-flash", 1_048_576],
  ["deepseek-v4-pro", 1_048_576],
  ["deepseek-v4.1-flash", 1_000_000],
]);

export const FALLBACK_MODELS: readonly ModelEntry[] = FALLBACK_MODEL_IDS.map((id) => {
  const window = CONTEXT_WINDOWS.get(id);
  return window === undefined
    ? { id, name: id, source: "fallback" as const }
    : { id, name: id, context_window: window, source: "fallback" as const };
});

/**
 * benefit 静态兜底集合（2 个）。
 *
 * 权威来源是 gateway/config，但首次启动 / 未登录 / 远端失败时拿不到，
 * 故保留这份来自真实 IDE 抓包 + 逐一实测的兜底。
 */
export const BENEFIT_FALLBACK: readonly string[] = ["glm-5.3-flash", "deepseek-v4.1-flash"];

const BENEFIT_CACHE_FILENAME = "benefit-models.json";
const MODELS_CACHE_FILENAME = "models.json";

/** 旧位置/旧文件名（一次性兼容读；新位置有内容就不看它）。 */
const LEGACY_CACHE_DIR = join(homedir(), ".cache", "deveco");
const LEGACY_FILENAMES: Record<string, readonly string[]> = {
  [MODELS_CACHE_FILENAME]: ["codearts_models.json"],
  [BENEFIT_CACHE_FILENAME]: ["codearts_benefit_models.json"],
};

/**
 * 缓存目录：`DSH_CODEARTS_CACHE_DIR`（或 `CODEARTS_CACHE_DIR`）可显式覆盖，
 * 默认落在渠道层内（`<存储根>/codearts/cache/`）。
 */
export function cacheDir(): string {
  const override = process.env["DSH_CODEARTS_CACHE_DIR"] ?? process.env["CODEARTS_CACHE_DIR"];
  if (override && override.trim()) return override.trim();
  return sharedCacheDir();
}

/** 读缓存：新位置/新名优先，回落到旧位置与旧文件名。 */
function readCache(filename: string): unknown[] | null {
  const direct = readCacheArray(join(cacheDir(), filename));
  if (direct) return direct;
  for (const dir of [cacheDir(), LEGACY_CACHE_DIR]) {
    for (const legacyName of LEGACY_FILENAMES[filename] ?? []) {
      const found = readCacheArray(join(dir, legacyName));
      if (found) return found;
    }
  }
  return null;
}

/** 写缓存：一律写新位置/新名（写不进去不影响主流程）。 */
function writeCache(filename: string, value: unknown): void {
  writeCacheArray(join(cacheDir(), filename), value);
}

function readCacheArray(path: string): unknown[] | null {
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCacheArray(path: string, value: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch {
    /* 缓存写不进去不影响主流程 */
  }
}

/** 去重记录器（跨两个端点共用，保证同名模型只出现一次）。 */
export type SeenSet = Set<string>;

/**
 * 去掉模型 id 末尾的日期版本后缀：`deepseek-v4-flash-0731` → `deepseek-v4-flash`。
 *
 * 只匹配末尾 `-NNNN`（4 位数字），避免误去 `glm-5.3-flash` 这类合法 id。
 */
export function normalizeModelId(id: string): string {
  if (id.length > 5) {
    const suffix = id.slice(-5);
    if (suffix.startsWith("-") && /^\d{4}$/.test(suffix.slice(1))) return id.slice(0, -5);
  }
  return id;
}

/** 视觉（VL）模型：从列表隐藏（只通过 analyzeImage 类工具间接调用）。 */
export function isVisionModel(id: string): boolean {
  return id.includes("-VL-") || id.endsWith("-VL");
}

/** 解析一组远端模型行（`model_id` / `model_name`）。 */
export function parseModelRows(
  rows: readonly unknown[],
  seen: SeenSet = new Set<string>(),
  source: ModelEntry["source"] = "remote",
): ModelEntry[] {
  const out: ModelEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const rawId = typeof rec["model_id"] === "string" ? rec["model_id"] : "";
    if (!rawId) continue;
    const id = normalizeModelId(rawId);
    if (isVisionModel(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const rawName = typeof rec["model_name"] === "string" ? rec["model_name"] : "";
    const entry: ModelEntry = { id, name: rawName ? normalizeModelId(rawName) : id, source };
    const window = CONTEXT_WINDOWS.get(id);
    if (window !== undefined) entry.context_window = window;
    out.push(entry);
  }
  return out;
}

// ── 缓存状态 ─────────────────────────────────────────────────────────────────

let remoteCache: ModelEntry[] | null = null;
let benefitCache: string[] | null = null;

/**
 * 同步读一次磁盘缓存（**惰性**：不在模块加载时读）。
 *
 * `isBenefitModel()` 在 chat 请求签名前被调用（同步路径），若等异步填充会有
 * 窗口期把 benefit 模型当成非 benefit 发出去（404）—— 故这里保持同步，只是把
 * 时机从「模块加载」推到「第一次使用」：仅 import 本模块不应产生读盘副作用
 * （巡检/统计工具会 import 各渠道模块拿 config）。
 */
function loadCaches(): void {
  const models = readCache(MODELS_CACHE_FILENAME);
  if (models && models.length > 0) {
    const entries: ModelEntry[] = [];
    for (const item of models) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const id = typeof rec["id"] === "string" ? rec["id"] : "";
      if (!id) continue;
      const entry: ModelEntry = {
        id,
        name: typeof rec["name"] === "string" && rec["name"] ? rec["name"] : id,
        source: "remote",
      };
      if (typeof rec["context_window"] === "number") entry.context_window = rec["context_window"];
      entries.push(entry);
    }
    if (entries.length > 0) remoteCache = entries;
  }
  const benefit = readCache(BENEFIT_CACHE_FILENAME);
  if (benefit) {
    benefitCache = benefit.filter((v): v is string => typeof v === "string" && v.length > 0);
  }
}

let cachesLoaded = false;

/** 首次使用时同步载入磁盘缓存。 */
function ensureCaches(): void {
  if (cachesLoaded) return;
  cachesLoaded = true;
  loadCaches();
}

/** 灌入远端目录与 benefit 集合（由 `upstream.fetchModels` 调用）。 */
export function setRemoteModels(entries: readonly ModelEntry[], benefitIds?: readonly string[]): void {
  if (entries.length > 0) {
    remoteCache = [...entries];
    writeCache(MODELS_CACHE_FILENAME, remoteCache);
  }
  if (benefitIds && benefitIds.length > 0) {
    // ⚠️ 只在确实拿到 benefit 模型时写入，避免用空集合覆盖可用缓存。
    benefitCache = [...new Set(benefitIds)];
    writeCache(BENEFIT_CACHE_FILENAME, benefitCache);
  }
}

export function remoteModels(): ModelEntry[] | null {
  ensureCaches();
  return remoteCache ? [...remoteCache] : null;
}

/** 清空内存与磁盘缓存（测试隔离 / 用户点「刷新目录」）。 */
export function resetRemoteCache(): void {
  remoteCache = null;
  benefitCache = null;
}

/** 当前生效的目录：远端优先，未拉到时用兜底表。 */
export function entries(): ModelEntry[] {
  ensureCaches();
  return remoteCache && remoteCache.length > 0 ? [...remoteCache] : [...FALLBACK_MODELS];
}

/** 按 id 取条目；不存在返回 null。 */
export function entryFor(id: string): ModelEntry | null {
  return entries().find((entry) => entry.id === id) ?? null;
}

/** 对外暴露的模型 id。 */
export function exposedIds(): string[] {
  // 模型池策略：只放行白名单内的家族（见 model-family.ts）
  return entries()
    .filter((entry) => isAllowedFamily(entry.id, entry.name))
    .map((entry) => entry.id);
}

/**
 * 短名 → 上游模型 id。
 *
 * 上游只认**归一化后的 id**（去掉 `-NNNN` 后缀）：带后缀的形态发给 chat
 * 端点会被 404。已知 id 归一化后返回；未知名称原样透传。
 */
export function resolveModel(name: string): string {
  const id = normalizeModelId(name);
  const known = new Set(entries().map((entry) => entry.id));
  return known.has(id) ? id : name;
}

/**
 * 该模型是否属于 benefit 集合（chat 时必须带 `maas_type: benefit`）。
 *
 * 判据：远端 benefit 缓存 ∪ 静态兜底。**静态兜底必须算进来** ——
 * 首次启动、远端失败时缓存为空，只靠缓存会让所有 benefit 模型 404。
 */
export function isBenefitModel(id: string): boolean {
  ensureCaches();
  const normalized = normalizeModelId(id);
  if (BENEFIT_FALLBACK.includes(normalized)) return true;
  return (benefitCache ?? []).includes(normalized);
}

/** 当前 benefit 集合（诊断用）。 */
export function benefitModels(): string[] {
  ensureCaches();
  return [...new Set([...BENEFIT_FALLBACK, ...(benefitCache ?? [])])];
}

/** 详情列表（状态页 / 调试用）。 */
export function details(): Array<Record<string, unknown>> {
  return entries().map((entry) => ({ ...entry }));
}
