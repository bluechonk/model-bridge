/**
 * `model` 命令组：池视图（list / usage）、本地目录、可登录渠道列表。
 *
 * 从 `command-groups.ts` 拆出。本文件同时承载**命令层共享的上下文与目录工具**
 * （`CommandContext` / `ensureCatalog` / `originNote`）—— 渠道动词组也依赖它们，
 * 依赖方向为单向：`channel-verbs.ts` → 本文件。
 */

import { channels, getChannel, hasChannel, type Channel } from "../../runtime/channel.js";
import { runInChannel } from "../../runtime/channel-context.js";
import { catalogCacheFetchedAt } from "../../runtime/catalog-cache.js";
import { asPoolModel, canonicalModelId, POOL_MODELS, poolCandidates } from "../../pool/pool-targets.js";
import { ledgerSnapshot, refreshBilling, scoreOf } from "../../pool/pool-usage.js";
import { poolUsagePath } from "../../runtime/paths.js";
import * as accountCli from "../account-cli.js";
import * as daemon from "../daemon.js";
import * as headless from "../headless.js";
import * as report from "../report.js";

export interface CommandContext {
  json: boolean;
  quiet: boolean;
  addr: string;
  uiPort: number;
  realm: string;
  force: boolean;
  /** `models <cid>` / `model usage` 的 `--refresh`：强制重拉上游目录。 */
  refresh: boolean;
  /** `login --wechat`：微信扫码登录（渠道声明 loginWechat 才支持）。 */
  wechat: boolean;
  lines: number;
  /** `paths`：统计工作区内全部渠道。 */
  all: boolean;
  /** `logs`：持续输出新增日志。 */
  follow: boolean;
  workspace?: string;
}

/** 渠道动词（供帮助文本与未知动词提示）。语法一律 `mx <动词> [<cid>] [参数]`。 */

type CatalogOrigin =
  /** 命中 `cache/models.json`（上次真实拉取的结果）—— 常态，零网络。 */
  | { kind: "cache"; fetchedAt: string | null }
  /** 本地没有缓存，刚刚拉了一次并落盘。 */
  | { kind: "fetched" }
  /** 该渠道没有远端目录层（目录就是内置表）。 */
  | { kind: "builtin" }
  /** 想拉但没成功（未登录 / 网络 / 上游拒绝）—— 回落内置表。 */
  | { kind: "failed"; reason: string };

/**
 * 确保目录可用：**缓存优先，只有本地没有缓存时才拉一次**。
 *
 * 这是「第一次 `model list` 把真实目录记到本地，之后一直用那个文件」的实现点：
 * - 有 `cache/models.json` → 直接用它，**不打网络**（所以离线/未登录也能列出真实目录）；
 * - 没有缓存 → 拉一次并落盘（渠道的 `refresh()` 内部负责写缓存）；
 * - 拉失败 → 回落渠道内置表，并把原因回报给调用方（**不抛错**，列表本身仍要能打）。
 *
 * `force = true`（CLI 的 `--refresh`）跳过「缓存优先」直接重拉，且**失败即抛错** ——
 * 用户显式要求刷新时，看到一张旧表却以为刷成功了是最坏的结果。
 */

async function ensureCatalog(
  channel: Channel,
  force: boolean,
): Promise<{ origin: CatalogOrigin; error?: Error }> {
  const cid = channel.config.cid;
  const refresh = channel.catalog.refresh;

  if (force) {
    if (!refresh) return { origin: { kind: "builtin" } };
    try {
      await runInChannel(cid, () => refresh());
      return { origin: { kind: "fetched" } };
    } catch (err) {
      return { origin: { kind: "failed", reason: String(err) }, error: err as Error };
    }
  }

  const fetchedAt = catalogCacheFetchedAt(cid);
  if (fetchedAt) return { origin: { kind: "cache", fetchedAt } };
  if (!refresh) return { origin: { kind: "builtin" } };
  try {
    await runInChannel(cid, () => refresh());
    return { origin: { kind: "fetched" } };
  } catch (err) {
    return { origin: { kind: "failed", reason: String(err) } };
  }
}

/** 目录来源的一句话说明（`--json` 之外的输出用；缓存命中时附拉取时刻）。 */

