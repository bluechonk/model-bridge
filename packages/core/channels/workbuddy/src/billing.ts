/**
 * 上游计费：查询 WorkBuddy 国内版账号的剩余额度（credits）。
 *
 * 走上游 billing 端点（**不是**本地网关 —— 网关只代理 chat），只读，不做任何写入。
 * 端点：`POST /v2/billing/meter/get-user-resource`。
 */

import { randomUUID } from "node:crypto";

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

const RESOURCE_PATH = "/v2/billing/meter/get-user-resource";
/** Tencent Cloud AI Code Assistant（CodeBuddy/WorkBuddy）。 */
const PRODUCT_CODE = "p_tcaca";
const HTTP_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 200;

/** 额度查询失败（未登录 / 上游拒绝 / 网络错误）。 */
export class CreditsError extends Error {
  override name = "CreditsError";
}

/** 一个套餐包的额度明细。 */
export interface CreditPackage {
  name: string;
  product: string;
  remain: number;
  size: number;
  used: number;
  unit: string;
  cycle_start: string;
  cycle_end: string;
  days_left: number | null;
  in_usage: boolean;
}

export interface CreditsResult {
  ok: true;
  account: { uid: string; domain: string };
  total: {
    remain: number;
    size: number;
    used: number;
    remain_percent: number;
    unit: string;
  };
  packages: CreditPackage[];
}

function headers(c: cred.Credentials, baseUrl: string): Record<string, string> {
  const host = upstream.hostOf(baseUrl);
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": "WorkBuddy/5.5.6",
    Origin: baseUrl.replace(/\/+$/, ""),
    Referer: `${baseUrl.replace(/\/+$/, "")}/`,
    Authorization: `Bearer ${c.accessToken}`,
    "X-User-Id": c.uid,
    "X-Domain": host,
    "X-CodeBuddy-Request": "1",
    "X-Request-ID": randomUUID(),
    "X-No-Enterprise-Id": "1",
    "X-Product": "SaaS",
  };
}

/** 宽容取数：先精确字段后粗略字段，都取不到返回 0。 */
function num(account: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = account[key];
    if (value === null || value === undefined || value === "") continue;
    const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** 到期天数；无法解析返回 null（不编造数字）。 */
function daysLeft(end: string): number | null {
  if (!end) return null;
  const trimmed = end.trim();
  // 上游用 `YYYY-MM-DD HH:MM:SS` 或 `YYYY-MM-DD`
  const parsed = Date.parse(trimmed.includes(" ") ? trimmed.replace(" ", "T") : trimmed);
  if (!Number.isFinite(parsed)) return null;
  const oneDay = 86_400_000;
  return Math.floor((parsed - Date.now()) / oneDay);
}

async function fetchAccounts(c: cred.Credentials, baseUrl: string): Promise<Record<string, unknown>[]> {
  const now = new Date();
  const fmt = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ");
  const body = JSON.stringify({
    PageNumber: 1,
    PageSize: PAGE_SIZE,
    ProductCode: PRODUCT_CODE,
    Status: [0, 3],
    PackageEndTimeRangeBegin: fmt(now),
    PackageEndTimeRangeEnd: "2036-01-01 00:00:00",
  });

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl.replace(/\/+$/, "")}${RESOURCE_PATH}`, {
      method: "POST",
      body,
      headers: headers(c, baseUrl),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CreditsError(`billing request failed: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new cred.NotLoggedInError("billing endpoint rejected the access token (401/403)");
  }
  if (resp.status !== 200) throw new CreditsError(`billing endpoint returned HTTP ${resp.status}`);

  let env: Record<string, unknown>;
  try {
    env = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    throw new CreditsError(`billing response is not valid JSON: ${String(err)}`);
  }
  if (env["code"] !== 0) {
    throw new CreditsError(`billing returned code=${String(env["code"])} msg=${String(env["msg"] ?? "")}`);
  }
  // 信封：data.Response.Data.Accounts（三层，任一层缺失都按空处理）
  const data = env["data"];
  const response = data && typeof data === "object" ? (data as Record<string, unknown>)["Response"] : null;
  const payload = response && typeof response === "object" ? (response as Record<string, unknown>)["Data"] : null;
  const accounts = payload && typeof payload === "object" ? (payload as Record<string, unknown>)["Accounts"] : null;
  if (!Array.isArray(accounts)) return [];
  return accounts.filter((a): a is Record<string, unknown> => !!a && typeof a === "object");
}

/**
 * 查询账号剩余额度，返回聚合结果。
 *
 * 401/403 时（默认）刷新一次令牌再试；仍失败抛 CreditsError / NotLoggedInError。
 */
