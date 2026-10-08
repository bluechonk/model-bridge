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

import { channelCount, channels, getChannel, type Channel } from "./channel.js";
import { runInChannel } from "./channel-context.js";
import { catalogCacheFetchedAt } from "./catalog-cache.js";
import { poolIds, qualifiedId } from "./model-pool.js";
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
  const ids = runInChannel(cid, () => {
    try {
      return poolIds(channel);
    } catch {
      return [] as string[];
    }
  });
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
          models: ids.map((id) => `${cid}/${id}`),
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
  if (ids.length === 0) {
    console.log(`${cid}: 池内没有可用模型`);
    return 0;
  }
  for (const id of ids) console.log(`${cid}/${id}`);
  return 0;
}

/** 全部渠道的模型池一览（`model list` 与兼容的 `channels` 共用）。 */
export async function listAllModels(json: boolean, force = false): Promise<number> {
  const list = channels();
  if (list.length === 0) {
    console.error("没有渠道被注册（入口忘了 import 渠道包？）");
    return 2;
  }
  const multi = channelCount() > 1;
  const rows: Array<{
    cid: string;
    display: string;
    version: string;
    models: string[];
    raw: string[];
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
    const ids = runInChannel(cid, () => {
      try {
        return poolIds(channel);
      } catch {
        return [] as string[];
      }
    });
    rows.push({
      cid,
      display: channel.upstream.DISPLAY_NAME,
      version: channel.config.version,
      models: ids.map((id) => qualifiedId(cid, id, multi)),
      raw: ids,
      source: origin.kind,
      ...(origin.kind === "cache" && origin.fetchedAt ? { fetched_at: origin.fetchedAt } : {}),
    });
  }

  if (json) {
    console.log(
      JSON.stringify(
        rows.map(({ raw, ...rest }) => ({ ...rest, raw_models: raw })),
        null,
        2,
      ),
    );
    return failures > 0 ? 1 : 0;
  }
  console.log(`${list.length} 个渠道（模型池）${multi ? "；对外模型 id 形如 <cid>/<模型>" : ""}：`);
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
      `  ${row.cid.padEnd(12)} ${row.display.padEnd(18)} ${row.models.join(", ") || "（无可用模型）"}${note}`,
    );
  }
  return failures > 0 ? 1 : 0;
}

/** `model <list|show <cid>>`。 */
export async function runModelGroup(args: string[], ctx: CommandContext): Promise<number> {
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list":
    case "ls":
      return listAllModels(ctx.json, ctx.refresh);
    case "show":
    case "get": {
      const cid = args[1];
      if (!cid) {
        console.error("用法: model show <cid>");
        return 2;
      }
      return listLocalModels(getChannel(cid), ctx.json, ctx.refresh);
    }
    case "refresh":
    case "update": {
      // 全部渠道或指定渠道强制重拉（`model refresh [cid]`）
      const cid = args[1];
      if (cid) return listLocalModels(getChannel(cid), ctx.json, true);
      return listAllModels(ctx.json, true);
    }
    default:
      console.error(`未知的 model 子命令: ${sub}（可用: list / show <cid> / refresh [cid]）`);
      return 2;
  }
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
      return headless.runLogin({ cid, json: ctx.json, realm: ctx.realm, force: ctx.force });
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
