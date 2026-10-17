/**
 * 本地 OpenAI Chat Completion 透明代理网关：路由与生命周期。
 *
 * 结构：
 * - 本文件：`createHandler`（路由分发）/ `makeApp` / `start` / `describe` / `splitAddr`
 * - `chat-relay.ts`：聊天转发链路（候选排序、失败转移、SSE 中继）—— 由 handleChat 承载
 * - `sse-stream.ts` / `portfree.ts`：SSE 规范化与端口自愈
 *
 * 渠道差异全部由注册的 `Channel`（`upstream` / `cred` / `catalog`）提供，
 * 本层不含任何渠道知识（见 `docs/POOL-ARCHITECTURE.md`）。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { channelCount, channelFor, channels, getChannel, type Channel, type Credential, type StreamTranslator, type UpstreamConfig } from "../runtime/channel.js";
import { runInChannel } from "../runtime/channel-context.js";
import { POOL_MODELS, getPoolModelMeta, poolCandidates } from "../pool/pool-targets.js";
import { inChannel } from "./chat-relay.js";
import { baseUrlOf, bindFreeServer, displayBase } from "./portfree.js";
import { handleChat, writeJson, writeJsonError } from "./chat-relay.js";

export function serviceName(cid?: string): string {
  if (cid !== undefined) return channelFor(cid).config.cid;
  if (channelCount() === 1) return channels()[0]!.config.cid;
  return "modelmux";
}

/** 本进程认得的全部服务标识（单渠道的 `cid` 与仓库级的 `modelmux`）。 */

export function knownServiceNames(): string[] {
  return ["modelmux", ...channels().map((c) => c.config.cid)];
}

/** 本实现的语言标识（供 status 区分同名的旧实现）。 */

export const IMPLEMENTATION = "typescript";


export interface GatewayOptions {
  verbose?: boolean;
  logger?: (message: string) => void;
  /**
   * 控制台 Web UI 的挂载点（**可选注入**）。
   *
   * 单端口模式（`mx web` / `mx start --web`）时传入 `createConsoleHandler(bridge, "/web")`，
   * 网关会在 `/web` 与 `/web/*` 前缀下转发给它；不传时网关行为与纯 API 服务完全一致
   * （保持 gateway 不被 UI 耦合）。
   */
  console?: (req: IncomingMessage, res: ServerResponse) => void;
  /** 控制台挂载前缀（默认 `/web`）。 */
  consolePrefix?: string;
}


/** 错误响应 JSON 结构：`{"error":{"type","code","message"}}`。 */


function handleModels(res: ServerResponse): void {
  const owner = serviceName();
  writeJson(res, {
    object: "list",
    // 字段结构对齐 DeepSeek 官方 `GET /models`（见 pool-targets.ts 的 PoolModelMeta）：
    // **没有 `created`**，`name` 是展示名，并带上上下文 / 最大输出 / 模态 / 档位。
    data: POOL_MODELS.map((id) => {
      const meta = getPoolModelMeta(id);
      return {
        id,
        object: "model",
        owned_by: owner,
        name: meta.name,
        context_window: meta.contextWindow,
        max_output_tokens: meta.maxOutputTokens,
        input_modalities: meta.inputModalities,
        output_modalities: meta.outputModalities,
        effort: {
          supported_levels: meta.effort.supportedLevels,
          default_level: meta.effort.defaultLevel,
        },
      };
    }),
  });
}


function handleHealth(res: ServerResponse): void {
  const list = channels();
  const status: Record<string, unknown> = {
    ok: true,
    service: serviceName(),
    implementation: IMPLEMENTATION,
  };

  const per: Array<Record<string, unknown>> = [];
  let anyLoggedIn = false;
  for (const channel of list) {
    const entry: Record<string, unknown> = {
      cid: channel.config.cid,
      display: channel.upstream.DISPLAY_NAME,
    };
    try {
      inChannel(channel, () => channel.cred.load());
      entry["logged_in"] = true;
      anyLoggedIn = true;
    } catch (err) {
      // 未登录**不算网关不健康** —— 网关可用性与凭据状态是两件事。
      // 把未登录报成 unhealthy 会让守护进程的 start 逻辑反复重启网关。
      entry["logged_in"] = false;
      entry["detail"] = String(err);
    }
    per.push(entry);
  }

  if (list.length === 1) {
    const only = per[0]!;
    status["logged_in"] = only["logged_in"] ?? false;
    if (only["detail"] !== undefined) status["detail"] = only["detail"];
  } else {
    // 多渠道路由：顶层是「任一已登录」，逐渠道明细在 channels[]
    status["logged_in"] = anyLoggedIn;
    status["channels"] = per;
  }
  writeJson(res, status);
}


