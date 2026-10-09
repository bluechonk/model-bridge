/**
 * 上游 SSE 流处理：规范化转发（流式）与聚合（非流式）。
 *
 * 集中承载所有「上游兼容性 hack」，与网关的路由层解耦：改上游兼容性只需动这里。
 *
 * 两处规范化（都是实测踩出来的）：
 *  1. **丢弃注释行**（以 `:` 开头，如上游自带的 `: keep-alive`）——
 *     部分客户端的 SSE 解析器遇到注释行会解析失败并重置流状态。
 *  2. **剔除 delta 里语义为空的字段**（`tool_calls: []`）——
 *     上游每个 delta 都带 `"tool_calls": []`，而客户端的解析器判定
 *     `delta.tool_calls != null` 就结束当前思考块，于是**每个 reasoning token
 *     都被切成独立的「思考」块**。删掉空数组（无任何信息量）即修复。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ServerResponse } from "node:http";

import { getChannel } from "./channel.js";
import { debugDir, noteOnce } from "./paths.js";

const READ_CHUNK = 8192;

/** 读取上游流时出错（如连接中断）。 */
export class StreamError extends Error {
  override name = "StreamError";
}

/**
 * 抓包落盘目录。
 *
 * 变量名取自渠道的 `debugDumpEnv`（含历史名）。值为 `1`/`true` 时落到渠道层内的
 * `debug/`；其余值必须是**绝对路径**。未设置则返回 null —— 抓包是 opt-in，
 * 默认不落盘（见 STORAGE-CONVENTION.md §4.5）。
 */
function debugDumpDir(cid?: string): string | null {
  const { config } = getChannel(cid);
  for (const name of [config.debugDumpEnv, ...(config.legacyDebugDumpEnv ?? [])]) {
    const value = process.env[name];
    if (!value) continue;
    if (name !== config.debugDumpEnv) {
      noteOnce(`debug-env:${name}`, `${name} is deprecated: use ${config.debugDumpEnv}`);
    }
    if (value === "1" || value.toLowerCase() === "true") return debugDir(cid);
    if (!isAbsolute(value)) {
      noteOnce(`debug-rel:${value}`, `${name} must be an absolute path; ignored: ${value}`);
      return null;
    }
    return value;
  }
  return null;
}

/** 把抓包数据原样落盘（目录由 debugDumpDir() 决定，未启用则不落盘）。 */
export function debugDump(tag: string, ext: string, data: Buffer, cid?: string): void {
  const dir = debugDumpDir(cid);
  if (!dir) return;
  const name = `${tag}-${Date.now()}-${process.hrtime.bigint() % 1_000_000n}.${ext}`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), data);
  } catch {
    /* 抓包失败不影响主流程 */
  }
}

function captureEnabled(cid?: string): boolean {
  return debugDumpDir(cid) !== null;
}

export interface AggregatedChoice {
  index: number;
  message: { role: string; content: string; reasoning_content?: string };
  finish_reason: string;
}

export interface AggregatedCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: AggregatedChoice[];
  usage: Record<string, unknown>;
}

/** 把上游的 SSE 流聚合为标准 OpenAI chat.completion JSON（非流式响应用）。 */
export function aggregateChatSse(buf: Buffer): AggregatedCompletion {
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  let finish = "";
  let id = "";
  let model = "";
  let created = 0;
  let usage: Record<string, unknown> | null = null;

  for (const block of buf.toString("utf8").split("\n\n")) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof chunk["id"] === "string") id = chunk["id"];
      if (typeof chunk["model"] === "string") model = chunk["model"];
      if (typeof chunk["created"] === "number") created = chunk["created"];
      if (chunk["usage"] && typeof chunk["usage"] === "object") {
        usage = chunk["usage"] as Record<string, unknown>;
      }
      const choices = chunk["choices"];
      if (!Array.isArray(choices)) continue;
      for (const choice of choices) {
        if (!choice || typeof choice !== "object") continue;
        const c = choice as Record<string, unknown>;
        const delta = c["delta"];
        if (delta && typeof delta === "object") {
          const d = delta as Record<string, unknown>;
          if (typeof d["content"] === "string" && d["content"]) contentParts.push(d["content"]);
          const r = d["reasoning_content"] ?? d["reasoning"];
          if (typeof r === "string" && r) reasoningParts.push(r);
        }
        if (typeof c["finish_reason"] === "string" && c["finish_reason"]) {
          finish = c["finish_reason"];
        }
      }
    }
  }

  const message: AggregatedChoice["message"] = {
    role: "assistant",
    content: contentParts.join(""),
  };
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("");

  return {
    id: id || "chatcmpl-gateway",
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finish || "stop" }],
    usage:
      usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * 取 SSE 字节里**第一个错误帧**（`data: {"error":{…}}`）；没有则返回 null。
 *
 * 上游 HTTP 200 但流内投递业务错误（如排队/限流）时，聚合器会把它当无内容可聚，
 * 结果退化成空 completion。调用方用本函数把这种「有错误帧但零内容」明确报成错误。
 */
