/**
 * 控制台 API 服务：`/api/*` 提供只读状态快照与写动作；`/` 与 `/assets/*` 静态托管 UI。
 *
 * 与网关分开的原因有二：
 *  - 网关的 `/` 返回 JSON 是既有 API 契约，不能混入别的端点；
 *  - 控制台必须在**登录完成前**就可用，而此时网关还没启动。
 *
 * 端点：
 *   GET  /                    静态 SPA 首页 (packages/gateway/dist/ui/index.html)
 *   GET  /assets/*            静态资产
 *   GET  /api/state           状态快照
 *   POST /api/theme           主题
 *   POST /api/retry-login     重试登录
 *   POST /api/commands        服务动作分发（web-command-handler.ts）
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, extname, join, resolve, sep } from "node:path";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

import { serviceName } from "./gateway.js";

export const DEFAULT_UI_HOST = "127.0.0.1";

const THEME_MODES = new Set(["system", "dark", "light"]);

/** UI 静态产物根：与 dist/*.js 平级。 */
const WEB_UI_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "ui");
const WEB_UI_INDEX = join(WEB_UI_ROOT, "index.html");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

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

function text(res: import("node:http").ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`${body}\n`);
}

/** 静态文件服务（含路径穿越校验）。 */
function serveStatic(res: import("node:http").ServerResponse, relPath: string): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    // 畸形百分号编码（如 `%E0%A4%A`）会让 decodeURIComponent 抛 URIError；
    // 不接住就是 uncaughtException，控制台进程会随网关一起挂掉。
    text(res, 400, "Bad request");
    return;
  }
  const relative = decoded.replace(/^[\\\/]+/, "");
  if (relative.split("/").some((segment) => segment === "..")) {
    text(res, 403, "Forbidden");
    return;
  }
  const file = isAbsolute(relative)
    ? relative
    : resolve(WEB_UI_ROOT, relative);
  if (!file.startsWith(`${WEB_UI_ROOT}${sep}`) && file !== WEB_UI_ROOT) {
    text(res, 403, "Forbidden");
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    text(res, 404, "Not found");
    return;
  }
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  // 内容哈希命名的资产可长缓存；其余（index.html 等）保持不缓存
  const cache = relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-store";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": cache });
  res.end(readFileSync(file));
}

/** 写操作同源校验（比对 host:port，避免只比 hostname 时跨端口请求被放行）。 */
function isSameOrigin(req: import("node:http").IncomingMessage, host: string): boolean {
  const origin = req.headers["origin"];
  // 同源 POST 也会带 Origin（浏览器规范），缺失时才按「非浏览器客户端」放行
  if (typeof origin !== "string" || !origin) return true;
  try {
    const parsed = new URL(origin);
    const reqHost = req.headers["host"] ?? "";
    // 严格比较 host:port —— 只比 hostname 会让 127.0.0.1:其他端口 / https 变体穿透
    return parsed.host === reqHost || (parsed.hostname === host && parsed.port === new URL(`http://${reqHost}`).port);
  } catch {
    return false;
  }
}

/** 启动控制台 API 服务。端口被占用时回退到系统分配的空闲端口。 */
export async function start(
  port: number,
  bridge: ControlBridge,
  host = DEFAULT_UI_HOST,
  cid?: string,
): Promise<ConsoleServer> {
  void cid; // 保留签名兼容（旧的 hostname 区分逻辑，独立 web 模式无渠道概念）
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    // —— 静态（GET） ——
    if (path === "/" && (req.method === "GET" || req.method === "HEAD")) {
      if (existsSync(WEB_UI_INDEX)) serveStatic(res, "index.html");
      else text(res, 404, "UI 未构建。请运行 npm run build 后再试 mx web。");
      return;
    }
    const assetsPrefix = "/assets/";
    if (req.method === "GET" && path.startsWith(assetsPrefix)) {
      serveStatic(res, path.slice(assetsPrefix.length));
      return;
    }

    // SPA 回退：React Router 在客户端负责路由（非 API 路径都回 index.html）
    if (!path.startsWith("/api/") && (req.method === "GET" || req.method === "HEAD")) {
      serveStatic(res, WEB_UI_INDEX);
      return;
    }

    // —— API ——
    if (path === "/api/state") {
      let snapshot: UiSnapshot;
      try {
        snapshot = bridge.provider?.() ?? emptySnapshot();
      } catch {
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

    if (path === "/api/commands") {
      if (req.method !== "POST") {
        json(res, { ok: false, error: "use POST" }, 405);
        return;
      }
      // 写操作需要同源。静态资产从 UI 发来的请求都同源（浏览器会带 Origin），
      // 这里只拦跨源；fetch 同源不会带 Origin，所以直接靠有 Origin 且不匹配拒绝。
      if (!isSameOrigin(req, host)) {
        json(res, { ok: false, error: "跨源请求已拒绝" }, 403);
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        void (async () => {
          let parsed: { action?: unknown; cid?: unknown; args?: unknown };
          try {
            parsed = JSON.parse(body || "{}") as { action?: unknown; cid?: unknown; args?: unknown };
          } catch {
            json(res, { ok: false, error: "invalid json" }, 400);
            return;
          }
          const { action, cid, args } = parsed;
          if (typeof action !== "string" || !action) {
            json(res, { ok: false, error: "参数 action 必填" }, 400);
            return;
          }
          const handle = (await import("./web-command-handler.js")).handleWebCommand;
          const result = await handle({
            action,
            ...(typeof cid === "string" ? { cid } : {}),
            args: typeof args === "object" && args !== null ? args as Record<string, unknown> : {},
          });
          json(res, result, result.ok ? 200 : 400);
        })();
      });
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
  console.error(`[${serviceName(cid)}] console API: ${url}`);

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
