/**
 * 本地 OpenAI Chat Completion 透明代理网关。
 *
 * ## 结构
 *
 * 渠道差异全部由注册的 `Channel`（`upstream` / `cred` / `catalog`）提供，
 * 本文件不含任何渠道知识：
 *
 * | 需要什么 | 由谁提供 |
 * |---|---|
 * | 端点 URL | `upstream.chatUrl()` |
 * | 请求头（鉴权 + 伪装） | `upstream.buildHeaders(credential)` |
 * | 请求体改写 | `upstream.buildChatBody(req, upstreamModel)` |
 * | 流翻译（自定义线型） | `upstream.newTranslator()`，由 `upstream.WIRE` 决定 |
 * | 凭据 | `cred.load()` / `cred.refresh()` |
 * | 模型目录 | `catalog.exposedIds()` / `catalog.resolveModel()` |
 *
 * ## 线型分流
 *
 * - `WIRE === "openai"`：上游帧已是 OpenAI delta → `sse-stream.relay()` 规范化透传
 * - `WIRE === "custom"`：上游是自定义协议（Anthropic 事件 / 累积帧 / event 流）
 *   → 用 `upstream.newTranslator()` **增量**翻成 OpenAI SSE
 *
 * ⚠ 增量而非「读完再翻」：后者会让流式失去意义（用户要等整轮生成完才看到第一个字）。
 *
 * ## 客户端要非流式怎么办
 *
 * 多数上游**只支持流式**（`stream: false` 会报错），故本层恒向上游要流式，
 * 客户端要非流式时**聚合**成一个 `chat.completion` JSON 返回。
 *
 * ## 渠道约束（首条必须 system / 只支持流式 / 指纹拦截）不在本层
 *
 * 它们是渠道知识，归 `upstream.buildChatBody()` 实现。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  channelCount,
  channelFor,
  channels,
  getChannel,
  type Channel,
  type Credential,
  type StreamTranslator,
  type UpstreamConfig,
} from "./channel.js";
import { runInChannel } from "./channel-context.js";
import { activateAccount, markActiveHealth, pickAccount, readIndex } from "./account-pool.js";
import { resolvePoolModel } from "./model-pool.js";
import { asPoolModel, poolCandidates, POOL_MODELS, POOL_MODEL_META } from "./pool-targets.js";
import { maybeRefreshBilling, noteFailure, noteSuccess, scoreOf } from "./pool-usage.js";
import * as sseStream from "./sse-stream.js";
import { baseUrlOf, bindFreeServer, displayBase } from "./portfree.js";

const MAX_BODY = 32 << 20;

/**
 * 转发响应时剔除的头：hop-by-hop 头，以及与本进程实际发出内容不一致的头。
 *
 * `content-length` 与 `content-encoding` 必须剔除：Node 会自动解压上游响应体，
 * 若把上游的 content-encoding 原样转发，客户端会按 gzip 去解压后的明文而出错。
 */
const STRIP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
]);

const READ_TIMEOUT_MS = 120_000;

/** 排队重试：单帧退避上限（上游给的 retryAfterSeconds 超过它就按这个等）。 */
const QUEUE_RETRY_MAX_DELAY_MS = 10_000;
/** 排队重试：整个请求的总时长上限（含首次尝试与所有等待）。 */
const QUEUE_RETRY_BUDGET_MS = 300_000;

/**
 * 服务标识：出现在 `/health` 应答里。
 *
 * ⚠ 为什么需要它：同一端口上可能跑着**其它实现或其它项目的网关**，
 * 它们同样返回 `{"ok":true}`。只按 `ok` 判定会让 `status` 把别人的进程
 * 报成「自己的网关 OK」，而请求实际发去了另一个程序。
 * 故 `daemon.gatewayHealthy()` 会核对 `service` 字段。
 *
 * 取值：单渠道模式为 `<cid>-bridge`（兼容既有守护进程判据）；多渠道路由下为
 * 仓库级身份 `model-bridge` —— 它同时服务所有已注册渠道。
 */
export function serviceName(cid?: string): string {
  if (cid !== undefined) return `${channelFor(cid).config.cid}-bridge`;
  if (channelCount() === 1) return `${channels()[0]!.config.cid}-bridge`;
  return "model-bridge";
}

