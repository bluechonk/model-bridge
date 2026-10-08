/**
 * Gemini Code Assist 额度：配额窗口查询（**不是积分**，PROTOCOL §6）。
 *
 * 端点 `POST {sandbox}/v1internal:retrieveUserQuotaSummary`，
 * 头与推理请求**完全一致**（含五个伪装头）。
 *
 * ## 实测要点
 *
 * - ⚠ **请求体必须带 `project`**（字段名是 `project`，不是 `cloudaicompanionProject`）——
 *   值取凭据里的 `cloudaicompanionProject`，缺失退到 `aicode-consumers`。
 *   原版发空对象 `{}` 是单账号抓包的结论；第二个账号用 `{}` 会被
 *   403 `SUBSCRIPTION_REQUIRED`，带上 project 就 200。
 * - 响应形状是普通 JSON：`{groups:[{displayName,buckets:[{bucketId,window,resetTime,
 *   remainingFraction}]}]}`。
 * - ⚠ **按 `bucketId` 匹配**（`gemini-5h` / `gemini-weekly`），不按 displayName/window。
 * - ⚠ `resetTime` 解析失败 ⇒ 整条桶丢弃。
 * - ⚠ 两个桶都没认出来 ⇒ **抛错**（真失败），**不伪造 100%**。
 * - 展示：单位 `%`，`total` 取两窗口剩余百分比的**平均**（取 min 会误导）。
 * - 缓存 60 秒，键用 `access_token`。
 * - 档位（`loadCodeAssist`）搭这趟车**并行发**；档位失败**绝不污染**配额结果。
 *
 * ⚠ 「查不到」不能显示成 0：失败一律抛 `CreditsError`。
 * ⚠ 未登录抛 `cred.NotLoggedInError`。
 */

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

/** 配额窗口桶 id（逐字常量，§6.2 按 bucketId 匹配）。 */
export const GEMINI_BUCKET_FIVE_HOUR = "gemini-5h";
export const GEMINI_BUCKET_WEEKLY = "gemini-weekly";

/** 配额缓存 TTL（§1.2 / §6.2）。 */
export const QUOTA_CACHE_TTL_MS = 60_000;

/** 额度查询失败（上游拒绝 / 网络错误 / 响应形状无法解析 / 桶都认不出）。 */
export class CreditsError extends Error {
  override name = "CreditsError";
}

export interface CreditPackage {
  name: string;
  remain: number;
  size: number;
  used: number;
  unit: string;
  days_left: number | null;
  /** 上游窗口标识（`5h` / `weekly`）。 */
  window: string;
  /** 桶重置时刻（RFC3339）；无法解析的桶已被丢弃，故这里一定有值。 */
  reset_time: string;
  [key: string]: unknown;
}

export interface CreditsResult {
  ok: true;
  total: {
    remain: number;
    size: number;
    used: number;
    unit: string;
    remain_percent: number;
  };
  packages: CreditPackage[];
  /** 账号档位短标签（Ultra / Pro / Free）；探测失败为空串（**不污染**配额）。 */
  tier: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function numOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 一个已识别的配额桶（resetTime 已成功解析）。 */
export interface QuotaBucket {
  bucketId: string;
  window: string;
  resetTime: string;
  /** 剩余比例（0..1）。 */
  remainingFraction: number;
}

/**
 * 从配额响应里识别两个桶。
 *
 * ⚠ 按 `bucketId` 匹配；`resetTime` 解析失败 ⇒ 整条桶丢弃；识别不到的桶不出现。
 */
export function parseQuotaBuckets(payload: unknown): QuotaBucket[] {
  // 兼容裸响应与 `{response: {...}}` 信封
  const root = isRecord(payload) && isRecord((payload as Record<string, unknown>)["response"])
    ? ((payload as Record<string, unknown>)["response"] as Record<string, unknown>)
    : payload;
  if (!isRecord(root)) return [];
  const groups = root["groups"];
  if (!Array.isArray(groups)) return [];

  const wanted = new Set([GEMINI_BUCKET_FIVE_HOUR, GEMINI_BUCKET_WEEKLY]);
  const found: QuotaBucket[] = [];
  for (const group of groups) {
    if (!isRecord(group)) continue;
    const buckets = group["buckets"];
    if (!Array.isArray(buckets)) continue;
    for (const bucket of buckets) {
      if (!isRecord(bucket)) continue;
      const bucketId = str(bucket["bucketId"]);
      if (!wanted.has(bucketId)) continue; // 按 bucketId 匹配（第三组 3p-* 与本 provider 无关）
      const resetTime = str(bucket["resetTime"]);
      if (!resetTime || !Number.isFinite(Date.parse(resetTime))) continue; // 解析失败 ⇒ 整条桶丢弃
      const fraction = numOrNull(bucket["remainingFraction"]);
      if (fraction === null) continue;
      found.push({
        bucketId,
        window: str(bucket["window"]),
        resetTime,
        remainingFraction: Math.max(0, Math.min(1, fraction)),
      });
    }
  }
  return found;
}

/** 缓存：键用 access_token（token 轮换即失效）。 */
let cache: { key: string; result: CreditsResult; at: number } | null = null;

/** 仅供测试：清空配额缓存。 */
export function clearCache(): void {
  cache = null;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = upstream.PROBE_TIMEOUT_MS,
): Promise<{ status: number; payload: unknown }> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new CreditsError(`配额请求失败: ${String(err)}`);
  }
  let payload: unknown = null;
  try {
    payload = await resp.json();
  } catch {
    payload = null;
  }
  return { status: resp.status, payload };
}

