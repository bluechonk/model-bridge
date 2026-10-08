/**
 * TRAE 模型目录：通道白名单过滤 + 硬过滤 + 合并优先级 + 兜底表。
 *
 * ## 通道白名单机制（docs/protocols/trae/PROTOCOL.md §5.2，重点）
 *
 * 15 个通道的**顺序即优先级**，它同时是白名单与排序表：
 * 不在表内的通道**整组丢弃**（连同其独有模型）。
 * 稳定被拒的 `chat`（4023）/ `builder`（4001）/ `inline_chat`（3003）绝不列入。
 *
 * 同一模型被多个白名单通道列出时的合并规则：
 *   ① 空档位不得覆盖有档位 → ② 两侧都有档位时取更靠前者 → ③ 其余「后覆盖前」。
 *
 * 硬过滤：`usage !== 'chat_completion'` 剔除、`config_switch === false` 剔除、
 * `is_invisible_to_user === true` 剔除；`is_custom_model === true` 也剔除
 * （实测 5/5 报 4001）。
 *
 * 目录来源优先级：远端目录（`mergeRemote` 写入的缓存）→ 仓库根 `models.json`
 * → 内置兜底表（32 条，含 4 条官方隐藏）。**兜底是必需的**：未登录或上游目录
 * 失败时用户仍应看到模型，否则渠道在选择器里凭空消失。
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAllowedFamily } from "@model-bridge/gateway";

/** 缺省通道（`function` 字段）。 */
export const DEFAULT_FUNCTION = "solo_work_lite";

/**
 * 通道白名单（15 个，顺序即优先级）。
 *
 * ⚠ 可用 `TRAE_CHANNELS`（逗号分隔）覆盖整张表 —— 上游调整通道时不必改代码。
 */
export const DEFAULT_CHANNEL_WHITELIST: string[] = [
  "solo_agent",
  "solo_work_lite",
  "solo_agent_remote",
  "solo_work_remote",
  "solo_agent_lite",
  "chat_v3",
  "builder_v3",
  "solo_coder",
  "solo_design_lite",
  "solo_design_remote",
  "git_ai",
  "code_reviewer",
  "code_review_summary",
  "multimodal",
  "system_diagnosis",
];

/** 当前白名单（含环境变量覆盖）。 */
export function channelWhitelist(): string[] {
  const env = process.env["TRAE_CHANNELS"];
  if (env) {
    const list = env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 0) return list;
  }
  return [...DEFAULT_CHANNEL_WHITELIST];
}

export interface ModelEntry {
  /** 对外暴露的 id。 */
  id: string;
  /** 上游 config_name（请求体 model / config_name 用它）。 */
  model: string;
  name: string;
  /** 该模型所属通道（请求体 function）。 */
  function: string;
  context_window: number;
  max_output: number;
  max_max_tokens?: number;
  max_mode: boolean;
  multimodal: boolean;
  tiered: boolean;
  efforts: string[];
  default_effort: string;
  hidden: boolean;
}

/** 产品级兜底输出上限（远端可用时完全采信远端）。 */
const FALLBACK_MAX_OUTPUT = 32_000;
/** 兜底 contextWindow（估值）。 */
const FALLBACK_CONTEXT_WINDOW = 200_000;

/** 32 条兜底模型（含 4 条官方隐藏 —— 隐藏条目不在 exposedIds 里）。 */
const FALLBACK_NAMES: Array<[string, boolean]> = [
  ["DeepSeek-V4-Flash-Official", false],
  ["Doubao-Seed-2.1-Pro", false],
  ["seed-code-pro-0430", false],
  ["Doubao-Seed-2.1-Turbo", false],
  ["Doubao-Seed-2.0-Code", false],
  ["browser_use_subagent", true],
  ["glm-5.2", false],
  ["glm-5-turbo", false],
  ["glm-5", false],
  ["DeepSeek-V4-Pro", false],
  ["DeepSeek-V4-Flash", false],
  ["kimi-k3", false],
  ["kimi-k2.7-code", false],
  ["kimi-k2.6", false],
  ["minimax-m3", false],
  ["qwen-3.7-plus", false],
  ["sagitta", false],
  ["aquila", false],
  ["custom_model_gemini", false],
  ["custom_model_placeholder", false],
  ["custom_model_1M_text", false],
  ["custom_model_1M", false],
  ["custom_model_kimi", false],
  ["custom_model_claude", false],
  ["custom_model_gpt-5", false],
  ["custom_model_no-fc", false],
  ["custom_model_deepseek_chat", false],
  ["custom_model_deepseek_reasoner", false],
  ["custom_model_deepseek_v4", false],
  ["explore_sub_agent_v13", true],
  ["explore_sub_agent_v2", true],
  ["summary", true],
];

