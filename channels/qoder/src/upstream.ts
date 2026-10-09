/**
 * Qoder 上游：**COSY 签名** + 自定义请求体编码 + SSE 信封解包。
 *
 * ## COSY 签名（纯 `node:crypto` 复刻）
 *
 * ```
 * temp_key  = 16 个 hex 字符      → 同时当 AES-128 的 key 与 IV
 * cosy_key  = base64(RSA_PKCS1v15(temp_key))          ← 官方 1024-bit 公钥
 * info      = base64(AES-128-CBC(身份体 JSON 紧凑排序, key=iv=temp_key))
 * payload   = base64(紧凑排序({cosyVersion, ideVersion, info, requestId, version}))
 * sig       = md5_hex([payload, cosy_key, date, body, path].join("\n"))
 * Authorization = "Bearer COSY." + payload + "." + sig
 * ```
 *
 * ⚠ **照抄不改**的三处（改了服务端直接拒）：`temp_key` 的形态（16 hex，不是随机 16 字节）、
 * 身份体的**键排序 + 紧凑 JSON**、签名里 `path` 要去掉 `/algo` 前缀。
 *
 * ## 请求体是编码后的字符串
 *
 * Qoder 的 body 不是 JSON 对象，而是 JSON 经**自定义 Base64 变体**编码后的字符串
 * （三段轮转 + 私有字母表，`=`→`$`）。所以 `buildChatBody` 返回**字符串**，
 * 网关会按字符串直发（见 `channel.ts` 的契约说明）。
 *
 * ## 签名需要 body，但 `buildHeaders` 拿不到
 *
 * 共享网关的调用序列是 `buildChatBody()` → `buildHeaders()`（中间无 await），
 * 与 codearts 同一套解法：`buildChatBody` 把「编码后的 body + 目标 URL + 模型 key」
 * 存进模块级 pending 槽，`buildHeaders` 从那里取。JS 单线程，两步之间无 await，安全。
 */

import { createCipheriv, createHash, publicEncrypt, randomUUID, constants as cryptoConstants } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import type { StreamTranslator } from "@model-bridge/gateway";

import {
  currentGatewayHost,
  currentRealm,
  currentUserType,
  machineIdOf,
  machineTokenOf,
  machineTypeOf,
  productOf,
  rememberGatewayHost,
  type Credentials,
  type Realm,
} from "./cred.js";

/** 契约要求：上游默认基址（当前区域的首选推理主机）。 */
export const DEFAULT_BASE_URL = productOf("cn").gateway[0]!;

/** 展示名。 */
export const DISPLAY_NAME = "Qoder";

/** 上游线型是**自定义**的：响应是 `{headers,body,statusCodeValue}` 信封，需翻译层。 */
export const WIRE = "custom" as const;

/** COSY 协议版本（与官方 0.4.3 系列客户端对齐；实测可用）。 */
export const COSY_VERSION = "1.1.64";

/** 推理端点（`Encode=1` 表示请求体走自定义编码）。 */
export const CHAT_PATH =
  "/algo/api/v2/service/pro/sse/agent_chat_generation" +
  "?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";

/** 模型目录端点。⚠ GET 也要带 body（`qoder_encode("{}")`）参与签名，否则 403。 */
export const MODELS_PATH = "/algo/api/v2/model/list?Encode=1";

/**
 * 官方客户端内置的 RSA 公钥（PKCS#1 v1.5，1024 位）。
 *
 * 只用来**包裹会话 AES 密钥**；私钥在服务端。换公钥在数学上不可能（必须与官方私钥配对）。
 */
const SERVER_PUB_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

/** 自定义 Base64 字母表（逐字照抄；标准表按位一对一映射）。 */
const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CUSTOM_PAD = "$";

export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

// ── 自定义 Base64 变体 ────────────────────────────────────────────────────────

/**
 * Qoder 的自定义 Base64：标准 base64 → 三段轮转（尾/中/首）→ 字母表映射 → `=` 换 `$`。
 *
 * 轮转公式（`a = floor(n/3)`）：`rearranged = std[n-a:] + std[a:n-a] + std[:a]`。
 */
export function qoderEncode(plain: string | Buffer): string {
  const std = Buffer.from(plain).toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  let out = "";
  for (const ch of rearranged) {
    const idx = STD_ALPHABET.indexOf(ch);
    out += idx >= 0 ? CUSTOM_ALPHABET[idx] : ch === "=" ? CUSTOM_PAD : ch;
  }
  return out;
}

