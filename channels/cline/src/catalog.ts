/**
 * Cline 模型目录：三个来源的合并、免费判定与别名映射。
 *
 * ## 三个来源（PROTOCOL §5）
 *
 * - **A `GET /api/v1/ai/cline/recommended-models`**（无需认证，**唯一权威的 free 集合**）
 *   ⚠ `clinePass` **不是免费集合** —— 它是订阅制模型（`cline-pass/*`），
 *   按订阅额度计费，把它当免费会误导用户。
 * - **B `GET /api/v1/models`**（需认证）—— 实测 460 个 id 里**根本没有**
 *   `cline-free/*`：免费模型**只**由 A 下发。
 * - **C `https://models.dev/api.json`**（补窗口/图片能力，TTL 6 小时）
 *   ⚠ 不采信 `limit.output` —— 一旦下发就是真写进请求体的 `max_tokens`；
 *   ⚠ **失败绝不抛到调用方**：拿不到就保持「未知」，退回本地兜底表。
 *
 * ## 合并顺序（cline-models.ts:200-264）
 *
 * free → recommended/clinePass 未覆盖的 → `/models` 其余 id（放最后：460 个，
 * 放前面会把免费模型挤到看不见）。
 *
 * ⚠ **兜底表不是无条件并入的**：远端成功下发目录时，兜底表里「远端已不认识」
 * 的条目会被丢弃（那是上游下架的模型 —— 曾发生过下架未同步，模型列表里挂着
 * 「免费」但选中回 `404 model not found`）。只在远端整体不可用时整表保底。
 *
 * ## 为什么目录是「快照 + 异步刷新」
 *
 * 契约要求 `exposedIds()` 是**同步**函数（网关的 `/v1/models` 处理器是同步的），
 * 而零依赖约束下 Node 没有同步 HTTP（Python 版的 `requests` 是阻塞的）。
 * 故本模块维护一份内存快照：同步访问返回当前快照，首次访问触发**后台刷新**；
 * 未登录/未刷新完成时返回兜底表（否则渠道会在选择器里凭空消失）。
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";
import { isAllowedFamily } from "@model-bridge/gateway";

/** models.dev 目录地址（可用 `CLINE_MODELS_DEV_URL` 覆盖，测试用）。 */
export const DEFAULT_MODELS_DEV_URL = "https://models.dev/api.json";

/** models.dev 缓存 TTL（6 小时，PROTOCOL §5 来源 C）。 */
export const MODELS_DEV_TTL_MS = 6 * 60 * 60 * 1000;

/** 远端目录成功结果的缓存时长。 */
const REMOTE_TTL_MS = 5 * 60 * 1000;
/** 远端失败/空结果的冷却时长（挡住「每模型重试一次」的放大）。 */
const REMOTE_FAIL_COOLDOWN_MS = 30 * 1000;

/** 思考档位（全 provider 统一，远端不下发）。 */
export const EFFORTS = ["none", "low", "medium", "high", "max"] as const;

/**
 * 档位展示名与 wire 值**刻意不同**：UI 菜单是 None/Low/Medium/High/**Extra**，
 * wire 值是 `none/low/medium/high/max`。
 */
export const EFFORT_NAMES: Record<string, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Extra",
};

/** 默认档位。 */
export const DEFAULT_EFFORT = "high";

export interface FallbackModel {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  supportsImage: boolean;
  isFree: boolean;
}

/**
 * 兜底静态模型表（编译期快照，实测 2026-10-05：free 共 3 个）。
 *
 * ⚠ 这条表要与远端 `free` 数组同步 —— 已发生两次下架未同步。
 */
export const FALLBACK_MODELS: FallbackModel[] = [
  {
    id: "stealth/space-bunny-alpha",
    name: "Space Bunny Alpha",
    contextWindow: 1_000_000,
    maxOutput: 524_288,
    supportsImage: true,
    isFree: true,
  },
  {
    id: "cline-free/mimo-v2.6-flash",
    name: "MiMo-V2.6-Flash",
    contextWindow: 1_048_576,
    maxOutput: 131_072,
    supportsImage: true,
    isFree: true,
  },
  {
    id: "cline-free/muse-spark-1.3-contributor",
    name: "Muse Spark 1.3 Contributor",
    contextWindow: 1_048_576,
    maxOutput: 943_718,
    supportsImage: true,
    isFree: true,
  },
];

const FALLBACK_BY_ID = new Map(FALLBACK_MODELS.map((m) => [m.id, m]));

