/**
 * Qoder 凭据：OAuth 设备授权登录（PKCE S256）+ 续期 + **设备指纹稳定派生**。
 *
 * ## 双区
 *
 * 同一套协议服务两个区：国际 `qoder.com` 与国内 `qoder.com.cn`，差异全部收敛在
 * `PRODUCTS` 表里（域名 / client_id / 授权 URL 参数形态 / UA）。凭据里的 `domain`
 * 按区取值 —— 账号池的 `key = sha256(domain+uid)` 靠它区分"同一 uid 属于哪个区"。
 *
 * ## 为什么要有设备指纹
 *
 * COSY 推理头必须带 `cosy-machineid` / `cosy-machinetoken` / `cosy-machinetype`
 * 三个字段（见 `upstream.ts`）。它们**按 uid 稳定派生**而不是随机生成：同一账号
 * 永远来自同一台"虚拟设备"，多账号之间天然隔离 —— 随机机器码会触发上游风控
 * （参考实现 `qoder2api-hub/qoder_fingerprint.py` 的结论）。
 *
 * ## 登录拿到的凭据字段
 *
 * 设备码轮询响应**不带昵称**，所以要补一次 `GET /api/v1/userinfo` 取 `name`；
 * `uid` 来自轮询响应的 `user_id`。续期响应不含 `machine_id` / `uid` / `nickname`，
 * 必须从旧凭据保留（见 `refresh()`）。
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  credentialsPath,
  ensureDir,
  login as shared,
  loginFlow,
  writeJsonSecret,
  type Credential,
} from "@model-bridge/gateway";

/** 区域：国际版 / 国内版。 */
export type Realm = "intl" | "cn";

/** 一个区域的全部端点与身份常量（差异只在这里）。 */
export interface ProductConfig {
  realm: Realm;
  label: string;
  /** 授权页与用户可见站点。 */
  website: string;
  /** 开放 API（登录轮询 / 续期 / userinfo / 额度与活动）。 */
  openapi: string;
  /** 推理主机候选（主选 + 故障切换；签名只覆盖 path，换主机不影响签名）。 */
  gateway: string[];
  clientId: string;
  redirectUri: string;
  /** 凭据里的 domain（账号池 key 的组成部分）。 */
  domain: string;
  userAgent: string;
  sendClientId: boolean;
  sendRedirectUri: boolean;
  /** nonce 是否用带横线的 UUID（国内）还是 32 位 hex（国际）。 */
  nonceDashed: boolean;
}

export const PRODUCTS: Record<Realm, ProductConfig> = {
  cn: {
    realm: "cn",
    label: "Qoder 国内版",
    website: "https://qoder.com.cn",
    openapi: "https://openapi.qoder.com.cn",
    gateway: ["https://gateway.qoder.com.cn"],
    clientId: "1c5e33e1-364d-4ce6-b02c-acaa81274a5c",
    redirectUri: "qoder-work-cn://",
    domain: "qoder.com.cn",
    userAgent: "QoderWork/1.1.64",
    sendClientId: true,
    sendRedirectUri: true,
    nonceDashed: true,
  },
  intl: {
    realm: "intl",
    label: "Qoder 国际版",
    website: "https://qoder.com",
    openapi: "https://openapi.qoder.sh",
    // 官方客户端内置候选：api1 主选，api2/api3 为故障切换域名
    gateway: ["https://api1.qoder.sh", "https://api2.qoder.sh", "https://api3.qoder.sh"],
    clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
    redirectUri: "qoder://aicoding.aicoding-agent/login-success",
    domain: "qoder.com",
    userAgent: "Qoder/1.1.64",
    sendClientId: true,
    sendRedirectUri: false,
    nonceDashed: false,
  },
};

/**
 * 本渠道**固定绑定**的区域。
 *
 * ⚠ 域是渠道身份的一部分，写死在配置里 —— 国际版 `qoder`（`qoder.com`）与国内版
 * `qodercn`（`qoder.com.cn`）是**两个独立渠道**（同 `workbuddy` / `workbuddyai` 的拆法）：
 * 账号在哪个域就得用哪个渠道登录。这样登录链路与凭据落点不会随 `--realm` 漂移，
 * 也不会出现"用国内版渠道登了国际版账号"这种串区。
 *
 * 代价是两个渠道的源码高度相似（重复代码）—— 这是有意的：两区的端点、模型目录、
 * 账单口径都可能各自演进，共享抽象会把「一个改了两边都变」变成默认行为。
 */
