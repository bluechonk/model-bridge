/**
 * 命令分组：`model-bridge <cid> <动词>` 与 `model-bridge model <子命令>`。
 *
 * 设计取向（对应「像 playwright-cli 那样有子命令」的诉求）：
 * - **网关生命周期是仓库级的**：`start/stop/restart/status/logs/serve` 不带渠道，
 *   因为它们操作的是那个服务全部渠道的网关。
 * - **以渠道为第一参数**：`<cid> login` / `<cid> billing` / `<cid> checkin` …
 *   这是「对某个渠道做点什么」的自然读法。
 * - **分组**：`model list`（全部池子）、`model show <cid>`（单个池子）。
 * - 原来的扁平形式（`status --channel <cid>`、`credits`、`channels`…）**全部保留**，
 *   所以既有脚本与插件命令不用改。
 */

import { channels, getChannel, type Channel } from "./channel.js";
import { runInChannel } from "./channel-context.js";
import { catalogCacheFetchedAt } from "./catalog-cache.js";
import { asPoolModel, canonicalModelId, POOL_MODELS, poolCandidates } from "./pool-targets.js";
import { ledgerSnapshot, refreshBilling, scoreOf } from "./pool-usage.js";
import { poolUsagePath } from "./paths.js";
import * as accountCli from "./account-cli.js";
import * as daemon from "./daemon.js";
import * as headless from "./headless.js";
import * as report from "./report.js";
import * as signinCli from "./signin-cli.js";

export interface CommandContext {
  json: boolean;
  quiet: boolean;
  addr: string;
  uiPort: number;
  realm: string;
  force: boolean;
  /** `checkin --status`：只查不领。 */
  statusOnly: boolean;
  /** `checkin --daily-only`：只处理"每日"语义的渠道（跳过一次性奖励）。 */
  dailyOnly: boolean;
  /** `checkin --fail-if-unclaimed`：今天明确未签 → 退出码非零。 */
  failIfUnclaimed: boolean;
  /** `model list` / `<cid> models` 的 `--refresh`：强制重拉上游目录。 */
  refresh: boolean;
  /** `login --wechat`：微信扫码登录（渠道声明 loginWechat 才支持）。 */
  wechat: boolean;
  lines: number;
  workspace?: string;
}

/** 渠道级动词（供帮助文本与未知动词提示；别名在括号里）。 */
export const CHANNEL_VERBS: ReadonlyArray<readonly [string, string]> = [
  ["status", "该渠道的登录 / 凭证状态（默认动词）"],
  ["login", "浏览器授权登录该渠道"],
  ["models", "该渠道池内的模型 id（读本地缓存，不需要网关；`--refresh` 强制重拉）"],
  ["billing", "剩余额度 / 账单（别名 credits；只读，不经网关）"],
  ["checkin", "签到 / 领奖励（`--status` 只查不领、`--daily-only` 跳过一次性；别名 signin）"],
  ["accounts", "账号池：`list` / `use <key>` / `add` / `remove <key>`"],
  ["paths", "该渠道的存储落点与文件（只读）"],
  ["logs", "该渠道的网关日志尾部"],
];

/** 目录的来源，决定 CLI 怎么向用户交代这次列的是哪份数据。 */
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
 * `<cid> models`：该渠道贡献了池内哪些模型。
 *
 * 对外 id 恒为**池 id**（`deepseek-v4-flash` 这种），客户端不指定渠道。
 * 渠道目录里没进池的条目只报数量（可能几十条，全列是噪音）。
 */
