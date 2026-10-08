/**
 * TRAE 额度与签到：签到三端点（status / claim / usage），全部走 `api.trae.cn`。
 *
 * ## 实测要点（docs/protocols/trae/PROTOCOL.md §6）
 *
 * - **claim 的 body 是 `{}`**（不是 `{"req_source":2}`），且成功响应只有
 *   `{"code":0,"message":"success"}` —— **不含积分数**，必须补查一次 `status`
 *   才能拿到 `credits`（实测 150）。
 * - **设备身份确定性派生**（`deviceId15` / `marketUserId` / `sessionId`）：
 *   每个账号稳定唯一，从而规避「每设备每天一次」配额。
 * - `9074`（签到人数过多）是**设备级限流**：轮换签到设备代次并报错。
 * - `expire_time` 是**秒**级 Unix（×1000 才是毫秒）。
 *
 * ⚠ 「查不到」不能显示成 0：失败一律抛 `CreditsError`。
 * ⚠ 未登录抛 `cred.NotLoggedInError`。
 */

import { randomBytes, randomUUID } from "node:crypto";

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

export const CHECKIN_STATUS_PATH = "/trae/api/v2/ug/checkin_credits/status";
export const CHECKIN_CLAIM_PATH = "/trae/api/v2/ug/checkin_credits/claim";
export const USAGE_PATH = "/trae/api/v2/pay/ide_user_ent_usage";

const HTTP_TIMEOUT_MS = 30_000;
/** 设备级限流码（签到人数过多）。 */
const DEVICE_RATE_LIMIT_CODE = 9074;

/** 额度查询/签到失败（上游拒绝 / 网络错误 / 响应形状无法解析）。 */
export class CreditsError extends Error {
  override name = "CreditsError";
}

/** 一个权益包的额度明细。 */
export interface CreditPackage {
  name: string;
  remain: number;
  size: number;
  used: number;
  unit: string;
  expire_at: string;
  days_left: number | null;
  [key: string]: unknown;
}

export interface CreditsResult {
  ok: true;
  account: { uid: string };
  total: {
    remain: number;
    size: number;
    used: number;
    unit: string;
    remain_percent: number;
  };
  packages: CreditPackage[];
  /** 可领活动：每日签到（未签到时出现）。 */
  claimable?: Array<Record<string, unknown>>;
}