export const CHANNEL_REALM: Realm = "intl";

/** 默认区域 = 本渠道的区域（`DEFAULT_REALM` 这个名字是给调用方读的）。 */
export const DEFAULT_REALM: Realm = CHANNEL_REALM;

/** 契约要求：渠道的默认基址。 */
export const DEFAULT_BASE_URL = PRODUCTS[DEFAULT_REALM].openapi;

/** 默认身份类型（实测值，服务端按它区分试用/正式）。 */
export const DEFAULT_USER_TYPE = "personal_professional_trial";

/** 登录轮询的超时与间隔（官方设备码语义）。 */
const POLL_INTERVAL_MS = 1000;
const POLL_EXPIRES_SEC = 300;

export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
}

/** 凭据：`Credential` 是共享层的三条契约字段，其余为本渠道扩展。 */
export interface Credentials extends Credential {
  readonly accessToken: string;
  readonly uid: string;
  readonly domain: string;
  /** 有它才可静默续期。 */
  readonly refreshToken: string;
  readonly nickname: string;
  /** 参与服务端设备绑定，且是 COSY 头的 `cosy-machineid`。**必须持久化**。 */
  readonly machineId: string;
  readonly userType: string;
  readonly realm: Realm;
  /** 最近一次被上游接受的主机（国际版 api1/api2/api3 里哪个能用，随账号而异）。 */
  readonly gatewayHost: string;
  /** 毫秒时间戳；`null` = 上游没给。 */
  readonly expireAt: number | null;
  readonly refreshExpireAt: number | null;
}

// ── 区域解析 ──────────────────────────────────────────────────────────────────

/**
 * 区域解析：**恒定返回本渠道的区域**（见 `CHANNEL_REALM`）。
 *
 * 保留参数只是为了满足既有调用点的签名，刻意忽略它 —— `--realm` 不该让凭据
 * 落到另一个区的域名上。
 */
export function normalizeRealm(_value?: string): Realm {
  return CHANNEL_REALM;
}

/** 本渠道的区域配置。 */
export function productOf(_realm?: string): ProductConfig {
  return PRODUCTS[CHANNEL_REALM];
}

/** 契约的 `resolveBaseUrl(realm)`：登录与上游共用的默认基址。 */
export function resolveBaseUrl(_realm = "auto"): string {
  return PRODUCTS[CHANNEL_REALM].openapi;
}

// ── 设备指纹（按 uid 稳定派生；`upstream.ts` 的 COSY 头直接用这三个） ──────────

/** `md5("{salt}:{uid}")` 的 hex —— 稳定、幂等。 */
export function deriveId(uid: string, salt: string): string {
  return createHash("md5").update(`${salt}:${uid || "anonymous"}`, "utf8").digest("hex");
}

/** `cosy-machineid`：32 位 hex。 */
export function machineIdOf(uid: string): string {
  return deriveId(uid, "machine");
}

/** `cosy-machinetype`：18 位（去掉横线并截断）。 */
export function machineTypeOf(uid: string): string {
  return deriveId(uid, "machinetype").replace(/-/g, "").slice(0, 18);
}

/** `cosy-machinetoken`：sha512 → base64url（无 padding）取前 43 位。 */
export function machineTokenOf(uid: string): string {
  return createHash("sha512").update(`machinetoken:${uid}`, "utf8").digest("base64url").slice(0, 43);
}

// ── PKCE ─────────────────────────────────────────────────────────────────────

/** PKCE verifier 的字符集（RFC 7636 的 unreserved）。 */
const PKCE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/**
 * 生成 PKCE 对。
 *
 * ⚠ challenge = base64url(sha256(verifier)) 且**不带 `=` padding** ——
 * 带 padding 会被服务端判为校验失败。
 */