export async function fetchCredits(options: { refreshOn401?: boolean } = {}): Promise<CreditsResult> {
  const { refreshOn401 = true } = options;
  let c = cred.load();

  let cfg: upstream.Config;
  try {
    [cfg] = upstream.loadConfig();
  } catch {
    cfg = upstream.defaultConfig();
  }
  if (c.domain && c.domain !== upstream.hostOf(cfg.baseUrl)) {
    cfg.baseUrl = `https://${c.domain}`;
  }
  const base = cfg.baseUrl;

  let accounts: Record<string, unknown>[];
  try {
    accounts = await fetchAccounts(c, base);
  } catch (err) {
    if (!(err instanceof cred.NotLoggedInError) || !refreshOn401) throw err;
    c = await cred.refresh(c); // 失败会抛异常，交由调用方提示重新登录
    accounts = await fetchAccounts(c, base);
  }

  const packages: CreditPackage[] = [];
  let totalRemain = 0;
  let totalSize = 0;
  let totalUsed = 0;

  for (const a of accounts) {
    const remain = num(a, "CapacityRemainPrecise", "CapacityRemain");
    const size = num(a, "CapacitySizePrecise", "CapacitySize");
    const used = num(a, "CapacityUsedPrecise", "CapacityUsed");
    totalRemain += remain;
    totalSize += size;
    totalUsed += used;
    const end = String(a["CycleEndTime"] ?? "");
    packages.push({
      name: String(a["PackageName"] ?? ""),
      product: String(a["SubProductName"] ?? a["ProductName"] ?? ""),
      remain: Math.round(remain * 100) / 100,
      size: Math.round(size * 100) / 100,
      used: Math.round(used * 100) / 100,
      unit: String(a["CapacityUnit"] ?? "credits"),
      cycle_start: String(a["CycleStartTime"] ?? ""),
      cycle_end: end,
      days_left: daysLeft(end),
      in_usage: Boolean(a["InUsage"]),
    });
  }

  // 有余额且未过期的排前面，再按剩余量降序
  packages.sort((x, y) => {
    const xEmpty = x.remain <= 0 ? 1 : 0;
    const yEmpty = y.remain <= 0 ? 1 : 0;
    if (xEmpty !== yEmpty) return xEmpty - yEmpty;
    return y.remain - x.remain;
  });

  const pct = totalSize > 0 ? (totalRemain / totalSize) * 100 : 0;
  return {
    ok: true,
    account: { uid: c.uid, domain: c.domain },
    total: {
      remain: Math.round(totalRemain * 100) / 100,
      size: Math.round(totalSize * 100) / 100,
      used: Math.round(totalUsed * 100) / 100,
      remain_percent: Math.round(pct * 10) / 10,
      unit: packages[0]?.unit ?? "credits",
    },
    packages,
  };
}

// ── 每日签到（billing/meter 域）───────────────────────────────────────────────

/** 每日签到端点（国内版现状：`/v2` 前缀；POST 空 body，参考实现 checkin_activity.go 同族）。 */
const DAILY_CHECKIN_PATH = "/v2/billing/meter/daily-checkin";

/** 一次签到的结果。 */
export interface CheckinResult {
  checkedIn: boolean;
  /** 上游幂等拒绝（今天已签）时为 true。 */
  already: boolean;
  message: string;
}

/**
 * 执行每日签到（`POST /v2/billing/meter/daily-checkin`，body `{}`）。
 *
 * 参考实现实测（2026-09-28，CN 与 global 同形）：已签到时上游业务码非 0，
 * 按「幂等成功」处理而不是报错；其余业务码如实抛 CreditsError。
 */
export async function dailyCheckin(): Promise<CheckinResult> {
  const c = cred.load(); // 未登录 → NotLoggedInError

  let cfg: upstream.Config;
  try {
    [cfg] = upstream.loadConfig();
  } catch {
    cfg = upstream.defaultConfig();
  }
  if (c.domain && c.domain !== upstream.hostOf(cfg.baseUrl)) {
    cfg.baseUrl = `https://${c.domain}`;
  }
  const base = cfg.baseUrl.replace(/\/+$/, "");

  let resp: Response;
  try {
    resp = await fetch(`${base}${DAILY_CHECKIN_PATH}`, {
      method: "POST",
      body: "{}",
      headers: headers(c, base),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CreditsError(`daily checkin request failed: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new cred.NotLoggedInError("daily checkin rejected the access token (401/403)");
  }
  if (resp.status !== 200) throw new CreditsError(`daily checkin returned HTTP ${resp.status}`);

  let env: Record<string, unknown>;
  try {
    env = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    throw new CreditsError(`daily checkin response is not valid JSON: ${String(err)}`);
  }
  const code = env["code"];
  const msg = String(env["msg"] ?? "");
  if (code === 0) {
    return { checkedIn: true, already: false, message: "签到成功" };
  }
  if (/already|已签|repeat|duplicate/i.test(msg)) {
    return { checkedIn: true, already: true, message: msg || "今天已签到" };
  }
  throw new CreditsError(`daily checkin failed: code=${String(code)} msg=${msg}`);
}

// ── 签到 / 领取能力（共享层 CLI 的 `<cid> checkin` 用；契约要求**每个渠道都提供**）──────

import type { SigninModule } from "@modelmux/gateway";
/**
 * 签到 / 领取能力（`<cid> checkin`）。
 *
 * 早期「国内版没有签到端点」的结论**有误**（参考实现 HanawaBanana 实测
 * `/v2/billing/meter/daily-checkin`，2026-09-28 CN 与 global 同形）——
 * `claim()` 真实执行签到；上游幂等拒绝（今天已签）按成功回报。
 */
export const signin: SigninModule = {
  async status() {
    return {
      claimable: true,
      summary: "存在每日签到端点（/v2/billing/meter/daily-checkin，POST 空 body）",
    };
  },
  async claim() {
    const r = await dailyCheckin();
    return { ok: true, summary: r.message };
  },
};
