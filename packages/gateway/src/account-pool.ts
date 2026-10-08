/**
 * 账号池：一个渠道下挂多个账号。
 *
 * ## 目录结构（见 docs/POOL-ARCHITECTURE.md §3）
 *
 * ```
 * <root>/<cid>/
 * ├── credentials.json         当前生效账号（渠道的 cred.load() 语义**不变**）
 * ├── accounts.json            索引：账号列表 + 当前选中 + 元信息
 * └── accounts/<key>.json      单账号凭证（与 credentials.json 同构）
 * ```
 *
 * ## 为什么共享层能不知道渠道的凭证格式
 *
 * 共享层**不解析**任何渠道的磁盘字段，只做三件事：
 *
 * 1. **收进池子**：把"当前生效"的 `credentials.json` 原样复制成
 *    `accounts/<key>.json`；元信息（uid / domain）取自渠道 `cred.load()` 的返回值 ——
 *    `uid` / `domain` 是契约字段（`CredModule` 要求每个渠道都提供），故无需渠道知识。
 *    `label` / `expires_at` 是**尽力而为**的展示信息（见下），取不到就是空/null。
 * 2. **切换账号**：把 `accounts/<key>.json` 复制回 `credentials.json`，更新索引里的 `active`。
 * 3. **对账**：渠道自己的 `cred.refresh()` 只会写 `credentials.json`，不会回灌池子；
 *    故按 mtime 做一次「谁新用谁」的回灌（渠道零改动即可保持池子与生效凭证一致）。
 *
 * `key` 用 `sha256(domain \u0000 uid)` 的前 16 hex：稳定（重登不变）、文件名安全
 * （全小写 hex，过得了 `paths.channelFile` 的校验）。uid 为空的渠道退化为按
 * accessToken 派生 —— 那种渠道重登会得到新 key（已知限制，见 §备注）。
 */

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { getChannel, type Channel } from "./channel.js";
import { channelDir, credentialsPath, ensureDir } from "./paths.js";
import { writeJsonSecret } from "./secret-file.js";

/** 账号健康状态。`unauthorized` 由网关在刷新失败时写入。 */
export type AccountHealth = "ok" | "unauthorized" | "unknown";

export interface PoolAccount {
  /** 稳定账号标识（文件名：`accounts/<key>.json`）。 */
  key: string;
  uid: string;
  domain: string;
  /** 展示名（尽力而为：nickname → email → phone → uid → key）。 */
  label: string;
  added_at: string;
  last_used_at: string;
  /** 过期时刻（epoch 秒）；取不到为 null。**仅展示用**，不作为判据。 */
  expires_at: number | null;
  health: AccountHealth;
  health_at: string;
}

export interface PoolIndex {
  version: 1;
  /** 当前生效账号的 key；无则 null。 */
  active: string | null;
  accounts: PoolAccount[];
}

const INDEX_NAME = "accounts.json";
const ACCOUNT_DIR = "accounts";
/** 索引里保留的展示字段别名（尽力而为，取不到就空）。 */
const LABEL_FIELDS = ["nickname", "email", "phone", "name"] as const;
const EXPIRY_FIELDS = ["expiresAt", "expireTime", "expiry", "expires_at", "refreshExpiresAt"] as const;

function accountDir(cid?: string): string {
  return join(channelDir(cid), ACCOUNT_DIR);
}

function indexFile(cid?: string): string {
  return join(channelDir(cid), INDEX_NAME);
}

