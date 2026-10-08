import { isAllowedFamily } from "@model-bridge/gateway";

/**
 * LobsterAI 模型目录：远端 `/api/models/available` 的解析、缓存与兜底表。
 *
 * ## 兜底表是必需的，但**不能**替代远端
 *
 * 未登录或上游目录失败时用户仍要在模型选择器里看到模型（否则渠道凭空消失，
 * 用户以为插件坏了）——故保留 Go `handler.go:94-114` 的 19 条静态表。
 * 但远端列表才是权威：实测它会下发 `contextWindow`（多为 1000000）、
 * `thinkingConfig`、`costMultiplier`（裸数字）等静态表没有的信息，
 * 且**只有远端列表里有 `kimi-k3`**（兜底表是 2026-08-06 的快照）。
 *
 * ## 两个语义不可混用的档位
 *
 * `thinkingConfig.options[].level` 是产品侧档位名（含 `max`，给 UI），
 * `openclawLevel` 才是发给服务端的 wire 值（`off/minimal/low/medium/high/xhigh`，
 * **没有 `max`**）。实测远端把 `level:'max'` 映射到 `openclawLevel:'xhigh'`，
 * 直接发 `reasoning_effort:'max'` 与不带参数无差异 —— 故两者分开记录。
 *
 * ## 缓存由谁填充
 *
 * 网关的 `/v1/models` 走同步的 `exposedIds()`，而拉远端是异步的。
 * 拉取动作挂在 `upstream.fetchModels()` 上（`auth-flow` 在启动/登录时必调），
 * 拉到后调 `setRemoteModels()` 灌进本模块的内存缓存 —— 这样网关保持同步、
 * 且不会为了列模型额外打一次上游。
 */

/** 一条目录条目。 */
export interface ModelEntry {
  id: string;
  name: string;
  /** 上下文窗口；兜底表统一填 131072（**桥接层估计值，非逐个实测**）。 */
  context_window: number;
  /** 最大输出 token（远端 `maxTokens`）。 */
  max_output?: number;
  supports_image?: boolean;
  supports_thinking?: boolean;
  /** 产品侧档位名（含 `max`），仅展示用。 */
  efforts?: string[];
  /** 档位名 → 服务端 wire 值（`openclawLevel`）。 */
  efforts_wire?: Record<string, string>;
  default_effort?: string;
  cost_multiplier?: number;
  description?: string;
  capabilities?: string[];
  source: "fallback" | "remote";
}

/**
 * 兜底模型表（19 条，全部 `contextWindow: 131072`）。
 *
 * 来源：Go `handler.go:94-114` 的 `staticModels`（2026-08-06 从
 * `GET /api/models/available` 实测拉取）。顺序照抄原表，不重排 ——
 * 它是实测时的返回顺序，重排会让「与上游对比」失去可比性。
 *
 * ⚠️ 不含 `costMultiplier`：编译期快照，价格会变，**不猜**。
 */
const FALLBACK: readonly string[] = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "MiniMax-M3",
  "MiniMax-M2.7",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
  "qwen3.5-plus-2026-04-20",
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
  "kimi-k2.6",
  "kimi-k2.5",
  "doubao-seed-2-1-pro-260628",
  "doubao-seed-2-1-turbo-260628",
  "doubao-seed-2-0-code-preview-260215",
  "glm-5.2",
  "glm-5.1",
  "glm-5v-turbo",
  "glm-5",
];

/** 兜底上下文窗口估计值（统一填，非逐个实测）。 */
export const FALLBACK_CONTEXT_WINDOW = 131_072;

/** 兜底条目（id 与展示名相同）。 */
export const FALLBACK_MODELS: readonly ModelEntry[] = FALLBACK.map((id) => ({
  id,
  name: id,
  context_window: FALLBACK_CONTEXT_WINDOW,
  source: "fallback" as const,
}));

let remoteCache: ModelEntry[] | null = null;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    // 本渠道实测是**裸数字**（0.05 / 1.08 / 20）；buddy 那是 `"x0.05"` 字符串形态，
    // 这里也容忍 `x` 前缀，免得同一个字段两种来源两种行为。
    const text = value.trim().replace(/^[xX]/, "");
    const parsed = Number.parseFloat(text);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * 解析 `thinkingConfig`：把产品档位名与 wire 值分开。
 *
 * 缺失 `openclawLevel` 时该档位不进 `efforts_wire`（宁可不认，也不把
 * `level` 当 wire 值发出去 —— 那正是 `max` 会踩的坑）。
 */
function parseThinkingConfig(raw: unknown): {
  efforts?: string[];
  efforts_wire?: Record<string, string>;
  default_effort?: string;
} {
  if (!raw || typeof raw !== "object") return {};
  const cfg = raw as Record<string, unknown>;
  const options = Array.isArray(cfg["options"]) ? cfg["options"] : [];
  const efforts: string[] = [];
  const wire: Record<string, string> = {};
  for (const option of options) {
    if (!option || typeof option !== "object") continue;
    const level = str((option as Record<string, unknown>)["level"]);
    if (!level) continue;
    efforts.push(level);
    const openclaw = str((option as Record<string, unknown>)["openclawLevel"]);
    if (openclaw) wire[level] = openclaw;
  }
  const result: ReturnType<typeof parseThinkingConfig> = {};
  if (efforts.length > 0) result.efforts = efforts;
  if (Object.keys(wire).length > 0) result.efforts_wire = wire;
  const defaultLevel = str(cfg["defaultLevel"]);
  if (defaultLevel) result.default_effort = defaultLevel;
  return result;
}

