/**
 * CatPaw 额度查询与申领（个人版网关积分中心）。
 *
 * 结论来源：`reference/HITZY2002_catpaw2api`（Go，`internal/upstream/const.go`
 * 与 `client.go` 的 CreditBalance / Register），推翻了本模块早期
 * 「网关不暴露额度端点」的错误结论 —— 额度在**个人版网关**上：
 *
 * - 查询：`GET https://catx.nocode.cn/api/gateway/credit/balance`
 * - 申领（注册奖励，幂等）：`POST https://catx.nocode.cn/api/gateway/credit/register`
 *
 * 鉴权是网关层 `X-Auth-Token: <accessToken>`（与对话用的
 * `X-Passport-Token` / Cookie 不是同一套；我们的 accessToken 就来自
 * 网关 passport poll-token，两者同源 —— 见 cred.ts）。
 */

/** 额度查询失败。 */
export class CreditsError extends Error {
  override name = "CreditsError";
  constructor(message = "credit query failed") {
    super(message);
  }
}

const GATEWAY_HOST = "https://catx.nocode.cn";
const CREDIT_BALANCE_PATH = "/api/gateway/credit/balance";
const CREDIT_REGISTER_PATH = "/api/gateway/credit/register";
/** 注册奖励的申领渠道（参考实现 RegisterChannel 常量）。 */
const REGISTER_CHANNEL = "CATPAW_PC";

function gatewayHeaders(token: string): Record<string, string> {
  return { "X-Auth-Token": token, Accept: "application/json" };
}

/** 剥信封：网关响应形如 `{code, data}`；无 code 字段时视 body 本身即 data。 */
function unwrap(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") {
    throw new CreditsError("credit response is not an object");
  }
  const env = payload as Record<string, unknown>;
  const data = env["data"];
  if (typeof env["code"] !== "undefined" && data && typeof data === "object") {
    return data as Record<string, unknown>;
  }
  return env;
}

function numOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 对外额度视图（字段与 loomy 等渠道的 CreditsResult 对齐）。 */
export interface CreditsResult {
  ok: true;
  total: {
    remain: number;
    size: number;
    used: number;
    unit: string;
    remain_percent: number;
  };
  packages: Array<Record<string, unknown>>;
  claimable: Array<Record<string, unknown>>;
}

/**
 * 查询额度：`credit/balance` 的 `availableCredits` 是**可用积分**。
 *
 * 上游只给「可用余额」，没有「已用 / 总额」字段 —— used 恒 0、size=remain
 * 是**如实映射**而不是伪造（从余额无法推出已用量）。
 */
export async function fetchCredits(
  _options: { refreshOn401?: boolean } = {},
): Promise<CreditsResult> {
  const c = cred.load(); // 未登录 → NotLoggedInError

  let payload: unknown;
  try {
    const resp = await fetch(`${GATEWAY_HOST}${CREDIT_BALANCE_PATH}`, {
      headers: gatewayHeaders(c.accessToken),
      signal: AbortSignal.timeout(30_000),
    });
    if (resp.status === 401 || resp.status === 403) {
      throw new cred.NotLoggedInError("CatPaw gateway rejected the token; please log in again");
    }
    if (resp.status !== 200) {
      throw new CreditsError(`credit balance request failed: HTTP ${resp.status}`);
    }
    payload = await resp.json();
  } catch (err) {
    if (err instanceof CreditsError || err instanceof cred.NotLoggedInError) throw err;
    throw new CreditsError(`credit balance request failed: ${String(err)}`);
  }

  const data = unwrap(payload);
  const remain = numOf(data["availableCredits"]);
  if (remain === null) {
    throw new CreditsError(`credit balance response has no availableCredits: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return {
    ok: true,
    total: { remain, size: remain, used: 0, unit: "积分", remain_percent: 100 },
    packages: [],
    claimable: [],
  };
}

/** 申领结果（register 的响应字段，见参考实现 RegisterResult）。 */
export interface RegisterResult {
  registrationBonus: number | null;
  registerBonusValueYuan: string;
  rewardExpireDays: number | null;
  rewardLastValidDate: string;
  newUser: boolean;
}

/**
 * 申领注册奖励（`credit/register`，幂等：老用户 newUser=false 不重复发放）。
 *
 * 这是「签到」在这个渠道上的对应物 —— 上游没有每日签到，只有注册奖励与活动。
 */
export async function claimRegister(): Promise<{ result: RegisterResult; raw: Record<string, unknown> }> {
  const c = cred.load();
  let payload: unknown;
  try {
    const resp = await fetch(`${GATEWAY_HOST}${CREDIT_REGISTER_PATH}`, {
      method: "POST",
      headers: { ...gatewayHeaders(c.accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({ registerChannel: REGISTER_CHANNEL }),
      signal: AbortSignal.timeout(30_000),
    });
    if (resp.status === 401 || resp.status === 403) {
      throw new cred.NotLoggedInError("CatPaw gateway rejected the token; please log in again");
    }
    if (resp.status !== 200) {
      throw new CreditsError(`credit register request failed: HTTP ${resp.status}`);
    }
    payload = await resp.json();
  } catch (err) {
    if (err instanceof CreditsError || err instanceof cred.NotLoggedInError) throw err;
    throw new CreditsError(`credit register request failed: ${String(err)}`);
  }
  const data = unwrap(payload);
  return {
    result: {
      registrationBonus: numOf(data["registrationBonus"]),
      registerBonusValueYuan: String(data["registerBonusValueYuan"] ?? ""),
      rewardExpireDays: numOf(data["rewardExpireDays"]),
      rewardLastValidDate: String(data["rewardLastValidDate"] ?? ""),
      newUser: data["newUser"] === true,
    },
    raw: data,
  };
}

// ── 签到 / 领取能力（共享层 CLI 的 `<cid> checkin` 用；契约要求**每个渠道都提供**）──────

import * as cred from "./cred.js";
import type { SigninModule } from "@modelmux/gateway";

/**
 * 签到 / 领取能力（`<cid> checkin`）。
 *
 * 上游没有**每日**签到端点；这里的「领取」对应注册奖励申领（幂等，
 * 领过就 newUser=false），能领的时候会真实入账。
 */
export const signin: SigninModule = {
  async status() {
    return {
      claimable: true,
      summary: "存在注册奖励申领端点（credit/register，幂等；上游没有每日签到）",
    };
  },
  async claim() {
    const { result } = await claimRegister();
    const bonus = result.registrationBonus;
    const summary = result.newUser
      ? `注册奖励已入账：+${bonus ?? "?"} 积分（价值 ¥${result.registerBonusValueYuan || "?"}，${result.rewardExpireDays ?? "?"} 天有效）`
      : `该账号已是注册老用户，无新奖励可领（newUser=false）`;
    return { ok: true, summary };
  },
};