function accountFile(key: string, cid?: string): string {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(key)) throw new Error(`非法 account key: ${key}`);
  return join(accountDir(cid), `${key}.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 「谁新用谁」的时间戳（毫秒）；不存在返回 0。 */
function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function hint(cred: Record<string, unknown>, fields: readonly string[]): string {
  for (const field of fields) {
    const value = cred[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** 过期时刻（epoch 秒）；字符串/毫秒/秒都尽力归一，取不到 null。 */
function parseExpiry(cred: Record<string, unknown>): number | null {
  for (const field of EXPIRY_FIELDS) {
    const value = cred[field];
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.trunc(value > 1e12 ? value / 1000 : value);
    }
    if (typeof value === "string") {
      const numeric = Number.parseFloat(value);
      if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(value.trim())) {
        return Math.trunc(numeric > 1e12 ? numeric / 1000 : numeric);
      }
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return Math.trunc(parsed / 1000);
    }
  }
  return null;
}

/**
 * 由凭据派生账号 key（稳定、文件名安全）。
 *
 * `uid` 非空时用 `sha256(domain\0uid)[:16]`；为空则退化到 token 派生
 * （此时重登会得到新 key —— 该渠道无法区分账号，属已知限制）。
 */
export function accountKey(credential: { uid?: unknown; domain?: unknown; accessToken?: unknown }): string {
  const uid = typeof credential.uid === "string" ? credential.uid.trim() : "";
  const domain = typeof credential.domain === "string" ? credential.domain.trim() : "";
  const basis = uid ? `${domain}\u0000${uid}` : `token\u0000${String(credential.accessToken ?? "")}`;
  return createHash("sha256").update(basis, "utf8").digest("hex").slice(0, 16);
}

/** 读索引；文件缺失/损坏时返回空池（不抛错）。 */
export function readIndex(cid?: string): PoolIndex {
  try {
    const parsed: unknown = JSON.parse(readFileSync(indexFile(cid), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyIndex();
    const rec = parsed as Record<string, unknown>;
    const list = Array.isArray(rec["accounts"]) ? rec["accounts"] : [];
    const accounts: PoolAccount[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const a = item as Record<string, unknown>;
      const key = typeof a["key"] === "string" ? a["key"] : "";
      if (!key) continue;
      accounts.push({
        key,
        uid: String(a["uid"] ?? ""),
        domain: String(a["domain"] ?? ""),
        label: String(a["label"] ?? "") || key,
        added_at: String(a["added_at"] ?? ""),
        last_used_at: String(a["last_used_at"] ?? ""),
        expires_at: typeof a["expires_at"] === "number" ? a["expires_at"] : null,
        health: (a["health"] === "unauthorized" || a["health"] === "ok" ? a["health"] : "unknown") as AccountHealth,
        health_at: String(a["health_at"] ?? ""),
      });
    }
    const active = typeof rec["active"] === "string" ? rec["active"] : null;
    return { version: 1, active, accounts };
  } catch {
    return emptyIndex();
  }
}

function emptyIndex(): PoolIndex {
  return { version: 1, active: null, accounts: [] };
}

function writeIndex(index: PoolIndex, cid?: string): void {
  ensureDir(cid);
  mkdirSync(accountDir(cid), { recursive: true });
  writeJsonSecret(indexFile(cid), index);
}

/** 池子摘要（供 CLI / 网关）：先与"现实"同步，再读索引。 */
export function listAccounts(cid?: string): PoolIndex {
  syncPool(cid);
  return readIndex(cid);
}

/**
 * 把渠道当前的 `credentials.json` 收进池子（新增或更新 active）。
 *
 * 元信息取自渠道 `cred.load()` 的**契约字段**（accessToken/uid/domain），
 * 其余展示字段尽力而为。凭据文件本身是**原样复制**，共享层不解析格式。
 */
export function captureActive(
  cid?: string,
  options: { label?: string } = {},
): PoolAccount | null {
  const channel: Channel = getChannel(cid);
  const source = credentialsPath(cid);
  if (!existsSync(source)) return null;

  let raw: Record<string, unknown>;
  try {
    const loaded: unknown = channel.cred.load();
    raw = loaded && typeof loaded === "object" ? (loaded as Record<string, unknown>) : {};
  } catch {
    return null;
  }

  const key = accountKey(raw);
  const index = readIndex(cid);
  const existing = index.accounts.find((a) => a.key === key);
  const stamp = nowIso();
  const account: PoolAccount = {
    key,
    uid: String(raw["uid"] ?? ""),
    domain: String(raw["domain"] ?? ""),
    label: options.label?.trim() || hint(raw, LABEL_FIELDS) || String(raw["uid"] ?? "") || key,
    added_at: existing?.added_at ?? stamp,
    last_used_at: existing?.last_used_at ?? stamp,
    expires_at: parseExpiry(raw),
    health: "ok",
    health_at: stamp,
  };

  mkdirSync(accountDir(cid), { recursive: true });
  copyFileSync(source, accountFile(key, cid));
  try {
    chmodSync(accountFile(key, cid), 0o600);
  } catch {
    /* ignore */
  }

  const accounts = [...index.accounts.filter((a) => a.key !== key), account];
  writeIndex({ version: 1, active: key, accounts }, cid);
  return account;
}

/** 切换当前生效账号：把池里的凭证复制回 `credentials.json`。 */
export function activateAccount(key: string, cid?: string): PoolAccount {
  const index = readIndex(cid);
  const account = index.accounts.find((a) => a.key === key);
  if (!account) {
    const known = index.accounts.map((a) => a.key).join(", ") || "(空池)";
    throw new Error(`账号不存在: ${key}（该渠道池内: ${known}）`);
  }
  const from = accountFile(key, cid);
  if (!existsSync(from)) throw new Error(`账号文件缺失: ${from}`);
  ensureDir(cid);
  copyFileSync(from, credentialsPath(cid));
  try {
    chmodSync(credentialsPath(cid), 0o600);
  } catch {
    /* ignore */
  }
  account.last_used_at = nowIso();
  writeIndex({ version: 1, active: key, accounts: index.accounts }, cid);
  return account;
}

/**
 * 从池子里删掉某账号。
 *
 * 删的是**当前生效**账号时同时**登出**（删掉 `credentials.json`）：否则下次同步
 * 会把这份仍然生效的凭证又收回来，"移除"就成了空操作。`active` 置空，不会悄悄
 * 回退到别的账号。
 */
export function removeAccount(
  key: string,
  cid?: string,
): { removed: boolean; wasActive: boolean; loggedOut: boolean } {
  const index = readIndex(cid);
  const hit = index.accounts.find((a) => a.key === key);
  if (!hit) return { removed: false, wasActive: false, loggedOut: false };
  const wasActive = index.active === key;
  try {
    rmSync(accountFile(key, cid), { force: true });
  } catch {
    /* 文件已不在也算删掉 */
  }
  let loggedOut = false;
  if (wasActive) {
    try {
      rmSync(credentialsPath(cid), { force: true });
      loggedOut = true;
    } catch {
      /* 删不掉就算了，下次同步会把它收回来 */
    }
  }
  writeIndex(
    { version: 1, active: wasActive ? null : index.active, accounts: index.accounts.filter((a) => a.key !== key) },
    cid,
  );
  return { removed: true, wasActive, loggedOut };
}

/** 进程内的健康度缓存：稳态下每个请求不读盘（仅状态变化时写索引）。 */
const healthCache = new Map<string, AccountHealth>();

/**
 * 标记当前生效账号的健康度（网关在刷新失败/请求成功时调用）。
 *
 * 同值短路（先看内存缓存），所以「每个请求都调」也不会有额外 I/O。
 */
export function markActiveHealth(health: AccountHealth, cid?: string): void {
  let scope: string;
  try {
    scope = channelDir(cid);
  } catch {
    return; // 路径不可用（未注册/多渠道路由下未给 cid）→ 静默跳过，别影响请求
  }
  if (healthCache.get(scope) === health) return;
  const index = readIndex(cid);
  if (!index.active) {
    healthCache.set(scope, health);
    return;
  }
  const hit = index.accounts.find((a) => a.key === index.active);
  healthCache.set(scope, health);
  if (!hit || hit.health === health) return;
  hit.health = health;
  hit.health_at = nowIso();
  writeIndex(index, cid);
}

/**
 * 与渠道自己的写盘对账：渠道 `cred.refresh()` 只写 `credentials.json`。
 *
 * 公开入口会在**确认账号身份一致**后调用它（见 `reconcile`）。
 *
 * @returns 是否发生了回灌。
 */
export function reconcile(cid?: string): boolean {
  const cred = loadLive(cid);
  if (!cred) return false;
  const index = readIndex(cid);
  if (!index.active || accountKey(cred) !== index.active) return false;
  return reconcileActive(cid, index);
}

/** 同一账号的 token 刷新：把 credentials.json 回灌池内那份（调用方已确认身份一致）。 */
function reconcileActive(cid: string | undefined, index: PoolIndex): boolean {
  if (!index.active) return false;
  const pool = accountFile(index.active, cid);
  const live = credentialsPath(cid);
  if (!existsSync(pool) || !existsSync(live)) return false;
  if (mtimeMs(live) <= mtimeMs(pool)) return false;

  copyFileSync(live, pool);
  try {
    chmodSync(pool, 0o600);
  } catch {
    /* ignore */
  }
  const hit = index.accounts.find((a) => a.key === index.active);
  if (hit) {
    hit.last_used_at = nowIso();
    hit.expires_at = parseExpiry(readRawCredential(cid));
    writeIndex(index, cid);
  }
  return true;
}

/** 读 credentials.json 的原始 JSON（**仅用于展示字段**，不解释渠道语义）。 */
function readRawCredential(cid?: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(credentialsPath(cid), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 读当前生效凭证（走渠道自己的 `load()`，从而拿到契约字段 uid/domain）。未登录返回 null。 */
function loadLive(cid?: string): Record<string, unknown> | null {
  try {
    const loaded: unknown = getChannel(cid).cred.load();
    return loaded && typeof loaded === "object" && !Array.isArray(loaded)
      ? (loaded as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * 选下一个可用账号（**失败转移**用）。
 *
 * 跳过 `unauthorized` 的（已知不可用）与 `exclude` 里的（本次请求已经试过）；
 * 其余按 `last_used_at` 升序（最久未用优先）。没有可用账号返回 null。
 *
 * `unknown` 健康度**不算不可用** —— 那是"还没试过"，正该拿它去试。
 */
export function pickAccount(cid?: string, exclude: readonly string[] = []): PoolAccount | null {
  const index = readIndex(cid);
  const usable = index.accounts
    .filter((a) => a.health !== "unauthorized" && !exclude.includes(a.key))
    .sort((a, b) => (a.last_used_at < b.last_used_at ? -1 : a.last_used_at > b.last_used_at ? 1 : 0));
  return usable[0] ?? null;
}

/**
 * 把"现实"同步进池子（登录成功后、守护启动前、查看池子时调用；幂等且不抛错）。
 *
 * ⚠ **必须先比账号身份，再决定怎么同步** —— 只看 mtime 是错的：换了账号登录时，
 * `credentials.json` 也变新了，但它**不是** active 那份的刷新，而是另一个账号，
 * 按 mtime 回灌会把 active 账号的池内文件写成别人的凭证。
 */
export function syncPool(cid?: string): void {
  try {
    const cred = loadLive(cid);
    if (!cred) return; // 未登录：池子不动
    const key = accountKey(cred);
    const index = readIndex(cid);
    if (index.active === key) {
      reconcileActive(cid, index); // 同一账号：把刷新过的 token 回灌
      return;
    }
    captureActive(cid); // 换了账号、或池子还没 active：收进来并设为当前生效
  } catch {
    /* 同步失败不影响主流程 */
  }
}

/** 池内某账号的凭证原始 JSON（供诊断；不解释渠道语义）。 */
export function readAccountCredential(key: string, cid?: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(accountFile(key, cid), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export { ACCOUNT_DIR, INDEX_NAME };
