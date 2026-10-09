/**
 * 登录/凭证流程：与界面解耦 —— 只通过 `LoginUi` 接口交互。
 *
 * 无窗口（headless）与桌面窗口两种运行模式共用本模块：前者传一个把状态打到
 * stdout 的实现，后者传窗口对象。
 *
 * 三种情形的处置（关键差异）：
 *  - **无凭证**：非交互模式只报告状态并返回 false（由 `login` 子命令补凭证）；
 *    交互模式走浏览器授权
 *  - **凭证被拒**：先刷新；刷新失败**删除本地凭证**，让「重试登录」真正走重新
 *    登录流程，而不是重复同一条失败路径
 *  - **网络不通等临时问题**：照常启动，运行期请求失败会自动刷新
 *
 * 渠道差异（cred / upstream / 凭据路径）全部由注册的 `Channel` 提供。
 */

import { unlinkSync } from "node:fs";

import { getChannel, type LoginUi } from "./channel.js";
import { credentialsPath } from "./paths.js";

export type { LoginUi };

/**
 * 保证存在可用登录凭证；必要时引导登录。
 *
 * @param interactive 无窗口被动模式下传 false —— 缺凭证**不开浏览器**，
 *   只报告状态并返回 false。
 * @returns true 表示可以启动网关
 */
export async function ensureLogin(
  ui: LoginUi,
  options: { interactive?: boolean; baseUrl?: string; cid?: string } = {},
): Promise<boolean> {
  const { interactive = true, baseUrl, cid } = options;
  const { cred, upstream } = getChannel(cid);

  let c: ReturnType<typeof cred.load> | null;
  try {
    c = cred.load();
  } catch (err) {
    if (err instanceof cred.NotLoggedInError) {
      c = null;
    } else {
      ui.setState("login", `failed to read credentials (${String(err)}); re-login required.`);
      c = null;
    }
  }

  if (!c) {
    if (!interactive) {
      ui.setState("login", "not logged in: run the login subcommand for browser authorization, then retry.");
      return false;
    }
    ui.setState("login", "requesting authorization URL...");
    try {
      c = await cred.login(baseUrl ?? cred.DEFAULT_BASE_URL, {
        onUrl: (url) =>
          ui.setState("login", "complete authorization in the browser that just opened; this window will continue automatically.", url),
        onStatus: (msg) => ui.setState("login", msg),
      });
    } catch (err) {
      ui.setState("error", `login failed: ${String(err)}`);
      return false;
    }
    ui.setState("login", "authorized; initializing...");
    try {
      // 拉一次模型载荷：既验证新凭据可用，也顺便把上游连接配置落盘
      const data = await upstream.fetchModels(c);
      await upstream.saveConfig(upstream.resolveConfig(data));
    } catch {
      /* 模型载荷拉取失败不阻塞登录本身（网关运行期还会再拉） */
    }
    return true;
  }

  // 有凭证：探测登录状态（失效先刷新，仍失败则引导重新登录）
  try {
    await upstream.fetchModels(c);
    return true;
  } catch (err) {
    if (!(err instanceof upstream.UpstreamUnauthorized)) {
      // 网络不通等临时问题：照常启动，运行期请求失败会自动刷新
      ui.setState("error", `login check failed (${String(err)}); continuing to start anyway.`);
      return true;
    }
    try {
      const refreshed = await cred.refresh(c);
      await upstream.fetchModels(refreshed);
      return true;
    } catch (err2) {
      // 刷新失败（刷新令牌可能已被上游消费/作废）：删掉本地凭证，
      // 让「重试登录」真正走重新登录流程，而不是重复同一条失败路径
      try {
        unlinkSync(credentialsPath(cid));
      } catch {
        /* 文件本来就不在 */
      }
      ui.setState(
        "error",
        `credentials expired and refresh failed (${String(err2)}); click "retry login" to log in again.`,
      );
      return false;
    }
  }
}
