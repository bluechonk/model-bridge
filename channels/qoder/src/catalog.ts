/**
 * Qoder 模型目录：**动态拉取**（COSY 签名）+ 静态兜底。
 *
 * ## 对外名 ≠ 上游 key
 *
 * Qoder 的模型 id 是**短 key**（`dfmodel` / `gfmodel`），不是模型名。而公共模型池认的是
 * 归一化后的名字（`deepseek-v4-flash` / `glm-5.3-flash`），所以本模块做一层映射：
 *
 * | 上游 key | 上游展示名 | 对外 id（池内名） |
 * |---|---|---|
 * | `dfmodel` | DeepSeek-Flash（1M 上下文） | `deepseek-v4-flash` |
 * | `gfmodel` | GLM-5.3-Flash | `glm-5.3-flash` |
 *
 * 其余条目（`dmodel` DeepSeek-V4-Pro、`gmodel` GLM-5.3、`qmodel*`、`kmodel*`…）**不进池** ——
 * 池策略是「`(deepseek|glm)` 的 **flash** 型号」，与共享层白名单同一条判据。
 * 它们仍在底层目录里（`details()` 可见），只是不出现在 `/v1/models`。
 *
 * ## 三源优先级（参考实现同款）
 *
 * 1. 动态 `GET /algo/api/v2/model/list?Encode=1`（COSY 签名，`refresh()` 拉）
 * 2. 本机磁盘缓存 `cache/models.json`（上一次拉到的结果，**离线可用**）
 * 3. 内置兜底表（连缓存都没有时）
 *
 * 之所以需要 2：网关启动时可能未登录 / 上游不可达，此时仍要能列出模型，
 * 否则「池子为空」会被误读成渠道坏了。
 */

import { readCatalogCache, writeCatalogCache } from "@model-bridge/gateway";

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

/** 一条模型条目（本渠道内部形态）。 */
export interface ModelEntry {
  /** 上游 key（`x-model-key` / 请求体 `model_config.key` 用它）。 */
  key: string;
  /** 对外 id（池内名）。 */
  id: string;
  displayName: string;
  isReasoning: boolean;
  isVl: boolean;
  maxInputTokens: number;
}

/**
 * 上游 key → 池内 id。
 *
 * 只列**确定能进池**的两条。`dmodel`（DeepSeek-V4-Pro）与 `gmodel`（GLM-5.3）
 * 都是同家族的非 flash 型号，按池策略挡在池外。
 */
const POOL_KEY_MAP: Record<string, string> = {
  dfmodel: "deepseek-v4-flash",
  gfmodel: "glm-5.3-flash",
};

/** 兜底表：连磁盘缓存都没有时用（元数据取自官方目录快照）。 */
const FALLBACK: ModelEntry[] = [
  {
    key: "dfmodel",
    id: "deepseek-v4-flash",
    displayName: "DeepSeek-Flash",
    isReasoning: true,
    isVl: false,
    maxInputTokens: 1_000_000,
  },
  {
    key: "gfmodel",
    id: "glm-5.3-flash",
    displayName: "GLM-5.3-Flash",
    isReasoning: true,
    isVl: false,
    maxInputTokens: 1_000_000,
  },
];

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 官方目录条目 → 内部条目。
 *
 * 只保留 `POOL_KEY_MAP` 里列出的 key：其余模型不进池，留着它们只会让
 * 「池子为什么是空的」更难解释。
 */
function toEntry(raw: Record<string, unknown>): ModelEntry | null {
  const key = str(raw["key"]) || str(raw["id"]);
  const id = POOL_KEY_MAP[key];
  if (!id) return null;
  return {
    key,
    id,
    displayName: str(raw["display_name"]) || str(raw["name"]) || key,
    isReasoning: raw["is_reasoning"] === true,
    isVl: raw["is_vl"] === true,
    maxInputTokens: num(raw["max_input_tokens"], 180_000),
  };
}

/** 读目录：磁盘缓存优先，缓存缺失/为空时退回内置表。 */
export function loadCatalog(): ModelEntry[] {
  try {
    // 缓存条目运行期带着渠道自己的字段（key / display_name…），类型上只保证 `id`
    const cached = readCatalogCache();
    if (cached && cached.length > 0) {
      const mapped = cached
        .map((item) => toEntry(item as unknown as Record<string, unknown>))
        .filter((entry): entry is ModelEntry => entry !== null);
      if (mapped.length > 0) return mapped;
    }
  } catch {
    /* 缓存读不出来就用兜底表 —— 目录不可用不该让整个渠道消失 */
  }
  return [...FALLBACK];
}

/** 对外暴露的模型 id（池内名；去重、保持目录顺序）。 */
export function exposedIds(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of loadCatalog()) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry.id);
  }
  return out;
}

/** 按对外 id 取完整条目（供 upstream 填 `model_config` 元数据）。 */
export function entryOf(name: string): ModelEntry | null {
  const wanted = name.toLowerCase();
  return loadCatalog().find((entry) => entry.id.toLowerCase() === wanted) ?? null;
}

/**
 * 对外 id（或上游 key）→ 上游 key。
 *
 * 三种输入都认：池内名（`deepseek-v4-flash`）、上游 key（`dfmodel`）、
 * 上游展示名（`DeepSeek-Flash`）—— 排查时手写哪种都能通。未命中则原样返回。
 */
export function resolveModel(name: string): string {
  const wanted = name.toLowerCase();
  for (const entry of loadCatalog()) {
    if (entry.id.toLowerCase() === wanted) return entry.key;
    if (entry.key.toLowerCase() === wanted) return entry.key;
    if (entry.displayName.toLowerCase() === wanted) return entry.key;
  }
  return name;
}

/**
 * 强制从上游重拉目录并落盘（CLI 的 `--refresh` 用；失败**抛错**）。
 *
 * 上游返回 `payload.chat[]`，每条以 `key` 为模型 id。落盘走共享的目录缓存
 * （`<root>/qoder/cache/models.json`），**不裁剪字段** —— 以后要放宽池策略时
 * 不必重新拉。
 */
export async function refresh(): Promise<void> {
  const credential = cred.load();
  const payload = await upstream.fetchModels(credential);
  const chat = Array.isArray(payload["chat"]) ? (payload["chat"] as unknown[]) : [];
  const entries = chat
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => {
      const key = str(item["key"]);
      return { ...item, id: key };
    })
    .filter((item) => str(item["id"]) !== "");
  if (entries.length === 0) throw new Error("上游模型列表为空");
  writeCatalogCache(entries);
}
