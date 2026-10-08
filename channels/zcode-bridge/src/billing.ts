/**
 * ZCode 额度：`billing/balance`（余额）+ `billing/preview`（可领活动预览）。
 *
 * ## 实测要点（docs/protocols/zcode/PROTOCOL.md §6）
 *
 * - **计量单位是 token**：上游明确下发 `unit_type: "token"`（`94.54M` tokens，
 *   不是「积分」）。早期把它当泛化积分渲染，界面会显示 `94539275` 这种无单位数字。
 * - **`Authorization` 与 `X-Device-Mid` 都是硬需求**：缺 Authorization 得 401，
 *   缺 `X-Device-Mid` 得 **400 `{"code":3001,"msg":"parameter error"}`**。
 * - **`preview` 的内容依赖客户端活跃信号**：服务端不会主动推送活动；
 *   必须先补 `POST /api/v1/event/report` 的 `app_launch` / `app_daily_active`
 *   两条事件，preview 才可能给出 plan。故本模块导出 `reportActivity()`，
 *   **领取流程**（claim）需要先调用它 —— 但 claim 本身需要阿里云 captcha
 *   （网页 SDK 无感验证），本模块不实现，见文末说明。
 *
 * ⚠ 「查不到」不能显示成 0：失败一律抛 `CreditsError`。
 * ⚠ 未登录抛 `cred.NotLoggedInError`。
 */

import type { Credentials } from "./cred.js";
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

const BALANCE_PATH = "/api/v1/zcode-plan/billing/balance";
const PREVIEW_PATH = "/api/v1/zcode-plan/billing/preview";
const EVENT_REPORT_PATH = "/api/v1/event/report";

const HTTP_TIMEOUT_MS = 20_000;

/** 额度查询失败（上游拒绝 / 网络错误 / 响应形状无法解析）。 */
export class CreditsError extends Error {
  override name = "CreditsError";
}

/** 一个额度桶。 */
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
  account: { uid: string; domain: string };
  total: {
    remain: number;
    size: number;
    used: number;
    unit: string;
    remain_percent: number;
  };
  packages: CreditPackage[];
  /** 可领活动（preview 的 plans）。需要先 `reportActivity()` 才可能非空。 */
  claimable?: Array<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 宽容取数：先精确字段后粗略字段，都取不到返回 null（不编造数字）。 */
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

/** base url：凭据带 domain 时切到该域（登录域与默认域可能不同）。 */
function baseUrlFor(c: Credentials): string {
  const [cfg] = upstream.loadConfig();
  if (c.domain && c.domain !== upstream.hostOf(cfg.baseUrl)) return `https://${c.domain}`;
  return cfg.baseUrl.replace(/\/+$/, "");
}

