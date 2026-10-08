/**
 * Cline 额度：**两个不同的额度概念**（PROTOCOL §6）。
 *
 * 1. **余额**（还剩多少钱）：`GET /api/v1/users/{userId}/balance`
 *    ⚠ `userId` **必须用凭据里的 `account_id`（`usr-…`）**，
 *    **不是** JWT 的 `sub`（`user_…`）—— 实测传 `sub` 回
 *    `400 {"error":"Invalid request format"}`，两者形态完全不同、极易混用。
 * 2. **订阅额度窗口**：`GET /api/v1/users/me/plan/usage-limits`
 *    ⚠ 用**字面量 `users/me`**，由网关按 Bearer 令牌判定账号，
 *    **不依赖凭据里的 `account_id``；`resetsAt` 是带纳秒精度的 ISO 字符串
 *    （**不要按毫秒解析**），用量为 0 的窗口 `resetsAt` 是空串。
 *
 * **签到不存在**（对整个 sidecar 做字符串扫描，`checkin` / `check-in` / `daily`
 * / `campaign` 无任何 Cline 业务端点命中），故 `claimable` 恒为空数组。
 *
 * ⚠ **「查不到」不能显示成 0**：失败抛 `CreditsError`，而不是返回 `remain: 0`。
 */

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

/**
 * 余额换算系数：`balance: 500000` ÷ `100_000` = **$5.00**。
 *
 * ⚠ **这是全模块唯一的不确定点：没有源码证据**（PROTOCOL §6.1）。
 * ⚠ 不要用 `/usages` 的 `costUsd` 反推本系数 —— 两个字段口径不同，不可互推。
 */
export const CLINE_BALANCE_SCALE = 100_000;

const BALANCE_TIMEOUT_MS = 30_000;
/** 窗口端点的路径用**字面量 users/me**，不是 accountId。 */
const USAGE_LIMITS_PATH = "/api/v1/users/me/plan/usage-limits";

/** 额度查询失败（未登录 / 上游拒绝 / 形状不对）。 */
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
  [key: string]: unknown;
}

export interface UsageLimit {
  type: string;
  /** ⚠ **不做夹取**：网关若给 120（超额）如实透传。 */
  percent_used: number;
  /** ⚠ 原样上报：带纳秒的 ISO 字符串 / 空串 / 未来的数字时间戳都不猜单位。 */
  resets_at: string;
}

export interface UsageLimitsResult {
  ok: boolean;
  limits: UsageLimit[];
  error?: string;
}