/** 远端条目的最小形态。 */
interface RemoteItem {
  id: string;
  name: string;
  description: string;
  free: boolean;
}

/** 一个来源的抓取结果。 */
interface RemoteCatalog {
  free: RemoteItem[];
  recommended: RemoteItem[];
  clinePass: RemoteItem[];
  allIds: string[];
  /** 至少一个来源成功（用于判断「远端是否可用」）。 */
  reachable: boolean;
}

export interface ModelsDevMeta {
  name?: string;
  contextWindow?: number;
  supportsImage?: boolean;
}

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  contextWindow: number;
  maxOutput: number;
  supportsImage: boolean;
  isFree: boolean;
  source: "remote" | "fallback";
}

interface Snapshot {
  entries: CatalogEntry[];
  freeIds: Set<string>;
  modelsDev: Map<string, ModelsDevMeta>;
}

let snapshot: Snapshot | null = null;
let refreshing = false;
let remoteCache: { catalog: RemoteCatalog; at: number } | null = null;
let modelsDevCache: { meta: Map<string, ModelsDevMeta>; at: number } | null = null;

/** 仅供测试：清空全部缓存。 */
export function clearCache(): void {
  snapshot = null;
  remoteCache = null;
  modelsDevCache = null;
}

/** 仅供测试：覆盖 models.dev 地址。 */
export function setModelsDevUrl(url: string): void {
  process.env["CLINE_MODELS_DEV_URL"] = url;
  modelsDevCache = null;
  snapshot = null;
}

