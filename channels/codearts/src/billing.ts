/**
 * CodeArts 额度查询与活动领取（全部走 SDK-HMAC-SHA256 签名，直连 snap-access）。
 *
 * ## 为什么不用官方文档给的 portal 路径
 *
 * `codearts.huaweicloud.com/portal/...` 是 portal BFF，**依赖浏览器会话 Cookie**：
 * 实测不带 Cookie 时无论是否带 AK/SK 签名都返回 IAM 登录跳转 HTML（HTTP 200 +
 * `text/html`）。IDE 直连的 snap-access 端点接受签名，故走这条路径。
 *
 * ## 三个端点的信封形态不同（逐字实现）
 *
 * - `statistics/plugin` —— **裸对象，无 `{code,data}` 信封**（`PackageInfoService`
 *   直接 `toPackageInfo(JSON.parse(body))`）
 * - `ops/delivery` / `ops/claim` / `ops/confirm` —— `{code, message, data}`，
 *   `code !== 0` 即业务失败
 *
 * ## 两个真实缺陷（字段名/类型都错过的坑）
 *
 * 1. **`campaignId` 是数字**（实测 `1`）。用只接受字符串的解析会得到空串 →
 *    领取判 `failed`「活动缺少 campaignId」（用户看到「1 个失败」而积分没领到）。
 * 2. **可领积分字段是 `benefitAmount`**（实测 1000），**不是** `amount`；
 *    读错恒为 0。
 * 3. 不可领取活动的 `status` 是 **`null`**，解析要能容忍。
 */

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

/** 账户/套餐信息端点（积分账户检测的唯一真相源）。 */
export const PACKAGE_INFO_PATH = "/snap-manager/v1/statistics/plugin";
/** 活动列表端点。 */
export const OPS_DELIVERY_PATH = "/v1/ops/delivery";
/** 领取端点。 */
export const OPS_CLAIM_PATH = "/v1/ops/claim";
/** 领取确认端点。 */
export const OPS_CONFIRM_PATH = "/v1/ops/confirm";
/** 渠道标识（声明请求来自 IDE 形态）。 */
export const OPS_CHANNEL = "IDE";
/** 「每日签到得积分」在活动列表里的 `type` 取值。 */
export const DAILY_LOGIN_TYPE = "USER_LOGIN";

/**
 * 签名后追加的附加头（**绝不参与签名**）。
 *
 * ⚠️ 实测（2026-09-18 真实凭据）：`Agent-Type` 一旦进入 canonical request 与
 * SignedHeaders，服务端回 `401 {"error_code":"APIG.0301",...verify ak sk
 * signature fail}`；同一个头在**签名之后**追加则 200。
 */
export const SNAP_EXTRA_HEADERS: Readonly<Record<string, string>> = {
  "Agent-Type": "PromptCenter",
  "X-Language": "zh-cn",
};

/** 「已领取/已确认/已核销」三种状态（UI 里领取按钮在这三态下禁用）。 */
export const CLAIMED_STATUSES: readonly string[] = ["CLAIMED", "CONFIRMED", "CONSUMED"];

const REQUEST_TIMEOUT_MS = 30_000;

/** 积分 metric 名 → 展示名。 */
const CREDIT_METRIC_LABELS: Readonly<Record<string, string>> = {
  usageTotalPackageCredit: "总积分包",
  usageBasicPackageCredit: "基础积分包",
  usageOnDemandPackageCredit: "按需积分包",
  usageBonusPackageCredit: "赠送积分包",
};
/** 总额 metric 名（**不累加分类明细**，否则重复计算）。 */
const TOTAL_CREDIT_METRIC = "usageTotalPackageCredit";

/** 额度查询失败（未登录 / 上游拒绝 / 网络错误 / 查不到）。 */
export class CreditsError extends Error {
  override name = "CreditsError";
}

/** 一个资源包。 */
export interface CreditPackage {
  name: string;
  remain: number;
  size: number;
  used: number;
  unit: string;
  /** 该端点不下发周期字段，如实留空（**不臆造到期时间**）。 */
  cycle_start?: string;
  cycle_end?: string;
  days_left?: number | null;
}