async function getJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  let resp: Response;
  try {
    resp = await fetch(url, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (err) {
    throw new CreditsError(`billing 请求失败: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new cred.NotLoggedInError("billing 端点拒绝了访问令牌（401/403）");
  }
  if (resp.status !== 200) throw new CreditsError(`billing 端点返回 HTTP ${resp.status}`);
  let body: unknown;
  try {
    body = await resp.json();
  } catch (err) {
    throw new CreditsError(`billing 响应不是合法 JSON: ${String(err)}`);
  }
  return { status: resp.status, body: isRecord(body) ? body : null };
}

/** 业务信封校验：401/1002 = 凭据失效；其它非 0 = 上游错误。 */
function unwrap(body: Record<string, unknown> | null, what: string): Record<string, unknown> {
  if (!body) throw new CreditsError(`${what} 响应不是 JSON 对象`);
  const code = body["code"];
  if (code === 401 || code === 1002) {
    throw new cred.NotLoggedInError(`上游凭据失效（${what} code=${String(code)}）`);
  }
  if (code !== undefined && code !== 0) {
    throw new CreditsError(`${what} 返回 code=${String(code)} msg=${String(body["msg"] ?? "")}`);
  }
  const data = body["data"];
  return isRecord(data) ? data : body;
}

/**
 * 在响应里找额度桶。
 *
 * 上游明确下发的桶字段是
 * `{meter:"model_usage", unit_type:"token", total_units, used_units, remaining_units}`，
 * 但信封层数未在规格中固定，故按候选路径逐个探测（data / balance / model_usage /
 * buckets[] / balances[]），命中第一个含单位字段的对象。
 */
function pickBucket(data: Record<string, unknown>): Record<string, unknown> | null {
  const candidates: Array<Record<string, unknown>> = [data];
  for (const key of ["balance", "model_usage", "usage"]) {
    const nested = data[key];
    if (isRecord(nested)) candidates.push(nested);
  }
  for (const key of ["buckets", "balances", "meters"]) {
    const list = data[key];
    if (Array.isArray(list)) {
      for (const item of list) if (isRecord(item)) candidates.push(item);
    }
  }
  const looksLikeBucket = (rec: Record<string, unknown>): boolean =>
    num(rec, "remaining_units", "total_units", "used_units", "remaining", "total") !== null;
  // 优先 meter = model_usage 的桶
  for (const rec of candidates) {
    if (looksLikeBucket(rec) && str(rec, "meter") === "model_usage") return rec;
  }
  for (const rec of candidates) if (looksLikeBucket(rec)) return rec;
  return null;
}

/** 从 preview 的 plans 里取出可领条目（保留原始字段 + 统一的 id）。 */
function toClaimable(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const plans = data["plans"];
  if (!Array.isArray(plans)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const plan of plans) {
    if (!isRecord(plan)) continue;
    const id = str(plan, "plan_id", "id", "campaign_id");
    out.push({ ...plan, id: id || "unknown-plan" });
  }
  return out;
}

/**
 * 查询账号额度。
 *
 * @param options.refreshOn401 余额端点 401 时先做一次凭据有效性探测再重试
 *   （ZCode 没有续期端点，refresh 只是探测；探测失败会抛错）。
 */
export async function fetchCredits(
  options: { refreshOn401?: boolean } = {},
): Promise<CreditsResult> {
  const { refreshOn401 = true } = options;
  let c = cred.load();
  const base = baseUrlFor(c);

  const fetchBalance = async (current: Credentials): Promise<Record<string, unknown>> => {
    const headers = upstream.buildHeaders(current);
    const { body } = await getJson(`${base}${BALANCE_PATH}`, headers);
    return unwrap(body, "billing/balance");
  };

  let data: Record<string, unknown>;
  try {
    data = await fetchBalance(c);
  } catch (err) {
    if (!(err instanceof cred.NotLoggedInError) || !refreshOn401) throw err;
    c = await cred.refresh(c); // 失效会抛，交由调用方提示重新登录
    data = await fetchBalance(c);
  }

  const bucket = pickBucket(data);
  if (!bucket) {
    throw new CreditsError(
      "billing/balance 响应里找不到额度桶（期望含 total_units/used_units/remaining_units）",
    );
  }
  const size = num(bucket, "total_units", "total") ?? 0;
  const used = num(bucket, "used_units", "used") ?? 0;
  const remain = num(bucket, "remaining_units", "remaining") ?? Math.max(size - used, 0);
  const unit = str(bucket, "unit_type", "unit") || "token";

  const pkg: CreditPackage = {
    name: str(bucket, "meter", "name") || "model_usage",
    remain,
    size,
    used,
    unit,
    days_left: null, // 余额桶不下发到期时间；不编造
  };

  const result: CreditsResult = {
    ok: true,
    account: { uid: c.uid, domain: c.domain },
    total: {
      remain,
      size,
      used,
      unit,
      remain_percent: size > 0 ? Math.round((remain / size) * 1000) / 10 : 0,
    },
    packages: [pkg],
  };

  // preview 是**不需要 Authorization** 的端点（但仍需 X-Device-Mid）；
  // 它只是「可领活动预览」，失败不影响余额结论。
  try {
    const headers = upstream.buildHeaders(c, undefined, { authorization: false });
    const { body } = await getJson(`${base}${PREVIEW_PATH}`, headers);
    const previewData = unwrap(body, "billing/preview");
    result.claimable = toClaimable(previewData);
  } catch {
    /* 预览不可用则不附 claimable（不伪造空列表之外的任何结论） */
  }
  return result;
}

/**
 * 补客户端活跃上报。
 *
 * ⚠ 服务端**不会主动推送**活动：`preview` 的内容依赖客户端活跃信号。
 * 实测「补两条事件之前 preview 恒空，补之后才给出 plan」⇒ 领取流程必须先调本函数。
 */
export async function reportActivity(c: Credentials = cred.load()): Promise<void> {
  const base = baseUrlFor(c);
  // preview / event report 都不需要用户凭据，但 device_mid 是硬需求
  const headers = upstream.buildHeaders(c, undefined, { authorization: false });
  for (const event of ["app_launch", "app_daily_active"]) {
    const resp = await fetch(`${base}${EVENT_REPORT_PATH}`, {
      method: "POST",
      body: JSON.stringify({ event }),
      headers,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    }).catch((err: unknown) => {
      throw new CreditsError(`event/report 请求失败: ${String(err)}`);
    });
    if (resp.status !== 200) {
      throw new CreditsError(`event/report(${event}) 返回 HTTP ${resp.status}`);
    }
  }
}

/*
 * ## 为什么不实现「一键领取」（claim）
 *
 * `POST /zcode-plan/billing/claim` 始终索要阿里云 captcha（缺则 400 code 3007），
 * 且校验**前置于** plan 校验；captcha 是**网页 SDK 的无感验证**
 * （AliyunCaptcha.js + headful 浏览器，`--headless=new` 过不了）。
 * 在一个零依赖 Node 模块里伪造验证头只会得到 3007，所以本模块只提供
 * 「可领活动预览」（claimable）与补活跃上报（reportActivity），
 * 领取动作留给能打开浏览器的调用方。
 */