/**
 * 解析远端模型行。
 *
 * 只取协议列出的字段（`modelId` / `modelName` / `contextWindow` / `maxTokens` /
 * `supportsImage` / `supportsThinking` / `thinkingConfig` / `requestCapabilities` /
 * `description` / `costMultiplier`）；**刻意不取** `provider` / `apiFormat` /
 * `runtimeProfile`（那是 IDE 内部的运行时画像，桥接层用不到）。
 *
 * ⚠️ `costMultiplier` 是**裸数字**（实测 0.05 / 1.08 / 20）——
 * 与 buddy 的字符串 `"x0.05"` 形态不同，这里两种都容忍。
 */
export function parseRemoteModels(rows: readonly unknown[]): ModelEntry[] {
  const seen = new Set<string>();
  const entries: ModelEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = str(rec["modelId"]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const entry: ModelEntry = {
      id,
      name: str(rec["modelName"]) || id,
      // 远端没给窗口时用兜底估计值（列表里恒有窗口，比留 0 更有用）。
      context_window: num(rec["contextWindow"]) ?? FALLBACK_CONTEXT_WINDOW,
      source: "remote",
    };
    const maxOutput = num(rec["maxTokens"]);
    if (maxOutput !== undefined) entry.max_output = maxOutput;
    if (typeof rec["supportsImage"] === "boolean") entry.supports_image = rec["supportsImage"];
    if (typeof rec["supportsThinking"] === "boolean") entry.supports_thinking = rec["supportsThinking"];
    const thinking = parseThinkingConfig(rec["thinkingConfig"]);
    if (thinking.efforts) entry.efforts = thinking.efforts;
    if (thinking.efforts_wire) entry.efforts_wire = thinking.efforts_wire;
    if (thinking.default_effort) entry.default_effort = thinking.default_effort;
    const multiplier = num(rec["costMultiplier"]);
    if (multiplier !== undefined) entry.cost_multiplier = multiplier;
    const description = str(rec["description"]);
    if (description) entry.description = description;
    if (Array.isArray(rec["requestCapabilities"])) {
      entry.capabilities = rec["requestCapabilities"].filter(
        (v): v is string => typeof v === "string",
      );
    }
    entries.push(entry);
  }
  return entries;
}

/** 灌入远端目录（由 upstream.fetchModels 在拉到列表后调用）。 */
export function setRemoteModels(entries: readonly ModelEntry[]): void {
  remoteCache = entries.length > 0 ? [...entries] : null;
}

/** 当前远端缓存；未拉取过时返回 null。 */
export function remoteModels(): ModelEntry[] | null {
  return remoteCache ? [...remoteCache] : null;
}

/** 清空远端缓存（供测试与「刷新目录」用）。 */
export function resetRemoteCache(): void {
  remoteCache = null;
}

/** 当前生效的目录：远端优先，未拉到时用兜底表。 */
export function entries(): ModelEntry[] {
  return remoteCache && remoteCache.length > 0 ? [...remoteCache] : [...FALLBACK_MODELS];
}

/** 按 id 取条目；不存在返回 null（不编造）。 */
export function entryFor(id: string): ModelEntry | null {
  return entries().find((entry) => entry.id === id) ?? null;
}

/** 对外暴露的模型 id（短名；本渠道短名即上游 id）。 */
export function exposedIds(): string[] {
  // 模型池策略：只放行白名单内的家族（见 model-family.ts）
  return entries()
    .filter((entry) => isAllowedFamily(entry.id, entry.name))
    .map((entry) => entry.id);
}

/**
 * 短名 → 上游 slug。
 *
 * LobsterAI 的上游 id 就是短名（没有 buddy 那种 alias 层），故这里是恒等映射；
 * 保留该函数是为了满足契约，并给「兜底表里没有、但远端有」的 id 一个明确通路
 * ——未知名**原样返回**，由上游自己判定。
 */
export function resolveModel(name: string): string {
  return name;
}

/**
 * `reasoning_effort` 的 wire 值换算。
 *
 * 产品档位名可能含 `max`（UI 档位），而服务端只认 `openclawLevel`
 * （`off/minimal/low/medium/high/xhigh`）。优先用该模型的映射表；
 * 没有映射表时只做一处**有实测依据**的兜底：`max` → `xhigh`
 * （远端实测的映射），其余原样返回。
 */
export function reasoningEffortWire(model: string, level: string): string {
  const entry = entryFor(model);
  const mapped = entry?.efforts_wire?.[level];
  if (mapped) return mapped;
  return level === "max" ? "xhigh" : level;
}

/** 详情列表（状态页 / 调试用）。 */
export function details(): Array<Record<string, unknown>> {
  return entries().map((entry) => ({ ...entry }));
}