/** `qoderEncode` 的逆运算（测试与调试用）。 */
export function qoderDecode(encoded: string): Buffer {
  let std = "";
  for (const ch of encoded) {
    const idx = CUSTOM_ALPHABET.indexOf(ch);
    std += idx >= 0 ? STD_ALPHABET[idx] : ch === CUSTOM_PAD ? "=" : ch;
  }
  const n = std.length;
  const a = Math.floor(n / 3);
  const original = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  return Buffer.from(original, "base64");
}

// ── 紧凑排序 JSON 与 AES ─────────────────────────────────────────────────────

/**
 * 键排序 + 无空白的紧凑 JSON。
 *
 * ⚠ 服务端按同一套字节算签名/解密，所以**不能**用 `JSON.stringify(obj)` 直接产出
 * （它保持插入顺序）；必须按键排序，且 `null` 视作空串。
 */
export function sortedCompactJson(mapping: Record<string, unknown>): string {
  const parts = Object.keys(mapping)
    .sort()
    .map((key) => {
      const value = mapping[key] === null || mapping[key] === undefined ? "" : mapping[key];
      return `${JSON.stringify(key)}:${JSON.stringify(value)}`;
    });
  return `{${parts.join(",")}}`;
}

/** AES-128-CBC（PKCS7），key 与 iv 同值（官方如此）。 */
function aesEncrypt(plain: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key, key);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

/** 用服务端公钥包裹会话密钥（PKCS#1 v1.5）。 */
function rsaWrap(key: string): Buffer {
  return publicEncrypt(
    { key: SERVER_PUB_PEM, padding: cryptoConstants.RSA_PKCS1_PADDING },
    Buffer.from(key, "utf8"),
  );
}

/** 去掉 `/algo` 前缀 —— 服务端签名覆盖的是这个形态的 path。 */
export function signPathOf(rawUrl: string): string {
  let path: string;
  try {
    path = new URL(rawUrl).pathname;
  } catch {
    path = rawUrl.split("?")[0] ?? "/";
  }
  return path.startsWith("/algo") ? path.slice("/algo".length) : path;
}

// ── COSY 会话 ────────────────────────────────────────────────────────────────

interface Identity {
  name: string;
  uid: string;
  nickname: string;
  userType: string;
  accessToken: string;
  refreshToken: string;
  realm: Realm;
}

/** 一个账号的 COSY 会话（会话密钥 + 加密身份体，access token 轮换后重建）。 */
export class CosySession {
  readonly cosyKey: string;
  readonly info: string;
  readonly machineId: string;
  readonly machineToken: string;
  readonly machineType: string;
  /** 会话归属的 uid（`cosy-user` 头）。 */
  readonly uid: string;

  constructor(identity: Identity) {
    this.uid = identity.uid;
    // ⚠ 必须与官方一致：16 个十六进制字符当 AES-128 的 key 与 IV。
    // 熵偏低（≈64 bit）是刻意的 —— 服务端按同一字节串解开 info，改了直接失败。
    const tempKey = randomUUID().replace(/-/g, "").slice(0, 16);
    const keyBytes = Buffer.from(tempKey, "utf8");
    this.cosyKey = rsaWrap(tempKey).toString("base64");

    const identityBody: Record<string, unknown> = {
      name: identity.nickname || "",
      aid: identity.uid,
      uid: identity.uid,
      yx_uid: "",
      organization_id: "",
      organization_name: "",
      user_type: identity.userType,
      security_oauth_token: identity.accessToken,
      refresh_token: identity.refreshToken,
    };
    this.info = aesEncrypt(Buffer.from(sortedCompactJson(identityBody), "utf8"), keyBytes).toString(
      "base64",
    );

    this.machineId = machineIdOf(identity.uid);
    this.machineToken = machineTokenOf(identity.uid);
    this.machineType = machineTypeOf(identity.uid);
  }

  /** 生成 `Bearer COSY.<payload>.<sig>`。 */
  bearer(body: string, rawUrl: string): { date: string; authorization: string } {
    const payload = sortedCompactJson({
      cosyVersion: COSY_VERSION,
      ideVersion: "",
      info: this.info,
      requestId: randomUUID(),
      version: "v1",
    });
    const payloadB64 = Buffer.from(payload, "utf8").toString("base64");
    const date = String(Math.floor(Date.now() / 1000));
    const raw = [payloadB64, this.cosyKey, date, body, signPathOf(rawUrl)].join("\n");
    const sig = createHash("md5").update(raw, "utf8").digest("hex");
    return { date, authorization: `Bearer COSY.${payloadB64}.${sig}` };
  }