/** 本进程认得的全部服务标识（单渠道的 `<cid>-bridge` 与仓库级的 `model-bridge`）。 */
export function knownServiceNames(): string[] {
  return ["model-bridge", ...channels().map((c) => `${c.config.cid}-bridge`)];
}

/** 本实现的语言标识（供 status 区分同名的旧实现）。 */
export const IMPLEMENTATION = "typescript";

export interface GatewayOptions {
  verbose?: boolean;
  logger?: (message: string) => void;
}

function writeJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

/** 错误响应 JSON 结构：`{"error":{"type","code","message"}}`。 */
function writeJsonError(res: ServerResponse, status: number, code: string, message: string): void {
  writeJson(res, { error: { type: "error", code, message } }, status);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > MAX_BODY) throw new Error("request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** 调用渠道模块时一律包进渠道上下文（渠道内部的 `paths.*` 据此解析自己的落点）。 */
function inChannel<T>(channel: Channel, fn: () => T): T {
  return runInChannel(channel.config.cid, fn);
}

/** 该渠道的上游线型是否为自定义（需翻译层）。 */
function isCustomWire(channel: Channel): boolean {
  return String(channel.upstream.WIRE) !== "openai";
}

/**
 * 池路由一次请求最多尝试几个候选渠道。
 *
 * 为什么要有上限：候选可能有一大片（某个模型有 4~5 家候选），逐个串行尝试会让
 * 最坏情况的延迟成倍增长。默认 3 与账号池的转移上限一致。
 * `BRIDGE_POOL_MAX_TRIES` 可覆盖。
 */
const DEFAULT_POOL_ATTEMPTS = 3;

function maxPoolAttempts(): number {
  const raw = process.env["BRIDGE_POOL_MAX_TRIES"];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POOL_ATTEMPTS;
}

/**
 * 按账本给候选排序：**账单已用量降序**，冷却期内当 0，同分保持注册顺序。
 *
 * `poolCandidates()` 已按注册顺序返回，而 `Array.prototype.sort` 稳定，
 * 所以并列时天然保持注册顺序 —— 不需要额外的 tie-break 字段。
 */
function rankCandidates<T extends { cid: string }>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => scoreOf(b.cid) - scoreOf(a.cid));
}

interface UpstreamCall {
  ok: boolean;
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  error?: Error;
  /** 连接阶段失败（请求未发出）—— 重试无副作用。 */
  connectFailed?: boolean;
}

/**
 * 向上游发起流式请求。
 *
 * 401/403 由调用方刷新后重试；连接阶段失败归 `connectFailed`（请求未发出，可安全重试）。
 */