function originNote(origin: CatalogOrigin): string {
  switch (origin.kind) {
    case "cache":
      return origin.fetchedAt ? `本地缓存（拉取于 ${origin.fetchedAt}）` : "本地缓存";
    case "fetched":
      return "刚从上游拉取并已记录到本地";
    case "builtin":
      return "该渠道的模型表是内置的，没有远端可刷新";
    case "failed":
      return `未能从上游拉取（${origin.reason}），下面是内置表；加 --refresh 可重试`;
  }
}

/**
 * `models <cid>`：该渠道贡献了池内哪些模型。
 *
 * 对外 id 恒为**池 id**（`deepseek-v4.1-flash` 这种），客户端不指定渠道。
 * 渠道目录里没进池的条目只报数量（可能几十条，全列是噪音）。
 */

export async function listLocalModels(
  channel: Channel,
  json: boolean,
  force: boolean,
): Promise<number> {
  const cid = channel.config.cid;
  const { origin, error } = await ensureCatalog(channel, force);
  // 显式刷新失败要如实报错，不能让用户以为刷新成功了
  if (force && error) {
    console.error(`${cid}: 刷新模型目录失败：${error.message}`);
    return 1;
  }
  // 匹配用目录里的**原始写法**（见 pool-targets.ts 的说明）；展示与去重分开处理
  const catalogIds = runInChannel(cid, () => {
    try {
      return channel.catalog.exposedIds();
    } catch {
      return [] as string[];
    }
  });
  const contributed = POOL_MODELS.flatMap((model) => {
    const hit = catalogIds.find((id) => canonicalModelId(id) === model);
    return hit === undefined ? [] : [{ model, exposed_id: hit }];
  });
  const deduped = [...new Map(catalogIds.map((id) => [id.toLowerCase(), id])).values()];
  const outside = deduped.filter((id) => asPoolModel(id) === null);

  if (json) {
    console.log(
      JSON.stringify(
        {
          cid,
          display: channel.upstream.DISPLAY_NAME,
          source: origin.kind,
          ...(origin.kind === "cache" && origin.fetchedAt
            ? { fetched_at: origin.fetchedAt }
            : {}),
          ...(origin.kind === "failed" ? { reason: origin.reason } : {}),
          pool_models: contributed,
          out_of_pool_count: outside.length,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  // 数据走 stdout（便于管道），**来源说明走 stderr**：缓存命中是常态，不必打扰；
  // 其余情形（刚拉取 / 拉取失败 / 内置表）用户需要知道自己在看哪份数据。
  if (origin.kind !== "cache") console.error(`${cid}: ${originNote(origin)}`);
  if (contributed.length === 0) {
    console.log(`${cid}: 该渠道没有池内模型（池只有 ${POOL_MODELS.join(" / ")}）`);
  } else {
    console.log(`${cid} 贡献的池内模型：`);
    for (const row of contributed) {
      console.log(`  ${row.model.padEnd(22)} ← ${row.exposed_id}`);
    }
  }
  if (outside.length > 0) {
    console.error(`${cid}: 另有 ${outside.length} 个模型不在池内（渠道 CLI 仍可直接调用）`);
  }
  return 0;
}

/** 某渠道目录里进了池的模型 id（池 id 形态）。 */

function contributedOf(channel: Channel): string[] {
  const catalogIds = runInChannel(channel.config.cid, () => {
    try {
      return channel.catalog.exposedIds();
    } catch {
      return [] as string[];
    }
  });
  return POOL_MODELS.filter((model) => catalogIds.some((id) => canonicalModelId(id) === model));
}

/**
 * `model list`：**公共模型池视图** —— 池内模型，各自挂出候选渠道与账本状态。
 *
 * 展示顺序与实际路由顺序一致（账单已用量降序、冷却中当 0、同分保持注册顺序），
 * 所以看到的第一行就是网关会先试的那家。
 */

export async function listPoolModels(json: boolean): Promise<number> {
  const list = channels();
  if (list.length === 0) {
    console.error("没有渠道被注册（入口忘了 import 渠道包？）");
    return 2;
  }
  const now = Date.now();
  const ledger = ledgerSnapshot();
  const rows = POOL_MODELS.map((model) => ({
    model,
    candidates: poolCandidates(model)
      .map((candidate) => {
        const entry = ledger.channels[candidate.cid];
        return {
          cid: candidate.cid,
          display: candidate.channel.upstream.DISPLAY_NAME,
          exposed_id: candidate.exposedId,
          score: scoreOf(candidate.cid, now),
          used: entry?.used ?? 0,
          unit: entry?.unit ?? "",
          cooling: (entry?.cooldown_until ?? 0) > now,
          ok: entry?.ok ?? 0,
          fail: entry?.fail ?? 0,
          billing_at: entry?.billing_at ?? null,
        };
      })
      .sort((a, b) => b.score - a.score),
  }));

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }

  console.log(
    `公共模型池（对外 ${POOL_MODELS.length} 个模型；请求落到哪家由网关按账单已用量决定）\n`,
  );
  for (const row of rows) {
    console.log(`  ${row.model}`);
    if (row.candidates.length === 0) {
      console.log("    （没有渠道提供它）\n");
      continue;
    }
    for (const candidate of row.candidates) {
      const used = `${candidate.used}${candidate.unit ? ` ${candidate.unit}` : ""}`;
      const marks = [
        candidate.cooling ? "冷却中" : "",
        candidate.ok > 0 ? `ok=${candidate.ok}` : "",
        candidate.fail > 0 ? `fail=${candidate.fail}` : "",
      ]
        .filter(Boolean)
        .join("  ");
      console.log(`    ${candidate.cid.padEnd(14)} used=${used.padEnd(16)} ${marks}`);
    }
    console.log();
  }
  console.log(`账本: ${poolUsagePath()}（账单额度每 8 小时自动刷一次）`);
  return 0;
}

/**
 * `login list`：列出**可以登录哪些渠道**与各自的登录状态（只读，不需要网关）。
 *
 * - 口径与 `status` 的逐渠道凭证探测一致：`cred.load()` 成功 = 已登录
 *   （渠道知识零新增 —— 这里只调渠道自己的 `cred.load()`，不解释凭证内容）。
 * - 输出里只带 `uid` 这类不透明的身份标识，不回显手机号/昵称等个人信息。
 */

export async function listLogins(json: boolean): Promise<number> {
  const list = channels();
  if (list.length === 0) {
    console.error("没有渠道被注册（入口忘了 import 渠道包？）");
    return 2;
  }
  const identityOf = (cred: unknown): string => {
    if (!cred || typeof cred !== "object") return "";
    const record = cred as Record<string, unknown>;
    for (const key of ["uid", "userid", "userId"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  };
  const rows = list.map((channel) => {
    const cid = channel.config.cid;
    let loggedIn = false;
    let uid = "";
    try {
      uid = identityOf(runInChannel(cid, () => channel.cred.load()));
      loggedIn = true;
    } catch {
      loggedIn = false;
    }
    return { cid, display: channel.upstream.DISPLAY_NAME, logged_in: loggedIn, uid };
  });

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  const logged = rows.filter((r) => r.logged_in).length;
  console.log(`${list.length} 个渠道可登录（已登录 ${logged} 个，未登录 ${list.length - logged} 个）：`);
  for (const row of rows) {
    const status = row.logged_in ? `已登录${row.uid ? `  uid=${row.uid}` : ""}` : "未登录";
    console.log(`  ${row.cid.padEnd(12)} ${row.display.padEnd(18)} ${status}`);
  }
  console.log("登录某个渠道：`mx login <cid>`（重新授权用 `mx relogin <cid>`）。");
  return 0;
}

/** `model <list|usage> [--refresh]`。 */

export async function runModelGroup(args: string[], ctx: CommandContext): Promise<number> {
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list":
      return listPoolModels(ctx.json);
    case "usage":
      return showPoolUsage(ctx.json, ctx.refresh);
    default:
      console.error(`未知的 model 子命令: ${sub}（可用: list / usage）`);
      return 2;
  }
}

/**
 * `model usage [--refresh]`：看池账本；`--refresh` 立刻重查一遍各渠道账单。
 *
 * 展示的仍是池视图（模型 → 候选渠道 + 已用量 + 冷却）—— 账本的意义是
 * 「下一次请求会先落到谁」，单看一串数字看不出这个。
 */

export async function showPoolUsage(json: boolean, force = false): Promise<number> {
  if (force) {
    const result = await refreshBilling((m) => {
      if (!json) console.error(m);
    });
    if (!json) {
      const failed = result.failed.map((f) => f.cid).join("、");
      console.error(
        `账单已刷新：成功 ${result.refreshed.length} 个渠道` +
          (result.failed.length > 0 ? `，失败 ${result.failed.length} 个（${failed}）` : ""),
      );
    }
  }
  return listPoolModels(json);
}

/** 渠道动词名集合（`mx <动词> [<cid>]` 的第一参数）。 */