export function firstSseError(buf: Buffer): { code?: string; message?: string } | null {
  for (const block of buf.toString("utf8").split("\n\n")) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) continue;
      const err = (chunk as Record<string, unknown>)["error"];
      if (!err || typeof err !== "object" || Array.isArray(err)) continue;
      const e = err as Record<string, unknown>;
      return {
        ...(typeof e["code"] === "string" ? { code: e["code"] } : {}),
        ...(typeof e["message"] === "string" ? { message: e["message"] } : {}),
      };
    }
  }
  return null;
}

/**
 * 剔除 data 块里语义为空的字段（目前只有空数组 `tool_calls`）。
 *
 * ⚠ 上游每个 delta 都带 `"tool_calls": []`，而客户端判定
 * `delta.tool_calls != null` 就结束当前思考块 —— 空数组导致每个 reasoning token
 * 都被切成独立的「思考」块。删除它（无任何信息量）即修复。
 * 解析失败或无需改动的行原样返回。
 */
function normalizeDataLine(line: string): string {
  const payload = line.startsWith("data:") ? line.slice(5).trimStart() : line;
  if (!payload || payload.startsWith("[DONE]")) return line;
  let chunk: unknown;
  try {
    chunk = JSON.parse(payload);
  } catch {
    return line;
  }
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) return line;

  let changed = false;
  const rec = chunk as Record<string, unknown>;
  const choices = rec["choices"];
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") continue;
      const delta = (choice as Record<string, unknown>)["delta"];
      if (!delta || typeof delta !== "object") continue;
      const d = delta as Record<string, unknown>;
      if (Array.isArray(d["tool_calls"]) && d["tool_calls"].length === 0) {
        delete d["tool_calls"];
        changed = true;
      }
    }
  }
  if (!changed) return line;
  return `data: ${JSON.stringify(chunk)}`;
}

/**
 * 清洗一个 SSE 事件块：丢弃注释行、规范化 data 行；清洗后为空则返回 null（不转发）。
 */
function processEvent(event: string): string | null {
  const kept: string[] = [];
  for (const line of event.split("\n")) {
    if (line.startsWith(":")) continue;
    kept.push(normalizeDataLine(line));
  }
  if (!kept.some((x) => x.trim())) return null;
  return kept.join("\n");
}

/**
 * SSE 感知透传上游流到客户端（响应头需已写出）。
 *
 * 按事件块（空行分隔）切分上游字节流，做两处规范化后再转发；
 * 事件数据其余部分原样保留，不在重组时引入额外延迟。
 *
 * 兼容 `\n\n` 与 `\r\n\r\n` 两种事件分隔符，取最先出现者；
 * 统一规范化为标准 SSE 帧（`\n\n` 结尾），避免 `\r` 残留。
 */
export async function relay(
  out: ServerResponse,
  upstreamBody: ReadableStream<Uint8Array>,
  contentType: string,
  cid?: string,
): Promise<void> {
  const isSse = contentType.toLowerCase().includes("text/event-stream");
  const capture: Buffer[] | null = captureEnabled(cid) ? [] : null;
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder("utf-8");

  try {
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (capture) capture.push(Buffer.from(value));
      if (!isSse) {
        out.write(Buffer.from(value));
        continue;
      }
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const lf = buffer.indexOf("\n\n");
        const crlf = buffer.indexOf("\r\n\r\n");
        if (lf < 0 && crlf < 0) break;
        let event: string;
        if (crlf < 0 || (lf >= 0 && lf < crlf)) {
          event = buffer.slice(0, lf);
          buffer = buffer.slice(lf + 2);
        } else {
          event = buffer.slice(0, crlf);
          buffer = buffer.slice(crlf + 4);
        }
        const processed = processEvent(event);
        if (processed !== null) out.write(`${processed.replace(/\r+$/, "")}\n\n`);
      }
    }
    if (isSse) {
      buffer += decoder.decode();
      if (buffer) {
        const processed = processEvent(buffer);
        if (processed !== null) out.write(processed);
      }
    }
  } catch (err) {
    // 客户端提前断开（如主动取消请求）属正常情况，降级为调试日志
    if (!isBenignDisconnect(err)) throw err;
  } finally {
    await reader.cancel().catch(() => {});
    if (capture) debugDump("resp", "sse", Buffer.concat(capture), cid);
    out.end();
  }
}

function isBenignDisconnect(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    (err as Error | null)?.name === "AbortError"
  );
}

/** 读完整个上游响应体（非流式路径），读取中断抛 StreamError。 */
export async function readAll(
  upstreamBody: ReadableStream<Uint8Array>,
  cid?: string,
): Promise<Buffer> {
  const capture: Buffer[] | null = captureEnabled(cid) ? [] : null;
  const chunks: Buffer[] = [];
  const reader = upstreamBody.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      chunks.push(buf);
      if (capture) capture.push(buf);
    }
  } catch (err) {
    throw new StreamError(String(err));
  } finally {
    await reader.cancel().catch(() => {});
    if (capture) debugDump("resp", "sse", Buffer.concat(capture), cid);
  }
  return Buffer.concat(chunks);
}

export { READ_CHUNK };