export const FALLBACK_MODELS: ModelEntry[] = FALLBACK_NAMES.map(([id, hidden]) => ({
  id,
  model: id,
  name: id,
  function: DEFAULT_FUNCTION,
  context_window: FALLBACK_CONTEXT_WINDOW,
  max_output: FALLBACK_MAX_OUTPUT,
  max_mode: false,
  multimodal: false,
  tiered: false,
  efforts: [],
  default_effort: "",
  hidden,
}));

// ── 远端目录解析 ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): string {
  return typeof value === "string" && value ? value : "";
}

function numberOr(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** `display_contact_config` 是 JSON **字符串**，必须二次 parse。 */
function parseContactConfig(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** 展示名带倍率（活动期 `名称 · x0.80→x0.08`；`rate === 0` 显示「免费」）。 */
function decorateName(base: string, contact: Record<string, unknown>): string {
  const rate = typeof contact["consumption_rate"] === "number" ? contact["consumption_rate"] : null;
  const discount =
    typeof contact["activity_discount"] === "number" ? contact["activity_discount"] : null;
  if (rate === null) return discount === null ? base : `${base} · x${discount.toFixed(2)}`;
  if (rate === 0) return `${base} · 免费`;
  if (discount !== null && discount !== rate) {
    return `${base} · x${discount.toFixed(2)}→x${rate.toFixed(2)}`;
  }
  return `${base} · x${rate.toFixed(2)}`;
}

/**
 * 解析单个 config_info 条目；被硬过滤时返回 null。
 *
 * 硬过滤：usage（若给出且非 chat_completion）、config_switch === false、
 * is_invisible_to_user === true、is_custom_model === true。
 */
function parseConfigEntry(functionName: string, raw: unknown): ModelEntry | null {
  if (!isRecord(raw)) return null;
  const usage = nonEmpty(raw["usage"]);
  if (usage && usage !== "chat_completion") return null;
  if (raw["config_switch"] === false) return null;
  if (raw["is_invisible_to_user"] === true) return null;

  const display = isRecord(raw["display_config"]) ? raw["display_config"] : {};
  if (display["is_custom_model"] === true) return null; // 实测 5/5 报 4001

  const model = nonEmpty(raw["config_name"]);
  if (!model) return null;

  // context_window 取 max（有档位时更靠 max），缺省用兜底估值
  const windows = isRecord(raw["context_window_tokens"]) ? raw["context_window_tokens"] : {};
  const contextWindow = numberOr(windows["max"], numberOr(windows["dev"], FALLBACK_CONTEXT_WINDOW));

  // model_detail_list 的 __dev / __max 后缀区分档位明细
  let maxOutput = FALLBACK_MAX_OUTPUT;
  let maxMaxTokens: number | undefined;
  const details = raw["model_detail_list"];
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (!isRecord(detail)) continue;
      const name = nonEmpty(detail["model_name"]);
      const tokens = typeof detail["max_tokens"] === "number" ? detail["max_tokens"] : null;
      if (tokens === null) continue;
      if (name.endsWith("__max")) maxMaxTokens = tokens;
      else if (name.endsWith("__dev")) maxOutput = tokens;
    }
  }

  // 思考档位：options 是单值字符串（既展示名也是 wire 值），键序即展示顺序
  const reasoning = isRecord(raw["reasoning_effort_config"]) ? raw["reasoning_effort_config"] : {};
  const efforts = Array.isArray(reasoning["options"])
    ? reasoning["options"].filter((o): o is string => typeof o === "string" && o.length > 0)
    : [];
  const defaultLevel = nonEmpty(reasoning["default_level"]);
  // ⚠ 默认档采信上游 default_level，但它可能不在 options 里（实测下发 'max'）——
  // 此时必须退到最强档（options 末位，键序即强度序），不能照抄。
  const defaultEffort = efforts.length
    ? efforts.includes(defaultLevel)
      ? defaultLevel
      : efforts[efforts.length - 1]!
    : "";

  const baseName = nonEmpty(display["display_name"]) || model;
  return {
    id: model,
    model,
    name: decorateName(baseName, parseContactConfig(raw["display_contact_config"])),
    function: functionName,
    context_window: contextWindow,
    max_output: maxOutput,
    max_max_tokens: maxMaxTokens,
    max_mode: display["max_mode"] === true,
    multimodal: display["multimodal"] === true,
    tiered: efforts.length > 0,
    efforts,
    default_effort: defaultEffort,
    hidden: false,
  };
}