async function listLocalModels(
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
 * `channels`：**渠道视角** —— 每个渠道各自贡献了池内哪些模型。
 *
 * 与 `model list`（模型视角）互补：排查「某个模型为什么没人接」时看前者，
 * 排查「某个渠道到底还能提供什么」时看这个。
 */
export async function listChannels(json: boolean, force = false): Promise<number> {
  const list = channels();
  if (list.length === 0) {
    console.error("没有渠道被注册（入口忘了 import 渠道包？）");
    return 2;
  }
  const rows: Array<{
    cid: string;
    display: string;
    version: string;
    models: string[];
    source: CatalogOrigin["kind"];
    fetched_at?: string;
  }> = [];
  let failures = 0;

  for (const channel of list) {
    const cid = channel.config.cid;
    const { origin, error } = await ensureCatalog(channel, force);
    if (force && error) {
      failures += 1;
      if (!json) console.error(`${cid}: 刷新模型目录失败：${error.message}`);
    }
    rows.push({
      cid,
      display: channel.upstream.DISPLAY_NAME,
      version: channel.config.version,
      models: contributedOf(channel),
      source: origin.kind,
      ...(origin.kind === "cache" && origin.fetchedAt ? { fetched_at: origin.fetchedAt } : {}),
    });
  }

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return failures > 0 ? 1 : 0;
  }
  console.log(`${list.length} 个渠道（每个渠道是池子的一个来源；对外模型只有 ${POOL_MODELS.length} 个）：`);
  for (const row of rows) {
    const note =
      row.source === "cache" && row.fetched_at
        ? `  [缓存 ${row.fetched_at}]`
        : row.source === "builtin"
          ? "  [内置表]"
          : row.source === "fetched"
            ? "  [已刷新]"
            : "";
    console.log(
      `  ${row.cid.padEnd(12)} ${row.display.padEnd(18)} ${row.models.join(", ") || "（不贡献池内模型）"}${note}`,
    );
  }
  return failures > 0 ? 1 : 0;
}

/** `model <list|show <cid>|usage|refresh [cid]>`。 */
export async function runModelGroup(args: string[], ctx: CommandContext): Promise<number> {
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list":
    case "ls":
      return listPoolModels(ctx.json);
    case "show":
    case "get": {
      const cid = args[1];
      if (!cid) {
        console.error("用法: model show <cid>");
        return 2;
      }
      return listLocalModels(getChannel(cid), ctx.json, ctx.refresh);
    }
    case "usage":
    case "billing":
    case "ledger":
      return showPoolUsage(ctx.json, ctx.refresh);
    case "refresh":
    case "update": {
      // 这里的 `--refresh` 是「重拉上游**目录**」；刷账单走 `model usage --refresh`。
      const cid = args[1];
      if (cid) return listLocalModels(getChannel(cid), ctx.json, true);
      return listChannels(ctx.json, true);
    }
    default:
      console.error(
        `未知的 model 子命令: ${sub}（可用: list / show <cid> / usage / refresh [cid]）`,
      );
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

/** `model-bridge <cid> <动词> [参数]`。 */
export async function runChannelCommand(
  cid: string,
  args: string[],
  ctx: CommandContext,
): Promise<number> {
  const verb = args[0] ?? "status";
  const rest = args.slice(1);
  const channel = getChannel(cid); // 未注册会抛错，调用方已确认

  switch (verb) {
    case "status":
      return daemon.status({ cid, json: ctx.json, addr: ctx.addr, uiPort: ctx.uiPort });
    case "login":
      return headless.runLogin({ cid, json: ctx.json, realm: ctx.realm, force: ctx.force, wechat: ctx.wechat });
    case "models":
      return listLocalModels(channel, ctx.json, ctx.refresh);
    case "billing":
    case "credits":
      return daemon.credits({ cid, json: ctx.json });
    case "checkin":
    case "check-in":
    case "signin":
      return signinCli.runCheckin({
        cid,
        json: ctx.json,
        statusOnly: ctx.statusOnly,
        dailyOnly: ctx.dailyOnly,
        failIfUnclaimed: ctx.failIfUnclaimed,
      });
    case "accounts":
      return accountCli.runAccounts({
        cid,
        json: ctx.json,
        verb: rest[0] ?? "list",
        ...(rest[1] !== undefined ? { target: rest[1] } : {}),
      });
    case "paths":
      return report.runPaths({ cid, json: ctx.json });
    case "logs":
      return daemon.logs(ctx.lines, ctx.json, cid);
    case "start":
    case "stop":
    case "restart":
      console.error(
        `网关是**仓库级**的：\`model-bridge ${verb}\` 管的是服务全部渠道的那个网关。\n` +
          `只想跑 ${cid} 一个渠道调试，用 \`node channels/${cid}/dist/cli.js ${verb}\`（独立端口）。`,
      );
      return 2;
    default:
      console.error(
        `未知动词: ${verb}\n` +
          `用法: model-bridge <cid> <动词>；可用动词: ${CHANNEL_VERBS.map(([v]) => v).join(" / ")}`,
      );
      return 2;
  }
}
