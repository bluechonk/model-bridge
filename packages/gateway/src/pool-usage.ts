/**
 * 渠道账本：**账单已用量**（排序主键）＋ 请求成败（失败冷却）。
 *
 * ## 为什么不是「请求次数」
 *
 * 上游账单里没有任何渠道提供请求计数 —— 只有额度（积分 / credits / 美元），
 * 经共享接口 `CreditsResult.total.used` 暴露。所以排序取「**账单已用量**降序」：
 * 用得最多的渠道优先。各家单位不同，跨渠道横比只是近似（这是刻意的取舍：
 * 换来的是零额外网络开销 + 跨渠道统一）。
 *
 * ## 为什么要落盘 + 缓存
 *
 * 查账单要联网、要凭据、部分渠道还很慢。一天查两三次足够，所以结果落在
 * `<root>/pool-usage.json`，TTL 8 小时；到期后由**后台**异步刷新，
 * 绝不阻塞正在处理的请求（见 `maybeRefreshBilling`）。
 *
 * ## 失败当 0
 *
 * `scoreOf()` 里，处于冷却期的渠道得分**当 0** —— 这正是「请求失败的直接当为 0」
 * 的落地：坏渠道不抢，冷却到期自动回来，不永久惩罚。成功一次即清冷却。
 */

import { existsSync, readFileSync } from "node:fs";

import { channels, type Channel } from "./channel.js";
import { runInChannel } from "./channel-context.js";
import { poolUsagePath } from "./paths.js";
import { writeJsonSecret } from "./secret-file.js";

/** 账单缓存有效期：8 小时 ≈ 一天三次。 */
export const BILLING_TTL_MS = 8 * 60 * 60 * 1000;

/** 失败后的冷却时长（冷却期内得分当 0）。 */
export const FAIL_COOLDOWN_MS = 60 * 1000;

/** 单个渠道的账本条目。 */
export interface ChannelLedger {
  /** 账单已用量（排序主键）；查不到时是 0。 */
  used: number;
  /** 账单总额度（展示用）。 */
  size: number;
  /** 账单剩余（展示用）。 */
  remain: number;
  /** 账单单位（各渠道不同：积分 / credits / USD）。 */
  unit: string;
  /** 最近一次账单查询的**尝试**时刻（ISO）；成功失败都更新，用它判 TTL。 */
  billing_at: string | null;
  /** 最近一次账单查询是否成功。 */
  billing_ok: boolean;
  /** 本地成功转发次数（诊断用，**不**参与排序）。 */
  ok: number;
  /** 本地失败次数（诊断用）。 */
  fail: number;
  /** 冷却截止（epoch ms）；0 = 未冷却。 */
  cooldown_until: number;
}

export interface PoolLedger {
  version: 1;
  channels: Record<string, ChannelLedger>;
}

/** 空条目。 */
function emptyChannel(): ChannelLedger {
  return {
    used: 0,
    size: 0,
    remain: 0,
    unit: "",
    billing_at: null,
    billing_ok: false,
    ok: 0,
    fail: 0,
    cooldown_until: 0,
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 读盘结果按路径缓存（测试会切存储根，故缓存键带上路径）。 */
let cache: { path: string; ledger: PoolLedger } | null = null;

/** 惰性加载账本（文件缺失 / 损坏都退回空账本，**不阻塞**）。 */
function load(): PoolLedger {
  const path = poolUsagePath();
  if (cache && cache.path === path) return cache.ledger;
  let ledger: PoolLedger = { version: 1, channels: {} };
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PoolLedger>;
      if (raw && typeof raw === "object" && raw.channels && typeof raw.channels === "object") {
        const merged: Record<string, ChannelLedger> = {};
        for (const [cid, entry] of Object.entries(raw.channels)) {
          const base = emptyChannel();
          const rec = (entry ?? {}) as Partial<ChannelLedger>;
          merged[cid] = {
            used: num(rec.used),
            size: num(rec.size),
            remain: num(rec.remain),
            unit: str(rec.unit),
            billing_at: typeof rec.billing_at === "string" ? rec.billing_at : null,
            billing_ok: rec.billing_ok === true,
            ok: num(rec.ok),
            fail: num(rec.fail),
            cooldown_until: num(rec.cooldown_until),
          };
        }
        ledger = { version: 1, channels: merged };
      }
    } catch {
      ledger = { version: 1, channels: {} };
    }
  }
  cache = { path, ledger };
  return ledger;
}

/** 取（必要时创建）某渠道的条目。 */
function entryOf(ledger: PoolLedger, cid: string): ChannelLedger {
  const existing = ledger.channels[cid];
  if (existing) return existing;
  const created = emptyChannel();
  ledger.channels[cid] = created;
  return created;
}

/** 落盘节流：高频请求下不每次写盘。 */
const SAVE_DEBOUNCE_MS = 1000;
let saveTimer: NodeJS.Timeout | null = null;