export function makePkce(): { verifier: string; challenge: string } {
  const length = 43 + Math.floor(86 * Math.random()); // 43..128
  const bytes = randomBytes(length);
  let verifier = "";
  for (let i = 0; i < length; i += 1) {
    verifier += PKCE_CHARS[bytes[i]! % PKCE_CHARS.length];
  }
  const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
  return { verifier, challenge };
}

/** 构造授权页 URL（双区参数差异全在这里）。 */
export function buildAuthUrl(
  product: ProductConfig,
  challenge: string,
  nonce: string,
  machineId: string,
): string {
  const query = new URLSearchParams({ challenge, challenge_method: "S256", nonce });
  if (product.sendRedirectUri) query.set("redirect_uri", product.redirectUri);
  if (product.sendClientId) {
    query.set("client_id", product.clientId);
    query.set("machine_id", machineId);
  }
  return `${product.website}/device/selectAccounts?${query.toString()}`;
}

// ── 最近身份（供 upstream 构造签名与请求体） ──────────────────────────────────

/**
 * 最近一次读到的身份。
 *
 * 为什么需要：`upstream.buildChatBody()` 要填 `session_type`（国内 `qoder_work` /
 * 国际 `qodercli`）与 `aliyun_user_type`，但它的签名（契约固定）**拿不到凭据** ——
 * 凭据是在之后 `buildHeaders()` / `callUpstream()` 阶段才加载的。所以由本模块在
 * `load()` / `login()` / `refresh()` 时记下，上游读这里。网关的 `/health` 每轮都会
 * `cred.load()`，所以进程起来后这个值总是对应当前生效账号。
 */
let lastIdentity: { realm: Realm; userType: string; gatewayHost: string } = {
  realm: DEFAULT_REALM,
  userType: DEFAULT_USER_TYPE,
  gatewayHost: "",
};

/** 当前生效账号所属区域。 */
export function currentRealm(): Realm {
  return lastIdentity.realm;
}

/** 当前生效账号的身份类型（请求体 `aliyun_user_type` 用它）。 */
export function currentUserType(): string {
  return lastIdentity.userType;
}

/**
 * 当前生效账号可用的推理主机（空串 = 还没探到）。
 *
 * 为什么要记：国际版有三个候选域名，**哪个能被接受随账号而异**（实测某账号
 * `api1` 恒 403、`api2` 正常）。`upstream` 在拉到模型目录时记下成功的主机，
 * 推理就直接用它，省掉每次都要先失败一次再切换。
 */
export function currentGatewayHost(): string {
  return lastIdentity.gatewayHost;
}

/** 记下上游接受的主机（由 upstream 在请求成功后调用，并回写凭据文件）。 */
export function rememberGatewayHost(host: string): void {
  if (!host || lastIdentity.gatewayHost === host) return;
  lastIdentity = { ...lastIdentity, gatewayHost: host };
  try {
    const current = load();
    writeJsonSecret(credentialsPath(), { ...current, gatewayHost: host });
  } catch {
    /* 没登录 / 写不进去都无所谓：内存里那份已经生效，下次请求仍走对的主机 */
  }
}

/** 记下身份（由 `load` / `login` / `refresh` 调用）。 */
export function rememberIdentity(realm: Realm, userType: string, gatewayHost = ""): void {
  lastIdentity = {
    realm,
    userType: userType || DEFAULT_USER_TYPE,
    gatewayHost: gatewayHost || lastIdentity.gatewayHost,
  };
}

/** **仅供测试**：重置最近身份。 */
export function resetIdentityForTest(): void {
  lastIdentity = { realm: DEFAULT_REALM, userType: DEFAULT_USER_TYPE, gatewayHost: "" };
}

