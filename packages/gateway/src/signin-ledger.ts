/**
 * 签到台账：**本地**记「我们最后一次实际领到是什么时候」。
 *
 * 为什么需要它（`checkin --status` 单独问上游的三个短板）：
 * 1. 未登录 / 离线时问不到上游 → 台账仍能回答"我们这边今天领过没有"；
 * 2. 有的渠道**没有**签到状态端点（loomy、以及 workbuddyai/catpaw/cline/gemini 这类
 *    上游自动发奖的渠道）→ 上游永远答不了；
 * 3. 上游答"今天没签"时，我们还想知道是"我们没领"还是"在别处（客户端）领的"。
 *
 * 落点：`<root>/<cid>/state/signin.json`（跨重启保持的状态 → 按存储规范放 `state/`）。
 *
 * ⚠ 台账只证明**我们**发起过的领取；它不代表"上游认为今天已签"（那只有上游知道）。
 * 所以判定顺序是「上游优先，台账兜底」，并且上游说已签时会**回填**台账（自愈：
 * 覆盖"在客户端签的"这种情况）。
 */

import { existsSync, readFileSync } from "node:fs";

import { ensureStateDir, stateDir } from "./paths.js";
import { writeJsonSecret } from "./secret-file.js";

/** 一次领取的记录。 */
export interface ClaimRecord {
  /** 本地时区下的日期 `YYYY-MM-DD`。 */
  date: string;
  /** 领取时刻（ISO）。 */
  at: string;
  /** 来源：`cli`（我们领的） / `upstream-backfill`（上游说已签，补记）。 */
  via: string;
}

export interface SigninLedger {
  version: 1;
  /** 记录时用的 IANA 时区名（换了时区也不改写历史记录）。 */
  timezone: string;
  /** 最近一次领取。 */
  last_claim?: ClaimRecord;
  /** 历史（新→旧，最多 `HISTORY_LIMIT` 条）。 */
  history: ClaimRecord[];
}

export const HISTORY_LIMIT = 30;

function ledgerPath(cid?: string): string {
  return `${stateDir(cid)}/signin.json`;
}

/** 当前时区（IANA 名）；拿不到时返回 `UTC`。 */
export function currentTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** 把时刻换算成某时区下的 `YYYY-MM-DD`。 */
export function dateInTimezone(at: Date, timezone: string): string {
  try {
    // en-CA 的输出就是 ISO 形状的 YYYY-MM-DD
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** 读台账；文件缺失/损坏时返回空台账（不抛错）。 */
export function readLedger(cid?: string): SigninLedger {
  const empty: SigninLedger = { version: 1, timezone: currentTimezone(), history: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(ledgerPath(cid), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
    const rec = parsed as Record<string, unknown>;
    const timezone = typeof rec["timezone"] === "string" && rec["timezone"] ? rec["timezone"] : empty.timezone;
    const history: ClaimRecord[] = [];
    for (const item of Array.isArray(rec["history"]) ? rec["history"] : []) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const date = typeof entry["date"] === "string" ? entry["date"] : "";
      if (!date) continue;
      history.push({
        date,
        at: typeof entry["at"] === "string" ? entry["at"] : "",
        via: typeof entry["via"] === "string" ? entry["via"] : "unknown",
      });
    }
    const lastRaw = rec["last_claim"];
    let last: ClaimRecord | undefined;
    if (lastRaw && typeof lastRaw === "object") {
      const entry = lastRaw as Record<string, unknown>;
      if (typeof entry["date"] === "string" && entry["date"]) {
        last = {
          date: entry["date"],
          at: typeof entry["at"] === "string" ? entry["at"] : "",
          via: typeof entry["via"] === "string" ? entry["via"] : "unknown",
        };
      }
    }
    return { version: 1, timezone, history, ...(last ? { last_claim: last } : {}) };
  } catch {
    return empty;
  }
}

/**
 * 记一次「今天领过了」。
 *
 * @returns 写入的记录（含日期与来源）。
 */
export function recordClaim(
  cid?: string,
  options: { via?: string; now?: Date; timezone?: string } = {},
): ClaimRecord {
  const { via = "cli", now = new Date(), timezone = currentTimezone() } = options;
  const record: ClaimRecord = {
    date: dateInTimezone(now, timezone),
    at: now.toISOString(),
    via,
  };
  const ledger = readLedger(cid);
  const next: SigninLedger = {
    version: 1,
    timezone,
    last_claim: record,
    // 同一天重复记只留一条（最新的那条）
    history: [record, ...ledger.history.filter((h) => h.date !== record.date)].slice(0, HISTORY_LIMIT),
  };
  ensureStateDir(cid);
  writeJsonSecret(ledgerPath(cid), next);
  return record;
}

/** 台账里是否记着"今天（按当前时区）领过"。 */
export function claimedTodayPerLedger(cid?: string, now: Date = new Date()): boolean {
  const ledger = readLedger(cid);
  const today = dateInTimezone(now, currentTimezone());
  return ledger.last_claim?.date === today;
}

/** 台账是否存在（用于区分"没有记录"和"记录说没领"）。 */
export function ledgerExists(cid?: string): boolean {
  return existsSync(ledgerPath(cid));
}
