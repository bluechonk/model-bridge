/**
 * Raccoon 额度：只读余额、每日签到（积分发放触发 + 账单核对）与登录奖励。
 *
 * ## 本模块承载的渠道知识（实测 + 参考实现 agent2api 交叉验证）
 *
 * | 来源 | 金额 | 触发方式 | 本模块 |
 * |---|---|---|---|
 * | 新人注册礼包 | 3000 | 注册时服务端自动发放 | 不涉及 |
 * | 每日积分发放 | 300 | **`GET /api/web/office/v3/setting_info`**（按天幂等） | ✅ 签到 |
 * | 桌面端登录奖励 | 3000 | `POST …/login/points/grant`（幂等一次性） | 导出备用 |
 *
 * ⚠ **签到 = 触发 + 核对两步**：`setting_info` 只是触发器（官方桌面端每次启动都打，
 * 服务端按天幂等发放）；「今天有没有领到」以**账单**（`points>0` 且日期=今天）为准
 * —— 只信触发器会把「服务端没发」误报成签到成功。
 * ⚠ **「今天」按北京时间**（上游自然日即 UTC+8 零点）：跟机器时区走会让海外/容器
 * 部署把 16 小时的账单认成昨天，「今日积分」与「今天已签」整体错位。
 * ⚠ **登录奖励不是每日签到**：该端点是**幂等一次性**的，幂等判据是 `granted`
 * （`false` → `already-claimed`，**不是** `claimed`）；不与每日签到混跑。
 * ⚠ **「查不到」不能显示成 0**：`available_points` 缺失即抛 `CreditsError`。
 * ⚠ **在「打开面板」这类高频路径上绝不触碰写端点**。
 */

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

/** 额度单位。 */
export const UNIT = "积分";

/** 登录奖励的伪 campaign id（本地编排用，服务端没有这个字段）。 */
export const LOGIN_REWARD_CAMPAIGN_ID = "desktop-login-reward";

/** 默认额度（服务端只回 `granted` 与 `popup.points` 时兜底展示）。 */
export const LOGIN_REWARD_POINTS = 3000;

/** 已领判据：账单里存在这条记录（`biz_type` + `event_name` 缺一不可）。 */
const REWARD_BIZ_TYPE = "reward_grant";
const REWARD_EVENT_NAME = "桌面端登录奖励";

/** 额度查询/领取失败。 */
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

