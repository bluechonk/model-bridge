/**
 * MiniMax Code 额度：签到（status/claim）+ 积分余额（docs/protocols/minimax/PROTOCOL.md §6）。
 *
 * ## 本模块承载的渠道知识（§6.2 五个必须记住的点）
 *
 * 1. **`timezone_id` 是 query 参数且必填**，值取
 *    `Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"` —— **必须传 IANA 名**。
 *    请求头传无效、都不带报 `invalid timezone_id`。
 * 2. **业务码在 `base_resp.status_code`**（不是 `code`），
 *    且 `invalid timezone_id` 也是 **HTTP 200**。
 * 3. **两个端点响应形状不同**：`signin/status`、`signin/claim` 是信封（业务字段在
 *    `data` 下）；`credit/details` 是**平铺的**（`total_count` 与 `base_resp` 同级，
 *    **无 `data` 键**）。解析函数 `unwrapEnvelopeData` 兼容两者。
 * 4. `points` 是总数、`bonus_points` 是其中的额外部分，**不得相加**（实测 800 / 400）。
 * 5. 「今日已领」判据是 `is_today && status === 3`；领取幂等判据是
 *    `claim_result === 2`（重复领取同样 HTTP 200）。
 *
 * ## 余额口径（§6.4）
 *
 * **余额 = Σ `details[].remaining_amount`**（字符串形态，需宽容解析）。
 * `total_count` 是 `details[]` 的记录条数，**不是余额**（已被生产数据推翻的误读）。
 * `details` 缺失 → 余额 0（「真的为 0」）；`base_resp.status_code` 非 0 → 抛错（真失败）。
 *
 * ⚠ 「查不到」不能显示成 0：失败一律抛 `CreditsError`。
 * ⚠ 未登录抛 `cred.NotLoggedInError`。
 */

import type { Credentials } from "./cred.js";
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

/** 签到状态端点（§1）。 */
const SIGNIN_STATUS_PATH = "/minimax-cloud/api/v1/signin/status";
/** 签到领取端点（§1）。 */
const SIGNIN_CLAIM_PATH = "/minimax-cloud/api/v1/signin/claim";
/** 积分明细端点（§1）。 */
const CREDIT_DETAILS_PATH = "/minimax-cloud/api/v1/credit/details";

const HTTP_TIMEOUT_MS = 30_000;

/** 签到状态（§6.1）。 */
export const SIGNIN_STATUS = { Upcoming: 1, Claimable: 2, Claimed: 3, Disabled: 4 } as const;
/** 领取结果（§6.1）。 */
export const CLAIM_RESULT = { Claimed: 1, AlreadyClaimed: 2 } as const;
/** 面板场景（§6.1）。 */
export const PANEL_SCENE = { Unknown: 0, First: 1, Active: 2, Completed: 3, Broken: 4 } as const;

/** 额度查询失败（上游拒绝 / 网络错误 / 响应形状无法解析）。 */
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
  /** 今日是否已签到 / 是否可领（签到面板结论）。 */
  claimable?: Array<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 当前 IANA 时区名（§6.2 点 1：必须传 IANA 名，取不到回退 UTC）。 */
