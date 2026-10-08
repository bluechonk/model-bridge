/**
 * Raccoon 额度：只读余额、登录奖励（一次性幂等）与「查奖励是否已领」。
 *
 * ## 本模块承载的渠道知识（raccoon-credits.ts:4-25）
 *
 * | 来源 | 金额 | 触发方式 | 本模块 |
 * |---|---|---|---|
 * | 新人注册礼包 | 3000 | 注册时服务端自动发放 | 不涉及 |
 * | 桌面端登录奖励 | 3000 | `POST …/login/points/grant` | ✅ 实现 |
 * | 每日积分发放 | 300 | **服务端按日自动发放，无端点** | ❌ **不实现** |
 *
 * ⚠ **每日 300 没有签到端点**：实测该账号 13:30 注册、13:31 就收到 `daily_grant`
 * 账单（`biz_type: 'daily_grant'`）。故**不能**把它实现成签到按钮。
 * ⚠ **登录奖励不是每日签到**：该端点是**幂等一次性**的，幂等判据是 `granted`
 * （`false` → `already-claimed`，**不是** `claimed`）。
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
    throw new CreditsError(`请求 ${url} 失败: ${String(err)}`);
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
    throw new cred.NotLoggedInError("Raccoon 拒绝了访问令牌（401/403 或 code 200003）");
  }
  if (result.code !== 0) {
    throw new CreditsError(`余额查询失败: code=${result.code} ${result.message}`);
  }

  const available = num(result.data["available_points"]);
  if (available === null) {
    // ⚠ 形状不对 → 抛错，绝不显示成 0
    throw new CreditsError("余额响应里没有 available_points 字段（形状不对，不显示成 0）");
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
    return { status: "failed", points: 0, error: `领取请求失败: ${String(err)}` };
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
      error: `领取失败: HTTP ${resp.status} code=${code} ${cred.envelopeMessage(payload)}`,
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
 * 签到 / 领取能力（`<cid> checkin`）。
 *
 * ⚠ 上游**不是每日签到**：`daily_grant` 由服务端自动发；这里是一笔**一次性**的
 * 「登录奖励」，幂等判据是 `granted`（见 docs/protocols/raccoon/PROTOCOL.md）。
 * 所以 summary 里点明「一次性」，别让用户以为是每天能领。
 */
export const signin: SigninModule = {
  async status() {
    cred.load(); // 未登录时抛 NotLoggedInError：别把"没登录"显示成"可领"
    const claimed = await loginRewardClaimed();
    // ⚠ `loginRewardClaimed()` 查询失败**也**返回 false（它自己文档里写明"保守返回"），
    // 所以 false 只能表示"没查到领取记录"——既可能真没领过、也可能查询失败。
    // 故 claimable 用 null（"不知道"），不能报 true（那是虚假承诺）。
    return {
      claimable: claimed ? false : null,
      summary: claimed
        ? "登录奖励已领过（一次性，非每日）"
        : "没查到登录奖励记录（可能可领、也可能查询失败；checkin 会尝试领，上游幂等）",
    };
  },
  async claim() {
    const r = await claimLoginReward();
    return {
      ok: r.status === "claimed",
      summary:
        r.status === "claimed"
          ? `领取成功${r.points > 0 ? `，+${r.points}` : ""}`
          : r.status === "already-claimed"
            ? "已领过（一次性奖励）"
            : `领取失败: ${r.error ?? r.status}`,
      detail: r,
    };
  },
};
