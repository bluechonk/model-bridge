/**
 * Web 命令分发：把前端 `/web/api/commands` 的 action 翻译到共享服务函数上。
 *
 * 独立模式下进程就在手边，直接调函数，不走进程外 CLI 探测。
 * 所有 handler 输出 JSON 对象（不是 `console.log`），与 CLI 的进程退出码语义解耦。
 *
 * ⚠ **登录的触发经 `WebCommandDeps.triggerLogin` 注入**，不在本层 import app 层的
 * `headless`（那会造成 http → app 的层级违例，见 `scripts/verify-layering.mjs`）。
 * 调用方（headless 的 bridge）负责提供实现。
 */

import { channels, getChannel, hasChannel } from "../runtime/channel.js";
import { runInChannel } from "../runtime/channel-context.js";
import { POOL_MODELS, canonicalModelId, poolModelId, poolCandidates } from "../pool/pool-targets.js";
import { ledgerSnapshot, scoreOf } from "../pool/pool-usage.js";
import { listAccounts, activateAccount, removeAccount, syncPool } from "../runtime/account-pool.js";
import { renderChannelPool } from "./web-types.js";
import type { WebCommandBody, WebCommandResult, WebChannelStatus } from "./web-types.js";

/**
 * 命令分发的外部依赖（由调用方注入）。
 *
 * `triggerLogin` 省略时登录动作返回「未就绪」——纯 API 形态的网关不挂控制台，
 * 自然也没有交互式登录可用。
 */
export interface WebCommandDeps {
  /** 触发某渠道的交互式登录（浏览器授权等）。实现方负责异步执行与错误上报。 */
  triggerLogin?: (cid: string, force: boolean) => void;
  /**
   * 提交用户粘回的回调链接（一次性授权 code 的兜底通道）。
   *
   * 回调页线上是 404（微信只校验 `redirect_uri` 域名、官方客户端在内嵌窗口里
   * 拦跳转），所以没有浏览器的进程只能靠用户把地址栏那条链接粘回来。
   */
  submitCallback?: (raw: string) => void;
}

export type WebCommandHandler = (body: WebCommandBody) => Promise<WebCommandResult>;

/** /api/commands 的统一入口。 */
export function createWebCommandHandler(deps: WebCommandDeps = {}): WebCommandHandler {
  return async (body) => {
    const { action, cid, args = {} } = body;
    try {
      switch (action) {
        case "login": {
          if (cid === undefined || !hasChannel(cid)) {
            return err("参数 cid 必须是已注册渠道");
          }
          const force = typeof args["force"] === "boolean" ? args["force"] : false;
          return handleLogin(cid, force, deps);
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
          // 渠道内先按规范名去重：同一渠道的不同原始写法收敛为同一个对外 id
          const pool = [
            ...new Map(catalogIds.map((id) => [canonicalModelId(id), id])).values(),
          ].map((id) => poolModelId(cidInner, id));
          return {
            cid: cidInner,
            display: channel.upstream.DISPLAY_NAME,
            catalog: catalogIds,
            pool,
            out_of_pool: 0,
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
      case "pasteCallback": {
        // 兜底路径：回调页线上是 404，code 只在用户浏览器地址栏里。
        // 长轮询拿不到时，由用户把那条链接粘回来完成登录。
        const raw = typeof args["url"] === "string" ? args["url"] : "";
        if (!raw.trim()) return err("参数 url 必填（粘贴浏览器地址栏里的回调链接）");
        if (!deps.submitCallback) {
          return err("当前运行形态不支持粘贴回调链接（未注入 submitCallback）");
        }
        deps.submitCallback(raw);
        return ok({ submitted: true, message: "已收到回调链接，登录流程将继续" });
      }
      default:
        return err(`未知 action: ${String(action)}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
  };
}

/** login：经注入的回调触发渠道的登录流程（浏览器授权）。 */
function handleLogin(cid: string, force: boolean, deps: WebCommandDeps): WebCommandResult {
  // 登录本质是交互流程（弹浏览器/扫码等）；HTTP handler 只触发它并把控制权交还用户
  // ——真实完成态通过 `GET /web/api/state` 的 auth_url 轮询呈现。
  if (!deps.triggerLogin) {
    return err("当前运行形态不支持交互式登录（未注入 triggerLogin）");
  }
  // 回调实现方负责异步执行（可能阻塞几十秒）；这里立即返回，等 /web/api/state 轮询。
  setImmediate(() => {
    try {
      deps.triggerLogin!(cid, force);
    } catch {
      // 登录失败会反映在后续 /web/api/state 的 auth_url 或 gateway_error 上
    }
  });
  return ok({ started: true, message: "登录流程已启动，授权链接通过 /web/api/state 的 auth_url 轮询" });
}

function ok(data: Record<string, unknown>): WebCommandResult {
  return { ok: true, data };
}

function err(message: string): WebCommandResult {
  return { ok: false, error: message };
}