export interface CreditsResult {
  ok: true;
  account: { uid: string; account_id: string };
  total: {
    remain: number;
    size: number;
    used: number;
    unit: string;
    remain_percent: number;
    /** 上游只给余额时 size 是回填值（= remain），用本字段显式标记。 */
    size_known: boolean;
  };
  packages: CreditPackage[];
  usage_limits: UsageLimitsResult;
  claimable: Array<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 余额端点 URL（accountId 是凭据里的 `usr-…`）。 */
export function balanceUrl(cfg: upstream.Config, accountId: string): string {
  return `${cfg.baseUrl.replace(/\/+$/, "")}/api/v1/users/${encodeURIComponent(accountId)}/balance`;
}

/** 订阅额度窗口端点 URL（**字面量 users/me**）。 */
export function usageLimitsUrl(cfg: upstream.Config): string {
  return `${cfg.baseUrl.replace(/\/+$/, "")}${USAGE_LIMITS_PATH}`;
}

/** 查余额（只读），返回换算成 USD 的数值。 */
export async function fetchBalance(c: cred.Credentials, cfg: upstream.Config): Promise<number> {
  let resp: Response;
  try {
    resp = await fetch(balanceUrl(cfg, c.accountId), {
      headers: upstream.buildHeaders(c, { chat: false }),
      signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CreditsError(`余额请求失败: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new cred.NotLoggedInError("余额端点拒绝了访问令牌（HTTP 401/403）");
  }
  if (resp.status === 400) {
    // 实测：传 JWT 的 sub（user_…）而非 account_id（usr-…）就是这个症状
    throw new CreditsError(
      "余额查询返回 400 Invalid request format：userId 传错了 —— " +
        "必须用凭据里的 account_id（usr-…），不是 JWT 的 sub（user_…）",
    );
  }
  if (resp.status !== 200) throw new CreditsError(`余额端点返回 HTTP ${resp.status}`);

  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (err) {
    throw new CreditsError(`余额响应不是合法 JSON: ${String(err)}`);
  }
  if (!isRecord(payload)) throw new CreditsError("余额响应不是 JSON 对象");
  // 失败形态①：业务层失败（HTTP 200 + {success:false,error}）
  if (payload["success"] === false) {
    throw new CreditsError(`余额查询失败: ${String(payload["error"] ?? "未知原因")}`);
  }
  const data = isRecord(payload["data"]) ? payload["data"] : {};
  const balance = num(data["balance"]);
  if (balance === null) throw new CreditsError("余额响应里没有 balance 字段（形状不对，不显示成 0）");
  return balance / CLINE_BALANCE_SCALE;
}

/**
 * 查订阅额度窗口。
 *
 * ⚠ 失败一律「作为数据上报」（`ok:false` + `error`），**不抛错** ——
 * 窗口查询失败不该让整个额度面板崩掉。
 */
export async function fetchUsageLimits(
  c: cred.Credentials,
  cfg: upstream.Config,
): Promise<UsageLimitsResult> {
  let resp: Response;
  try {
    resp = await fetch(usageLimitsUrl(cfg), {
      headers: upstream.buildHeaders(c, { chat: false }),
      signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, limits: [], error: `窗口请求失败: ${String(err)}` };
  }
  if (resp.status !== 200) {
    return { ok: false, limits: [], error: `窗口端点返回 HTTP ${resp.status}` };
  }
  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (err) {
    return { ok: false, limits: [], error: `窗口响应不是合法 JSON: ${String(err)}` };
  }
  if (!isRecord(payload) || payload["success"] === false) {
    const reason = isRecord(payload) ? String(payload["error"] ?? "未知原因") : "响应不是对象";
    return { ok: false, limits: [], error: `窗口查询失败: ${reason}` };
  }
  const data = isRecord(payload["data"]) ? payload["data"] : {};
  const raw = data["limits"];
  const limits: UsageLimit[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item)) continue;
      const percent = num(item["percentUsed"]);
      limits.push({
        type: String(item["type"] ?? ""),
        percent_used: percent ?? 0, // ⚠ 不夹取（120 如实透传）
        // ⚠ 原样上报（纳秒 ISO 字符串 / 空串），不按毫秒解析
        resets_at: typeof item["resetsAt"] === "string" ? item["resetsAt"] : String(item["resetsAt"] ?? ""),
      });
    }
  }
  return { ok: true, limits };
}

/**
 * 查询账号额度（余额 + 窗口）。
 *
 * 401/403 时（默认）刷新一次令牌再试；仍失败抛 `CreditsError` / `NotLoggedInError`。
 * 未登录抛 `cred.NotLoggedInError`（CLI 据此提示运行 `cline login`）。
 */
export async function fetchCredits(
  options: { refreshOn401?: boolean } = {},
): Promise<CreditsResult> {
  const { refreshOn401 = true } = options;
  let c = cred.load(); // 未登录 → NotLoggedInError

  if (!c.accountId) {
    // 缺 account_id 时不瞎猜（既不用 JWT 的 sub，也不返回 0）
    throw new CreditsError(
      "凭据里没有 account_id，无法查询余额（余额端点需要 usr-… 形态的账号 id）",
    );
  }

  const cfg = upstream.loadConfig()[0];

  let remainUsd: number;
  try {
    remainUsd = await fetchBalance(c, cfg);
  } catch (err) {
    if (!(err instanceof cred.NotLoggedInError) || !refreshOn401) throw err;
    c = await cred.refresh(c); // 失败会抛，交由调用方提示重新登录
    remainUsd = await fetchBalance(c, cfg);
  }

  const usageLimits = await fetchUsageLimits(c, cfg);

  const unit = "USD";
  // 上游只给「剩余」：总量是回填值（= remain），用 size_known 显式标记，不编造 used
  const size = remainUsd;
  const used = 0;
  const percent = size > 0 ? (remainUsd / size) * 100 : 0;

  return {
    ok: true,
    account: { uid: c.uid, account_id: c.accountId },
    total: {
      remain: round2(remainUsd),
      size: round2(size),
      used: round2(used),
      unit,
      remain_percent: Math.round(percent * 10) / 10,
      size_known: false,
    },
    packages: [
      {
        name: "余额",
        remain: round2(remainUsd),
        size: round2(size),
        used: round2(used),
        unit,
        // 余额没有到期日概念 → 不编造天数
        days_left: null,
      },
    ],
    usage_limits: usageLimits,
    // Cline 没有签到端点（不存在）→ 恒空
    claimable: [],
  };
}

// ── 签到 / 领取能力（共享层 CLI 的 `<cid> checkin` 用；契约要求**每个渠道都提供**）──────

import type { SigninModule } from "@model-bridge/gateway";
/**
 * 签到 / 领取能力（`<cid> checkin`）。
 *
 * **Cline 没有签到端点** —— 对整个 sidecar 做过字符串扫描（checkin / check-in / daily / campaign 均无命中）；每日免费额度由服务端自动发放
 *
 * 按契约仍要提供这个能力（共享层对**所有**渠道一视同仁，不做能力探测），
 * 所以这里不假装有端点、也不当成错误：`status()` 只说"没有可领的"，
 * `claim()` 原样回同一句说明。用户看到的就是这句。
 */
const NO_ENDPOINT = "Cline 没有签到端点 —— 对整个 sidecar 做过字符串扫描（checkin / check-in / daily / campaign 均无命中）；每日免费额度由服务端自动发放";

export const signin: SigninModule = {
  async status() {
    return { claimable: false, summary: NO_ENDPOINT };
  },
  async claim() {
    return { ok: true, summary: NO_ENDPOINT };
  },
};
