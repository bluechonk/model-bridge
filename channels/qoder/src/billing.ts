/**
 * Qoder 额度与签到（只读 + 一个写动作，均直连上游，不经本地网关）。
 *
 * ## 为什么用另一套头
 *
 * `/sash/**`（余额、活动）走的是**桌面客户端身份**，不是推理那套 COSY 签名：
 * `Authorization: Bearer <access_token>` + `Cosy-ClientType: 10` + 一对机器头。
 * ⚠ `Cosy-ClientType` 的 10（桌面）与推理信封里的 `client_type=5`（CLI）**不可混用** ——
 * 用 5 去查活动，服务端返回**空列表**（不是报错，所以更容易误判成"没有活动"）。
 * 机器头缺一个也不行：必须 `Cosy-MachineToken` 与 `Cosy-MachineType` **成对**出现。
 *
 * ## 余额不只在 userQuota
 *
 * 实测 `userQuota.remaining = 0` 而 `addOnQuota.remaining = 100` 是常态，所以两者要合并。
 * `displayMode === "enterprise"` 时上游不给额度数字（返回 null）——那不算错误。
 *
 * ## 活动的"今天"怎么算
 *
 * 活动每日 **10:00（UTC+8）刷新**：刷新前看到的 `CLAIMED` 属于**昨天**，
 * 不能就此报「今天已领」。
 */

import type { SigninModule, SigninOutcome, SigninStatus } from "@model-bridge/gateway";

import * as cred from "./cred.js";

export class CreditsError extends Error {
  override name = "CreditsError";
}

export interface CreditPackage {
  name: string;
  remain: number;
  size: number;
  used?: number;
  unit?: string;
  days_left?: number | null;
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
  claimable?: Array<Record<string, unknown>>;
}

const USAGE_PATH = "/sash/api/v2/me/usage";
const CAMPAIGNS_PATH = "/sash/api/v1/me/campaigns";

