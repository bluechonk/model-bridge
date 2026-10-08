/**
 * `accounts` 子命令：一个渠道下多个账号的查看、切换、新增、删除。
 *
 * 本文件只做**编排**（选渠道 → 调账号池 → 打印），账号池的实现与文件布局
 * 在 `account-pool.ts`（见 docs/POOL-ARCHITECTURE.md §3）。
 */

import { channels, getChannel, type Channel } from "./channel.js";
import { runInChannel } from "./channel-context.js";
import {
  activateAccount,
  captureActive,
  listAccounts,
  removeAccount,
  syncPool,
  type PoolAccount,
  type PoolIndex,
} from "./account-pool.js";
import * as headless from "./headless.js";

export interface AccountsOptions {
  /** list（默认）/ use / add / remove。 */
  verb?: string;
  /** use / remove 的目标账号 key。 */
  target?: string;
  /** 只操作该渠道；省略 = 全部已注册渠道（仓库级）。 */
  cid?: string;
  json?: boolean;
  /** add 用：登录域（workbuddy 的 intl/cn）。 */
  realm?: string;
  /** add 用：忽略已有凭证强制重登。 */
  force?: boolean;
}

interface ChannelPool {
  cid: string;
  display: string;
  index: PoolIndex;
}

function poolOf(channel: Channel): ChannelPool {
  const cid = channel.config.cid;
  return {
    cid,
    display: channel.upstream.DISPLAY_NAME,
    // 先 syncPool：把「现实」同步进池子 —— 池子空但已有凭证时自动收进来（登录即入池），
    // 渠道路径刷新过 token 时回灌。这样首次 `accounts` 就能看到已经登录的账号。
    index: runInChannel(cid, () => {
      syncPool(cid);
      return listAccounts(cid);
    }),
  };
}

function expiryText(account: PoolAccount): string {
  if (account.expires_at === null) return "";
  const date = new Date(account.expires_at * 1000);
  const days = Math.floor((account.expires_at * 1000 - Date.now()) / 86_400_000);
  const stamp = date.toISOString().slice(0, 10);
  if (days < 0) return `${stamp} 已过期`;
  return `${stamp} 到期（${days} 天后）`;
}

function render(pool: ChannelPool): string {
  const lines = [`${pool.cid} (${pool.display}) —— 当前生效: ${pool.index.active ?? "（无）"}`];
  if (pool.index.accounts.length === 0) {
    lines.push("  （空池：登录一个账号后会自动入池，或用 `accounts add` 新增）");
    return lines.join("\n");
  }
  for (const account of pool.index.accounts) {
    const mark = account.key === pool.index.active ? "*" : " ";
    const label = (account.label || "(无备注)").slice(0, 20).padEnd(20);
    const health = account.health.padEnd(12);
    const uid = account.uid ? `uid=${account.uid}` : "uid=(空)";
    const exp = expiryText(account);
    lines.push(`  ${mark} ${account.key}  ${label} ${health} ${uid}${exp ? `  ${exp}` : ""}`);
  }
  return lines.join("\n");
}

/** 跨渠道找 key 所属的池子；命中多于一个时报错要求 `--channel`。 */
function locator(collected: ChannelPool[], key: string): ChannelPool {
  const hits = collected.filter((p) => p.index.accounts.some((a) => a.key === key));
  if (hits.length === 0) throw new Error(`没有渠道的池子里有账号 ${key}`);
  if (hits.length > 1) {
    throw new Error(
      `账号 ${key} 在多个渠道里都存在（${hits.map((h) => h.cid).join(", ")}）—— 请加 --channel 指定`,
    );
  }
  return hits[0]!;
}

/** `accounts` 子命令实现。返回进程退出码。 */
export async function runAccounts(options: AccountsOptions = {}): Promise<number> {
  const { verb = "list", target, cid, json = false, realm = "auto", force = false } = options;
  const targets: Channel[] = cid !== undefined ? [getChannel(cid)] : channels();

  if (targets.length === 0) {
    console.error("没有渠道被注册（入口忘了 import 渠道包？）");
    return 2;
  }

  switch (verb) {
    case "list": {
      const pools = targets.map(poolOf);
      if (json) {
        console.log(JSON.stringify({ channels: pools }, null, 2));
        return 0;
      }
      console.log(pools.map(render).join("\n"));
      return 0;
    }

    case "use": {
      if (!target) {
        console.error("用法: accounts use <key> [--channel <cid>]");
        return 2;
      }
      const pools = targets.map(poolOf);
      let pool: ChannelPool;
      try {
        pool = locator(pools, target);
      } catch (err) {
        console.error(String(err));
        return 2;
      }
      runInChannel(pool.cid, () => activateAccount(target, pool.cid));
      if (json) {
        console.log(JSON.stringify(poolOf(getChannel(pool.cid)), null, 2));
        return 0;
      }
      console.log(`已切换到 ${pool.cid} 的账号 ${target}（credentials.json 已替换）`);
      return 0;
    }

    case "remove": {
      if (!target) {
        console.error("用法: accounts remove <key> [--channel <cid>]");
        return 2;
      }
      const pools = targets.map(poolOf);
      let pool: ChannelPool;
      try {
        pool = locator(pools, target);
      } catch (err) {
        console.error(String(err));
        return 2;
      }
      const result = runInChannel(pool.cid, () => removeAccount(target, pool.cid));
      if (!result.removed) {
        console.error(`账号 ${target} 不在 ${pool.cid} 的池子里`);
        return 2;
      }
      console.log(`已从 ${pool.cid} 的池子里删除 ${target}`);
      if (result.wasActive) {
        console.log(
          result.loggedOut
            ? "它原本是当前生效账号 → 已同时**登出**（credentials.json 已删除），池里已无 active。"
            : "它原本是当前生效账号 → 池里已无 active，但 credentials.json 删不掉（下次同步可能又把它收回来）。",
        );
      }
      return 0;
    }

    case "add": {
      // 新增 = 走该渠道自己的登录流程（浏览器授权）→ 登录成功即自动入池
      const channel = targets.length === 1 ? targets[0]! : null;
      if (!channel) {
        console.error("新增账号需要在某个渠道上登录：请加 --channel <cid>");
        return 2;
      }
      const code = await headless.runLogin({
        cid: channel.config.cid,
        json,
        realm,
        force,
      });
      if (code !== 0) return code;
      const account = runInChannel(channel.config.cid, () => captureActive(channel.config.cid));
      if (!json) {
        console.log(
          account
            ? `已加入 ${channel.config.cid} 的账号池：${account.key}（${account.label}），并设为当前生效`
            : `登录成功，但未能读回凭证入池（${channel.config.cid}）`,
        );
      } else if (account) {
        console.log(JSON.stringify({ event: "account", cid: channel.config.cid, account }));
      }
      return account ? 0 : 1;
    }

    default:
      console.error(`未知的 accounts 子命令: ${verb}（可用: list / use / add / remove）`);
      return 2;
  }
}
