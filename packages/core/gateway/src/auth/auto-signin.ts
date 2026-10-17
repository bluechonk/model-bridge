/**
 * 自动签到调度器：网关 running 后逐渠道尝试每日签到。
 *
 * ## 触发规则
 *
 * - 网关启动（`runServe` 里网关进入 running）后触发一轮；此后每 `CHECK_INTERVAL_MS`
 *   轮询一次，捕获「网关跨天常驻」的场景（凌晨新的一天到来时自动补签）。
 * - **未登录渠道直接跳过**：不发任何网络请求（风控要求：登录必须用户主动触发）。
 * - **台账已签（今天）跳过**：本地台账（`state/signin.json`）记着今天领过，
 *   不再问上游 —— 状态登记在领取成功/上游回填时由签到链路自己完成。
 * - **单渠道连败 3 次 → 当日熔断**：失败计数落盘 `state/auto-signin.json`
 *   （跨重启累计；守护进程随时可能被 restart，内存计数撑不住）。日期翻篇自动清零。
 *
 * ## 与手动 `checkin` 的关系
 *
 * 完全复用 `signin.status()` / `signin.claim()` 契约，不做任何渠道特判；
 * 成功记账走同一个 `recordClaim`，所以 `checkin --status` 与 `mx status` 的
 * 签到摘要对自动签到天然可见。
 */

import { channels, type Channel, type SigninStatus } from "../runtime/channel.js";
import { runInChannel } from "../runtime/channel-context.js";
import { readFileSync } from "node:fs";
import { ensureStateDir, stateDir } from "../runtime/paths.js";
import { claimedTodayPerLedger, recordClaim } from "./signin-ledger.js";
import { writeJsonSecret } from "../runtime/secret-file.js";

/** 轮询间隔：签到是低频事件，30 分钟足够跨天补签（凌晨 0 点后 30 分钟内补上）。 */
export const CHECK_INTERVAL_MS = 30 * 60 * 1000;
/** 单渠道当日失败熔断阈值。 */
export const MAX_FAILURES_PER_DAY = 3;

/** 失败计数落盘结构：`{ [cid]: { date, failures } }`，只留当天的。 */
interface FailureState {
  date: string;
  failures: number;
}

function failurePath(cid: string): string {
  return `${stateDir(cid)}/auto-signin.json`;
}

function today(): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** 读失败计数（日期不是今天视为 0）；文件缺失/损坏返回 0。 */
export function readFailures(cid: string): number {
  try {
    const parsed = JSON.parse(readFileSync(failurePath(cid), "utf8")) as Partial<FailureState>;
    if (parsed.date === today()) return typeof parsed.failures === "number" ? parsed.failures : 0;
  } catch {
    /* 无记录 */
  }
  return 0;
}

function writeFailures(cid: string, failures: number): void {
  try {
    ensureStateDir(cid);
    writeJsonSecret(failurePath(cid), { date: today(), failures } satisfies FailureState);
  } catch {
    /* 计数写不进去只影响熔断精度，不阻塞签到 */
  }
}

/** 渠道今日是否已被熔断（连败达到阈值）。 */
export function tripped(cid: string): boolean {
  return readFailures(cid) >= MAX_FAILURES_PER_DAY;
}

/**
 * 对单个渠道执行一轮自动签到。返回是否发了领取请求。
 *
 * 跳过链（按序）：熔断 → 台账已签 → 未登录（不发请求）→ 上游已签/无可领。
 */
async function attemptChannel(channel: Channel): Promise<boolean> {
  const cid = channel.config.cid;

  // ① 当日熔断：连败 3 次的渠道今天不再触发
  if (tripped(cid)) return false;

  // ② 台账已签：今天领过，不问上游直接跳过
  if (claimedTodayPerLedger(cid)) return false;

  return runInChannel(cid, async () => {
    // ③ 未登录：不发任何请求（登录必须用户主动触发，不做网络探测以避免无谓的上游痕迹）
    try {
      channel.cred.load();
    } catch {
      return false;
    }

    const { signin } = channel.billing;
    let status: SigninStatus;
    try {
      status = await signin.status();
    } catch {
      // 上游答不了（含网络失败）：计一次失败，别盲领
      writeFailures(cid, readFailures(cid) + 1);
      return false;
    }

    // 上游权威：已签 → 回填台账（与手动链路一致的自愈），不再领取
    if (status.claimedToday === true) {
      try {
        recordClaim(cid, { via: "auto-backfill" });
      } catch {
        /* 回填失败不影响 */
      }
      return false;
    }
    // 明确无可领 → 不发请求也不算失败（有些渠道本来就没有签到活动）
    if (status.claimable === false) return false;

    // 领取
    try {
      const outcome = await signin.claim();
      if (outcome.ok) {
        // 状态登记：领取成功 → 台账记「今天已签」（via=auto 与手动 cli 区分）
        try {
          recordClaim(cid, { via: "auto" });
        } catch {
          /* 记账失败不影响签到本身 */
        }
        // 成功清零失败计数
        writeFailures(cid, 0);
      } else {
        writeFailures(cid, readFailures(cid) + 1);
      }
      return outcome.ok;
    } catch {
      writeFailures(cid, readFailures(cid) + 1);
      return false;
    }
  });
}

/** 跑一轮：全部已注册渠道逐个尝试。返回领取成功的渠道数。 */
export async function runOnce(): Promise<{ claimed: number }> {
  let claimed = 0;
  for (const channel of channels()) {
    try {
      if (await attemptChannel(channel)) claimed += 1;
    } catch {
      /* 单渠道异常不拖垮整轮 */
    }
  }
  return { claimed };
}

/**
 * 启动自动签到循环（不阻塞调用方）。
 *
 * 立即跑一轮（网关刚 ready，用户意图就是「开着网关顺便签到」），然后按
 * `CHECK_INTERVAL_MS` 轮询。单例：重复调用直接返回（serve 进程里只挂一次）。
 */
let started = false;
export function startAutoSignin(logger: (msg: string) => void = () => {}): void {
  if (started) return;
  started = true;
  const tick = async (): Promise<void> => {
    try {
      const { claimed } = await runOnce();
      if (claimed > 0) logger(`auto signin: ${claimed} channel(s) claimed`);
    } catch {
      /* 轮询轮失败等下一轮 */
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
  timer.unref(); // 不阻止进程退出
}
