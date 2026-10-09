/**
 * CodeArts 凭据：新式 IAM OAuth 登录（PKCE + DPoP）、凭据持久化与 STS 续期。
 *
 * ## 三件套：PKCE + DPoP + 本地回调（端口 ≥ 10000）
 *
 * - **PKCE**：`code_verifier = base64url(randomBytes(48))`，
 *   `code_challenge = base64url(sha256(verifier))`。
 * - **DPoP**：ES256 / P-256 密钥对，**私钥 JWK 随凭据持久化**（续期要用）；
 *   每次 token 请求都要**新签**一个 `dpop+jwt`（`jti` 随机）。
 * - **回调端口必须 ≥ 10000**：低端口会被 portal 拒绝；授权 URL
 *   **不能带 `auth_callback_url`**（portal 仅凭 `port` 参数构造回调，
 *   多余参数会让它静默回退旧 ticket 流程）。
 * - `code_challenge_method` 必须是 **`SHA-256`**（不是 RFC 缩写 `S256`）。
 *
 * ## DPoP JWS 手写（不引第三方库）
 *
 * `jose` 那类库在桥接层是不必要的重依赖：仓库约定 `dependencies` 为空，
 * `node:crypto` 足够 —— 三件事：`generateKeyPairSync("ec", {namedCurve:"P-256"})`
 * 出密钥、`key.export({format:"jwk"})` 出 JWK、`createSign("SHA256")` 出签名。
 * ⚠️ JWS 要的是 **raw `R||S`（P-256 恰好 64 字节）**，而 Node 默认输出 DER
 * （约 70~72 字节）—— 必须用 `dsaEncoding: "ieee-p1363"`，否则服务端验签必失败。
 *
 * ## refresh_token 一次性轮换
 *
 * 华为 STS 签发新凭据时旧 `refresh_token` 即失效（实测 `STS5.1806`）。
 * 故续期走**进程内串行队列**，且判终态前**先重读凭据**确认「我刚才用的那份
 * refresh_token 是否还是当前那份」—— 不是的话说明另一条入口已经轮换过，
 * 这次失败不代表终态。
 */

import {
  createHash,
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  type JsonWebKey,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

import { accounts, credentialsPath, ensureDir, login as sharedLogin } from "@model-bridge/gateway";
import * as upstream from "./upstream.js";

/** 上游 API 基址（snap-access 网关，硬编码 cn-north-4，无多区域）。 */
export const DEFAULT_BASE_URL = upstream.DEFAULT_BASE_URL;

/** 华为 STS token 端点（授码换取与续期共用）。 */
export const STS_TOKEN_ENDPOINT = "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens";

/** portal 基址（授权页与登录结果页）。 */
export const DEFAULT_PORTAL_BASE = "https://codearts.huaweicloud.com";

/** CodeArts Agent 的 OAuth client_id（即其 URI scheme）。 */
export const CLIENT_ID = "codearts-agent";
/** 本地回调路径。 */
export const REDIRECT_PATH = "/oauth/callback";
/** 回调端口下限：低于它的端口会被 portal 拒绝。 */
export const MIN_CALLBACK_PORT = 10_000;
/** 登录等待预算（浏览器 + 人工操作，180 秒）。 */
export const LOGIN_TIMEOUT_MS = 180_000;
/** token 请求超时（与真实插件一致）。 */
export const TOKEN_TIMEOUT_MS = 60_000;

/** portal 期望的插件名 / 版本（逆向常量，硬编码为真实扩展版本，勿用本包版本）。 */
export const LOGIN_PLUGIN_NAME = "snap_AIIDE";
export const LOGIN_PLUGIN_VERSION = "5.2.0";
/** 主题色 kind（2 = Dark）。 */
export const OAUTH_THEME = "2";
/** 界面语言。 */
export const OAUTH_LOCALE = "zh-cn";

/** 旧式 ticket 凭据轮询（回退路径）。 */
export const TICKET_PATH = "/snap-manager/v1/login/ticket";
export const TICKET_POLL_INTERVAL_MS = 1_000;
export const TICKET_POLL_MAX = 120;

const NOT_LOGGED_IN_MSG = "no credentials found; run `codearts login` first";

/** 磁盘上不存在可用凭据。 */
export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
  constructor(message: string = NOT_LOGGED_IN_MSG) {
    super(message);
  }
}

/**
 * refresh_token 已失效 —— 终态，只能重新登录。
 *
 * ⚠️ 判定只认两种信号：`error === 'invalid_grant'` 或
 * `error_code` 含 `ExpiredRefreshToken`。
 * **`InvalidDPoPHeader` 明确不算终态**：它说的是「这一次 proof 没过校验」
 * （时钟偏差 / 重放判定 / 网关抖动），与 refresh_token 能否继续用无关；
 * 把它当终态会把材料完好的账号一步标死。
 */
export class RefreshTokenExpiredError extends Error {
  override name = "RefreshTokenExpiredError";
}

/** DPoP ES256 公钥 JWK。 */
export interface DpopPublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