export interface CreditsResult {
  ok: true;
  account?: {
    uid: string;
    domain: string;
    isCreditPackage: boolean;
    packageName: string;
  };
  total: {
    remain: number;
    size: number;
    used: number;
    unit: string;
    remain_percent: number;
  };
  packages: CreditPackage[];
  /** 当前可领取的活动（含 `campaignId` 字符串化后的值）。 */
  claimable?: Array<Record<string, unknown>>;
}

/** 一条活动。 */
export interface OpsActivity {
  /** ⚠️ 服务端下发的是**数字**，这里统一成字符串（回传服务端所需形态）。 */
  campaignId: string;
  type: string;
  title: string;
  claimable: boolean;
  /** ⚠️ 不可领取时可能是 `null`。 */
  status: string;
  /** ⚠️ 字段名是 `benefitAmount`（不是 `amount`）。 */
  amount: number;
}

/** 一次领取的结果。 */
export interface ClaimOutcome {
  campaignId: string;
  ok: boolean;
  /** 今天/本活动已经领过（预检判定，**没有发请求**）。 */
  already: boolean;
  confirmed: boolean;
  amount: number;
  code: string;
  message: string;
}

/** 从 JSON 安全读取字符串。 */
function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * 读取标识符并统一成字符串（兼容数字与字符串）。
 *
 * 专门为 `campaignId` 而生：华为侧对同一语义字段的类型并不一致，
 * 只接受字符串会得到空串（真实缺陷）。
 */
