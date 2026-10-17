/**
 * `mx web` 实现：**单端口模式** —— 确保网关在跑，然后打开 Web 控制台。
 *
 * 控制台不再起独立进程/端口：UI 挂载在网关的 `/web` 前缀下（见 `REPO_UI_PREFIX`），
 * 控制台 API 位于 `/web/api/*`。因此 Web 页面看到的状态永远来自真实网关进程。
 */

import { REPO_DEFAULT_ADDR, REPO_UI_PREFIX } from "../runtime/cli-consts.js";
import * as daemon from "./daemon.js";

export interface WebOptions {
  host?: string;
  port?: number;
  open?: boolean;
  quiet?: boolean;
}

/** 跨平台打开浏览器（最小实现）。 */
async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

export async function runWeb(options: WebOptions = {}): Promise<number> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? Number.parseInt(REPO_DEFAULT_ADDR.split(":")[1] ?? "4412", 10);
  const addr = `${host}:${port}`;
  const url = `http://${addr}${REPO_UI_PREFIX}/`;

  // 复用 `start` 的幂等语义：未跑则拉起（受 auto_start 约束），已跑则直接返回
  const code = await daemon.start({ addr, quiet: options.quiet ?? false, auto: false });
  if (code !== 0) return code;

  console.log(`[web] ${url}`);
  if (options.open === true) await openBrowser(url);
  return 0;
}