function modelsDevUrl(): string {
  return process.env["CLINE_MODELS_DEV_URL"] || DEFAULT_MODELS_DEV_URL;
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

// ── 来源抓取 ──────────────────────────────────────────────────────────────────

/** 解析 recommended-models 响应（三个数组；`clinePass` 单独保留，**不算免费**）。 */
export function parseRecommended(payload: unknown): Pick<RemoteCatalog, "free" | "recommended" | "clinePass"> {
  const out = { free: [] as RemoteItem[], recommended: [] as RemoteItem[], clinePass: [] as RemoteItem[] };
  if (!isRecord(payload)) return out;
  const section = (key: string, free: boolean): RemoteItem[] => {
    const raw = payload[key];
    if (!Array.isArray(raw)) return [];
    const items: RemoteItem[] = [];
    for (const item of raw) {
      if (!isRecord(item)) continue;
      const id = str(item["id"]) || str(item["name"]);
      if (!id) continue;
      items.push({
        id,
        name: str(item["name"]) || str(item["display_name"]) || id,
        description: str(item["description"]),
        free,
      });
    }
    return items;
  };
  out.free = section("free", true);
  out.recommended = section("recommended", false);
  out.clinePass = section("clinePass", false);
  return out;
}

/** 解析 `/api/v1/models` 响应的 id 列表。 */
export function parseModelIds(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload["data"])) return [];
  const ids: string[] = [];
  for (const item of payload["data"]) {
    if (!isRecord(item)) continue;
    const id = str(item["id"]);
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * 解析 models.dev 的目录（**两种 provider 块形态都认**）。
 *
 * ⚠ 只认 `image` 模态（models.dev 还报 audio/video/pdf，那不是本渠道的模态词表）；
 * ⚠ 不读 `limit.output`（会变成请求体里的 max_tokens）。
 */
export function parseModelsDev(payload: unknown): Map<string, ModelsDevMeta> {
  const out = new Map<string, ModelsDevMeta>();
  if (!isRecord(payload)) return out;
  // 形态一：顶层直接是 `cline-pass`；形态二：`providers` 下嵌 `cline-pass`
  const holder = isRecord(payload["providers"]) ? (payload["providers"] as Record<string, unknown>) : payload;
  const block = holder["cline-pass"];
  if (!isRecord(block)) return out;
  const models = block["models"];

  const rows: Array<[string, Record<string, unknown>]> = [];
  if (Array.isArray(models)) {
    for (const item of models) {
      if (!isRecord(item)) continue;
      const id = str(item["id"]);
      if (id) rows.push([id, item]);
    }
  } else if (isRecord(models)) {
    for (const [id, item] of Object.entries(models)) {
      if (isRecord(item)) rows.push([id, item]);
    }
  }

  for (const [rawId, item] of rows) {
    // 模型 id 可能是裸 id（如 `claude-opus-4`），补 `cline-pass/` 前缀
    const id = rawId.includes("/") ? rawId : `cline-pass/${rawId}`;
    const meta: ModelsDevMeta = {};
    const name = str(item["name"]);
    if (name) meta.name = name;
    const limit = isRecord(item["limit"]) ? item["limit"] : {};
    const context = num(limit["context"]);
    if (context !== null) meta.contextWindow = context;
    const modalities = isRecord(item["modalities"]) ? item["modalities"] : {};
    const input = modalities["input"];
    if (Array.isArray(input)) {
      meta.supportsImage = input.some((m) => String(m).toLowerCase() === "image");
    }
    out.set(id, meta);
  }
  return out;
}

async function getJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function fetchRemoteCatalog(cfg: upstream.Config): Promise<RemoteCatalog> {
  const empty: RemoteCatalog = { free: [], recommended: [], clinePass: [], allIds: [], reachable: false };
  const result: RemoteCatalog = { ...empty, free: [], recommended: [], clinePass: [], allIds: [] };

  // 来源 A：唯一权威的 free 集合（不需要认证）
  try {
    const payload = await getJson(
      upstream.recommendedModelsUrl(cfg),
      { Accept: "application/json", ...cred.clientHeaders() },
      20_000,
    );
    const parsed = parseRecommended(payload);
    result.free = parsed.free;
    result.recommended = parsed.recommended;
    result.clinePass = parsed.clinePass;
    result.reachable = true;
  } catch {
    /* 来源 A 失败不抛（与来源 B/C 各自独立降级） */
  }

  // 来源 B：全量 id（需认证；未登录就跳过 —— 免费模型本来也不在这里）
  let credential: cred.Credentials | null = null;
  try {
    credential = cred.load();
  } catch {
    credential = null;
  }
  if (credential) {
    try {
      const payload = await getJson(
        upstream.modelsUrl(cfg),
        upstream.buildHeaders(credential, { chat: false }),
        20_000,
      );
      result.allIds = parseModelIds(payload);
      result.reachable = true;
    } catch {
      /* 来源 B 失败不影响来源 A 的结果 */
    }
  }
  return result;
}

async function fetchModelsDev(): Promise<Map<string, ModelsDevMeta>> {
  const now = Date.now();
  if (modelsDevCache && now - modelsDevCache.at < MODELS_DEV_TTL_MS) return modelsDevCache.meta;
  try {
    const payload = await getJson(modelsDevUrl(), { Accept: "application/json" }, 20_000);
    const meta = parseModelsDev(payload);
    modelsDevCache = { meta, at: now };
    return meta;
  } catch {
    // ⚠ 失败绝不抛到调用方：拿不到就保持「未知」，退回本地兜底表
    modelsDevCache = { meta: new Map(), at: now - MODELS_DEV_TTL_MS + REMOTE_FAIL_COOLDOWN_MS };
    return new Map();
  }
}

// ── 合并 ──────────────────────────────────────────────────────────────────────

/** 免费判定（不硬编码模型名）。⚠ 用**后缀**而非 `includes(':free')`。 */
export function isFree(id: string, remoteFreeIds?: ReadonlySet<string>): boolean {
  const freeIds: ReadonlySet<string> =
    remoteFreeIds ?? new Set(remoteCache?.catalog.free.map((f) => f.id) ?? []);
  return (
    freeIds.has(id) ||
    id.endsWith(":free") ||
    id.startsWith("cline-free/") ||
    FALLBACK_BY_ID.get(id)?.isFree === true
  );
}

/** 展示名：免费模型拼 ` · 免费`，且**必须写进 `name`**（composer 只渲染 name）。 */
export function displayName(base: string, free: boolean): string {
  return free ? `${base} · 免费` : base;
}

function buildEntry(
  id: string,
  remoteName: string,
  description: string,
  freeIds: Set<string>,
  dev: Map<string, ModelsDevMeta>,
): CatalogEntry {
  const fb = FALLBACK_BY_ID.get(id);
  const meta = dev.get(id);
  const free = isFree(id, freeIds);
  // 元数据优先级：本地兜底表 > 远端条目 > models.dev
  const base = fb?.name || remoteName || meta?.name || id;
  return {
    id,
    name: displayName(base, free),
    description,
    contextWindow: fb?.contextWindow ?? meta?.contextWindow ?? 0,
    // ⚠ 不取 models.dev 的 limit.output；兜底表的值是编译期快照
    maxOutput: fb?.maxOutput ?? 0,
    supportsImage: fb?.supportsImage ?? meta?.supportsImage ?? false,
    isFree: free,
    source: "remote",
  };
}

/** 合并三来源为目录（顺序见文件头注释）。 */
export function mergeCatalog(remote: RemoteCatalog, dev: Map<string, ModelsDevMeta>): CatalogEntry[] {
  const freeIds = new Set(remote.free.map((f) => f.id));
  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();
  const push = (id: string, name: string, description: string): void => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    entries.push(buildEntry(id, name, description, freeIds, dev));
  };

  for (const item of remote.free) push(item.id, item.name, item.description);
  for (const item of remote.recommended) push(item.id, item.name, item.description);
  for (const item of remote.clinePass) push(item.id, item.name, item.description);
  for (const id of remote.allIds) push(id, "", "");
  return entries;
}