export function readIdentifier(source: Record<string, unknown>, key: string): string {
  return str(source[key]);
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function readBool(source: Record<string, unknown>, key: string): boolean {
  const value = source[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return false;
}

function readRecord(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 把非 2xx 响应整理成**带服务端原因**的说明（`APIG.0301` 这类线索不能丢）。 */
export function describeHttpFailure(status: number, text: string): string {
  let detail = "";
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    detail = [str(parsed["error_code"]), str(parsed["error_msg"])].filter(Boolean).join(" ");
  } catch {
    detail = text.trim().slice(0, 200);
  }
  return detail ? `HTTP ${status}：${detail}` : `HTTP ${status}`;
}

/** 解包响应：`{code,message,data}` 信封，或**裸对象**（statistics/plugin）。 */
export function unwrapEnvelope(
  raw: Record<string, unknown>,
): { ok: true; data: Record<string, unknown> } | { ok: false; code: number; message: string } {
  const code = raw["code"];
  if (typeof code === "number") {
    if (code !== 0) {
      const message = str(raw["message"]) || str(raw["msg"]);
      return { ok: false, code, message: message || `业务码 ${code}` };
    }
    const data = raw["data"];
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return { ok: true, data: data as Record<string, unknown> };
    }
    return { ok: false, code, message: "响应缺少 data 字段" };
  }
  // 无 code 字段：裸对象形态（statistics/plugin）。
  return { ok: true, data: raw };
}

/** 拼出 snap-access 基址（优先已保存配置，便于自托管/测试）。 */
function snapBase(): string {
  const [cfg] = upstream.loadConfig();
  return (cfg.baseUrl || upstream.DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** 发起一次带签名的 snap-access 请求。 */
async function signedRequest(
  method: "GET" | "POST",
  path: string,
  c: upstream.AuthLike,
  body?: string,
): Promise<Record<string, unknown>> {
  const url = `${snapBase()}${path}`;
  const signed = upstream.signRequest({
    method,
    url,
    ...(body === undefined ? {} : { body }),
    ak: c.accessKeyId,
    sk: c.secretAccessKey,
    securityToken: c.securityToken,
  });
  const headers = upstream.withoutHost(signed);
  // 签名**之后**追加（进签名会 401 APIG.0301）。
  Object.assign(headers, SNAP_EXTRA_HEADERS);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CreditsError(`请求失败: ${String(err)}`);
  }
  const text = await resp.text().catch(() => "");
  if (resp.status === 401 || resp.status === 403) {
    throw new cred.NotLoggedInError(describeHttpFailure(resp.status, text));
  }
  if (!resp.ok) throw new CreditsError(describeHttpFailure(resp.status, text));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CreditsError("响应不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CreditsError("响应不是 JSON 对象");
  }
  const rec = parsed as Record<string, unknown>;
  const unwrapped = unwrapEnvelope(rec);
  if (!unwrapped.ok) throw new CreditsError(unwrapped.message);
  return unwrapped.data;
}

/** 账户/套餐信息（含积分账户判定）。 */
export interface AccountInfo {
  isCreditPackage: boolean;
  isTokenPackage: boolean;
  specCode: string;
  packageName: string;
  packageStatus: string;
  /** 积分口径存在时才给出（无 metric 时为 undefined，与 `total: 0` 严格区分）。 */
  total?: { remain: number; used: number };
  packages: CreditPackage[];
}

/** 解析账户/套餐信息（纯函数，便于测试）。 */
export function parseAccountInfo(data: Record<string, unknown>): AccountInfo {
  const pkg = readRecord(data, "package");
  const metrics = Array.isArray(data["metrics"]) ? data["metrics"] : [];
  const packages: CreditPackage[] = [];
  let totalRemain: number | undefined;
  let totalUsed: number | undefined;
  let sawCreditMetric = false;

  for (const item of metrics) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = str(record["name"]);
    const label = CREDIT_METRIC_LABELS[name];
    if (label === undefined) continue;
    sawCreditMetric = true;
    const amount = readNumber(record, "package_credit_amount");
    const used = readNumber(record, "package_credit_used");
    const remain = readNumber(record, "package_credit_remain");
    if (name === TOTAL_CREDIT_METRIC) {
      totalRemain = remain;
      totalUsed = used;
    }
    // 额度为 0 的分类不列（列出来只会让「N 个资源包」虚高）。
    if (amount <= 0 && remain <= 0) continue;
    packages.push({ name: label, remain, size: amount, used, unit: "credit" });
  }

  const info: AccountInfo = {
    isCreditPackage: readBool(pkg, "is_credit_package"),
    isTokenPackage: readBool(pkg, "is_token_package"),
    specCode: str(pkg["spec_code"]),
    packageName: str(pkg["package_name_cn"]) || str(pkg["package_name_en"]),
    packageStatus: str(pkg["status"]),
    packages,
  };
  if (sawCreditMetric) {
    // 总额取总 metric 的 remain/used，**不累加分类明细**（分类是总额的构成，
    // 相加会重复计算）；总额 metric 缺失才回退分类求和。
    const remain = totalRemain ?? packages.reduce((sum, p) => sum + p.remain, 0);
    const used = totalUsed ?? packages.reduce((sum, p) => sum + p.used, 0);
    info.total = { remain, used };
  }
  return info;
}

/** 查询账户/套餐信息（签名 GET）。 */
export async function fetchAccountInfo(c: upstream.AuthLike): Promise<AccountInfo> {
  const data = await signedRequest("GET", PACKAGE_INFO_PATH, c);
  return parseAccountInfo(data);
}

/** 拉取活动列表（签名 GET，`channel=IDE`）。 */
export async function fetchActivities(c: upstream.AuthLike): Promise<OpsActivity[]> {
  const data = await signedRequest("GET", `${OPS_DELIVERY_PATH}?channel=${OPS_CHANNEL}`, c);
  const items = Array.isArray(data["items"]) ? data["items"] : [];
  const out: OpsActivity[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    out.push({
      campaignId: readIdentifier(rec, "campaignId"),
      type: str(rec["type"]),
      title: str(rec["title"]),
      claimable: readBool(rec, "claimable"),
      // 不可领取时 status 可能是 null —— 这里收敛成空串，语义由 claimable 表达。
      status: str(rec["status"]),
      // ⚠️ benefitAmount 才是可领积分，amount 恒为 0。
      amount: readNumber(rec, "benefitAmount"),
    });
  }
  return out;
}

/**
 * 领取一个活动（claim + 必要时 confirm）。
 *
 * `claim` 响应 `data.id !== null && !== undefined` 时必须补发 `confirm` ——
 * 漏掉这一步积分会停在「待确认」不入账。
 */
export async function claimCampaign(c: upstream.AuthLike, activity: OpsActivity): Promise<ClaimOutcome> {
  if (!activity.campaignId) {
    return {
      campaignId: "",
      ok: false,
      already: false,
      confirmed: false,
      amount: 0,
      code: "missing-campaign-id",
      message: "活动缺少 campaignId，无法领取",
    };
  }
  if (!activity.claimable && CLAIMED_STATUSES.includes(activity.status)) {
    return {
      campaignId: activity.campaignId,
      ok: true,
      already: true,
      confirmed: false,
      amount: 0,
      code: "already-claimed",
      message: "今天已经领过了",
    };
  }
  const data = await signedRequest(
    "POST",
    OPS_CLAIM_PATH,
    c,
    JSON.stringify({ campaignId: activity.campaignId, channel: OPS_CHANNEL }),
  );
  // 仅在服务端要求确认时补发（data.id 非空）。
  const id = data["id"];
  let confirmed = false;
  if (id !== null && id !== undefined) {
    await signedRequest("POST", OPS_CONFIRM_PATH, c, JSON.stringify({ campaignId: activity.campaignId }));
    confirmed = true;
  }
  return {
    campaignId: activity.campaignId,
    ok: true,
    already: false,
    confirmed,
    amount: activity.amount,
    code: "claimed",
    message: "领取成功",
  };
}

/** 领取全部「每日签到」活动（预检 + 逐个领取）。 */
export async function claimDailyLogin(c: upstream.AuthLike): Promise<ClaimOutcome[]> {
  const activities = await fetchActivities(c);
  const out: ClaimOutcome[] = [];
  for (const activity of activities) {
    if (activity.type !== DAILY_LOGIN_TYPE) continue;
    out.push(await claimCampaign(c, activity));
  }
  return out;
}

/**
 * 查询积分余额（含可领活动）。
 *
 * 401/403 时（默认）刷新一次凭据再试。**「查不到」抛 `CreditsError`，绝不返回 0**：
 * 无任何 credit metric（Token 计费账户）与「余额为 0」是两件事。
 */
export async function fetchCredits(
  options: { refreshOn401?: boolean } = {},
): Promise<CreditsResult> {
  const { refreshOn401 = true } = options;
  let c = cred.load();

  const load = async (): Promise<AccountInfo> => {
    try {
      return await fetchAccountInfo(c);
    } catch (err) {
      if (!(err instanceof cred.NotLoggedInError) || !refreshOn401) throw err;
      c = await cred.refresh(c);
      return fetchAccountInfo(c);
    }
  };

  const info = await load();
  if (!info.total) {
    throw new CreditsError(
      info.isTokenPackage
        ? "该账号是 Token 计费账户，没有积分口径（查不到，不等于余额为 0）"
        : "上游未返回任何积分 metric（查不到，不等于余额为 0）",
    );
  }

  const remain = Math.max(0, info.total.remain);
  const used = Math.max(0, info.total.used);
  const size = remain + used;
  const percent = size > 0 ? (remain / size) * 100 : 0;
  const result: CreditsResult = {
    ok: true,
    account: {
      uid: c.uid,
      domain: c.domain,
      isCreditPackage: info.isCreditPackage,
      packageName: info.packageName,
    },
    total: {
      remain: Math.round(remain * 100) / 100,
      size: Math.round(size * 100) / 100,
      used: Math.round(used * 100) / 100,
      unit: "credit",
      remain_percent: Math.round(percent * 10) / 10,
    },
    packages: info.packages,
  };

  // 活动列表是**尽力而为**：活动服务不可用时不该让余额查询整体失败。
  try {
    const activities = await fetchActivities(c);
    result.claimable = activities
      .filter((activity) => activity.type === DAILY_LOGIN_TYPE)
      .map((activity) => ({
        campaign_id: activity.campaignId,
        title: activity.title,
        claimable: activity.claimable,
        status: activity.status,
        amount: activity.amount,
      }));
  } catch {
    /* 省略 claimable 字段 */
  }
  return result;
}