  /** 一次请求的完整 COSY 头。 */
  headers(body: string, rawUrl: string, modelKey = "", sse = true): Record<string, string> {
    const { date, authorization } = this.bearer(body, rawUrl);
    const headers: Record<string, string> = {
      authorization,
      "cosy-version": COSY_VERSION,
      "cosy-key": this.cosyKey,
      "cosy-date": date,
      "cosy-user": this.uid,
      "cosy-machineid": this.machineId,
      "cosy-machinetoken": this.machineToken,
      "cosy-machinetype": this.machineType,
      "cosy-clienttype": "5", // CLI 身份（与 /sash 的桌面身份 10 是两回事）
      "cosy-data-policy": "AGREE",
      "cosy-clientip": "169.254.198.161",
      "login-version": "v2",
      "content-type": "application/json",
      accept: sse ? "text/event-stream" : "application/json",
      "accept-encoding": "identity",
      "user-agent": "Go-http-client/2.0",
    };
    if (sse) headers["cache-control"] = "no-cache";
    if (modelKey) {
      headers["x-model-key"] = modelKey;
      headers["x-model-source"] = "system";
    }
    return headers;
  }
}

/** uid → 会话缓存（access token 变化即失效）。 */
const sessions = new Map<string, { token: string; session: CosySession }>();

/** 取（必要时建）会话；token 轮换会让旧会话作废。 */
export function sessionFor(credential: Credentials): CosySession {
  const key = credential.uid || credential.accessToken.slice(0, 16);
  const hit = sessions.get(key);
  if (hit && hit.token === credential.accessToken) return hit.session;
  const session = new CosySession({
    name: "",
    uid: credential.uid,
    nickname: credential.nickname,
    userType: credential.userType,
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    realm: credential.realm,
  });
  sessions.set(key, { token: credential.accessToken, session });
  return session;
}

/** **仅供测试**：清空会话缓存。 */
export function resetSessionsForTest(): void {
  sessions.clear();
  pendingChat = null;
}

// ── 待签名槽（`buildChatBody` → `buildHeaders`） ──────────────────────────────

let pendingChat: { body: string; url: string; modelKey: string } | null = null;

/** 当前请求该走哪个区域（由凭据的最近身份决定，见 cred.ts 的 `currentRealm`）。 */
let activeRealm: Realm = currentRealm();

export interface UpstreamConfig {
  baseUrl: string;
  realm: Realm;
}

export function defaultConfig(): UpstreamConfig {
  return { baseUrl: productOf("cn").gateway[0]!, realm: "cn" };
}

/** 读取配置（本渠道的端点来自区域表，不走凭据目录里的配置文件）。 */
export function loadConfig(): [UpstreamConfig, boolean] {
  return [defaultConfig(), false];
}

export async function saveConfig(_cfg: UpstreamConfig): Promise<void> {
  // 端点由 cred 的区域决定，没有需要持久化的渠道配置
}

export function resolveConfig(): UpstreamConfig {
  return { baseUrl: productOf(activeRealm).gateway[0]!, realm: activeRealm };
}

/**
 * 首选推理主机：**优先用上次被接受的那个**（随账号而异，见 `cred.currentGatewayHost`），
 * 没有记忆时退回配置里的第一个候选。
 */
function primaryHost(realm: Realm): string {
  return currentGatewayHost() || productOf(realm).gateway[0]!;
}

/** 推理 URL（当前区域的首选主机）。 */
export function chatUrl(): string {
  return `${primaryHost(activeRealm)}${CHAT_PATH}`;
}

/** 模型目录 URL。 */
export function modelsUrl(): string {
  return `${primaryHost(activeRealm)}${MODELS_PATH}`;
}

/** 该区域的全部推理主机候选（主选 + 故障切换）。 */
export function gatewayCandidates(realm: Realm): string[] {
  return [...productOf(realm).gateway];
}

/** 环境变量可覆盖 UA（排查时用）。 */
function clientUserAgent(): string {
  return process.env["QODER_CLIENT_UA"] ?? "Go-http-client/2.0";
}