/** DPoP ES256 私钥 JWK（仅持久化这一份；公钥由 x/y 重建）。 */
export interface DpopPrivateJwk extends DpopPublicJwk {
  d: string;
}

export interface DpopKeyPair {
  privateKeyJwk: DpopPrivateJwk;
  publicKeyJwk: DpopPublicJwk;
}

/** PKCE 配对。 */
export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/**
 * 一份 CodeArts 凭据。
 *
 * 契约要求的 `accessToken` 映射到 `securityToken`（推理请求的鉴权材料是
 * AK/SK/security_token 三元组，其中只有 security_token 是「令牌」）；
 * `domain` 恒空（单区域硬编码 cn-north-4）。
 */
export interface Credentials {
  readonly accessToken: string;
  readonly uid: string;
  readonly domain: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly securityToken: string;
  /** 过期时刻（上游 `expiration` 原样字符串）。 */
  readonly expiresAt: string;
  readonly domainId: string;
  readonly userId: string;
  readonly userName: string;
  /** 刷新令牌（新式 OAuth 签发；缺失表示旧 ticket 凭据，不可静默刷新）。 */
  readonly refreshToken: string;
  /** PKCE 验证器（续期换取时与 refresh_token 一起提交）。 */
  readonly codeVerifier: string;
  /** DPoP 私钥 JWK（续期时签发 JWS 用）。 */
  readonly dpopPrivateKeyJwk: DpopPrivateJwk | null;
  readonly obtainedAt: string;
  readonly source: string;
}

export const EMPTY_CREDENTIALS: Credentials = {
  accessToken: "",
  uid: "",
  domain: "",
  accessKeyId: "",
  secretAccessKey: "",
  securityToken: "",
  expiresAt: "",
  domainId: "",
  userId: "",
  userName: "",
  refreshToken: "",
  codeVerifier: "",
  dpopPrivateKeyJwk: null,
  obtainedAt: "",
  source: "",
};

/**
 * 取值收窄：本例**额外接受有限数字**（STS 信封里 user_id 等可能是数字），
 * 故不转发共享层的 `str`（那个只放行字符串）。
 */
function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** 当前时间的 ISO 字串（转发共享层原语）。 */
const nowIso = sharedLogin.nowIso;

// ── PKCE / DPoP ──────────────────────────────────────────────────────────────

/** PKCE 配对：verifier 随机 48 字节 base64url，challenge 为 S256。 */
export function generatePkcePair(): PkcePair {
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

/** 生成 ES256（P-256）DPoP 密钥对（JWK 形态）。 */
export function generateDpopKeyPair(): DpopKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const privateKeyJwk = privateKey.export({ format: "jwk" }) as DpopPrivateJwk;
  const publicKeyJwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  return {
    privateKeyJwk: { kty: "EC", crv: "P-256", x: privateKeyJwk.x, y: privateKeyJwk.y, d: privateKeyJwk.d },
    publicKeyJwk: { kty: "EC", crv: "P-256", x: publicKeyJwk.x, y: publicKeyJwk.y },
  };
}

/** base64url 编码（转发共享层原语）。 */
const b64url = sharedLogin.b64url;

/**
 * 用持久化的 DPoP 私钥签发 `dpop+jwt`（`htm` = HTTP 方法，`htu` = 完整 URL）。
 *
 * 每次请求都要新签（`jti` 随机、`iat` 当前秒）—— 重放同一个 proof 会被服务端
 * 按重放判定拒绝。
 */