async function openStream(channel: Channel, c: Credential, body: Buffer): Promise<UpstreamCall> {
  const { upstream } = channel;
  const headers = upstream.buildHeaders(c);
  if (!Object.keys(headers).some((k) => k.toLowerCase() === "accept")) {
    headers["Accept"] = "text/event-stream";
  }

  let resp: Response;
  try {
    resp = await fetch(upstream.chatUrl(), {
      method: "POST",
      body: new Uint8Array(body),
      headers,
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    const code = cause?.code ?? (err as { code?: string }).code;
    const connectFailed =
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      code === "UND_ERR_CONNECT_TIMEOUT" ||
      code === "UND_ERR_SOCKET";
    return {
      ok: false,
      status: 0,
      headers: new Headers(),
      body: null,
      error: new Error(`upstream request failed: ${String(err)}`),
      connectFailed,
    };
  }

  if (resp.status === 401 || resp.status === 403) {
    return { ok: false, status: resp.status, headers: resp.headers, body: null };
  }
  if (resp.status !== 200) {
    const snippet = await resp.text().catch(() => "");
    // 渠道可声明「非标准状态码的鉴权失败」（如 codearts 的 400 + APIG.0602）：
    // 归一成 401，让调用方走刷新/换账号链路
    if (upstream.isAuthFailure && upstream.isAuthFailure(resp.status, snippet)) {
      return { ok: false, status: 401, headers: resp.headers, body: null };
    }
    return {
      ok: false,
      status: resp.status,
      headers: resp.headers,
      body: null,
      error: new Error(`upstream returned HTTP ${resp.status}: ${snippet.slice(0, 2048)}`),
    };
  }
  return { ok: true, status: resp.status, headers: resp.headers, body: resp.body };
}

// ── 流处理 ────────────────────────────────────────────────────────────────────

/** 把翻译器产出的帧统一成 Buffer。 */
function asBuffer(frame: Buffer | string): Buffer {
  return Buffer.isBuffer(frame) ? frame : Buffer.from(frame, "utf8");
}

/**
 * 流式转发：`openai` 线型走规范化透传，`custom` 线型走增量翻译。
 *
 * ⚠ 翻译异常**不能穿透成 500**（响应头已发出）：产出 error 帧并正常结束，
 *   否则客户端只看到一个断掉的连接，拿不到任何原因。
 */
async function relayStream(
  res: ServerResponse,
  upstreamBody: ReadableStream<Uint8Array>,
  contentType: string,
  logger: (m: string) => void,
  channel: Channel,
  cid?: string,
  resumeTranslator?: StreamTranslator,
): Promise<void> {
  if (!isCustomWire(channel)) {
    await sseStream.relay(res, upstreamBody, contentType, cid);
    return;
  }

  const { upstream } = channel;
  // ⚠ 排队探测可能已用同一实例读了一段：必须接着用同一个。换新实例会把
  //   旧实例缓冲里的**半行**丢掉，残行收尾时整帧解析失败被丢弃（实测：tool_call 参数损坏）。
  const translator = resumeTranslator ?? upstream.newTranslator();
  const reader = upstreamBody.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of translator.feed(Buffer.from(value))) {
        res.write(asBuffer(frame));
      }
    }
    for (const frame of translator.finish()) {
      res.write(asBuffer(frame));
    }
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ECONNRESET" || code === "EPIPE" || code === "ERR_STREAM_PREMATURE_CLOSE") {
      // 客户端提前断开（如主动取消请求）属正常情况
      logger("client disconnected, stopping relay");
    } else {
      logger(`upstream stream failed: ${String(err)}`);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ error: { message: `upstream stream failed: ${String(err)}` } })}\n\n`,
        );
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    if (!res.writableEnded) res.end();
  }
}

/** 把上游流聚合成 OpenAI SSE 字节（非流式路径用）。 */
async function collectAsOpenAiSse(
  upstreamBody: ReadableStream<Uint8Array>,
  channel: Channel,
  cid?: string,
  resumeTranslator?: StreamTranslator,
): Promise<Buffer> {
  if (!isCustomWire(channel)) return sseStream.readAll(upstreamBody, cid);

  const { upstream } = channel;
  // ⚠ 与 relayStream 同理：探测用过的实例必须接着用，半行缓冲不能丢。
  const translator = resumeTranslator ?? upstream.newTranslator();
  const reader = upstreamBody.getReader();
  const out: Buffer[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of translator.feed(Buffer.from(value))) out.push(asBuffer(frame));
    }
    for (const frame of translator.finish()) out.push(asBuffer(frame));
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(out);
}

// ── 排队探测（响应头发出前） ─────────────────────────────────────────────────

/** `cred.load()` 的安全包装：未登录返回 null（排队重开上游时用）。 */
function loadCredentialSafe(channel: Channel): Credential | null {
  try {
    return inChannel(channel, () => channel.cred.load());
  } catch {
    return null;
  }
}

interface QueueProbe {
  /** 流内是否出现排队帧（渠道 isQueueError 判定）。 */
  queued: boolean;
  /** 上游建议的等待秒数（从排队帧解析；没有就不给）。 */
  delayMs?: number;
  /**
   * 探测消费掉、必须交回调用方**按原序**转发的帧（内容帧 + 非排队错误帧）。
   * 一个都不能丢 —— 吞掉就是流中缺段、非流式空响应（见本文件「排队探测」注释）。
   */
  frames: Buffer[];
  /** 是否已见到内容帧（见到 = 响应是真实的，排队重试必须停）。 */
  hasContent: boolean;
  /** 排队帧里解析到的 retryAfterSeconds 原文（日志用）。 */
  rawDelaySec?: number;
  /**
   * 探测用的翻译器实例。它的行缓冲里可能还剩**半行**（跨 TCP 块的帧前缀），
   * 转发阶段必须接着用同一实例，换新实例会把半行前缀丢掉、残行整帧解析失败。
   */
  translator: StreamTranslator;
}

/**
 * 消费上游流做「排队探测」：**不向客户端写任何字节**。
 *
 * 翻译器逐帧处理：
 * - 内容帧（`data:` 且非 error）→ 记入 `frames` 并停止探测（有内容就不能重试），
 *   **但同一块里紧随其后的帧也要一并收走**（TCP 合并发送时一块可能有多帧）
 * - 错误帧 → 问渠道 `isQueueError`：是排队就记下延迟并继续等下一帧；
 *   否则记入 `frames` 后停止探测（交回调用方，不能吞）
 * - 流结束仍无内容也无排队 → `queued: false`（正常完成或普通错误）
 *
 * ⚠ 只在 `relayUpstream` **之前**调用：一旦开始向客户端写字节，本函数就没意义了。
 * ⚠ 返回的 `translator` 必须交给转发层接着用（半行缓冲在里面）。
 */
async function consumeQueueProbe(
  upstreamBody: ReadableStream<Uint8Array>,
  channel: Channel,
  cid?: string,
  translator: StreamTranslator = channel.upstream.newTranslator(),
): Promise<QueueProbe> {
  const reader = upstreamBody.getReader();
  const probe: QueueProbe = { queued: false, frames: [], hasContent: false, translator };
  /** 已决定停止探测：同块剩余帧只收不判（丢了就是流中缺段）。 */
  let stopped = false;
  const take = (frame: Buffer | string): void => {
    const buf = asBuffer(frame);
    if (stopped) {
      probe.frames.push(buf);
      return;
    }
    const text = buf.toString("utf8");
    // 错误帧形如 `data: {"error":{...}}`
    const isErrorFrame = /^data: /.test(text) && /"error"\s*:/.test(text);
    if (!isErrorFrame) {
      probe.frames.push(buf);
      probe.hasContent = true;
      stopped = true;
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text.slice("data: ".length).trim()) as Record<string, unknown>;
    } catch {
      probe.frames.push(buf); // 判不了就转发（丢帧比转发危险）
      stopped = true;
      return;
    }
    if (channel.upstream.isQueueError?.(payload)) {
      probe.queued = true;
      const errObj = payload["error"] as { code?: unknown; message?: unknown } | undefined;
      const m = /retryAfterSeconds\D+(\d+)/i.exec(String(errObj?.message ?? ""));
      if (m) {
        const sec = Number.parseInt(m[1]!, 10);
        probe.rawDelaySec = sec;
        probe.delayMs = Math.max(1_000, sec * 1000);
      }
      return; // 排队帧本身不转发，继续读后续帧
    }
    probe.frames.push(buf);
    stopped = true; // 非排队错误帧：停止探测，交回调用方转发/回报
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of translator.feed(Buffer.from(value))) take(frame);
      if (stopped) return probe;
    }
    for (const frame of translator.finish()) take(frame);
  } finally {
    // ⚠ 必须 releaseLock（不是 cancel）：流可能还没读完就提前返回（发现内容/普通错误），
    // 此时 cancel 会抛「ReadableStream is locked」；releaseLock 后调用方才能安全地
    // cancel 或重新 getReader。
    reader.releaseLock();
  }
  return probe;
}

// ── 路由 ──────────────────────────────────────────────────────────────────────

/** 账号池失败转移的最大尝试账号数（首个账号也计入）。 */
const MAX_ACCOUNT_ATTEMPTS = 3;

/** 取上游流式响应的结果；把"调不动上游"的几种情形分开，好给出准确的错误语义。 */
type UpstreamOutcome =
  | { kind: "ok"; call: UpstreamCall }
  | { kind: "not_authenticated"; error: string }
  | { kind: "auth_exhausted"; error: string };

/**
 * 向上游发起请求，失败时按「刷新 token → 换池内账号」重试。
 *
 * 账号池的价值就在这里：某个账号的凭据失效时，不必等用户重新登录 —— 自动切到池内
 * 另一个可用账号。每个不可用的账号都会被标成 `unauthorized`，后续请求由
 * `pickAccount()` 跳过它（所以同一个坏账号不会被反复踩）。
 *
 * 只在**鉴权类**失败（401/403、刷新失败）时转移；上游 5xx / 网络错误照旧直接报错。
 */
async function callUpstream(
  channel: Channel,
  sendBody: Buffer,
  logger: (m: string) => void,
): Promise<UpstreamOutcome> {
  const cid = channel.config.cid;
  const { cred, upstream } = channel;

  let credential: Credential;
  try {
    credential = inChannel(channel, () => cred.load());
  } catch (err) {
    return { kind: "not_authenticated", error: String(err) };
  }

  const tried: string[] = [];

  for (let attempt = 0; attempt < MAX_ACCOUNT_ATTEMPTS; attempt += 1) {
    let call = await inChannel(channel, () => openStream(channel, credential, sendBody));
    if (!call.ok && call.connectFailed) {
      // 连接从未建立（请求没发出去），重试一次即可自愈网络抖动
      logger(`upstream connect failed, retrying once: ${String(call.error)}`);
      call = await inChannel(channel, () => openStream(channel, credential, sendBody));
    }
    if (call.ok || (call.status !== 401 && call.status !== 403)) return { kind: "ok", call };

    // 401/403：先刷新当前账号的 token
    logger("token rejected, trying refresh...");
    let refreshed: Credential | null = null;
    try {
      refreshed = await inChannel(channel, () => cred.refresh(credential));
    } catch (err) {
      logger(`refresh failed: ${String(err)}`);
    }
    if (refreshed) {
      const retry = await inChannel(channel, () => openStream(channel, refreshed, sendBody));
      if (retry.ok || (retry.status !== 401 && retry.status !== 403)) return { kind: "ok", call: retry };
    }

    // 这个账号确定不可用 → 记健康度，换池内下一个
    markActiveHealth("unauthorized", cid);
    const activeKey = readIndex(cid).active;
    if (activeKey) tried.push(activeKey);
    const next = pickAccount(cid, tried);
    if (!next) {
      return {
        kind: "auth_exhausted",
        error: `${upstream.DISPLAY_NAME} rejected the token and no other account in the pool is available; please log in again`,
      };
    }
    logger(`account ${activeKey ?? "(unknown)"} unavailable, using pool account ${next.key} (${next.label})`);
    activateAccount(next.key, cid);
    credential = inChannel(channel, () => cred.load());
  }

  // 循环能走到这里，说明每一轮都栽在鉴权上
  return {
    kind: "auth_exhausted",
    error: `${upstream.DISPLAY_NAME} rejected the token (tried ${tried.length} accounts); please log in again`,
  };
}

async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  opts: Required<GatewayOptions>,
): Promise<void> {
  if (req.method !== "POST") {
    writeJsonError(res, 405, "method_not_allowed", "use POST");
    return;
  }

  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch (err) {
    writeJsonError(res, 400, "bad_request", String(err));
    return;
  }

  let parsed: unknown;
  try {
    parsed = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : null;
  } catch (err) {
    writeJsonError(res, 400, "invalid_json", String(err));
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    writeJsonError(res, 400, "invalid_json", "request body must be a JSON object");
    return;
  }
  const payload = parsed as Record<string, unknown>;
  const model = payload["model"];
  const messages = payload["messages"];
  if (typeof model !== "string" || !model || !Array.isArray(messages) || messages.length === 0) {
    writeJsonError(res, 400, "invalid_request", "model and messages are required");
    return;
  }

  // 公共模型池：对外只认池内模型，请求落到哪家渠道由账本决定
  // （匹配见 pool-targets.ts，排序见 pool-usage.ts）。
  maybeRefreshBilling(opts.logger); // 账单额度到期就在后台刷，不阻塞本次请求

  const target = asPoolModel(model);
  if (!target) {
    writeJsonError(
      res,
      400,
      "unknown_model",
      `unknown model ${model}; available models: ${POOL_MODELS.join(", ")}`,
    );
    return;
  }
  const candidates = poolCandidates(target);
  if (candidates.length === 0) {
    writeJsonError(
      res,
      503,
      "not_authenticated",
      `no channel provides ${target} (channel not logged in or catalog not ready)`,
    );
    return;
  }

  // 按账本排序：账单已用量降序、失败冷却中当 0；最多试 maxPoolAttempts() 个候选。
  const attempts = rankCandidates(candidates).slice(0, maxPoolAttempts());
  const wantStream = Boolean(payload["stream"]);
  const tried: string[] = [];
  let lastError: { status: number; code: string; message: string } | null = null;

  for (const candidate of attempts) {
    tried.push(candidate.cid);
    const { channel } = candidate;
    const { upstream } = channel;
    const cid = candidate.cid;

    // 模型名解析：**渠道说了算**（目录里查不到 → 这个候选不可用，换下一家）。
    let resolvedModel: string;
    try {
      resolvedModel = inChannel(channel, () => resolvePoolModel(channel, candidate.exposedId));
    } catch (err) {
      opts.logger(`model name unresolved (channel ${cid}): ${String(err)}`);
      noteFailure(cid);
      lastError = {
        status: 400,
        code: "unknown_model",
        message: `channel ${cid} has no model ${candidate.exposedId}`,
      };
      continue;
    }

    // `buildChatBody` 通常返回 JSON 对象；个别渠道的上游要求**编码后的字符串**
    // 作为请求体（qoder 的 COSY 自定义 Base64 变体就是这么发的），此时按字符串直发。
    let built: Record<string, unknown> | string;
    try {
      built = inChannel(channel, () => upstream.buildChatBody(payload, resolvedModel));
    } catch (err) {
      // 渠道层抛的是**用户输入问题**（上下文超限、system 超长、缺必填字段…）——
      // 换一家渠道同样会失败，直接 400，不浪费尝试次数。
      opts.logger(`request build failed: ${String(err)}`);
      writeJsonError(res, 400, "invalid_request", String(err));
      return;
    }
    const body = typeof built === "string" ? null : built;
    const encodedBody = typeof built === "string" ? built : null;

    // 可选的异步前置（渠道声明了才有）：必须在发上游**之前完成**。
    // 例如 catpaw 要求 round → event（置 running）→ turn 的顺序，错一步上游就拒。
    // ⚠ 传入**同一个 body**：渠道不能再调一次 buildChatBody（会生成新会话 id）。
    // 返回字符串（自编码请求体）的渠道不走这个钩子。
    if (upstream.prepareChat && body) {
      try {
        await inChannel(channel, () => upstream.prepareChat!(body));
      } catch (err) {
        opts.logger(`upstream prepare failed (channel ${cid}): ${String(err)}`);
        noteFailure(cid);
        lastError = {
          status: 502,
          code: "upstream_error",
          message: "upstream prepare request failed; see gateway logs",
        };
        continue;
      }
    }

    const sendBody =
      encodedBody !== null
        ? Buffer.from(encodedBody, "utf8")
        : Buffer.from(JSON.stringify(body), "utf8");

    // ⚠ 只有**上游响应头到达之前**的失败才能转移 —— 一旦进入 relayUpstream，
    //    响应头已发给客户端，换渠道会变成两个响应。
    const outcome = await callUpstream(channel, sendBody, opts.logger);
    if (outcome.kind === "not_authenticated") {
      opts.logger(`channel ${cid} not logged in: ${outcome.error}`);
      noteFailure(cid);
      lastError = { status: 503, code: "not_authenticated", message: `not logged in: ${outcome.error}` };
      continue;
    }
    if (outcome.kind === "auth_exhausted") {
      noteFailure(cid);
      lastError = { status: 502, code: "upstream_unauthenticated", message: outcome.error };
      continue;
    }
    let call = outcome.call;

    // 排队重试：渠道声明了 isQueueError 且上游回了排队帧（HTTP 200 + 流内业务错误）
    // → 按 retryAfterSeconds 退避后重开上游，直到出内容或预算耗尽。
    // ⚠ 只在**响应头发出前**做：一旦开始向客户端写字节就不能再换请求。
    // ⚠ 探测消费掉的帧按原序记在 `pendingFrames`，转发前先写给客户端；
    //    探测用的翻译器（半行缓冲）也要交给转发层接续 —— 两者丢一个就是流中缺段。
    const pendingFrames: Buffer[] = [];
    let queuedOut = false;
    let probeTranslator: StreamTranslator | undefined;
    if (isCustomWire(channel) && channel.upstream.isQueueError) {
      const startedAt = Date.now();
      for (;;) {
        // 每次探测用新翻译器（换流后旧缓冲作废）；成功那次的实例要传给转发层
        const translator = channel.upstream.newTranslator();
        const probe = await inChannel(channel, () => consumeQueueProbe(call.body!, channel, cid, translator));
        if (!probe.queued || probe.hasContent) {
          // 探测消费掉的帧一个都不能丢：按原序交回转发
          pendingFrames.push(...probe.frames);
          probeTranslator = translator;
          break;
        }
        const elapsed = Date.now() - startedAt;
        const delayMs = Math.min(probe.delayMs ?? QUEUE_RETRY_MAX_DELAY_MS, QUEUE_RETRY_MAX_DELAY_MS);
        if (elapsed + delayMs > QUEUE_RETRY_BUDGET_MS) {
          opts.logger(`queue wait budget exhausted (channel ${cid}, waited ${Math.round(elapsed / 1000)}s)`);
          queuedOut = true;
          break;
        }
        opts.logger(`upstream queued (channel ${cid}), waiting ${Math.round(delayMs / 1000)}s before retry`);
        await new Promise((r) => setTimeout(r, delayMs));
        const credential = loadCredentialSafe(channel);
        if (!credential) {
          opts.logger(`queue retry aborted: no credential available (channel ${cid})`);
          queuedOut = true;
          break;
        }
        const next = await inChannel(channel, () => openStream(channel, credential, sendBody));
        if (!next.ok) {
          // 重开失败（连接/鉴权）→ 放弃排队等待，按原结果走后续错误处理
          opts.logger(`queue retry reopen failed (channel ${cid}): ${String(next.error?.message ?? "")}`);
          queuedOut = true;
          break;
        }
        // 旧流已消费完：释放 reader 锁并丢弃剩余数据，再换新流
        await call.body?.cancel().catch(() => {});
        call = next;
      }
    }

    if (!call.ok) {
      // 上游错误体只进本地日志，不回传客户端（可能含内部信息）
      if (call.connectFailed) opts.logger(`upstream request failed (channel ${cid}): ${String(call.error)}`);
      else opts.logger(`upstream returned non-200 (channel ${cid}): ${String(call.error?.message ?? "")}`);
      noteFailure(cid);
      lastError = { status: 502, code: "upstream_error", message: "upstream request failed; see gateway logs" };
      continue;
    }

    // 上游收下了这次请求 → 该渠道可用（清冷却）→ 交给转发层，池路由到此为止。
    noteSuccess(cid);
    markActiveHealth("ok", cid);
    await relayUpstream(res, channel, cid, call, wantStream, opts.logger, pendingFrames, queuedOut, probeTranslator);
    return;
  }

  opts.logger(`all pool candidates failed (${target}, tried ${tried.join(", ")})`);
  const final = lastError ?? {
    status: 502,
    code: "upstream_error",
    message: "upstream request failed; see gateway logs",
  };
  writeJsonError(res, final.status, final.code, final.message);
}

/** 聚合结果是否「什么都没有」：无 content、无 reasoning、无 token 用量。 */
function isEmptyCompletion(completion: ReturnType<typeof sseStream.aggregateChatSse>): boolean {
  const choice = completion.choices[0];
  if (!choice) return true;
  if (choice.message.content) return false;
  if (choice.message.reasoning_content) return false;
  const total = (completion.usage as { total_tokens?: unknown }).total_tokens;
  return !(typeof total === "number" && total > 0);
}

/**
 * 把胜出候选的上游响应交给客户端：非流式聚合、流式透传。
 *
 * ⚠ 一旦开始写响应头就**不能再转移渠道** —— 所以它只在池路由的最后一跳调用，
 *   池路由的尝试循环里不许出现它。
 */
async function relayUpstream(
  res: ServerResponse,
  channel: Channel,
  cid: string,
  call: UpstreamCall,
  wantStream: boolean,
  logger: (m: string) => void,
  pendingFrames: Buffer[] = [],
  queuedOut = false,
  probeTranslator?: StreamTranslator,
): Promise<void> {
  const streamBody = call.body;
  if (!streamBody) {
    writeJsonError(res, 502, "upstream_error", "upstream returned an empty response body");
    return;
  }

  // 非流式：消费完整上游流（必要时先翻译），聚合成一个 chat.completion JSON。
  // custom 线型且渠道声明了 isQueueError 时，**响应头还没发**——排队帧可以触发
  // 等待 + 重开上游重试（与流式路径同一套预算）。
  if (!wantStream) {
    try {
      // ⚠ 这里**不再二次探测**：`handleChat` 已用同一条件探测过这条流并推进了它的位置，
      // 再探测会丢掉第一次消费掉的帧（非流式空响应的元凶）。此处只把探测结果（前缀内容帧 /
      // 错误帧）与流剩余部分拼起来聚合。
      const buf = Buffer.concat([
        ...pendingFrames,
        await inChannel(channel, () => collectAsOpenAiSse(streamBody, channel, cid, probeTranslator)),
      ]);
      // 排队耗尽且零内容：给客户端一个明确的错误，而不是空 completion
      if (queuedOut && buf.length === 0) {
        writeJsonError(res, 503, "upstream_queued", "upstream is queued and the wait budget was exhausted");
        return;
      }
      const aggregated = sseStream.aggregateChatSse(buf);
      // 流内业务错误（上游 HTTP 200 + error 帧）且没有任何内容 → 报错误，别回空 completion
      if (isEmptyCompletion(aggregated)) {
        const sseError = sseStream.firstSseError(buf);
        if (sseError) {
          writeJsonError(res, 502, sseError.code ?? "upstream_error", sseError.message ?? "upstream error");
          return;
        }
      }
      writeJson(res, aggregated);
    } catch (err) {
      logger(`reading upstream response interrupted: ${String(err)}`);
      writeJsonError(res, 502, "upstream_error", "upstream request failed; see gateway logs");
    }
    return;
  }

  // 流式：复制上游响应头（剔除 hop-by-hop 与已失效头），状态码透传
  const outHeaders: Record<string, string> = {};
  if (isCustomWire(channel)) {
    // 自定义线型的输出恒为 OpenAI SSE，不能透传上游的 content-type
    outHeaders["Content-Type"] = "text/event-stream; charset=utf-8";
    outHeaders["Cache-Control"] = "no-cache";
  } else {
    for (const [name, value] of call.headers) {
      if (!STRIP_HEADERS.has(name.toLowerCase())) outHeaders[name] = value;
    }
  }
  res.writeHead(call.status, outHeaders);
  // 排队探测阶段已经消费掉的内容帧先补写给客户端（它们属于这次响应的前缀）
  for (const frame of pendingFrames) res.write(frame);
  if (queuedOut && pendingFrames.length === 0) {
    // 排队预算耗尽且没有任何内容：给出明确错误帧后结束
    res.write(
      `data: ${JSON.stringify({ error: { code: "upstream_queued", message: "upstream is queued and the wait budget was exhausted" } })}\n\n`,
    );
    res.end();
    return;
  }
  await inChannel(channel, () =>
    relayStream(res, streamBody, call.headers.get("content-type") ?? "", logger, channel, cid, probeTranslator),
  );
}

/**
 * 公共模型池：`/v1/models` **恒返回池内模型**。
 *
 * 客户端只看到池内 id（`POOL_MODELS`），**不带渠道前缀** —— 请求落到哪家由网关
 * 按账本决定，客户端不参与也无法指定。某个模型暂时没有可用渠道时照样列出
 * （模型可见性与登录状态解耦），请求时才报 503。
 */
function handleModels(res: ServerResponse): void {
  const owner = serviceName();
  writeJson(res, {
    object: "list",
    // 字段结构对齐 DeepSeek 官方 `GET /models`（见 pool-targets.ts 的 PoolModelMeta）：
    // **没有 `created`**，`name` 是展示名，并带上上下文 / 最大输出 / 模态 / 档位。
    data: POOL_MODELS.map((id) => {
      const meta = POOL_MODEL_META[id];
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
      display: list.length === 1 ? list[0]!.upstream.DISPLAY_NAME : "model-bridge",
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
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    try {
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

export { MAX_BODY, STRIP_HEADERS };
export type { UpstreamConfig };