export function buildHeaders(credential: Credentials): Record<string, string> {
  activeRealm = credential.realm;
  const pending = pendingChat;
  const body = pending?.body ?? "";
  const url = pending?.url ?? chatUrl();
  const session = sessionFor(credential);
  const headers = session.headers(body, url, pending?.modelKey ?? "", true);
  headers["user-agent"] = clientUserAgent();
  return headers;
}

// ── 请求体构造 ──────────────────────────────────────────────────────────────

interface ChatMessage {
  role: string;
  content: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
}

/** 取最后一条 user 消息的纯文本（上游用它做高亮与会话名）。 */
function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content
        .map((part) =>
          part && typeof part === "object" && (part as { type?: string }).type === "text"
            ? String((part as { text?: unknown }).text ?? "")
            : "",
        )
        .join("");
      if (text) return text;
    }
  }
  return "";
}

/**
 * OpenAI 请求 → Qoder 请求体（明文）。
 *
 * 字段清单来自 `PROTOCOL.md` §3.1 与参考实现的 `baseprompt.json` 模板。几个**必须**的点：
 * - `business` 必填：缺了会被路由到故障节点（返回 `[FAIL]node:…`）
 * - `chat_context.text` 是**对象** `{type:"text",text}`，不是字符串
 * - `imageUrls` 恒 `null`（图片走 `messages[].content` 的多模态数组）
 * - 顶层 `tools` 无工具时给**空数组**，不是缺字段
 */
export function buildRequestBody(
  req: Record<string, unknown>,
  modelKey: string,
  meta: { displayName?: string; isVl?: boolean; isReasoning?: boolean; maxInputTokens?: number } = {},
  realm: Realm = activeRealm,
): Record<string, unknown> {
  const rawMessages = Array.isArray(req["messages"]) ? (req["messages"] as ChatMessage[]) : [];
  const systems = rawMessages.filter((m) => m.role === "system");
  const rest = rawMessages.filter((m) => m.role !== "system");

  const systemText = systems
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .filter(Boolean)
    .join("\n\n");

  const messages: Array<Record<string, unknown>> = [];
  if (systemText) messages.push({ role: "system", content: systemText });
  for (const m of rest) {
    const out: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.tool_calls) out["tool_calls"] = m.tool_calls;
    if (m.tool_call_id) out["tool_call_id"] = m.tool_call_id;
    messages.push(out);
  }

  const prompt = lastUserText(rawMessages);
  const requestId = randomUUID();
  const tools = Array.isArray(req["tools"]) ? req["tools"] : [];

  const parameters: Record<string, unknown> = {};
  if (typeof req["max_tokens"] === "number") parameters["max_tokens"] = req["max_tokens"];
  if (typeof req["reasoning_effort"] === "string") {
    parameters["reasoning_effort"] = req["reasoning_effort"];
  }
  if (typeof req["temperature"] === "number") parameters["temperature"] = req["temperature"];

  return {
    request_id: requestId,
    request_set_id: requestId,
    chat_record_id: requestId,
    session_id: randomUUID(),
    stream: true, // 上游只支持流式
    chat_task: "FREE_INPUT",
    chat_context: {
      text: { type: "text", text: prompt },
      features: [],
      extra: {
        context: [],
        modelConfig: { key: modelKey, is_reasoning: Boolean(meta.isReasoning) },
        originalContent: { type: "text", text: prompt },
      },
      chatPrompt: "",
      imageUrls: null,
    },
    image_urls: null,
    is_reply: true,
    is_retry: false,
    code_language: "",
    source: 1,
    version: "3",
    chat_prompt: "",
    parameters,
    // 实际值由调用方用账号的 user_type 覆盖（见 gateway 的 body 后处理）
    aliyun_user_type: "",
    session_type: realm === "cn" ? "qoder_work" : "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    model_config: {
      key: modelKey,
      display_name: meta.displayName ?? modelKey,
      model: "",
      format: "openai",
      is_vl: Boolean(meta.isVl),
      is_reasoning: Boolean(meta.isReasoning),
      api_key: "",
      url: "",
      source: "system",
      max_input_tokens: meta.maxInputTokens ?? 180000,
    },
    custom_model: null,
    messages,
    tools,
    business: { product: "cli", version: "0.1.43", type: "agent", id: randomUUID(), name: prompt, begin_at: Date.now(), stage: "start" },
  };
}