/** 探测账号档位（best-effort）：任何失败返回空串，**绝不污染配额结果**。 */
async function probeTier(c: cred.Credentials): Promise<string> {
  try {
    const info = await upstream.fetchModels(c);
    return str(info["tier"]);
  } catch {
    return "";
  }
}

/**
 * 查询账号配额窗口。
 *
 * @param options.refreshOn401 配额端点 401/403 时先续期一次再重试。
 */
export async function fetchCredits(
  options: { refreshOn401?: boolean } = {},
): Promise<CreditsResult> {
  const { refreshOn401 = true } = options;
  let c = cred.load(); // 未登录抛 NotLoggedInError

  const hit = cache;
  if (hit && hit.key === c.accessToken && Date.now() - hit.at < QUOTA_CACHE_TTL_MS) {
    return hit.result;
  }

  const project = c.cloudaicompanionProject || upstream.GEMINI_DEFAULT_PROJECT;

  const query = async (current: cred.Credentials): Promise<{ status: number; payload: unknown }> =>
    postJson(upstream.quotaUrl(), upstream.buildHeaders(current), { project });

  let response: { status: number; payload: unknown };
  try {
    response = await query(c);
    if ((response.status === 401 || response.status === 403) && refreshOn401) {
      c = await cred.refresh(c); // 失效会抛，交由调用方提示重新登录
      response = await query(c);
    }
  } catch (err) {
    if (err instanceof CreditsError || err instanceof cred.NotLoggedInError) throw err;
    throw new CreditsError(String(err));
  }

  if (response.status === 401 || response.status === 403) {
    throw new cred.NotLoggedInError("配额端点拒绝了访问令牌（401/403）");
  }
  if (response.status !== 200) {
    // 透出上游 reason（§6.4：否则面板只会误导人去重新登录）
    throw new CreditsError(
      `配额端点返回 HTTP ${response.status}${describeUpstreamError(response.payload)}`,
    );
  }

  const buckets = parseQuotaBuckets(response.payload);
  if (buckets.length === 0) {
    throw new CreditsError(
      "配额响应里认不出 " +
        `${GEMINI_BUCKET_FIVE_HOUR} / ${GEMINI_BUCKET_WEEKLY} 桶（按 bucketId 匹配；不伪造 100%）`,
    );
  }

  // 展示：单位 %，total 取两窗口剩余百分比的**平均**
  const percents = buckets.map((b) => Math.round(b.remainingFraction * 1000) / 10);
  const averagePercent = percents.reduce((sum, p) => sum + p, 0) / percents.length;

  const packages: CreditPackage[] = buckets.map((b) => {
    const percent = Math.round(b.remainingFraction * 1000) / 10;
    return {
      name: b.bucketId,
      remain: percent,
      size: 100,
      used: Math.round((100 - percent) * 10) / 10,
      unit: "%",
      days_left: null,
      window: b.window,
      reset_time: b.resetTime,
    };
  });

  const result: CreditsResult = {
    ok: true,
    total: {
      remain: Math.round(averagePercent * 10) / 10,
      size: 100,
      used: Math.round((100 - averagePercent) * 10) / 10,
      unit: "%",
      remain_percent: Math.round(averagePercent * 10) / 10,
    },
    packages,
    tier: await probeTier(c),
  };

  cache = { key: c.accessToken, result, at: Date.now() };
  return result;
}

/** 从上游错误体挖出 `reason`（§6.4：必须透出，否则误导人去重新登录）。 */
function describeUpstreamError(payload: unknown): string {
  if (!isRecord(payload)) return "";
  const error = isRecord((payload as Record<string, unknown>)["error"])
    ? ((payload as Record<string, unknown>)["error"] as Record<string, unknown>)
    : null;
  if (!error) return "";
  const status = str(error["status"]);
  const details = error["details"];
  let reason = "";
  if (Array.isArray(details)) {
    for (const item of details) {
      if (isRecord(item) && str(item["reason"])) {
        reason = str(item["reason"]);
        break;
      }
    }
  }
  const parts = [status, reason].filter(Boolean);
  return parts.length > 0 ? `（${parts.join(" ")}）` : "";
}

// ── 签到 / 领取能力（共享层 CLI 的 `<cid> checkin` 用；契约要求**每个渠道都提供**）──────

import type { SigninModule } from "@model-bridge/gateway";
/**
 * 签到 / 领取能力（`<cid> checkin`）。
 *
 * **Gemini Code Assist 没有签到端点** —— 额度随订阅发放，上游没有签到 / 领取接口
 *
 * 按契约仍要提供这个能力（共享层对**所有**渠道一视同仁，不做能力探测），
 * 所以这里不假装有端点、也不当成错误：`status()` 只说"没有可领的"，
 * `claim()` 原样回同一句说明。用户看到的就是这句。
 */
const NO_ENDPOINT = "Gemini Code Assist 没有签到端点 —— 额度随订阅发放，上游没有签到 / 领取接口";

export const signin: SigninModule = {
  async status() {
    return { claimable: false, summary: NO_ENDPOINT };
  },
  async claim() {
    return { ok: true, summary: NO_ENDPOINT };
  },
};