/** 活动每日刷新时刻（UTC+8 的 10:00）。 */
const CAMPAIGN_REFRESH_HOUR_UTC8 = 10;

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `/sash/**` 的请求头：桌面身份 + 成对机器头。 */
function sashHeaders(credential: cred.Credentials): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${credential.accessToken}`,
    "Cosy-ClientType": "10", // 桌面 App 身份（用 5 会拿到空活动列表）
    "Cosy-MachineToken": cred.machineTokenOf(credential.uid),
    "Cosy-MachineType": cred.machineTypeOf(credential.uid),
    "User-Agent": cred.productOf(credential.realm).userAgent,
  };
}

async function sashGet(
  credential: cred.Credentials,
  path: string,
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
  const base = cred.productOf(credential.realm).openapi;
  const resp = await fetch(`${base}${path}`, {
    headers: sashHeaders(credential),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new CreditsError("Credential rejected, please log in again");
  }
  if (resp.status === 404) throw new CreditsError(`Upstream has no such endpoint (HTTP 404): ${path}`);
  if (!resp.ok) throw new CreditsError(`Upstream returned HTTP ${resp.status}`);
  return (await resp.json()) as Record<string, unknown>;
}

/** UTC+8 的当前时刻。 */
function utc8Now(now = Date.now()): Date {
  return new Date(now + 8 * 3600_000);
}

/**
 * 该活动的"今天"是否已领过。
 *
 * 活动每天 10:00（UTC+8）刷新：若当前时刻**还没到今天 10 点**，那看到的 CLAIMED
 * 属于昨天，不能算今天已领。
 */
function claimedToday(campaign: Record<string, unknown>, now = Date.now()): boolean {
  if (str(campaign["claimStatus"]) !== "CLAIMED") return false;
  const claimedAt = str(campaign["claimedAt"]);
  if (!claimedAt) return true; // 上游没给时刻，只能按状态算
  const at = Date.parse(claimedAt.includes(" ") ? claimedAt.replace(" ", "T") : claimedAt);
  if (!Number.isFinite(at)) return true;
  const nowU8 = utc8Now(now);
  const atU8 = utc8Now(at);
  // 同一个"活动日"的起点是各自的 10:00
  const dayStart = (d: Date): number => {
    const base = new Date(d.getTime());
    if (base.getUTCHours() < CAMPAIGN_REFRESH_HOUR_UTC8) base.setUTCDate(base.getUTCDate() - 1);
    base.setUTCHours(CAMPAIGN_REFRESH_HOUR_UTC8, 0, 0, 0);
    return base.getTime();
  };
  return dayStart(nowU8) <= dayStart(atU8) && dayStart(nowU8) === dayStart(atU8);
}

interface QuotaLike {
  total?: unknown;
  used?: unknown;
  remaining?: unknown;
  unit?: unknown;
}

/** 把 userQuota + addOnQuota + 专用资源包合并成一份总账。 */
function summarize(usage: Record<string, unknown>): { total: CreditsResult["total"]; packages: CreditPackage[] } {
  const qoderUsage =
    usage["qoderUsage"] && typeof usage["qoderUsage"] === "object"
      ? (usage["qoderUsage"] as Record<string, unknown>)
      : {};
  const packages: CreditPackage[] = [];
  let remain = 0;
  let size = 0;
  let unit = "";

  const collect = (label: string, quota: QuotaLike | undefined): void => {
    if (!quota || typeof quota !== "object") return;
    const total = num(quota.total);
    const used = num(quota.used);
    const left = num(quota.remaining);
    if (total === 0 && left === 0 && used === 0) return;
    remain += left;
    size += total || left + used;
    unit = unit || str(quota.unit);
    packages.push({ name: label, remain: left, size: total || left + used, used, unit: str(quota.unit) });
  };

  collect("用户额度", qoderUsage["userQuota"] as QuotaLike | undefined);
  collect("加油包", qoderUsage["addOnQuota"] as QuotaLike | undefined);

  const dedicated = Array.isArray(qoderUsage["dedicatedResourcePackages"])
    ? (qoderUsage["dedicatedResourcePackages"] as unknown[])
    : [];
  for (const pack of dedicated) {
    if (!pack || typeof pack !== "object") continue;
    const rec = pack as Record<string, unknown>;
    collect(str(rec["name"]) || "专用资源包", rec as QuotaLike);
  }

  const used = Math.max(0, size - remain);
  return {
    total: {
      remain,
      size,
      used,
      unit,
      remain_percent: size > 0 ? Math.round((remain / size) * 1000) / 10 : 0,
    },
    packages,
  };
}

/** 查余额 + 可领活动。 */
export async function fetchCredits(options: { refreshOn401?: boolean } = {}): Promise<CreditsResult> {
  let credential: cred.Credentials;
  try {
    credential = cred.load();
  } catch (err) {
    throw new CreditsError(String(err));
  }

  const usage = await sashGet(credential, USAGE_PATH).catch((err: unknown) => {
    if (options.refreshOn401 && err instanceof CreditsError && String(err).includes("log in again")) {
      throw err;
    }
    throw err instanceof CreditsError ? err : new CreditsError(String(err));
  });

  const { total, packages } = summarize(usage);
  const claimable = await listClaimable(credential).catch(() => []);
  // 查不到额度（enterprise 模式 / 上游不给数字）**不能显示成 0** —— 那是"不知道"
  if (total.size === 0 && total.remain === 0 && packages.length === 0) {
    throw new CreditsError("Upstream returned no usable quota numbers (enterprise mode or API change)");
  }
  return { ok: true, total, packages, ...(claimable.length > 0 ? { claimable } : {}) };
}

/** 取可领的活动（`actionType=CLAIM_BENEFIT` 且状态 `CLAIMABLE`）。 */
async function listClaimable(credential: cred.Credentials): Promise<Array<Record<string, unknown>>> {
  const payload = await sashGet(credential, CAMPAIGNS_PATH);
  const campaigns = Array.isArray(payload["campaigns"]) ? (payload["campaigns"] as unknown[]) : [];
  return campaigns.filter((item): item is Record<string, unknown> => {
    if (!item || typeof item !== "object") return false;
    const rec = item as Record<string, unknown>;
    return str(rec["actionType"]) === "CLAIM_BENEFIT" && str(rec["claimStatus"]) === "CLAIMABLE";
  });
}

/** 领取一个活动（幂等：重复领取上游返回 `replayed: true`）。 */
async function claimCampaign(
  credential: cred.Credentials,
  campaignId: string,
): Promise<Record<string, unknown>> {
  const base = cred.productOf(credential.realm).openapi;
  const resp = await fetch(`${base}${CAMPAIGNS_PATH}/${encodeURIComponent(campaignId)}/claim`, {
    method: "POST",
    // ⚠ body 必须是**空串**（不是 `{}`）—— 官方如此，实测参考实现
    body: "",
    headers: { ...sashHeaders(credential), "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new CreditsError(`Claim failed: HTTP ${resp.status}`);
  return (await resp.json()) as Record<string, unknown>;
}

/**
 * 签到 / 领取能力：Qoder 把它叫「每日领取 100 Credits」，走活动（campaign）平台。
 *
 * 只有 `actionType === "CLAIM_BENEFIT"` 且 `claimStatus === "CLAIMABLE"` 的才算可领；
 * `VIEW_DETAILS` 是"看看详情"，领它会报错。
 */
export const signin: SigninModule = {
  async status(): Promise<SigninStatus> {
    let credential: cred.Credentials;
    try {
      credential = cred.load();
    } catch (err) {
      return { claimable: null, summary: `未登录：${String(err)}`, claimedToday: null, daily: true };
    }
    try {
      const payload = await sashGet(credential, CAMPAIGNS_PATH);
      const campaigns = Array.isArray(payload["campaigns"])
        ? (payload["campaigns"] as unknown[])
        : [];
      const claimable = campaigns.filter((item): item is Record<string, unknown> => {
        if (!item || typeof item !== "object") return false;
        const rec = item as Record<string, unknown>;
        return str(rec["actionType"]) === "CLAIM_BENEFIT" && str(rec["claimStatus"]) === "CLAIMABLE";
      });
      if (claimable.length > 0) {
        const amount = num((claimable[0]!["benefit"] as Record<string, unknown> | undefined)?.["amount"]);
        return {
          claimable: true,
          summary: amount > 0 ? `今日可领 ${amount} Credits` : "今日有可领奖励",
          items: claimable,
          claimedToday: false,
          daily: true,
        };
      }
      // ⚠ 没有可领的**不等于**"今天已领"：该账号此刻可能压根没有每日签到活动
      // （实测国际版只有一条 `VIEW_DETAILS` 的 Pro 推广），报"未签到"会让人
      // 以为"还能签"。这里用上游顶层的 `claimable` 作权威判据。
      const topClaimable = payload["claimable"] === true;
      const claimed = campaigns.filter((item): item is Record<string, unknown> => {
        if (!item || typeof item !== "object") return false;
        const rec = item as Record<string, unknown>;
        return str(rec["actionType"]) === "CLAIM_BENEFIT" && str(rec["claimStatus"]) === "CLAIMED";
      });
      const done = claimed.some((item) => claimedToday(item));
      return {
        claimable: topClaimable,
        summary: done
          ? "今天已领"
          : "上游今天没有可领的奖励（当前没有可领取的签到活动）",
        // ⚠ 没有活动时是「不适用」而不是「未签」—— 返回 null 才会让 CLI 显示上面
        // 那句渠道自己的说明，而不是通用模板「今天未签到（依据：上游）」
        claimedToday: done ? true : null,
        daily: true,
      };
    } catch (err) {
      // 查不到 ≠ 没有：如实回报"不知道"，别让用户以为没得领
      return { claimable: null, summary: `查不到活动状态：${String(err)}`, claimedToday: null, daily: true };
    }
  },

  async claim(): Promise<SigninOutcome> {
    const credential = cred.load();
    const payload = await sashGet(credential, CAMPAIGNS_PATH);
    // 上游顶层的 `claimable` 是权威判据：为 false 就根本没东西可领，不必再翻活动列表
    if (payload["claimable"] !== true) {
      return { ok: true, summary: "上游今天没有可领的奖励" };
    }
    const campaigns = Array.isArray(payload["campaigns"])
      ? (payload["campaigns"] as unknown[])
      : [];
    const claimable = campaigns.filter((item): item is Record<string, unknown> => {
      if (!item || typeof item !== "object") return false;
      const rec = item as Record<string, unknown>;
      return str(rec["actionType"]) === "CLAIM_BENEFIT" && str(rec["claimStatus"]) === "CLAIMABLE";
    });
    if (claimable.length === 0) {
      return { ok: true, summary: "上游标记有可领奖励，但没有可领取的签到活动" };
    }
    const summaries: string[] = [];
    let claimed = 0;
    for (const campaign of claimable) {
      const id = str(campaign["campaignId"]);
      if (!id) continue;
      const result = await claimCampaign(credential, id);
      const amount = num((result["benefit"] as Record<string, unknown> | undefined)?.["amount"]);
      const replayed = result["replayed"] === true;
      if (!replayed) claimed += 1;
      summaries.push(`${amount > 0 ? `+${amount} Credits` : "已领取"}${replayed ? "（重复领取，未重复发放）" : ""}`);
    }
    return {
      ok: true,
      summary: claimed > 0 ? `领取成功：${summaries.join("；")}` : `没有新的可领奖励：${summaries.join("；")}`,
      detail: { claimed },
    };
  },
};