export interface CheckinState {
  checked_in: boolean;
  credits: number;
  enable: boolean;
  streak_days: number;
  total_credits: number;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function num(rec: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = rec[key];
    if (value === null || value === undefined || value === "") continue;
    const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function str(rec: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/**
 * 签到请求头（约 20 个）。
 *
 * `Authorization` 与对话同款（`Cloud-IDE-JWT`）；设备字段是**确定性派生**的，
 * 每个账号稳定唯一 —— 这正是「同一设备每天只能签一次」不被误伤的原因。
 */
export function buildCheckinHeaders(c: cred.Credentials): Record<string, string> {
  const generation = c.checkinGeneration ?? 0;
  return {
    "Content-Type": "application/json",
    Accept: "*/*",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "zh-CN",
    "User-Agent": "VSCode 1.107.1 (TRAE SOLO CN)",
    Authorization: `Cloud-IDE-JWT ${c.accessToken}`,
    "X-Market-Client-Id": "VSCode 1.107.1",
    "X-Market-User-Id": cred.deriveMarketUserId(c.uid),
    "X-User-Region": "CN",
    "X-Device-Id": cred.deriveCheckinDeviceId(c.uid, generation),
    "X-Lgw-Req-Sdk-Type": "3",
    "Package-Type": "stable_cn",
    "X-Lscbd-Aid": "787976",
    "X-Lscbd-Platform": "windows",
    "App-Version": cred.IDE_VERSION,
    "X-Tt-Trace-Id": `00-${randomBytes(16).toString("hex")}-01`,
    "Vscode-Sessionid": cred.deriveSessionId(c.uid),
    "X-Request-Id": randomUUID(),
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "none",
  };
}

async function postJson(
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  let resp: Response;
  try {
    resp = await fetch(`${cred.ugHost()}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CreditsError(`签到/额度请求失败: ${String(err)}`);
  }
  const text = await resp.text();
  if (resp.status === 401 || resp.status === 403) {
    throw new cred.NotLoggedInError("签到端点拒绝了访问令牌（401/403）");
  }
  if (resp.status !== 200) {
    const kind = upstream.classifyError(resp.status, text);
    throw new CreditsError(`签到端点返回 HTTP ${resp.status}（${kind}）`);
  }
  let env: unknown;
  try {
    env = JSON.parse(text);
  } catch (err) {
    throw new CreditsError(`签到端点响应不是合法 JSON: ${String(err)}`);
  }
  if (!isRecord(env)) throw new CreditsError("签到端点响应不是 JSON 对象");
  return env;
}

/**
 * 处理 9074（设备级限流）：轮换签到设备代次后报错。
 *
 * 轮换本身是持久化的（写入凭据的 `checkin_generation`），下一次请求自然换设备桶。
 */
async function handleDeviceRateLimit(c: cred.Credentials, env: Record<string, unknown>): Promise<never> {
  const code = num(env, "code");
  if (code === DEVICE_RATE_LIMIT_CODE) {
    await cred.rotateCheckinGeneration(c).catch(() => {
      /* 回写失败不掩盖原始错误 */
    });
    throw new CreditsError(`签到人数过多（9074，设备级限流），已轮换签到设备，请稍后重试`);
  }
  throw new CreditsError(`签到端点返回 code=${String(env["code"])} msg=${str(env, "message", "msg")}`);
}

/** 查询签到状态。 */
export async function checkinStatus(c?: cred.Credentials): Promise<CheckinState> {
  const current = c ?? cred.load();
  const env = await postJson(CHECKIN_STATUS_PATH, {}, buildCheckinHeaders(current));
  const code = num(env, "code");
  if (code !== null && code !== 0) await handleDeviceRateLimit(current, env);
  return {
    checked_in: env["checked_in"] === true,
    credits: num(env, "credits") ?? 0,
    enable: env["enable"] !== false,
    streak_days: num(env, "streak_days") ?? 0,
    total_credits: num(env, "total_credits") ?? 0,
    message: str(env, "message", "msg"),
  };
}

/**
 * 领取每日签到。
 *
 * ⚠ claim 的 body 是 **`{}`**（不是 `{"req_source":2}`）；响应**不含积分数**，
 * 故领取后必须补查一次 `status` 才能拿到 `credits`。
 */
export async function claimDaily(c?: cred.Credentials): Promise<{
  already: boolean;
  credits: number;
  streak_days: number;
  message: string;
}> {
  const current = c ?? cred.load();
  const before = await checkinStatus(current);
  if (before.checked_in) {
    return {
      already: true,
      credits: before.credits,
      streak_days: before.streak_days,
      message: before.message || "今日已签到",
    };
  }

  const claimEnv = await postJson(CHECKIN_CLAIM_PATH, {}, buildCheckinHeaders(current));
  const code = num(claimEnv, "code");
  if (code !== null && code !== 0) await handleDeviceRateLimit(current, claimEnv);

  // 成功响应只有 {"code":0,"message":"success"}：必须补查 status 拿积分
  const after = await checkinStatus(current);
  return {
    already: false,
    credits: after.credits,
    streak_days: after.streak_days,
    message: str(claimEnv, "message", "msg") || after.message || "success",
  };
}

/** 秒级 Unix 到期时间 → 剩余天数（不编造：无法解析返回 null）。 */
function daysLeft(expireSeconds: number | null): number | null {
  if (expireSeconds === null) return null;
  const ms = expireSeconds < 1e12 ? expireSeconds * 1000 : expireSeconds;
  return Math.floor((ms - Date.now()) / 86_400_000);
}

/**
 * 查询额度：usage（权益包）+ status（可领签到）。
 *
 * @param options.refreshOn401 401 时先走一次续期（ExchangeToken）再重试。
 */
export async function fetchCredits(
  options: { refreshOn401?: boolean } = {},
): Promise<CreditsResult> {
  const { refreshOn401 = true } = options;
  let c = cred.load();

  const fetchUsage = async (current: cred.Credentials): Promise<Record<string, unknown>> =>
    postJson(USAGE_PATH, { require_usage: true, req_source: 2 }, buildCheckinHeaders(current));

  let env: Record<string, unknown>;
  try {
    env = await fetchUsage(c);
  } catch (err) {
    if (!(err instanceof cred.NotLoggedInError) || !refreshOn401) throw err;
    c = await cred.refresh(c); // 失败会抛（终态），交由调用方提示重新登录
    env = await fetchUsage(c);
  }

  const packs = Array.isArray(env["user_entitlement_pack_list"])
    ? env["user_entitlement_pack_list"].filter(isRecord)
    : [];

  const packages: CreditPackage[] = [];
  let totalRemain = 0;
  let totalSize = 0;
  let totalUsed = 0;
  for (const pack of packs) {
    const info = isRecord(pack["entitlement_base_info"]) ? pack["entitlement_base_info"] : {};
    const quota = isRecord(info["quota"]) ? info["quota"] : {};
    const usage = isRecord(pack["usage"]) ? pack["usage"] : {};
    const size = num(quota, "credits_limit") ?? 0;
    const used = num(usage, "credits_amount") ?? 0;
    const remain = Math.max(size - used, 0);
    totalRemain += remain;
    totalSize += size;
    totalUsed += used;
    const expireSeconds = num(pack, "expire_time") ?? num(info, "expire_time");
    packages.push({
      name: str(info, "display_desc") || str(info, "name") || "TRAE 额度",
      remain: Math.round(remain * 100) / 100,
      size: Math.round(size * 100) / 100,
      used: Math.round(used * 100) / 100,
      unit: "credits",
      expire_at: expireSeconds === null ? "" : String(Math.trunc(expireSeconds * 1000)),
      // ⚠ expire_time 是秒级 Unix（×1000 才是毫秒）
      days_left: daysLeft(expireSeconds),
    });
  }

  const result: CreditsResult = {
    ok: true,
    account: { uid: c.uid },
    total: {
      remain: Math.round(totalRemain * 100) / 100,
      size: Math.round(totalSize * 100) / 100,
      used: Math.round(totalUsed * 100) / 100,
      unit: "credits",
      remain_percent: totalSize > 0 ? Math.round((totalRemain / totalSize) * 1000) / 10 : 0,
    },
    packages,
  };

  // 可领活动 = 未签到的每日签到（status 失败不影响额度结论）
  try {
    const state = await checkinStatus(c);
    if (state.enable && !state.checked_in) {
      result.claimable = [
        {
          campaign_id: "trae-daily-checkin",
          name: "每日签到",
          streak_days: state.streak_days,
          total_credits: state.total_credits,
        },
      ];
    } else {
      result.claimable = [];
    }
  } catch {
    /* 签到状态不可用时不附 claimable */
  }
  return result;
}

// ── 签到 / 领取能力（共享层 CLI 的 `<cid> checkin` 用；见 SigninModule 契约）─────────

import type { SigninModule } from "@model-bridge/gateway";
/**
 * 签到 / 领取能力（`<cid> checkin`）。
 *
 * 上游是「签到领积分」：`checkin_credits/status` 查状态、`.../claim` 领。
 * claim 的响应不含积分数，故实现里会补查一次 status。
 */
export const signin: SigninModule = {
  async status() {
    const s = await checkinStatus();
    const bits = [
      s.checked_in ? "今日已签到" : "今日未签到",
      s.streak_days > 0 ? `连续 ${s.streak_days} 天` : "",
      s.total_credits > 0 ? `累计 ${s.total_credits}` : "",
    ].filter(Boolean);
    return {
      claimable: s.enable ? !s.checked_in : false,
      summary: `${bits.join("，")}${s.message ? `（${s.message}）` : ""}`,
      // 上游直接给了"今天签没签"→ 交给共享层做「今日是否签到过」的权威判定
      claimedToday: s.checked_in,
      daily: true,
    };
  },
  async claim() {
    const r = await claimDaily();
    return {
      ok: true,
      summary: r.already
        ? `今日已签到（连续 ${r.streak_days} 天）`
        : `签到成功，+${r.credits} 积分（连续 ${r.streak_days} 天）`,
      detail: r,
    };
  },
};
