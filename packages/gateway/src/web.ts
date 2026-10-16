/**
 * `mx web` 实现：在本地起 console server（含 Web UI 静态托管 + /api/commands），
 * 默认不启网关 —— 前端 Dashboard 的运行状态来自 /api/state 轮询快照。
 */

import * as console_ from "./console.js";
import { defaultUiPort } from "./cli-consts.js";

export interface WebOptions {
  host?: string;
  port?: number;
  open?: boolean;
}

export async function runWeb(options: WebOptions = {}): Promise<number> {
  const host = options.host ?? console_.DEFAULT_UI_HOST;
  const port = options.port ?? defaultUiPort();
  // `mx web --open` 才打开浏览器；默认保持 headless
  const open = options.open === true;
  const bridge: console_.ControlBridge = {
    // 独立模式没有网关进程，返回空头快照（前端显示 probing）
    provider: () => console_.emptySnapshot(),
    setTheme: () => {},
    retryLogin: () => {},
  };
  const server = await console_.start(port, bridge, host);
  console.log(`[web] ${server.url}`);
  console.log("[web] Ctrl+C 停止");
  if (open) {
    // 跨平台打开浏览器的最小实现：Windows 走 cmd start，其余平台按惯例
    const { spawn } = await import("node:child_process");
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", server.url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [server.url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [server.url], { detached: true, stdio: "ignore" }).unref();
    }
  }
  // 只注册一次信号处理器，避免 main() 复跑时留下重复监听
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      console.log("[web] stopping");
      void server.close().then(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
