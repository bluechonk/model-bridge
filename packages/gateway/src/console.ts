/**
 * 控制台 API 服务：`/api/*` 提供只读状态快照与两个写动作。
 *
 * 与网关分开的原因有二：
 *  - 网关的 `/` 返回 JSON 是既有 API 契约，不能混入别的端点；
 *  - 控制台必须在**登录完成前**就可用，而此时网关还没启动。
 *
 * 只提供 API，不做静态页面托管；MCP 工具与脚本直接消费这些端点：
 *   GET  /api/state        状态快照（ui_state/message/auth_url/models/...）
 *   POST /api/theme        无窗口模式下为空操作（保留端点兼容）
 *   POST /api/retry-login  投递「重试登录」意图
 */

import { createServer, type Server } from "node:http";

import { serviceName } from "./gateway.js";

export const DEFAULT_UI_HOST = "127.0.0.1";

const THEME_MODES = new Set(["system", "dark", "light"]);

/** 状态快照；`ui_state` 取值 probing / login / error / running。 */
export interface UiSnapshot {
  ui_state: string;
  message: string;
  auth_url: string;
  base_url: string;
  chat_url: string;
  endpoints: string[];
  models: string[];
  theme_mode: string;
  resolved_theme: string;
  gateway_error: string;
}

export function emptySnapshot(): UiSnapshot {
  return {
    ui_state: "probing",
    message: "",
    auth_url: "",
    base_url: "",
    chat_url: "",
    endpoints: ["/v1/chat/completions", "/v1/models", "/health"],
    models: [],
    theme_mode: "system",
    resolved_theme: "dark",
    gateway_error: "",
  };
}

/**
 * HTTP 层 ↔ 运行层之间的桥。
 *
 * - `provider`：运行侧注册的「读快照」函数
 * - `setTheme` / `retryLogin`：运行侧注册的动作，由 HTTP 层调用；
 *   实现方自己保证线程/异步安全（retryLogin 用标志位即可）
 */
export interface ControlBridge {
  provider?: () => UiSnapshot;
  setTheme?: (mode: string) => void;
  retryLogin?: () => void;
}

export interface ConsoleServer {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

function json(res: import("node:http").ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

/** 启动控制台 API 服务。端口被占用时回退到系统分配的空闲端口。 */
export async function start(
  port: number,
  bridge: ControlBridge,
  host = DEFAULT_UI_HOST,
  cid?: string,
): Promise<ConsoleServer> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (path === "/api/state") {
      let snapshot: UiSnapshot;
      try {
        snapshot = bridge.provider?.() ?? emptySnapshot();
      } catch {
        // 运行侧尚未就绪时不要打断控制台
        snapshot = emptySnapshot();
      }
      json(res, snapshot);
      return;
    }

    if (path === "/api/theme") {
      if (req.method !== "POST") {
        json(res, { ok: false, error: "use POST" }, 405);
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        let mode: unknown;
        try {
          mode = (JSON.parse(body || "{}") as Record<string, unknown>)["mode"];
        } catch {
          json(res, { ok: false, error: "invalid json" }, 400);
          return;
        }
        if (typeof mode !== "string" || !THEME_MODES.has(mode)) {
          json(res, { ok: false, error: "invalid mode" }, 400);
          return;
        }
        if (!bridge.setTheme) {
          json(res, { ok: false, error: "not ready" }, 503);
          return;
        }
        bridge.setTheme(mode);
        json(res, { ok: true });
      });
      return;
    }

    if (path === "/api/retry-login") {
      if (req.method !== "POST") {
        json(res, { ok: false, error: "use POST" }, 405);
        return;
      }
      if (!bridge.retryLogin) {
        json(res, { ok: false, error: "not ready" }, 503);
        return;
      }
      bridge.retryLogin();
      json(res, { ok: true });
      return;
    }

    json(res, { ok: false, error: `unknown path ${path}` }, 404);
  });

  const bound = await new Promise<number>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EADDRINUSE" && err.code !== "EACCES") {
        reject(err);
        return;
      }
      // 端口不可用 → 改用系统分配端口（保留端口恢复时的兼容行为）
      server.listen(0, host, () => {
        const address = server.address() as { port: number } | null;
        resolve(address?.port ?? 0);
      });
    });
    server.listen(port, host, () => {
      const address = server.address() as { port: number } | null;
      resolve(address?.port ?? port);
    });
  });

  const url = `http://${host}:${bound}/`;
  console.error(`[${serviceName(cid)}] 控制台 API: ${url}`);

  return {
    server,
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