/** 立即落盘（CLI / 测试用；每次写盘都同步、原子）。 */
export function flushLedger(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    writeJsonSecret(poolUsagePath(), load());
  } catch {
    /* 写不进去不该让请求失败：账本丢了只影响排序精度 */
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushLedger();
  }, SAVE_DEBOUNCE_MS);
  // 计时器不该拖住进程退出
  saveTimer.unref?.();
}

/**
 * 渠道的排序得分：冷却期内**当 0**，否则是账单已用量。
 *
 * 得分只用于排序，不做剔除 —— 所有渠道都在冷却时仍然会按注册顺序尝试，
 * 服务不会因为冷却而不可用。
 */
export function scoreOf(cid: string, now = Date.now()): number {
  const entry = entryOf(load(), cid);
  if (entry.cooldown_until > now) return 0;
  return entry.used;
}

/** 一次成功转发：清冷却（失败计数不动）。 */
export function noteSuccess(cid: string): void {
  const entry = entryOf(load(), cid);
  entry.ok += 1;
  entry.cooldown_until = 0;
  scheduleSave();
}

/** 一次失败：进冷却（冷却期内得分当 0）。 */
export function noteFailure(cid: string, cooldownMs = FAIL_COOLDOWN_MS): void {
  const entry = entryOf(load(), cid);
  entry.fail += 1;
  entry.cooldown_until = Date.now() + cooldownMs;
  scheduleSave();
}

/** 写入一次账单查询结果（成功时）。 */
export function writeBilling(cid: string, credits: unknown): void {
  const total = (credits as { total?: Record<string, unknown> } | null)?.total ?? {};
  const entry = entryOf(load(), cid);
  entry.used = num(total["used"]);
  entry.size = num(total["size"]);
  entry.remain = num(total["remain"]);
  entry.unit = str(total["unit"]);
  entry.billing_at = new Date().toISOString();
  entry.billing_ok = true;
  scheduleSave();
}

/** 标记一次账单查询尝试（失败时只更新时刻，保留上一次的用量数字）。 */
function noteBillingAttempt(cid: string, ok: boolean): void {
  const entry = entryOf(load(), cid);
  entry.billing_at = new Date().toISOString();
  entry.billing_ok = ok;
  scheduleSave();
}

/** 只读快照（CLI / 诊断用）。 */
export function ledgerSnapshot(): PoolLedger {
  return load();
}

/** 是否需要刷新账单（任一渠道从没查过，或已过 TTL）。 */
export function needsBillingRefresh(now = Date.now()): boolean {
  const ledger = load();
  for (const channel of channels()) {
    const cid = channel.config.cid;
    const entry = ledger.channels[cid];
    if (!entry || !entry.billing_at) return true;
    const at = Date.parse(entry.billing_at);
    if (!Number.isFinite(at) || now - at > BILLING_TTL_MS) return true;
  }
  return false;
}

/** 正在跑的刷新（同一时刻只允许一个，避免请求风暴下重复联网查账单）。 */
let inFlight: Promise<RefreshResult> | null = null;

export interface RefreshResult {
  /** 查到账单的渠道。 */
  refreshed: string[];
  /** 查失败的渠道及原因。 */
  failed: Array<{ cid: string; error: string }>;
}

/** 查一轮账单（并行；不抛错，失败只记在返回值与账本里）。 */
async function runRefresh(logger: (m: string) => void): Promise<RefreshResult> {
  const list = channels();
  const result: RefreshResult = { refreshed: [], failed: [] };
  const settled = await Promise.allSettled(
    list.map(async (channel: Channel) => {
      const cid = channel.config.cid;
      const credits = await runInChannel(cid, () =>
        channel.billing.fetchCredits({ refreshOn401: true }),
      );
      return { cid, credits };
    }),
  );
  settled.forEach((item, index) => {
    const cid = list[index]!.config.cid;
    if (item.status === "fulfilled") {
      writeBilling(cid, item.value.credits);
      result.refreshed.push(cid);
    } else {
      const error = String(item.reason);
      noteBillingAttempt(cid, false);
      result.failed.push({ cid, error });
      logger(`账单查询失败（${cid}）: ${error}`);
    }
  });
  flushLedger();
  return result;
}

/**
 * 立刻刷新一轮账单（CLI `model refresh` 用；等待完成）。
 *
 * 同一时刻只跑一个：重复调用共享同一个 Promise。
 */
export function refreshBilling(logger: (m: string) => void = () => {}): Promise<RefreshResult> {
  if (inFlight) return inFlight;
  inFlight = runRefresh(logger).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * 需要就后台刷新（请求路径调用；**不等待**）。
 *
 * 判定只看内存里缓存的时刻，不读盘、不联网 —— 绝大多数请求在这里一次比较就返回。
 */
export function maybeRefreshBilling(logger: (m: string) => void = () => {}): void {
  if (inFlight) return;
  if (!needsBillingRefresh()) return;
  void refreshBilling(logger).catch((err: unknown) => logger(`账单刷新异常: ${String(err)}`));
}

/** **仅供测试**：清空内存缓存（切存储根 / 隔离用例）。 */
export function resetPoolLedgerForTest(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  inFlight = null;
  cache = null;
}