/**
 * 解析 `batch_get_detail_param` 载荷。
 *
 * 白名单外的通道**整组丢弃**；白名单内按合并规则去重。
 */
export function parseRemoteCatalog(payload: Record<string, unknown>): ModelEntry[] {
  const configs = payload["function_configs"];
  if (!Array.isArray(configs)) return [];
  const byFunction = new Map<string, unknown[]>();
  for (const item of configs) {
    if (!isRecord(item)) continue;
    const fn = nonEmpty(item["function"]);
    const list = item["config_info_list"];
    if (!fn || !Array.isArray(list)) continue;
    byFunction.set(fn, [...(byFunction.get(fn) ?? []), ...list]);
  }

  const merged = new Map<string, ModelEntry>();
  for (const fn of channelWhitelist()) {
    for (const raw of byFunction.get(fn) ?? []) {
      const entry = parseConfigEntry(fn, raw);
      if (!entry) continue;
      const existing = merged.get(entry.id);
      if (!existing) {
        merged.set(entry.id, entry);
        continue;
      }
      // ① 空档位不得覆盖有档位
      if (!existing.tiered && entry.tiered) {
        merged.set(entry.id, entry);
        continue;
      }
      // ② 两侧都有档位时取更靠前者（白名单顺序即优先级）⇒ 保持 existing
      if (existing.tiered && entry.tiered) continue;
      // ③ 其余「后覆盖前」
      merged.set(entry.id, entry);
    }
  }
  return [...merged.values()];
}

/** 远端目录缓存（由 `mergeRemote` 写入；`refreshRemote` 在调用方拼装）。 */
let remoteCache: ModelEntry[] | null = null;

/** 写入远端目录缓存（解析后的条目）。 */
export function mergeRemote(entries: ModelEntry[]): void {
  remoteCache = entries.length > 0 ? entries : null;
}

/** 清空远端缓存（仅测试/重登时用）。 */
export function resetRemoteCache(): void {
  remoteCache = null;
}

// ── models.json 兜底与对外接口 ───────────────────────────────────────────────

interface FileCacheEntry {
  key: string;
  catalog: ModelEntry[];
}

let fileCache: FileCacheEntry | null = null;

function candidatePaths(): string[] {
  const paths: string[] = [];
  const env = process.env["TRAE_MODELS_FILE"];
  if (env) paths.push(env);
  paths.push(join(process.cwd(), "models.json"));
  const here = fileURLToPath(import.meta.url);
  paths.push(join(here, "..", "..", "models.json"));
  return paths;
}

