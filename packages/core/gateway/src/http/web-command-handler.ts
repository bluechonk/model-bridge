/**
 * Web 命令分发：把前端 `/api/commands` 的 action 翻译到共享服务函数上。
 *
 * 独立模式下进程就在手边，直接调函数，不走进程外 CLI 探测。
 * 所有 handler 输出 JSON 对象（不是 `console.log`），与 CLI 的进程退出码语义解耦。
 */

import { channels, getChannel, hasChannel } from "../runtime/channel.js";
import { runInChannel } from "../runtime/channel-context.js";
import { POOL_MODELS, poolCandidates, canonicalModelId, asPoolModel } from "../pool/pool-targets.js";
import { ledgerSnapshot, scoreOf } from "../pool/pool-usage.js";
import { listAccounts, activateAccount, removeAccount, syncPool } from "../runtime/account-pool.js";
import { renderChannelPool } from "./web-types.js";
import type { WebCommandBody, WebCommandResult, WebChannelStatus } from "./web-types.js";

export type WebCommandHandler = (body: WebCommandBody) => Promise<WebCommandResult>;

/** /api/commands 的统一入口。 */
export const handleWebCommand: WebCommandHandler = async (body) => {
  const { action, cid, args = {} } = body;
  try {
    switch (action) {
      case "login": {
        if (cid === undefined || !hasChannel(cid)) {
          return err("参数 cid 必须是已注册渠道");
        }
        const force = typeof args["force"] === "boolean" ? args["force"] : false;
        return await handleLogin(cid, force);
      }
      case "status": {
        const list = cid !== undefined && hasChannel(cid) ? [getChannel(cid)] : channels();
        const rows: WebChannelStatus[] = list.map((channel) => {
          const cidInner = channel.config.cid;
          let present = false;
          try {
            runInChannel(cidInner, () => channel.cred.load());
            present = true;
          } catch {
            present = false;
          }
          return { cid: cidInner, display: channel.upstream.DISPLAY_NAME, present };
        });
        return ok({ channels: rows });
      }
      case "models": {
        const wanted = cid !== undefined && hasChannel(cid) ? [getChannel(cid)] : channels();
        const rows = wanted.map((channel) => {
          const cidInner = channel.config.cid;
          const catalogIds = runInChannel(cidInner, () => {
            try {
              return channel.catalog.exposedIds();
            } catch {
              return [] as string[];
            }
          });
          return {
            cid: cidInner,
            display: channel.upstream.DISPLAY_NAME,
            catalog: catalogIds,
            pool: POOL_MODELS.filter((model) => catalogIds.some((id) => canonicalModelId(id) === model)),
            out_of_pool: catalogIds.filter((id) => asPoolModel(id) === null).length,
          };
        });
        return ok({ channels: rows });
      }
      case "billing": {
        const now = Date.now();
        const ledger = ledgerSnapshot();
        const rows = POOL_MODELS.map((model) => ({
          model,
          candidates: poolCandidates(model).map((candidate) => {
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
            };
          }),
        }));
        return ok({ rows, models: POOL_MODELS });
      }
      case "accounts": {
        const targets = cid !== undefined && hasChannel(cid) ? [getChannel(cid)] : channels();
        if (targets.length === 0) return err("没有渠道被注册");
        const pools = targets.map((channel) => {
          const poolCid = channel.config.cid;
          runInChannel(poolCid, () => syncPool(poolCid));
          const index = runInChannel(poolCid, () => listAccounts(poolCid));
          return renderChannelPool(channel.config.cid, channel.upstream.DISPLAY_NAME, index);
        });
        return ok({ channels: pools });
      }
      case "activateAccount": {
        if (cid === undefined || !hasChannel(cid)) return err("参数 cid 必须是已注册渠道");
        const key = typeof args["key"] === "string" ? args["key"] : "";
        if (!key) return err("参数 key 必填");
        const account = runInChannel(cid, () => activateAccount(key, cid));
        return ok({ active: account.key });
      }
      case "removeAccount": {
        if (cid === undefined || !hasChannel(cid)) return err("参数 cid 必须是已注册渠道");
        const key = typeof args["key"] === "string" ? args["key"] : "";
        if (!key) return err("参数 key 必填");
        const result = runInChannel(cid, () => removeAccount(key, cid));
        if (!result.removed) return err(`账号 ${key} 不在 ${cid} 的池子里`);
        return ok({ removed: key, was_active: result.wasActive });
      }
      case "syncPool": {
        if (cid === undefined || !hasChannel(cid)) return err("参数 cid 必须是已注册渠道");
        runInChannel(cid, () => syncPool(cid));
        return ok({});
      }
      default:
        return err(`未知 action: ${String(action)}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
};

/** login：走通道自己的登录流程（浏览器授权）。 */
async function handleLogin(cid: string, force: boolean): Promise<WebCommandResult> {
  const channel = getChannel(cid);
  // 登录本质是交互流程（弹浏览器/扫码等）；HTTP handler 只触发它并把控制权交还用户
  // ——真实完成态通过 `GET /api/state` 的 auth_url 轮询呈现。
  void channel;
  void force;
  // 真·登录流程走 headless.runLogin（异步、可能阻塞几十秒）。这里先返回 ok:true，等 /api/state 轮询。
  setImmediate(() => {
    void (async () => {
      try {
        // 动态 import 避免 web-command-handler 在启动时强依赖 headless（重依赖网络）
        const { runLogin } = await import("../app/headless.js");
        await runLogin({ cid, force, json: true, realm: "auto" });
      } catch {
        // 登录失败会反映在后续 /api/state 的 auth_url 或 gateway_error 上
      }
    })();
  });
  return ok({ started: true, message: "登录流程已启动，授权链接通过 /api/state 的 auth_url 轮询" });
}

function ok(data: Record<string, unknown>): WebCommandResult {
  return { ok: true, data };
}

function err(message: string): WebCommandResult {
  return { ok: false, error: message };
}