// ── 凭据读写 ──────────────────────────────────────────────────────────────────

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 读凭据；未登录 / 文件损坏都抛 `NotLoggedInError`（共享层靠它判断"没东西"）。 */
export function load(): Credentials {
  let raw: string;
  try {
    raw = readFileSync(credentialsPath(), "utf8");
  } catch {
    throw new NotLoggedInError("Not logged in: run `qoder login` to authorize in the browser");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new NotLoggedInError("Credential file is corrupted, please log in again");
  }
  const accessToken = str(parsed["accessToken"]);
  if (!accessToken) throw new NotLoggedInError("Credential has no access_token, please log in again");
  const uid = str(parsed["uid"]);
  const realm = normalizeRealm(str(parsed["realm"]));
  const userType = str(parsed["userType"]) || DEFAULT_USER_TYPE;
  rememberIdentity(realm, userType, str(parsed["gatewayHost"]));
  return {
    accessToken,
    uid,
    domain: str(parsed["domain"]) || productOf(realm).domain,
    refreshToken: str(parsed["refreshToken"]),
    nickname: str(parsed["nickname"]),
    // 老凭据可能没存 machine_id：按 uid 重派生即可（同一账号结果一致）
    machineId: str(parsed["machineId"]) || machineIdOf(uid),
    userType,
    realm,
    gatewayHost: str(parsed["gatewayHost"]),
    expireAt: shared.parseExpireTime(parsed["expireAt"]),
    refreshExpireAt: shared.parseExpireTime(parsed["refreshExpireAt"]),
  };
}

/** 写凭据（原子写 + 0600；账号池也靠这个文件判断"已登录"）。 */
export async function save(credential: Credentials): Promise<void> {
  ensureDir();
  writeJsonSecret(credentialsPath(), credential);
}

// ── 登录 ─────────────────────────────────────────────────────────────────────

export interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (msg: string) => void;
  /** 测试注入的 sleep（不起真实定时器）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 指定区域；缺省按 baseUrl 推断，再缺省用 `DEFAULT_REALM`。 */
  realm?: string;
}

interface DeviceToken {
  accessToken: string;
  refreshToken: string;
  uid: string;
  expireAt: number | null;
  refreshExpireAt: number | null;
}

/** 补昵称：设备码轮询响应里没有，必须单独取。尽力而为，失败不阻塞登录。 */
async function fetchNickname(product: ProductConfig, accessToken: string): Promise<string> {
  try {
    const resp = await shared.fetchWithTimeout(
      `${product.openapi}/api/v1/userinfo`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": product.userAgent,
        },
      },
      15_000,
    );
    if (!resp.ok) return "";
    const data = (await resp.json()) as Record<string, unknown>;
    return str(data["name"]) || str(data["nickname"]);
  } catch {
    return "";
  }
}

/**
 * 完整设备授权登录：构造授权 URL → 用户浏览器授权 → 轮询取 token → 补昵称 → 落盘。
 *
 * ⚠ 轮询的 HTTP 404 是**正常中间态**（官方语义：用户还没点同意），必须继续轮询；
 * 其它非 2xx 才是错误（实测参考实现）。
 */