export function timezoneId(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * 兼容信封与平铺两种形状（§6.2 点 3）。
 *
 * `signin/*` 的业务字段在 `data` 下；`credit/details` 是平铺的（无 `data` 键）。
 */
export function unwrapEnvelopeData(body: Record<string, unknown>): Record<string, unknown> {
  const data = body["data"];
  return isRecord(data) ? data : body;
}

/** 业务码校验：`base_resp.status_code` 非 0 即失败（§6.2 点 2）。 */
function checkBusinessCode(body: Record<string, unknown>, what: string): void {
  const baseResp = isRecord(body["base_resp"]) ? body["base_resp"] : null;
  const code = baseResp?.["status_code"];
  if (code === undefined || code === null) return; // 无业务码信封：交给后续形状校验
  if (code === 0) return;
  let msg = "";
  const statusMsg = baseResp?.["status_msg"];
  if (typeof statusMsg === "string") msg = statusMsg;
  throw new CreditsError(`${what} 业务失败 status_code=${String(code)}${msg ? ` (${msg})` : ""}`);
}

/** 宽容解析数字（字符串形态的余额需解析）。取不到返回 null（不编造）。 */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/** 凭据带 domain 时切到该域（登录域与默认域可能不同）。 */
function baseUrlFor(c: Credentials): string {
  const [cfg] = upstream.loadConfig();
  if (c.domain && c.domain !== upstream.hostOf(cfg.baseUrl)) return `https://${c.domain}`;
  return cfg.baseUrl.replace(/\/+$/, "");
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  method = "GET",
  body?: string,
): Promise<Record<string, unknown>> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CreditsError(`额度请求失败: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new cred.NotLoggedInError("额度端点拒绝了访问令牌（401/403）");
  }
  if (resp.status !== 200) throw new CreditsError(`额度端点返回 HTTP ${resp.status}`);
  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch (err) {
    throw new CreditsError(`额度响应不是合法 JSON: ${String(err)}`);
  }
  if (!isRecord(parsed)) throw new CreditsError("额度响应不是 JSON 对象");
  return parsed;
}

// ── 签到面板解析（§6.3） ────────────────────────────────────────────────────

/** 一个签到日条目。 */
export interface SigninDay {
  day_no: number;
  points: number;
  is_today: boolean;
  status: number;
}

/** 归一后的签到面板结论。 */
export interface SigninPanel {
  days: SigninDay[];
  /** 今日是否已领（`is_today && status === 3`，§6.2 点 5）。 */
  claimedToday: boolean;
  /** 当前可领的条目（最多 1 条）。 */
  claimable: SigninDay | null;
  scene: number | null;
  /** ⚠ `isStreakDay` 当前不可判读且几乎恒为 true，未修复 —— 恒置 false（§6.4）。 */
  isStreakDay: false;
}

/**
 * 签到面板硬校验（§6.3）：
 * `days` 恰好 7 条、`day_no` 1..7 整数且无重复、`points` 非负、`is_today` 是 boolean、
 * `status` ∈ {1,2,3,4}、最多 1 条 Claimable、最多 1 条 `is_today`、`scene` ∈ {0..4}。
 */
export function parseSigninPanel(data: Record<string, unknown>): SigninPanel {
  const rawDays = data["days"];
  if (!Array.isArray(rawDays) || rawDays.length !== 7) {
    throw new CreditsError(`签到面板 days 必须恰好 7 条（收到 ${Array.isArray(rawDays) ? rawDays.length : "非数组"}）`);
  }
  const days: SigninDay[] = [];
  const seenDayNo = new Set<number>();
  let todayCount = 0;
  let claimableCount = 0;
  let claimable: SigninDay | null = null;

  for (const raw of rawDays) {
    if (!isRecord(raw)) throw new CreditsError("签到面板 days 含非对象条目");
    const dayNo = num(raw["day_no"]);
    if (dayNo === null || !Number.isInteger(dayNo) || dayNo < 1 || dayNo > 7) {
      throw new CreditsError(`签到日 day_no 必须是 1..7 的整数（收到 ${String(raw["day_no"])}）`);
    }
    if (seenDayNo.has(dayNo)) throw new CreditsError(`签到日 day_no 重复：${dayNo}`);
    seenDayNo.add(dayNo);

    const points = num(raw["points"]);
    if (points === null || points < 0) throw new CreditsError("签到日 points 必须非负");
    const isToday = raw["is_today"];
    if (typeof isToday !== "boolean") throw new CreditsError("签到日 is_today 必须是 boolean");
    const status = num(raw["status"]);
    if (status === null || ![1, 2, 3, 4].includes(status)) {
      throw new CreditsError(`签到日 status 必须 ∈ {1,2,3,4}（收到 ${String(raw["status"])}）`);
    }
    const day: SigninDay = { day_no: dayNo, points, is_today: isToday, status };
    if (day.is_today) todayCount += 1;
    if (status === SIGNIN_STATUS.Claimable) {
      claimableCount += 1;
      claimable = day;
    }
    days.push(day);
  }
  if (todayCount > 1) throw new CreditsError("签到面板最多 1 条 is_today");
  if (claimableCount > 1) throw new CreditsError("签到面板最多 1 条 Claimable");

  let scene: number | null = null;
  const sceneRaw = data["scene"];
  if (sceneRaw !== undefined && sceneRaw !== null) {
    const n = num(sceneRaw);
    if (n === null || ![0, 1, 2, 3, 4].includes(n)) {
      throw new CreditsError(`签到面板 scene 必须 ∈ {0..4}（收到 ${String(sceneRaw)}）`);
    }
    scene = n;
  }
  days.sort((a, b) => a.day_no - b.day_no);
  const today = days.find((d) => d.is_today);
  return {
    days,
    claimedToday: Boolean(today && today.status === SIGNIN_STATUS.Claimed),
    claimable,
    scene,
    isStreakDay: false, // §6.4：字段不可判读，恒置 false
  };
}

// ── 额度查询 ────────────────────────────────────────────────────────────────

/**
 * 查询账号额度：签到状态 + 积分余额（§6）。
 *
 * @param options.refreshOn401 额度端点 401 时先续期再重试一次
 */
export async function fetchCredits(
  options: { refreshOn401?: boolean } = {},
): Promise<CreditsResult> {
  const { refreshOn401 = true } = options;
  let c = cred.load();
  const base = baseUrlFor(c);
  const tz = encodeURIComponent(timezoneId());

  const signinStatus = async (current: Credentials): Promise<Record<string, unknown>> => {
    const headers = upstream.businessHeaders(current);
    const body = await getJson(`${base}${SIGNIN_STATUS_PATH}?timezone_id=${tz}`, headers);
    checkBusinessCode(body, "signin/status");
    return unwrapEnvelopeData(body);
  };

  const creditDetails = async (current: Credentials): Promise<Record<string, unknown>> => {
    const headers = upstream.businessHeaders(current);
    const body = await getJson(`${base}${CREDIT_DETAILS_PATH}`, headers);
    checkBusinessCode(body, "credit/details");
    return unwrapEnvelopeData(body);
  };

  let signin: Record<string, unknown> = {};
  let details: Record<string, unknown> = {};
  try {
    signin = await signinStatus(c);
    details = await creditDetails(c);
  } catch (err) {
    if (!(err instanceof cred.NotLoggedInError) || !refreshOn401) throw err;
    c = await cred.refresh(c); // 失效会抛，交由调用方提示重新登录
    signin = await signinStatus(c);
    details = await creditDetails(c);
  }

  // 面板硬校验：失败即抛（不把校验不过的签到面板当 0 显示）
  const panel = parseSigninPanel(signin);

  // 余额 = Σ details[].remaining_amount（§6.4）
  const rawList = details["details"];
  let remain = 0;
  let size = 0;
  const packages: CreditPackage[] = [];
  if (Array.isArray(rawList)) {
    for (const item of rawList) {
      if (!isRecord(item)) continue;
      const remaining = num(item["remaining_amount"]) ?? 0;
      const granted = num(item["granted_amount"]) ?? 0;
      remain += remaining;
      size += granted;
      packages.push({
        name: formatCreditType(item["credit_type"]),
        remain: remaining,
        size: granted,
        unit: "points",
        days_left: null, // 不下发到期剩余天数；不编造
      });
    }
  }
  const used = Math.max(size - remain, 0);

  // claimable：仅当今日可领时给出（不伪造）
  const claimable: Array<Record<string, unknown>> = [];
  if (panel.claimable) {
    claimable.push({
      id: "daily-signin",
      kind: "signin",
      day_no: panel.claimable.day_no,
      points: panel.claimable.points,
      claimedToday: panel.claimedToday,
    });
  }

  return {
    ok: true,
    total: {
      remain,
      size,
      used,
      unit: "points",
      remain_percent: size > 0 ? Math.round((remain / size) * 1000) / 10 : 0,
    },
    packages,
    claimable,
  };
}

/** `credit_type` 是数字枚举，给个稳定的可读名（不猜测分类，仅命名）。 */
function formatCreditType(value: unknown): string {
  const n = num(value);
  return n === null ? "credit" : `credit_type_${n}`;
}

/**
 * 领取签到奖励（`POST signin/claim`，body `{}`，§1/§6）。
 *
 * 幂等判据：`claim_result === 2`（重复领取同样 HTTP 200，§6.2 点 5）。
 * 返回领取结果枚举值。
 */
export async function claimSignin(options: { refreshOn401?: boolean } = {}): Promise<{
  claimResult: number;
  alreadyClaimed: boolean;
  data: Record<string, unknown>;
}> {
  const { refreshOn401 = true } = options;
  let c = cred.load();
  const base = baseUrlFor(c);
  const tz = encodeURIComponent(timezoneId());

  const doClaim = async (current: Credentials): Promise<Record<string, unknown>> => {
    const headers = upstream.businessHeaders(current);
    const body = await getJson(
      `${base}${SIGNIN_CLAIM_PATH}?timezone_id=${tz}`,
      headers,
      "POST",
      "{}",
    );
    checkBusinessCode(body, "signin/claim");
    return unwrapEnvelopeData(body);
  };

  let data: Record<string, unknown> = {};
  try {
    data = await doClaim(c);
  } catch (err) {
    if (!(err instanceof cred.NotLoggedInError) || !refreshOn401) throw err;
    c = await cred.refresh(c);
    data = await doClaim(c);
  }

  const claimResult = num(data["claim_result"]);
  if (claimResult === null) {
    throw new CreditsError("signin/claim 响应缺少 claim_result");
  }
  return {
    claimResult,
    alreadyClaimed: claimResult === CLAIM_RESULT.AlreadyClaimed,
    data,
  };
}

// ── 签到 / 领取能力（共享层 CLI 的 `<cid> checkin` 用；见 SigninModule 契约）─────────

import type { SigninModule } from "@model-bridge/gateway";
/**
 * 只查签到面板（`signin/status`）—— 比 `fetchCredits()` 便宜，专供"今天签没签"的判定。
 */
export async function signinStatus(): Promise<{ claimedToday: boolean; claimable: boolean }> {
  const c = cred.load();
  const base = baseUrlFor(c);
  const tz = encodeURIComponent(timezoneId());
  const body = await getJson(`${base}${SIGNIN_STATUS_PATH}?timezone_id=${tz}`, upstream.businessHeaders(c));
  checkBusinessCode(body, "signin/status");
  const panel = parseSigninPanel(unwrapEnvelopeData(body));
  return { claimedToday: panel.claimedToday, claimable: panel.claimable !== null };
}

/**
 * 签到 / 领取能力（`<cid> checkin`）。
 *
 * 上游 `signin/status` + `signin/claim`。状态取自 `fetchCredits()` 里已经解析好的
 * 可领清单（避免再发一次 status 请求）。
 */
export const signin: SigninModule = {
  async status() {
    const panel = await signinStatus();
    return {
      claimable: panel.claimable,
      summary: panel.claimedToday ? "今天已领过" : panel.claimable ? "今天未领，可领" : "今天未领，暂无可领",
      claimedToday: panel.claimedToday,
      daily: true,
    };
  },
  async claim() {
    const r = await claimSignin();
    return {
      ok: !r.alreadyClaimed,
      summary: r.alreadyClaimed ? "今日已领过（上游幂等）" : "签到成功",
      detail: r,
    };
  },
};