/** 兜底表整表（远端不可用，或尚未刷新出远端目录时）。 */
function fallbackEntries(): CatalogEntry[] {
  return FALLBACK_MODELS.map((m) => ({
    id: m.id,
    name: displayName(m.name, m.isFree),
    description: "",
    contextWindow: m.contextWindow,
    maxOutput: m.maxOutput,
    supportsImage: m.supportsImage,
    isFree: m.isFree,
    source: "fallback" as const,
  }));
}

/** 远端是否「成功下发了目录」（三者拼成，不是只看 freeIds）。 */
function remoteUsable(catalog: RemoteCatalog): boolean {
  return catalog.free.length + catalog.recommended.length + catalog.clinePass.length + catalog.allIds.length > 0;
}

/**
 * 显式刷新目录（异步）。失败时保留上一次快照；从未成功过则退回兜底表。
 *
 * 网关/CLI 可以在启动时 await 它；同步访问器也会在后台自动调用。
 */
export async function refreshCatalog(): Promise<void> {
  const cfg = upstream.loadConfig()[0];
  let catalog: RemoteCatalog;
  const cached = remoteCache;
  const now = Date.now();
  if (cached && now - cached.at < (remoteUsable(cached.catalog) ? REMOTE_TTL_MS : REMOTE_FAIL_COOLDOWN_MS)) {
    catalog = cached.catalog;
  } else {
    catalog = await fetchRemoteCatalog(cfg);
    remoteCache = { catalog, at: now };
  }
  const dev = await fetchModelsDev();
  const entries = remoteUsable(catalog) ? mergeCatalog(catalog, dev) : fallbackEntries();
  snapshot = { entries, freeIds: new Set(catalog.free.map((f) => f.id)), modelsDev: dev };
}

/** 首次同步访问时触发一次后台刷新（不阻塞当前调用）。 */
function ensureRefresh(): void {
  if (snapshot || refreshing) return;
  refreshing = true;
  void refreshCatalog()
    .catch(() => {})
    .finally(() => {
      refreshing = false;
    });
}

function currentEntries(): CatalogEntry[] {
  if (!snapshot) {
    ensureRefresh();
    return fallbackEntries();
  }
  return snapshot.entries;
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
  const env = process.env["CLINE_MODELS_FILE"];
  if (env) paths.push(env);
  paths.push(join(process.cwd(), "models.json"));
  const here = fileURLToPath(import.meta.url); // dist/catalog.js → 上两级是项目根
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

/** 对外暴露的模型 id（别名在最前；被别名覆盖的原始 id 不再重复暴露）。 */
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
  // 模型池策略：只放行 flash 家族（见 model-family.ts）。
  // Cline 的免费池里 `cline-free/mimo-v2.6-flash` 与推荐池的
  // `deepseek/deepseek-v4.1-flash` 命中白名单；`z-ai/glm-4.7` 等非 flash 不暴露
  // （数据仍在底层目录，过滤只发生在呈现层）。
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
  const dev = snapshot?.modelsDev;
  return currentEntries().map((e) => ({
    id: e.id,
    name: e.name,
    description: e.description,
    context_window: e.contextWindow,
    max_output: e.maxOutput,
    vision: e.supportsImage,
    is_free: e.isFree,
    efforts: [...EFFORTS],
    default_effort: DEFAULT_EFFORT,
    effort_names: EFFORT_NAMES,
    source: e.source,
    models_dev_known: dev ? dev.has(e.id) : false,
  }));
}

/** 供排查：models.dev 解析结果（未刷新时为 null）。 */
export function modelsDevMeta(): Record<string, ModelsDevMeta> | null {
  if (!snapshot) return null;
  return Object.fromEntries(snapshot.modelsDev);
}