export interface CreditsResult {
  ok: true;
  total: {
    remain: number;
    size: number;
    used: number;
    unit: string;
    remain_percent: number;
    /** 上游只给剩余，没有总量 → 显式标记 size 是回填值。 */
    size_known: boolean;
  };
  packages: CreditPackage[];
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

function headers(c: cred.Credentials, platform: boolean): Record<string, string> {
  return upstream.buildHeaders(
    { accessToken: c.accessToken, officeIdentity: c.officeIdentity, deviceId: c.deviceId },
    { jsonBody: false, platform },
  );
}

async function getJson(
  url: string,
  c: cred.Credentials,
  platform = false,
  timeoutMs = 20_000,
): Promise<{ status: number; code: number; data: Record<string, unknown>; message: string }> {
  let resp: Response;
  try {
    resp = await fetch(url, { headers: headers(c, platform), signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new CreditsError(`Request ${url} failed: ${String(err)}`);
  }
  let payload: unknown = null;
  try {
    payload = await resp.json();
  } catch {
    /* 非 JSON（网关错误页）→ 由状态码推导 */
  }
  const record = isRecord(payload) ? payload : {};
  const code =
    typeof record["code"] === "number" ? (record["code"] as number) : resp.status >= 400 ? resp.status : 0;
  const data = isRecord(record["data"]) ? (record["data"] as Record<string, unknown>) : {};
  return { status: resp.status, code, data, message: cred.envelopeMessage(payload) };
}

/**
 * 查余额（**只读**）。
 *
 * 各池**分开作 package**：奖励积分 / 每日积分 / 会员积分（**仅 > 0 时才加**）/ 充值积分。
 */
export async function fetchCredits(
  options: { refreshOn401?: boolean } = {},
): Promise<CreditsResult> {
  const { refreshOn401 = true } = options;
  let c = cred.load(); // 未登录 → NotLoggedInError
  const cfg = upstream.loadConfig()[0];

  let result: Awaited<ReturnType<typeof getJson>>;
  try {
    result = await getJson(upstream.balanceUrl(cfg), c);
  } catch (err) {
    if (!refreshOn401) throw err;
    c = await cred.refresh(c); // 失败会抛，交由调用方提示重新登录
    result = await getJson(upstream.balanceUrl(cfg), c);
  }
  if (result.status === 401 || result.status === 403 || result.code === 200003) {
    throw new cred.NotLoggedInError("Raccoon rejected the access token (401/403 or code 200003)");
  }
  if (result.code !== 0) {
    throw new CreditsError(`Balance query failed: code=${result.code} ${result.message}`);
  }

  const available = num(result.data["available_points"]);
  if (available === null) {
    // ⚠ 形状不对 → 抛错，绝不显示成 0
    throw new CreditsError("Balance response has no available_points field (bad shape; not shown as 0)");
  }

  const pools: Array<[string, number | null]> = [
    ["奖励积分", num(result.data["reward_points"])],
    ["每日积分", num(result.data["daily_points"])],
    ["会员积分", num(result.data["monthly_points"])],
    ["充值积分", num(result.data["topup_points"])],
  ];
  const packages: CreditPackage[] = [];
  for (const [name, value] of pools) {
    // 会员积分仅 > 0 时才出现（其余池恒显示，0 也是有意义的「本池为空」）
    if (name === "会员积分" && !(value !== null && value > 0)) continue;
    const amount = value ?? 0;
    packages.push({
      name,
      remain: round2(amount),
      size: round2(amount),
      used: 0,
      unit: UNIT,
      // 各池没有到期日概念 → 不编造天数
      days_left: null,
    });
  }

  const claimable: Array<Record<string, unknown>> = [];
  if (!(await loginRewardClaimed(c))) {
    claimable.push({
      campaign_id: LOGIN_REWARD_CAMPAIGN_ID,
      label: "桌面端登录奖励",
      amount: LOGIN_REWARD_POINTS,
    });
  }

  return {
    ok: true,
    total: {
      remain: round2(available),
      // 上游只给剩余：size 记作剩余、used 不编造
      size: round2(available),
      used: 0,
      unit: UNIT,
      remain_percent: available > 0 ? 100 : 0,
      size_known: false,
    },
    packages,
    claimable,
  };
}

/**
 * 查奖励是否已领。
 *
 * 判据：存在 `biz_type === 'reward_grant'` **且** `event_name === '桌面端登录奖励'` 的记录。
 *
 * ⚠ **不能靠 `balance` 推断** —— 余额是多个来源的合计；
 * ⚠ **不能只按 `biz_type === 'reward_grant'` 判定** —— 「新人注册礼包」也是 `reward_grant`；
 * ⚠ 服务端没有单独的奖励状态端点，故只能查账单明细；
 * ⚠ 查询失败时**保守返回 `claimed: false`**（宁可多显示一次领取按钮）。
 */
export async function loginRewardClaimed(c?: cred.Credentials): Promise<boolean> {
  let credential: cred.Credentials;
  try {
    credential = c ?? cred.load();
  } catch {
    return false;
  }
  const cfg = upstream.loadConfig()[0];
  try {
    const result = await getJson(upstream.billsUrl(cfg), credential);
    if (result.code !== 0) return false;
    const items = result.data["items"];
    if (!Array.isArray(items)) return false;
    return items.some(
      (item) =>
        isRecord(item) &&
        item["biz_type"] === REWARD_BIZ_TYPE &&
        item["event_name"] === REWARD_EVENT_NAME,
    );
  } catch {
    return false;
  }
}

export interface RewardResult {
  status: "claimed" | "already-claimed" | "failed";
  points: number;
  error?: string;
}

// ── 每日签到（setting_info 触发 + 账单核对）────────────────────────────────────

/** 上游自然日 = 北京时间（UTC+8）—— 不跟机器时区走，见模块头注释。 */
function beijingToday(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

interface DailyGrant {
  name: string;
  points: number;
  at: string;
}

/**
 * 账单里**今天（北京时间）**入账的积分发放（`points > 0`）。
 *
 * ⚠ 账单接口是慢接口（实测约 9 秒），用独立超时；失败**抛错**
 * （由调用方决定怎么显示 —— 「查不到」不能显示成「没领」）。
 */
async function todayGrants(c: cred.Credentials): Promise<DailyGrant[]> {
  const cfg = upstream.loadConfig()[0];
  const result = await getJson(upstream.billsUrl(cfg), c, false, 25_000);
  if (result.status === 401 || result.status === 403 || result.code === 200003) {
    throw new cred.NotLoggedInError("Raccoon rejected the access token (401/403 or code 200003)");
  }
  // ⚠ HTTP 状态也是判据：网关错误页可能带 `code: 0`（不能只看业务码）
  if (result.status >= 400 || result.code !== 0) {
    throw new CreditsError(`Bills query failed: HTTP ${result.status} code=${result.code} ${result.message}`);
  }
  const items = result.data["items"];
  if (!Array.isArray(items)) return [];
  const today = beijingToday();
  const out: DailyGrant[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const points = num(item["points"]);
    if (points === null || points <= 0) continue;
    const createdAt = typeof item["created_at"] === "string" ? item["created_at"] : "";
    if (createdAt.slice(0, 10) !== today) continue;
    out.push({
      name: typeof item["event_name"] === "string" ? item["event_name"] : "积分发放",
      points,
      at: createdAt.replace("T", " ").slice(11, 19),
    });
  }
  return out;
}

/**
 * 触发每日积分发放（**按天幂等**）：`GET setting_info`（platform 头必需）。
 *
 * 官方桌面端每次启动都会打这个接口；发放由服务端完成，本函数的返回值只是
 * 发放通知（`point_grant_popups` / `point_grant_toast`），**不是**结果判据。
 */
export async function triggerDailyGrant(c?: cred.Credentials): Promise<Record<string, unknown>> {
  const credential = c ?? cred.load();
  const cfg = upstream.loadConfig()[0];
  const result = await getJson(upstream.settingInfoUrl(cfg), credential, true, 25_000);
  if (result.status === 401 || result.status === 403 || result.code === 200003) {
    throw new cred.NotLoggedInError("Raccoon rejected the access token (401/403 or code 200003)");
  }
  if (result.status >= 400 || result.code !== 0) {
    throw new CreditsError(`setting_info failed: HTTP ${result.status} code=${result.code} ${result.message}`);
  }
  return {
    popups: result.data["point_grant_popups"] ?? null,
    toast: result.data["point_grant_toast"] ?? null,
  };
}

/**
 * 领取桌面端登录奖励（**幂等一次性**，不是每日签到）。
 *
 * ⚠ **需要 `X-Client-Platform` 头**（依据主进程 `resolveDesktopClientPlatform`，
 * `win32` → `desktop-windows`；猜错会被拒）；
 * ⚠ 幂等判据是 `granted`，`false` → `already-claimed`；
 * ⚠ 本函数**不抛错**（失败也返回 `failed`）。
 */
export async function claimLoginReward(c?: cred.Credentials): Promise<RewardResult> {
  let credential: cred.Credentials;
  try {
    credential = c ?? cred.load();
  } catch (err) {
    return { status: "failed", points: 0, error: String(err) };
  }
  const cfg = upstream.loadConfig()[0];
  let resp: Response;
  try {
    resp = await fetch(upstream.loginGrantUrl(cfg), {
      method: "POST",
      headers: headers(credential, true), // platform 必需
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { status: "failed", points: 0, error: `Claim request failed: ${String(err)}` };
  }
  let payload: unknown = null;
  try {
    payload = await resp.json();
  } catch {
    /* 非 JSON */
  }
  const record = isRecord(payload) ? payload : {};
  const code =
    typeof record["code"] === "number" ? (record["code"] as number) : resp.status >= 400 ? resp.status : 0;
  if (resp.status >= 400 || code !== 0) {
    return {
      status: "failed",
      points: 0,
      error: `Claim failed: HTTP ${resp.status} code=${code} ${cred.envelopeMessage(payload)}`,
    };
  }
  const data = isRecord(record["data"]) ? (record["data"] as Record<string, unknown>) : {};
  const popup = isRecord(data["popup"]) ? (data["popup"] as Record<string, unknown>) : {};
  const points = num(popup["points"]) ?? LOGIN_REWARD_POINTS;
  if (data["granted"] === true) return { status: "claimed", points };
  // 幂等判据是 granted → false 映射成 already-claimed（不是 claimed）
  return { status: "already-claimed", points: 0 };
}

// ── 签到 / 领取能力（共享层 CLI 的 `<cid> checkin` 用；见 SigninModule 契约）─────────

import type { SigninModule } from "@model-bridge/gateway";

/**
 * 每日签到（`<cid> checkin`）。
 *
 * 语义对齐上游真实链路：**触发**（`setting_info`，按天幂等）+ **核对**（账单里
 * 今天有没有入账）。`ok` 的口径是「今日积分确有入账」—— 重复签到不会重复入账，
 * 账单里看得到就算领到（与参考实现 agent2api 的 `claim_daily_grant` 一致）。
 */
export const signin: SigninModule = {
  async status() {
    const c = cred.load(); // 未登录时抛 NotLoggedInError：别把"没登录"显示成"可领"
    let grants: DailyGrant[];
    try {
      grants = await todayGrants(c);
    } catch (err) {
      // 查不到 ≠ 没领 —— 报「不知道」，不报「可领」
      return {
        claimable: null,
        claimedToday: null,
        daily: true,
        summary: `账单查询失败，今日是否已签未知（${String(err)}）`,
      };
    }
    const total = grants.reduce((sum, g) => sum + g.points, 0);
    if (grants.length > 0) {
      return {
        claimable: false,
        claimedToday: true,
        daily: true,
        summary: `今日已入账 ${total} 积分（${grants.map((g) => `${g.name} +${g.points}`).join("、")}）`,
        items: grants.map((g) => ({ name: g.name, points: g.points, at: g.at })),
      };
    }
    return {
      claimable: true,
      claimedToday: false,
      daily: true,
      summary: "今日还没有入账记录（checkin 会触发一次发放；上游按天幂等，重复执行不会重复入账）",
    };
  },
  async claim() {
    let c: cred.Credentials;
    try {
      c = cred.load();
    } catch (err) {
      return { ok: false, summary: String(err) };
    }
    // ① 触发发放（按天幂等）
    let notify: Record<string, unknown>;
    try {
      notify = await triggerDailyGrant(c);
    } catch (err) {
      return { ok: false, summary: `触发发放失败: ${String(err)}`, detail: { error: String(err) } };
    }
    // ② 账单核对（权威结果）
    let grants: DailyGrant[];
    try {
      grants = await todayGrants(c);
    } catch (err) {
      return {
        ok: false,
        summary: `已触发发放，但账单核对失败（暂时无法确认入账）: ${String(err)}`,
        detail: { notify },
      };
    }
    if (grants.length === 0) {
      return {
        ok: false,
        summary: "已触发发放，但今日账单暂未见入账（稍后可再看账单）",
        detail: { notify },
      };
    }
    const total = grants.reduce((sum, g) => sum + g.points, 0);
    return {
      ok: true,
      summary: `签到成功，今日已入账 ${total} 积分`,
      detail: { notify, grants },
    };
  },
};