export const ENDPOINTS = ["/v1/chat/completions", "/v1/models", "/health"];


function handleRoot(res: ServerResponse, path: string): void {
  if (path === "/") {
    const list = channels();
    writeJson(res, {
      service: serviceName(),
      display: list.length === 1 ? list[0]!.upstream.DISPLAY_NAME : "modelmux",
      channels: list.map((c) => c.config.cid),
      endpoints: ENDPOINTS,
    });
    return;
  }
  writeJsonError(res, 404, "not_found", `unknown path ${path}`);
}

/** 构造 HTTP 请求处理器（供 server 与测试共用）。 */

export function createHandler(opts: GatewayOptions = {}) {
  const options: Required<GatewayOptions> = {
    verbose: opts.verbose ?? false,
    logger: opts.logger ?? ((m: string) => console.error(`[${serviceName()}] ${m}`)),
    console: opts.console ?? (() => {}),
    consolePrefix: opts.consolePrefix ?? "/web",
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    try {
      // —— 控制台 Web UI（可选挂载；未注入时下面的 live 检查会直接跳过）——
      if (opts.console) {
        const prefix = options.consolePrefix;
        // `/web` 无尾斜杠时补一个 301，保证 SPA 里的相对资源路径解析正确
        if (path === prefix) {
          res.writeHead(301, { Location: `${prefix}/` });
          res.end();
          return;
        }
        if (path.startsWith(`${prefix}/`)) {
          options.console(req, res);
          return;
        }
      }
      if (path === "/v1/chat/completions") {
        await handleChat(req, res, options);
        return;
      }
      if (path === "/v1/models") {
        if (req.method !== "GET") {
          writeJsonError(res, 405, "method_not_allowed", "use GET");
          return;
        }
        handleModels(res);
        return;
      }
      if (path === "/health") {
        handleHealth(res);
        return;
      }
      handleRoot(res, path);
    } catch (err) {
      options.logger(`request handler error: ${String(err)}`);
      if (!res.headersSent) {
        writeJsonError(res, 500, "internal_error", "gateway internal error; see logs");
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  };
}


export interface RunningGateway {
  server: Server;
  addr: string;
  close: () => Promise<void>;
}

/** 构造一个未监听的 HTTP server（供测试直接 listen(0)）。 */

export function makeApp(opts: GatewayOptions = {}): Server {
  const handler = createHandler(opts);
  return createServer((req, res) => {
    void handler(req, res);
  });
}

/** 在指定地址上启动网关（端口自愈）。 */

export async function start(addr: string, opts: GatewayOptions = {}): Promise<RunningGateway> {
  const [host, portText] = splitAddr(addr);
  const port = Number.parseInt(portText, 10);
  const logger =
    opts.logger ?? ((m: string) => console.error(`[${serviceName()}] ${m}`));
  const server = await bindFreeServer(host, port, logger);
  const handler = createHandler({ ...opts, logger });
  server.on("request", (req, res) => {
    void handler(req, res);
  });

  const actualPort = (server.address() as { port: number } | null)?.port ?? port;
  return {
    server,
    addr: `${host}:${actualPort}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/** 解析 `host:port`（支持 `[v6]:port`）。 */

export function splitAddr(addr: string): [string, string] {
  if (addr.startsWith("[")) {
    const close = addr.indexOf("]");
    const host = addr.slice(1, close);
    const port = addr.slice(close + 2);
    return [host, port];
  }
  const idx = addr.lastIndexOf(":");
  if (idx < 0) return ["127.0.0.1", addr];
  return [addr.slice(0, idx) || "127.0.0.1", addr.slice(idx + 1)];
}

/** 供 headless/serve 复用的展示信息。 */

export function describe(addr: string): { base: string; url: string } {
  return { base: displayBase(addr), url: baseUrlOf(addr) };
}

export type { UpstreamConfig };