export function signDpopJws(keyPair: DpopKeyPair, htm: string, htu: string): string {
  const header = { alg: "ES256", typ: "dpop+jwt", jwk: keyPair.publicKeyJwk };
  const payload = {
    htm,
    htu,
    iat: Math.floor(Date.now() / 1000),
    jti: randomBytes(32).toString("hex"),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  // `node:crypto` 要求 JsonWebKey（带索引签名），故这里做一次结构化转换。
  const jwk = { ...keyPair.privateKeyJwk } as unknown as JsonWebKey;
  const key = createPrivateKey({ key: jwk, format: "jwk" });
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  // ⚠️ JWS 的 ES256 签名是 raw R||S（64 字节），不是 DER —— 不加 dsaEncoding
  // 会产出 ~71 字节的 DER，服务端验签必然失败。
  const signature = signer.sign({ key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(signature)}`;
}

/** 从持久化的私钥 JWK 恢复密钥对（公钥由 x/y 重建）。 */
export function keyPairFromStoredJwk(jwk: DpopPrivateJwk): DpopKeyPair {
  return {
    privateKeyJwk: jwk,
    publicKeyJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
  };
}

// ── STS token 请求 ───────────────────────────────────────────────────────────

export interface TokenResponse {
  credentials?: {
    access_key_id?: string;
    secret_access_key?: string;
    security_token?: string;
    expiration?: string;
  };
  refresh_token?: string;
  error?: string;
  error_code?: string;
  error_msg?: string;
  domain_id?: string;
  user_id?: string;
  user_name?: string;
}

/** STS 端点；`CODEARTS_STS_URL` 可覆盖（自托管 / 离线测试）。 */
export function stsEndpoint(): string {
  const override = process.env["CODEARTS_STS_URL"];
  return override && override.trim() ? override.trim() : STS_TOKEN_ENDPOINT;
}

/**
 * 向 STS 发起一次带 DPoP 的 token 请求。
 *
 * 终态判定只认 `invalid_grant` / `ExpiredRefreshToken`（见
 * `RefreshTokenExpiredError` 的说明）。
 */
export async function requestToken(
  body: Record<string, string>,
  keyPair: DpopKeyPair,
): Promise<TokenResponse> {
  const endpoint = stsEndpoint();
  const dpop = signDpopJws(keyPair, "POST", endpoint);
  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: { DPoP: dpop, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`CodeArts token request network error: ${String(err)}`);
  }
  let data: TokenResponse | null = null;
  const text = await resp.text().catch(() => "");
  try {
    data = JSON.parse(text) as TokenResponse;
  } catch {
    data = null;
  }
  if (!resp.ok || !data?.credentials) {
    const detail = data ? JSON.stringify(data) : text.slice(0, 200);
    const message = `CodeArts token request failed: ${resp.status} ${detail}`;
    const errorCode = String(data?.error_code ?? "");
    if (data?.error === "invalid_grant" || errorCode.includes("ExpiredRefreshToken")) {
      throw new RefreshTokenExpiredError(message);
    }
    throw new Error(message);
  }
  return data;
}

/** 授权码换取（新式 IAM OAuth）。 */
export function exchangeAuthorizationCode(
  code: string,
  codeVerifier: string,
  port: number,
  keyPair: DpopKeyPair,
): Promise<TokenResponse> {
  return requestToken(
    {
      client_id: CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: `http://127.0.0.1:${port}${REDIRECT_PATH}`,
    },
    keyPair,
  );
}