/**
 * 构造并**编码**请求体，返回要直发的字符串。
 *
 * 模型目录元数据由 `catalog.ts` 注入（display_name / is_vl / is_reasoning），
 * 这里只收一个可选的查表回调，避免四个模块互相 import 成环。
 */
export function buildChatBody(
  req: Record<string, unknown>,
  modelKey: string,
  realm?: Realm,
): string {
  const effectiveRealm = realm ?? activeRealm;
  activeRealm = effectiveRealm;
  const body = buildRequestBody(req, modelKey, {}, effectiveRealm);
  // 身份类型必须用**真实账号**的（参考实现里就是这么覆盖模板默认值的）
  body["aliyun_user_type"] = currentUserType();
  const encoded = qoderEncode(JSON.stringify(body));
  pendingChat = { body: encoded, url: chatUrl(), modelKey };
  return encoded;
}

/** 模型目录端点要带一个空的编码 body（否则签名与 body 不一致 → 403）。 */
export function emptyEncodedBody(): string {
  return qoderEncode("{}");
}

/** 为模型目录请求构造签名头（不经过 pending 槽，直接用给定 body）。 */
export function modelsHeaders(credential: Credentials): Record<string, string> {
  activeRealm = credential.realm;
  const body = emptyEncodedBody();
  const session = sessionFor(credential);
  const headers = session.headers(body, modelsUrl(), "", false);
  headers["user-agent"] = clientUserAgent();
  return headers;
}

/**
 * **GET 带 body** 的请求（Node 的 `fetch` 做不到）。
 *
 * Qoder 的模型目录端点是 `GET`，但签名覆盖请求体，所以**必须真的把 body 发出去**
 * （裸 GET 会 403 —— 服务端校验签名与 body 一致）。而 WHATWG fetch 规范**禁止**
 * GET/HEAD 带 body，undici 直接抛 `Request with GET/HEAD method cannot have body`。
 * 其它语言实现没有这个限制，所以只有 Node 这边要绕：走 `node:https`。
 */
function getWithBody(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs = 15_000,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: { ...headers, "content-length": String(Buffer.byteLength(body, "utf8")) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("model list request timed out")));
    req.on("error", reject);
    req.write(body, "utf8");
    req.end();
  });
}

/**
 * 上游模型目录（原始响应，由 catalog.ts 归一化）。
 *
 * ⚠ **必须遍历主机候选**：国际版有 `api1/api2/api3` 三个域名（官方故障切换），
 * 实测 `api1` 会对部分账号回 403 而 `api2` 正常。签名只覆盖 path（不含 host），
 * 所以换主机后签名依然有效，不用重算。
 */