function parseCatalogFile(path: string): ModelEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(data)) return [];
  const models = data["models"];
  if (!Array.isArray(models)) return [];

  const entries: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (!isRecord(model)) continue;
    const slug = nonEmpty(model["slug"]);
    if (!slug) continue;
    const id = nonEmpty(model["alias"]) || nonEmpty(model["short"]) || slug;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({
      id,
      model: slug,
      name: nonEmpty(model["name"]) || slug,
      function: nonEmpty(model["function"]) || nonEmpty(model["channel"]) || DEFAULT_FUNCTION,
      context_window: numberOr(model["context_window"], FALLBACK_CONTEXT_WINDOW),
      max_output: numberOr(model["max_output"], FALLBACK_MAX_OUTPUT),
      max_mode: model["max_mode"] === true,
      multimodal: model["multimodal"] === true,
      tiered: false,
      efforts: [],
      default_effort: "",
      hidden: model["hidden"] === true,
    });
  }
  return entries;
}

/** 当前目录（远端缓存 → models.json → 兜底表）。 */
export function loadCatalog(): ModelEntry[] {
  if (remoteCache) return remoteCache.map((e) => ({ ...e }));
  for (const path of candidatePaths()) {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    const key = `${path}:${stat.mtimeMs}:${stat.size}`;
    if (fileCache && fileCache.key === key) return fileCache.catalog.map((e) => ({ ...e }));
    const entries = parseCatalogFile(path);
    if (entries.length > 0) {
      fileCache = { key, catalog: entries };
      return entries.map((e) => ({ ...e }));
    }
  }
  return FALLBACK_MODELS.map((e) => ({ ...e }));
}

/** 对外暴露的模型 ID 列表（隐藏条目不在其中）。 */
export function exposedIds(): string[] {
  return loadCatalog()
    .filter((e) => !e.hidden)
    // `custom_model_*` 是官方客户端的「自定义模型」模板占位（让用户填自己的
    // endpoint），**不是可调用模型** —— 实测选中它们 5/5 报 `4001 param is invalid`。
    // 列出来只会让用户点到必然失败的条目，故排除。
    .filter((e) => !e.id.startsWith("custom_model"))
    // 模型池策略：只放行白名单内的家族（见 model-family.ts）
    .filter((e) => isAllowedFamily(e.id, e.name, e.model))
    .map((e) => e.id);
}

/** 短名 → 上游 config_name；未知名称原样透传。 */
export function resolveModel(name: string): string {
  const entries = loadCatalog();
  for (const entry of entries) {
    if (entry.id === name || entry.model === name) return entry.model;
  }
  const folded = name.toLowerCase();
  for (const entry of entries) {
    if (entry.id.toLowerCase() === folded || entry.model.toLowerCase() === folded) return entry.model;
  }
  return name;
}

/** 取模型所属通道（请求体 `function` 字段）；未知回退缺省通道。 */
export function channelFor(name: string): string {
  const entries = loadCatalog();
  for (const entry of entries) {
    if (entry.id === name || entry.model === name) return entry.function;
  }
  const folded = name.toLowerCase();
  for (const entry of entries) {
    if (entry.model.toLowerCase() === folded) return entry.function;
  }
  return DEFAULT_FUNCTION;
}

/** 目录条目提示（供 buildChatBody 的 Max 模式成套下发）。 */
export function entryFor(name: string): ModelEntry | null {
  const entries = loadCatalog();
  return (
    entries.find((e) => e.id === name || e.model === name) ??
    entries.find((e) => e.model.toLowerCase() === name.toLowerCase()) ??
    null
  );
}

/** 供状态页/UI 使用的目录详情。 */
export function details(): Array<Record<string, unknown>> {
  return loadCatalog()
    .filter((e) => !e.hidden)
    .map((e) => ({
      id: e.id,
      name: e.name,
      model: e.model,
      function: e.function,
      context_window: e.context_window,
      max_output: e.max_output,
      max_max_tokens: e.max_max_tokens ?? null,
      max_mode: e.max_mode,
      tiered: e.tiered,
      efforts: e.efforts,
      default_effort: e.default_effort,
    }));
}

/** 仅供测试：清空 models.json 缓存。 */
export function clearCache(): void {
  fileCache = null;
}