/** 刷新令牌换取（静默续期）。 */
export function exchangeRefreshToken(
  refreshToken: string,
  codeVerifier: string,
  keyPair: DpopKeyPair,
): Promise<TokenResponse> {
  return requestToken(
    {
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
    keyPair,
  );
}

/**
 * 从 `refresh_token` 里解出**稳定的用户身份**（`user_profile.account_id`）。
 *
 * ## 为什么必须这么做
 *
 * STS 的信封（登录与续期都一样）**只给 `credentials` + `refresh_token`**，
 * 从不给 `user_id` / `domain_id` —— 于是本模块原来退化成 `sha256(access_key_id)[:16]`
 * 当 `uid`。但**华为 STS 每次签发都换一套新 AK**，所以同一个人每次登录/续期都算出
 * 不同的 `uid`，账号池就把它当成不同账号：
 *
 * - 池子无限膨胀（实测一个用户躺了 3 个"账号"）
 * - 更糟：这些伪账号**共享同一个 refresh token 家族**，一个被消费就全体作废，
 *   池子的故障转移于是从"救命"变成"把一个失败放大成 N 次无效重试"
 *
 * `refresh_token` 是 JWT，其 `user_profile` 声明里带着真实且**稳定**的身份
 * （`account_id` / `principal_id`），同一个人跨登录完全一致（实测三个伪账号的
 * `account_id` 都是 `019fb1171afe7d21a114c649628b72e1`）。
 *
 * ⚠ 只做 base64 解码，**不验签**：这个值仅用于「是不是同一个人」的去重，
 * 不参与鉴权判断 —— 真伪由上游对 token 本身的校验负责。解不开就返回空串，
 * 由调用方退回到旧算法（保守，不改变既有行为）。
 */
export function identityFromRefreshToken(refreshToken: string): string {
  try {
    const parts = refreshToken.split(".");
    if (parts.length < 2) return "";
    const segment = parts[1] ?? "";
    // JWT 用 base64url；补齐 padding 后解码
    const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4);
    const payload = JSON.parse(
      Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as Record<string, unknown>;
    // 只认 refreshToken 类型：access token / id token 的身份声明未必同一口径
    if (str(payload["type"]) && str(payload["type"]) !== "refreshToken") return "";
    const profileRaw = payload["user_profile"];
    if (typeof profileRaw !== "string" || !profileRaw) return "";
    const profilePadded = profileRaw + "=".repeat((4 - (profileRaw.length % 4)) % 4);
    const profile = JSON.parse(
      Buffer.from(profilePadded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as Record<string, unknown>;
    // account_id 是账号级身份；缺失时退到 principal_id（用户级）
    return str(profile["account_id"]) || str(profile["principal_id"]);
  } catch {
    return "";
  }
}

/**
 * 由 token 响应组装可持久化凭据（含刷新所需字段）。
 *
 * `uid` 的优先级（**顺序不可换**）：
 * 1. STS 信封里的 `user_id`（若上游哪天开始给）
 * 2. `refresh_token` JWT 里的 `account_id` —— 稳定，同一个人跨登录一致
 * 3. `sha256(access_key_id)[:16]` —— 最后兜底，**每次登录都会变**，只保证不空
 *
 * ⚠ 第 3 条会让账号池把同一个人当成不同账号（见 `identityFromRefreshToken` 说明），
 * 所以只要第 2 条可用就绝不走它。
 */
export function credentialFromTokenResponse(
  token: TokenResponse,
  pkce: PkcePair,
  keyPair: DpopKeyPair,
  source: string,
): Credentials {
  const credentials = token.credentials ?? {};
  const accessKeyId = str(credentials.access_key_id);
  const securityToken = str(credentials.security_token);
  const userId = str(token.user_id);
  const refreshToken = str(token.refresh_token);
  const identity = userId || identityFromRefreshToken(refreshToken);
  return {
    ...EMPTY_CREDENTIALS,
    // 契约的 accessToken：本渠道的「令牌」就是 security_token。
    accessToken: securityToken || accessKeyId,
    uid: identity || createHash("sha256").update(accessKeyId).digest("hex").slice(0, 16),
    accessKeyId,
    secretAccessKey: str(credentials.secret_access_key),
    securityToken,
    expiresAt: str(credentials.expiration),
    domainId: str(token.domain_id),
    userId,
    userName: str(token.user_name),
    refreshToken,
    codeVerifier: pkce.codeVerifier,
    dpopPrivateKeyJwk: keyPair.privateKeyJwk,
    obtainedAt: nowIso(),
    source,
  };
}

// ── 凭据读写 ─────────────────────────────────────────────────────────────────

function fromDisk(rec: Record<string, unknown>): Credentials {
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = str(rec[key]);
      if (value) return value;
    }
    return "";
  };
  const jwkRaw = rec["dpop_private_key_jwk"] ?? rec["dpopPrivateKeyJwk"];
  let jwk: DpopPrivateJwk | null = null;
  if (jwkRaw && typeof jwkRaw === "object") {
    jwk = jwkRaw as DpopPrivateJwk;
  } else if (typeof jwkRaw === "string" && jwkRaw.trim()) {
    try {
      jwk = JSON.parse(jwkRaw) as DpopPrivateJwk;
    } catch {
      jwk = null;
    }
  }
  return {
    accessToken: pick("access_token", "accessToken", "security_token", "securityToken"),
    uid: pick("uid", "user_id", "userId"),
    domain: pick("domain"),
    accessKeyId: pick("access_key_id", "accessKeyId"),
    secretAccessKey: pick("secret_access_key", "secretAccessKey"),
    securityToken: pick("security_token", "securityToken"),
    expiresAt: pick("expires_at", "expiresAt"),
    domainId: pick("domain_id", "domainId"),
    userId: pick("user_id", "userId"),
    userName: pick("user_name", "userName"),
    refreshToken: pick("refresh_token", "refreshToken"),
    codeVerifier: pick("code_verifier", "codeVerifier"),
    dpopPrivateKeyJwk: jwk,
    obtainedAt: pick("obtained_at", "obtainedAt"),
    source: pick("source"),
  };
}

/** 磁盘布局（snake_case，与 `CodeArtsCredential` 同形）。 */
export interface DiskCredentials {
  access_key_id: string;
  secret_access_key: string;
  security_token: string;
  expires_at: string;
  refresh_token: string;
  code_verifier: string;
  dpop_private_key_jwk: DpopPrivateJwk | null;
  domain_id: string;
  user_id: string;
  user_name: string;
  uid: string;
  obtained_at: string;
  source: string;
}

function toDisk(c: Credentials): DiskCredentials {
  return {
    access_key_id: c.accessKeyId,
    secret_access_key: c.secretAccessKey,
    security_token: c.securityToken,
    expires_at: c.expiresAt,
    refresh_token: c.refreshToken,
    code_verifier: c.codeVerifier,
    dpop_private_key_jwk: c.dpopPrivateKeyJwk,
    domain_id: c.domainId,
    user_id: c.userId,
    user_name: c.userName,
    uid: c.uid,
    obtained_at: c.obtainedAt || nowIso(),
    source: c.source,
  };
}

/**
 * 从磁盘读取凭据。
 *
 * 文件缺失 / JSON 损坏 / 缺 AK 或 SK 一律抛 `NotLoggedInError`。
 * `uid` 缺失时用 `sha256(ak)[:16]` 补齐（不拒绝整条凭据）。
 */
export function load(): Credentials {
  let raw: string;
  try {
    raw = readFileSync(credentialsPath(), "utf8");
  } catch {
    throw new NotLoggedInError();
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new NotLoggedInError();
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new NotLoggedInError();
  const c = fromDisk(data as Record<string, unknown>);
  if (!c.accessKeyId || !c.secretAccessKey) throw new NotLoggedInError();
  return { ...c, uid: resolveUid(c) };
}

/**
 * 定稿 `uid`：**修掉历史上按 AK 派生的伪身份**。
 *
 * 老版本的 `uid` 是 `sha256(access_key_id)[:16]`（因为 STS 信封不给 `user_id`）。
 * AK 每次签发都换，所以同一个人被记成多个账号，账号池因此把一次失败放大成多次
 * 无效重试（详见 `identityFromRefreshToken`）。
 *
 * 判定「是不是旧算法」用**精确比对**：只有当存盘值恰好等于「当前 AK 的 sha256 前 16 位」
 * 时才认为它是伪身份，改用 JWT 里的稳定 `account_id`。这样：
 * - 真·上游 `user_id`（若哪天有）不会被误改；
 * - 已经修好的凭据（uid = account_id）不会被二次改写；
 * - 老凭据在**第一次读取时**自动纠正，不需要用户重登。
 */
function resolveUid(c: Credentials): string {
  const legacy = createHash("sha256").update(c.accessKeyId).digest("hex").slice(0, 16);
  const stable = identityFromRefreshToken(c.refreshToken);
  if (!c.uid) return stable || legacy;
  if (c.uid === legacy && stable) return stable;
  return c.uid;
}

/** 尝试读取；不可用时返回 null（不抛）。 */
function tryLoad(): Credentials | null {
  try {
    return load();
  } catch {
    return null;
  }
}

/** 原子写盘（临时文件 + rename）并置 0600。 */
export async function save(c: Credentials): Promise<void> {
  ensureDir();
  const path = credentialsPath();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(toDisk(c), null, 2)}\n`, "utf8");
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

/** 凭据是否已过期（无法解析时**不判定过期**）。 */
export function isExpired(c: Credentials, nowMs = Date.now()): boolean {
  if (!c.expiresAt) return false;
  const parsed = Date.parse(c.expiresAt);
  return Number.isFinite(parsed) ? nowMs >= parsed : false;
}

// ── 登录 ─────────────────────────────────────────────────────────────────────

/** portal 基址；`CODEARTS_PORTAL_BASE` 可覆盖（自托管 / 测试）。 */
export function portalBase(): string {
  const override = process.env["CODEARTS_PORTAL_BASE"];
  return override && override.trim()
    ? override.trim().replace(/\/+$/, "")
    : DEFAULT_PORTAL_BASE;
}

/**
 * 构造 portal 授权 URL（参数完全对齐真实插件 `buildLoginUrl`）。
 *
 * ⚠️ 三处实测踩坑：
 * - `code_challenge_method` 必须是 **`SHA-256`**（错值会**静默回退旧 ticket 流程**）
 * - **不能带 `auth_callback_url`**（portal 仅凭 `port` 参数构造回调）
 * - 端口 < 10000 会被 portal 拒绝（`startCallbackServer` 保证 ≥ 10000）
 */
export function buildLoginUrl(port: number, pkce: PkcePair, ticketId: string): string {
  return (
    `${portalBase()}/portal/authorize?theme=${OAUTH_THEME}&locale=${OAUTH_LOCALE}` +
    `&uri_scheme=${CLIENT_ID}&client_id=${CLIENT_ID}&port=${port}` +
    `&code_challenge=${pkce.codeChallenge}&code_challenge_method=SHA-256` +
    `&ticket_id=${ticketId}&plugin-name=${LOGIN_PLUGIN_NAME}&plugin-version=${LOGIN_PLUGIN_VERSION}`
  );
}

/** portal 登录结果页 URL（回调成功后 307 重定向到此页）。 */
export function buildPortalLoginResultUrl(succeeded: boolean): string {
  return (
    `${portalBase()}/portal/login?login_succeed=${succeeded}` +
    `&uri_scheme=${CLIENT_ID}&locale=${OAUTH_LOCALE}`
  );
}

/** Windows 下用 `cmd /c start "" "{url}"` 打开浏览器（空标题防 `&` 截断 URL）。 */
export function openBrowser(url: string): void {
  sharedLogin.openBrowser(url);
}

/** 已启动的回调服务器。 */
export interface CallbackServer {
  port: number;
  close: () => Promise<void>;
  /** 换取成功后 resolve（此时凭据**尚未落盘**，由 `login()` 负责）。 */
  result: Promise<Credentials>;
}

/** 在 ≥10000 的端口上监听（低端口会被 portal 拒绝：关闭后换随机高端口重试）。 */
function listenOnCallbackPort(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const tryListen = (port: number, attempts: number): void => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const assigned = (server.address() as { port: number } | null)?.port ?? 0;
        if (assigned >= MIN_CALLBACK_PORT) {
          resolve(assigned);
          return;
        }
        server.close(() => {
          if (attempts > 20) {
            reject(new Error("could not obtain a callback port >= 10000"));
            return;
          }
          const retry = Math.floor(Math.random() * (65_536 - MIN_CALLBACK_PORT)) + MIN_CALLBACK_PORT;
          tryListen(retry, attempts + 1);
        });
      });
    };
    tryListen(0, 0);
  });
}

/** 旧式 ticket 凭据解析：兼容 `data.credential.*` 与 `data.result.*` 两种形状。 */
export function credentialFromTicketPayload(payload: Record<string, unknown>): Credentials | null {
  const data =
    payload["data"] && typeof payload["data"] === "object"
      ? (payload["data"] as Record<string, unknown>)
      : payload;
  const credential =
    data["credential"] && typeof data["credential"] === "object"
      ? (data["credential"] as Record<string, unknown>)
      : data["result"] && typeof data["result"] === "object"
        ? (data["result"] as Record<string, unknown>)
        : null;
  if (!credential) return null;
  const ak = str(credential["access"] ?? credential["accessKeyId"]);
  const sk = str(credential["secret"] ?? credential["secretAccessKey"]);
  const st = str(credential["securitytoken"] ?? credential["securityToken"]);
  const expires = str(credential["expires_at"] ?? credential["expiresAt"] ?? credential["expiration"]);
  if (!ak || !sk) return null;
  return {
    ...EMPTY_CREDENTIALS,
    accessToken: st || ak,
    uid: str(data["user_id"]) || createHash("sha256").update(ak).digest("hex").slice(0, 16),
    accessKeyId: ak,
    secretAccessKey: sk,
    securityToken: st,
    // `expires_at` 无法解析时回退 now + 24h（对齐 Go 的宽松处理）。
    expiresAt: Number.isFinite(Date.parse(expires))
      ? expires
      : new Date(Date.now() + 24 * 3600_000).toISOString(),
    domainId: str(data["domain_id"]),
    userId: str(data["user_id"]),
    userName: str(data["user_name"]),
    obtainedAt: nowIso(),
    source: "codearts-ticket",
  };
}

/** 旧式 ticket 轮询（间隔 1 秒，最多 120 次）。 */
export async function pollTicketCredential(ticketId: string, secret: string): Promise<Credentials> {
  const base = (upstream.loadConfig()[0].baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${base}${TICKET_PATH}?ticket_id=${encodeURIComponent(ticketId)}&secret=${encodeURIComponent(secret)}`;
  for (let attempt = 0; attempt < TICKET_POLL_MAX; attempt += 1) {
    try {
      const resp = await fetch(url, {
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          "plugin-name": LOGIN_PLUGIN_NAME,
          "plugin-version": LOGIN_PLUGIN_VERSION,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
      if (resp.ok) {
        const payload = (await resp.json()) as Record<string, unknown>;
        const c = credentialFromTicketPayload(payload);
        if (c) return c;
      }
    } catch {
      /* 轮询失败下一轮再试 */
    }
    await new Promise((r) => setTimeout(r, TICKET_POLL_INTERVAL_MS));
  }
  throw new Error("legacy ticket login timed out (120 polls without credentials)");
}

/**
 * 启动回调服务器。
 *
 * 新流程：`?code=` → 立即 exchange → 307 到 portal 结果页（成功/失败页不同）。
 * 旧流程回退：`?secret=` → 307 到 `redirect` 参数 → 后台轮询 ticket 端点。
 */
export function startCallbackServer(options: {
  pkce: PkcePair;
  keyPair: DpopKeyPair;
  ticketId: string;
  timeoutMs?: number;
  pollTicket?: (ticketId: string, secret: string) => Promise<Credentials>;
}): Promise<CallbackServer> {
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
  return new Promise<CallbackServer>((resolveReady, rejectReady) => {
    let settle: (c: Credentials) => void = () => {};
    let fail: (err: Error) => void = () => {};
    const result = new Promise<Credentials>((res, rej) => {
      settle = res;
      fail = rej;
    });
    const timer = setTimeout(() => {
      fail(new Error("login timed out (no authorization result within 180 seconds)"));
      server.close();
    }, timeoutMs);
    timer.unref?.();

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!url.pathname.startsWith(REDIRECT_PATH)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      // 旧流程回退：portal 以 secret + redirect 回调。
      const secret = url.searchParams.get("secret");
      if (secret) {
        const redirectTo = url.searchParams.get("redirect") ?? buildPortalLoginResultUrl(true);
        res.writeHead(307, { Location: redirectTo });
        res.end();
        const poll = options.pollTicket ?? pollTicketCredential;
        poll(options.ticketId, secret).then(settle, fail);
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Missing authorization code or secret");
        return;
      }
      const port = (server.address() as { port: number } | null)?.port ?? 0;
      exchangeAuthorizationCode(code, options.pkce.codeVerifier, port, options.keyPair).then(
        (token) => {
          clearTimeout(timer);
          const credential = credentialFromTokenResponse(token, options.pkce, options.keyPair, "codearts-oauth");
          res.writeHead(307, { Location: buildPortalLoginResultUrl(true) });
          res.end();
          settle(credential);
        },
        (err: unknown) => {
          clearTimeout(timer);
          res.writeHead(307, { Location: buildPortalLoginResultUrl(false) });
          res.end();
          fail(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });

    server.on("error", (err) => rejectReady(err));
    listenOnCallbackPort(server).then(
      (port) =>
        resolveReady({
          port,
          close: () =>
            new Promise<void>((done) => {
              clearTimeout(timer);
              server.close(() => done());
              server.closeAllConnections?.();
            }),
          result,
        }),
      (err) => rejectReady(err),
    );
  });
}

export interface LoginOptions {
  onUrl?: (url: string) => void;
  onStatus?: (message: string) => void;
}

/** 完整登录流程：PKCE + DPoP + 本地回调（≥10000）+ 打开浏览器 + 落盘。 */
export async function login(baseUrl?: string, options: LoginOptions = {}): Promise<Credentials> {
  const base = (baseUrl ?? resolveBaseUrl()) || DEFAULT_BASE_URL;
  // 把「配置指向的基址」落盘：billing / models 也读同一份配置（单一直相源）。
  try {
    const [cfg] = upstream.loadConfig();
    if (cfg.baseUrl !== base) await upstream.saveConfig({ baseUrl: base });
  } catch {
    /* 配置写不进去不影响登录本身 */
  }

  const pkce = generatePkcePair();
  const keyPair = generateDpopKeyPair();
  const ticketId = randomBytes(32).toString("hex");
  const callback = await startCallbackServer({ pkce, keyPair, ticketId });
  const url = buildLoginUrl(callback.port, pkce, ticketId);
  // ⚠️ 拿到 URL 后**立刻**回调（界面据此弹窗），不等浏览器启动结果。
  options.onUrl?.(url);
  options.onStatus?.(`authorization page opened, waiting for authorization (up to ${LOGIN_TIMEOUT_MS / 1000}s)...`);
  openBrowser(url);
  try {
    const c = await callback.result;
    await save(c);
    pruneLegacyAccounts();
    options.onStatus?.("authorization succeeded; credentials saved.");
    return c;
  } finally {
    await callback.close();
  }
}

// ── 存量清理：把「按 AK 派生的伪账号」合并掉 ─────────────────────────────────

/**
 * 清掉池内**同一个人的历史伪账号**（渠道自己的修复，不动共享层）。
 *
 * ## 为什么需要
 *
 * 老版本的 `uid` 是 `sha256(access_key_id)[:16]`。华为 STS 每次签发都换 AK，
 * 于是同一个人的每次登录/续期都变成池内一条**新账号** —— 实测一个用户躺了 3 条。
 * 它们共享同一个 refresh token 家族：一个被消费，全体作废，池子的故障转移
 * 于是把一次失败放大成 3 次无效重试（`STS5.1806 the refresh token has been used`）。
 *
 * ## 判定：按 JWT 身份分组，**不看存盘的 uid**
 *
 * 存盘的 `uid` 本身就是坏的那个值（伪账号的定义），拿它分组会把同一个人分成几组。
 * 所以以「各自 refresh token 里解出的 `account_id`」为身份；解不出的（非 JWT /
 * 已被消费成 opaque 串）各自独立成组 —— 宁可不合并，也不误删别人的凭据。
 *
 * ## 保留策略
 *
 * 同一身份只留一份，优先级：**当前生效** → 身份可解 → `last_used_at` 最新。
 * 其余删掉（连带 `accounts/<key>.json`，复用共享层 `removeAccount`）。
 *
 * ⚠ 存盘 uid 不改写：`load()` 已在内存里把它纠正为稳定身份（见 `resolveUid`），
 * 而 `accountKey` 由 `load()` 的结果算出 —— 所以池子的 key 本来就是稳定的，
 * 不会重新膨胀。索引里那个旧 `uid` 只是展示字段，改它反而要动共享层的写索引 API。
 *
 * 幂等；任何异常都吞掉 —— 清理失败不该影响登录/续期主流程。
 */
export function pruneLegacyAccounts(): number {
  try {
    const index = accounts.readIndex();
    // 身份解析一次，后面复用
    const identityOf = new Map<string, string>();
    for (const entry of index.accounts) {
      const raw = accounts.readAccountCredential(entry.key);
      identityOf.set(entry.key, identityFromRefreshToken(str(raw["refresh_token"])));
    }

    // 分组：身份可解的按身份，解不出的各自独立（绝不误合并）
    const groups = new Map<string, string[]>();
    for (const entry of index.accounts) {
      const identity = identityOf.get(entry.key) ?? "";
      const bucket = identity || `__solo__${entry.key}`;
      const list = groups.get(bucket) ?? [];
      list.push(entry.key);
      groups.set(bucket, list);
    }

    let removed = 0;
    for (const keys of groups.values()) {
      if (keys.length < 2) continue; // 一个人只有一份：无事可做
      const ordered = [...keys].sort((a, b) => {
        if (a === index.active) return -1;
        if (b === index.active) return 1;
        const ia = identityOf.get(a) ?? "";
        const ib = identityOf.get(b) ?? "";
        if (Boolean(ia) !== Boolean(ib)) return ia ? -1 : 1;
        const ea = index.accounts.find((x) => x.key === a)?.last_used_at ?? "";
        const eb = index.accounts.find((x) => x.key === b)?.last_used_at ?? "";
        return ea > eb ? -1 : ea < eb ? 1 : 0;
      });
      for (const key of ordered.slice(1)) {
        if (key === index.active) continue; // 正在被 gateway 使用的绝不删
        if (accounts.removeAccount(key).removed) removed += 1;
      }
    }
    return removed;
  } catch {
    return 0; // 清理是尽力而为，绝不影响登录/续期主流程
  }
}

// ── 续期 ─────────────────────────────────────────────────────────────────────

/**
 * 续期串行队列。
 *
 * `refresh_token` 一次性轮换：并发续期里后到的一次会拿一个已被消费的 token
 * （实测 `STS5.1806 the refresh token has been used`），于是把本来健康的账号
 * 判成终态。三条并发入口（网关 401 重试 / billing 401 重试 / 用户手动刷新）
 * 必须排队。
 */
let refreshQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = refreshQueue.then(task, task);
  refreshQueue = run.catch(() => {});
  return run;
}

/** 用存储的 refresh_token 换新凭据（**一次性轮换**，串行执行）。 */
export function refresh(c: Credentials): Promise<Credentials> {
  return serialize(() => refreshInner(c));
}

async function refreshInner(passedIn: Credentials): Promise<Credentials> {
  // 先重读凭据：内存里的那份可能已被其它入口轮换过。
  const current = tryLoad();
  const source = current && current.refreshToken ? current : passedIn;
  const refreshToken = source.refreshToken;
  const codeVerifier = source.codeVerifier;
  const jwk = source.dpopPrivateKeyJwk;
  if (!refreshToken || !codeVerifier || !jwk) {
    throw new Error("credentials lack refresh_token / code_verifier / DPoP private key; cannot refresh silently, please log in again");
  }

  let token: TokenResponse;
  try {
    token = await exchangeRefreshToken(refreshToken, codeVerifier, keyPairFromStoredJwk(jwk));
  } catch (err) {
    if (err instanceof RefreshTokenExpiredError) {
      // ⚠️ 判终态前先重读：若当前磁盘上的 refresh_token 已不是我刚用的那份，
      // 说明另一条入口已经轮换成功，这次失败只是拿了旧 token —— 不算终态。
      const latest = tryLoad();
      if (latest && latest.refreshToken && latest.refreshToken !== refreshToken) {
        token = await exchangeRefreshToken(
          latest.refreshToken,
          latest.codeVerifier || codeVerifier,
          keyPairFromStoredJwk(latest.dpopPrivateKeyJwk ?? jwk),
        );
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }

  const next: Credentials = {
    ...source,
    ...credentialFromTokenResponse(
      token,
      { codeVerifier, codeChallenge: "" },
      keyPairFromStoredJwk(jwk),
      source.source === "codearts-ticket" ? "codearts-refresh" : source.source || "codearts-refresh",
    ),
  };
  // 保留身份字段（STS 响应常常不带 user 信息）。
  //
  // ⚠ `uid` 不能写 `next.uid || source.uid`：`next.uid` 在信封没有 `user_id` 时
  // 会退化成「新 AK 的 sha256」—— 那是个**每次续期都变**的伪身份，会覆盖掉
  // `source.uid` 里那个稳定的 `account_id`，等于每次续期都换一个账号身份。
  // 故续期**只接受来自 refresh token 的稳定身份**，其余一律沿用 source。
  const stableUid = identityFromRefreshToken(next.refreshToken || source.refreshToken);
  const merged: Credentials = {
    ...next,
    uid: str(token.user_id) || stableUid || source.uid || next.uid,
    userId: source.userId,
    userName: source.userName,
    domainId: source.domainId,
    obtainedAt: source.obtainedAt,
    source: source.source || next.source,
  };
  await save(merged);
  return merged;
}

/**
 * 解析登录用 base url。
 *
 * 本渠道**硬编码单区域**（cn-north-4），realm 只作兼容参数：
 * 已知值返回已配置基址（默认 snap-access 网关）；未知 realm 抛错。
 */
export function resolveBaseUrl(realm = "auto"): string {
  const known = new Set(["auto", "", "default", "codearts", "cn", "cn-north-4"]);
  if (!known.has(realm)) throw new Error(`unknown realm: ${realm} (CodeArts only supports cn-north-4)`);
  const [cfg] = upstream.loadConfig();
  return cfg.baseUrl || DEFAULT_BASE_URL;
}

/** 仅供测试：清空续期串行队列。 */
export function resetRefreshQueue(): void {
  refreshQueue = Promise.resolve();
}

/** 生成一个 32 位 hex 的 id（Chat-Id / Session-Id / prompt_cache_key 同款）。 */
export function newHex32(): string {
  return randomBytes(16).toString("hex");
}

/** 生成 uuid4（PKCE 之外的通用标识）。 */
export function newUuid(): string {
  return randomUUID();
}