export async function login(baseUrl?: string, options: LoginOptions = {}): Promise<Credentials> {
  // 区域由渠道决定，不看 `--realm` / baseUrl（见 CHANNEL_REALM）
  const product = productOf();
  const { verifier, challenge } = makePkce();
  const machineId = randomUUID();
  const nonce = product.nonceDashed ? randomUUID() : shared.randomHex(16);

  const authUrl = buildAuthUrl(product, challenge, nonce, machineId);
  options.onUrl?.(authUrl);
  options.onStatus?.(
    `${product.label}: complete authorization in the browser that just opened (machine_id ${machineId.slice(0, 8)}…)`,
  );
  shared.openBrowser(authUrl);

  const pollQuery = new URLSearchParams({ nonce, verifier, challenge_method: "S256" });
  const pollUrl = `${product.openapi}/api/v1/deviceToken/poll?${pollQuery.toString()}`;

  const token = await loginFlow.pollDeviceCode<DeviceToken>({
    intervalMs: POLL_INTERVAL_MS,
    expiresInSec: POLL_EXPIRES_SEC,
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    attempt: async () => {
      const resp = await shared.fetchWithTimeout(
        pollUrl,
        { headers: { Accept: "application/json" } },
        20_000,
      );
      // 404 = 尚未授权（官方语义），不是错误
      if (resp.status === 404) return { kind: "pending" };
      if (!resp.ok) {
        return { kind: "fatal", error: new Error(`Device authorization polling failed: HTTP ${resp.status}`) };
      }
      const data = (await resp.json()) as Record<string, unknown>;
      // 字段名登录与续期不一致，三种都认
      const accessToken =
        str(data["token"]) || str(data["device_token"]) || str(data["access_token"]);
      if (!accessToken) return { kind: "pending" }; // 还没好，继续等
      return {
        kind: "done",
        value: {
          accessToken,
          refreshToken: str(data["refresh_token"]) || str(data["refreshToken"]),
          uid: str(data["user_id"]) || str(data["userId"]),
          expireAt: shared.parseExpireTime(data["expires_at"] ?? data["expiresAt"]),
          refreshExpireAt: shared.parseExpireTime(
            data["refresh_token_expires_at"] ?? data["refreshTokenExpiresAt"],
          ),
        },
      };
    },
  });

  if (!token.accessToken) throw new Error("Device authorization succeeded but no access token was returned");

  const nickname = await fetchNickname(product, token.accessToken);
  rememberIdentity(product.realm, DEFAULT_USER_TYPE);
  const credential: Credentials = {
    accessToken: token.accessToken,
    uid: token.uid,
    domain: product.domain,
    refreshToken: token.refreshToken,
    nickname,
    machineId,
    userType: DEFAULT_USER_TYPE,
    realm: product.realm,
    // 新登录：还不知道哪个推理主机能被接受，留给第一次成功请求去记
    gatewayHost: "",
    expireAt: token.expireAt,
    refreshExpireAt: token.refreshExpireAt,
  };
  await save(credential);
  options.onStatus?.(`Logged in ${product.label}${nickname ? ` (${nickname})` : ""}`);
  return credential;
}

/**
 * 续期：`POST {openapi}/api/v1/deviceToken/refresh`，body `{refresh_token, machine_id}`。
 *
 * - 401/403 → 终态（`NotLoggedInError`，提示重新登录）
 * - 200 但无 token → 同样终态
 * - 其余（5xx/429/网络）→ 普通 Error，共享层会当作可重试
 *
 * ⚠ 续期响应**不含** `machine_id` / `uid` / `nickname`，必须从旧凭据保留 ——
 * 丢了 `machine_id` 会破坏服务端设备绑定。
 */
export async function refresh(credential: Credentials): Promise<Credentials> {
  if (!credential.refreshToken) throw new Error("Credential has no refresh_token, cannot refresh silently");
  const product = productOf(credential.realm);

  let resp: Response;
  try {
    resp = await shared.fetchWithTimeout(
      `${product.openapi}/api/v1/deviceToken/refresh`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": product.userAgent,
        },
        body: JSON.stringify({
          refresh_token: credential.refreshToken,
          machine_id: credential.machineId,
        }),
      },
      20_000,
    );
  } catch (err) {
    throw new Error(`Refresh request failed (retryable): ${String(err)}`);
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new NotLoggedInError("refresh_token expired, please run `qoder login` again");
  }
  if (!resp.ok) throw new Error(`Refresh failed: HTTP ${resp.status} (retryable)`);

  const data = (await resp.json()) as Record<string, unknown>;
  const accessToken = str(data["token"]) || str(data["device_token"]) || str(data["access_token"]);
  if (!accessToken) throw new NotLoggedInError("Refresh response has no token, please log in again");

  const next: Credentials = {
    ...credential,
    accessToken,
    refreshToken:
      str(data["refresh_token"]) || str(data["refreshToken"]) || credential.refreshToken,
    expireAt: shared.parseExpireTime(data["expires_at"] ?? data["expiresAt"]) ?? credential.expireAt,
    refreshExpireAt:
      shared.parseExpireTime(data["refresh_token_expires_at"] ?? data["refreshTokenExpiresAt"]) ??
      credential.refreshExpireAt,
  };
  rememberIdentity(next.realm, next.userType);
  await save(next);
  return next;
}

/** 打开浏览器（复用共享实现；打不开不影响流程，用户可以手动复制 URL）。 */
export function openBrowser(url: string): void {
  shared.openBrowser(url);
}