export async function fetchModels(credential: Credentials): Promise<Record<string, unknown>> {
  const body = emptyEncodedBody();
  const headers = modelsHeaders(credential);
  let lastError: Error | null = null;

  for (const host of gatewayCandidates(credential.realm)) {
    const url = `${host}${MODELS_PATH}`;
    try {
      const resp = await getWithBody(url, headers, body);
      if (resp.status === 200) {
        try {
          const parsed = JSON.parse(resp.text) as Record<string, unknown>;
          // 记住这台主机：推理直接用它，不必每次先失败一次再切换
          rememberGatewayHost(host);
          return parsed;
        } catch {
          lastError = new Error(`model list response is not JSON (${host})`);
          continue;
        }
      }
      if (resp.status === 401 || resp.status === 403) {
        lastError = new UpstreamUnauthorized(
          `Qoder rejected the signature (HTTP ${resp.status}, host ${host}), please log in again`,
        );
        continue; // 换下一个主机再试
      }
      lastError = new Error(`model list request failed: HTTP ${resp.status} (${host})`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error("model list request failed (no usable inference host)");
}

// ── SSE 信封解包（增量） ──────────────────────────────────────────────────────

interface Envelope {
  headers?: unknown;
  body?: unknown;
  statusCodeValue?: unknown;
  statusCode?: unknown;
}

/** 判断内层 body 是不是"注意帧"之外的错误载荷。 */
function innerError(payload: Record<string, unknown>): { code?: string; message?: string } | null {
  const code = payload["code"];
  const message = payload["message"] ?? payload["error"];
  if (code === undefined && message === undefined) return null;
  return {
    ...(typeof code === "string" ? { code } : {}),
    ...(message !== undefined ? { message: typeof message === "string" ? message : JSON.stringify(message) } : {}),
  };
}

/**
 * 增量翻译器：`data:{headers:…,body:"<内层 chunk>",statusCodeValue:200}` → 标准 OpenAI SSE。
 *
 * 三类帧：
 * - 内层有 `choices` / `usage` → 原样透传（保留 `choices: []`）
 * - 内层是 `null` / 空 / `{}` → **心跳，整帧跳过**（当成错误会让正常回完的请求报失败）
 * - 内层带 `code` / `message` → 业务错误，转成 SSE error 帧（保真 `code`，下游靠它识别排队）
 */
export function newTranslator(): StreamTranslator {
  let buffer = "";
  const decoder = new TextDecoder("utf-8");

  const processLine = (line: string): string[] => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data:")) return [];
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return [`data: ${data || "[DONE]"}\n\n`];

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      // 不是 JSON（有些帧直接是标准 chunk 文本）→ 原样透传
      return [`data: ${data}\n\n`];
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [`data: ${data}\n\n`];
    }

    const envelope = parsed as Envelope;
    // 不是信封 → 可能是直发的标准 chunk，**也可能是裸的统计帧**（实测 Qoder 会发
    // `data:{"firstTokenDuration":…}` 这种没套信封的帧）。所以同样按 chunk/error 判据过滤：
    // 有 `choices` / `usage` 才透传，有 `code` / `message` 转 error，其余丢弃。
    if (!("body" in envelope) && !("statusCodeValue" in envelope) && !("statusCode" in envelope)) {
      const bare = parsed as Record<string, unknown>;
      const bareErr = innerError(bare);
      if (bareErr && bare["choices"] === undefined) {
        return [
          `data: ${JSON.stringify({ error: { code: bareErr.code ?? "upstream_error", message: bareErr.message ?? "upstream error" } })}\n\n`,
        ];
      }
      const bareChunk = Array.isArray(bare["choices"]) || bare["usage"] !== undefined;
      return bareChunk ? [`data: ${data}\n\n`] : [];
    }

    const status = Number(envelope.statusCodeValue ?? 200);
    if (Number.isFinite(status) && status !== 200) {
      return [
        `data: ${JSON.stringify({ error: { code: String(status), message: `Qoder upstream returned ${status}` } })}\n\n`,
      ];
    }

    const inner = envelope.body;
    // null / 空串 / 标量 → 心跳，整帧跳过（当成错误会让正常回完的请求报失败）
    if (inner === null || inner === undefined || inner === "") return [];
    if (typeof inner === "number" || typeof inner === "boolean") return [];

    let payload: Record<string, unknown> | null = null;
    if (typeof inner === "string") {
      try {
        const decoded: unknown = JSON.parse(inner);
        if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
          payload = decoded as Record<string, unknown>;
        }
      } catch {
        return [];
      }
    } else if (typeof inner === "object" && !Array.isArray(inner)) {
      payload = inner as Record<string, unknown>;
    }
    if (!payload) return [];
    if (Object.keys(payload).length === 0) return []; // 空对象也是心跳

    const err = innerError(payload);
    if (err && payload["choices"] === undefined) {
      return [
        `data: ${JSON.stringify({ error: { code: err.code ?? "upstream_error", message: err.message ?? "upstream error" } })}\n\n`,
      ];
    }
    // ⚠ **只透传真正的 chunk**：判据 = 有 `choices` 数组或 `usage`（含 `choices: []`）。
    //
    // Qoder 的流里还会混进**统计帧**（实测 `{"firstTokenDuration":185,"totalDuration":926,
    // "serverDuration":296}`）—— 它既没有 choices 也没有 error，原样透传会让 OpenAI 客户端
    // 校验失败（ZCode 报 `Type validation failed: expected array, received undefined`，
    // 表现为「内容已经正常出完了，最后却报模型请求失败」）。这类帧直接跳过。
    const isChunk = Array.isArray(payload["choices"]) || payload["usage"] !== undefined;
    if (!isChunk) return [];
    return [`data: ${JSON.stringify(payload)}\n\n`];
  };

  return {
    feed(chunk: Buffer): Array<Buffer | string> {
      buffer += decoder.decode(chunk, { stream: true });
      const out: string[] = [];
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        for (const frame of processLine(line)) out.push(frame);
        index = buffer.indexOf("\n");
      }
      return out;
    },
    finish(): Array<Buffer | string> {
      buffer += decoder.decode();
      const rest = buffer;
      buffer = "";
      return rest ? processLine(rest) : [];
    },
  };
}
