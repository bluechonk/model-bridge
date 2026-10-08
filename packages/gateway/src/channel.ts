/**
 * 渠道注册表：共享 gateway 层与渠道独有模块（cred / upstream / catalog / billing）之间
 * **唯一的接缝**。
 *
 * ## 为什么不直接 import
 *
 * gateway / daemon / headless / auth-flow 这些模块在所有 `<渠道>-bridge` 里是同一份，
 * 但它们在运行期要调用渠道独有的实现。旧做法是每个项目各存一份共享模块、用相对
 * import 直连渠道模块（副本 + 字符串替换），改一处要重刷 11 份。
 *
 * 现在共享模块只认这里的 `Channel` 接口；每个 bridge 在入口处把自己的 4 个模块
 * 组装成一个 `Channel` 并用 `setChannel()` 注册。共享包不 import 任何渠道模块。
 *
 * 渠道的**落点**（存储根、分层名、目录内文件名）不在这里决定：统一由共享层
 * `paths.ts` 按 `cid` 推导，见 docs/STORAGE-CONVENTION.md。
 *
 * ## 生命周期
 *
 * bridge 的入口（`src/channel.ts`）在模块加载时调用 `setChannel()`；
 * 共享模块在**函数被调用时**（不是模块加载时）通过 `getChannel()` 取用，
 * 所以注册顺序只需早于第一次网络/路径操作即可。
 */

import type { FileMigration } from "./migrate.js";

/** 凭据的最小契约（见 docs/CONTRACT-TS.md §3）。渠道可带更多字段。 */
export interface Credential {
  readonly accessToken: string;
  readonly uid: string;
  readonly domain: string;
}

/** 上游流翻译器：必须增量（见 CONTRACT-TS.md）。 */
export interface StreamTranslator {
  feed(chunk: Buffer): Array<Buffer | string>;
  finish(): Array<Buffer | string>;
}

/** 上游连接配置（渠道自定义字段由各渠道补）。 */
export interface UpstreamConfig {
  baseUrl: string;
  [key: string]: unknown;
}

export interface CreditPackage {
  name: string;
  remain: number;
  size: number;
  used?: number;
  unit?: string;
  days_left?: number | null;
  [key: string]: unknown;
}

export interface CreditsResult {
  ok: true;
  total: {
    remain: number;
    size: number;
    used: number;
    unit: string;
    remain_percent: number;
  };
  packages: CreditPackage[];
  claimable?: Array<Record<string, unknown>>;
}

/** 登录流程的界面能力（打到 stdout / 窗口状态机都可以满足）。 */
export interface LoginUi {
  setState(state: string, message?: string, url?: string): void;
}

/*
 * 下面四个接口描述「渠道模块必须提供哪些成员」。凭据/配置形态各渠道不同，
 * 故这些位置用 `any`：共享层只在**结构**上依赖它们（调用点已由 CONTRACT-TS.md
 * 固定），不做跨渠道的类型统一 —— 那会在 11 个异构渠道间制造大量摩擦。
 */

/** 渠道 `cred.ts` 需要提供的接口。 */
export interface CredModule {
  DEFAULT_BASE_URL: string;
  NotLoggedInError: new (message?: string) => Error;
  load(): any;
  save(c: any): Promise<void>;
  login(
    baseUrl: string,
    options?: { onUrl?: (url: string) => void; onStatus?: (msg: string) => void },
  ): Promise<any>;
  refresh(c: any): Promise<any>;
  resolveBaseUrl(realm?: string): string;
}

/** 渠道 `upstream.ts` 需要提供的接口。 */
export interface UpstreamModule {
  DEFAULT_BASE_URL: string;
  /** `openai`（标准 SSE delta）或 `custom`（需翻译层）。 */
  WIRE: "openai" | "custom";
  /** 展示名（状态页与日志用）。 */
  DISPLAY_NAME: string;
  UpstreamUnauthorized: new (message?: string) => Error;
  defaultConfig(): any;
  loadConfig(): [any, boolean];
  saveConfig(cfg: any): Promise<void>;
  chatUrl(cfg?: any): string;
  modelsUrl(cfg?: any): string;
  buildHeaders(credential: any, cfg?: any): Record<string, string>;
  buildChatBody(
    req: Record<string, unknown>,
    upstreamModel: string,
  ): Record<string, unknown>;
  fetchModels(credential: any): Promise<Record<string, unknown>>;
  resolveConfig(data: Record<string, unknown>, fallback?: any): any;
  /** 仅 `WIRE === "custom"` 时需要。 */
  newTranslator(): StreamTranslator;
}

/** 渠道 `catalog.ts` 需要提供的接口。 */
export interface CatalogModule {
  exposedIds(): string[];
  resolveModel(name: string): string;
}

/** 渠道 `billing.ts` 需要提供的接口。 */
export interface BillingModule {
  CreditsError: new (message?: string) => Error;
  fetchCredits(options?: { refreshOn401?: boolean }): Promise<any>;
}

/**
 * 渠道的静态配置：旧实现里靠字符串替换注入到共享模块的那批常量，
 * 现在集中在一个对象里。
 */
export interface BridgeConfig {
  /** 渠道 id，如 `zcode`。用于日志前缀、服务名、CLI 名，以及统一存储根下的**分层名**。 */
  readonly cid: string;
  /** 展示名，如 `ZCode`。 */
  readonly display: string;
  /** CLI 版本号。 */
  readonly version: string;
  /**
   * **单渠道独立运行**时的网关默认监听地址，如 `127.0.0.1:8803`。
   *
   * ⚠ 仓库级（多渠道路由）网关注册多个渠道，**不看这个字段** —— 它固定用
   * `REPO_DEFAULT_ADDR`（`127.0.0.1:8787`），所有渠道从同一个端口按 `<cid>/<模型>` 路由。
   * 本字段只在 `channels/<cid>/dist/cli.js start|serve` 这类单渠道入口里生效。
   */
  readonly defaultAddr: string;
  /** 单渠道独立运行时的控制台 API 默认端口（仓库级固定用 `REPO_DEFAULT_UI_PORT`）。 */
  readonly uiPort: number;
  /**
   * 历史顶层目录名（新→旧），首次访问时收拢进 `<root>/<cid>/`。
   *
   * 首项通常是刚被取代的 `.<cid>-bridge`。**只填本渠道的历史名** ——
   * 混入其它渠道的名字会导致跨渠道数据劫持（见 STORAGE-CONVENTION.md §3.1）。
   */
  readonly legacyDirs?: readonly string[];
  /**
   * 存储根覆盖变量的历史名（新→旧）。现在只认共享的 `MODEL_BRIDGE_HOME`，
   * 这些名字仍被兼容读取（按存储根处理并打一次弃用提示）。
   */
  readonly legacyEnvVars?: readonly string[];
  /** 抓包落盘目录的环境变量名，如 `ZCODE_DEBUG_DUMP`（值 `1` 表示用渠道内 `debug/`）。 */
  readonly debugDumpEnv: string;
  /** 抓包落盘变量的历史名（新→旧）。 */
  readonly legacyDebugDumpEnv?: readonly string[];
  /** 渠道层内的历史文件名收敛规则（幂等，见 migrate.ts）。 */
  readonly fileMigrations?: readonly FileMigration[];
}

/** 一个渠道的完整装配：配置 + 四个渠道独有模块。 */
export interface Channel {
  readonly config: BridgeConfig;
  readonly cred: CredModule;
  readonly upstream: UpstreamModule;
  readonly catalog: CatalogModule;
  readonly billing: BillingModule;
}

const registry = new Map<string, Channel>();

/** 注册（或替换）一个渠道。bridge 入口加载时调用；同 cid 重复注册即替换。 */
export function setChannel(channel: Channel): void {
  registry.set(channel.config.cid, channel);
}

/** 全部已注册渠道（按注册顺序）。 */
export function channels(): Channel[] {
  return [...registry.values()];
}

/** 按 cid 取渠道；未注册抛错。 */
export function channelFor(cid: string): Channel {
  const found = registry.get(cid);
  if (!found) {
    const known = [...registry.keys()].join(", ") || "(没有渠道被注册)";
    throw new Error(`channel not registered: ${cid}（已注册: ${known}）`);
  }
  return found;
}

/**
 * 取渠道。
 *
 * - 传 `cid`：取该渠道（未注册抛错）。
 * - 不传：**仅在恰好注册了一个渠道时**返回它（单渠道模式，各 bridge 的 CLI 就是这样）。
 *   注册了多个渠道时必须显式传 `cid` —— 否则无法判断请求该发给谁。
 */
export function getChannel(cid?: string): Channel {
  if (cid !== undefined) return channelFor(cid);
  if (registry.size === 0) {
    throw new Error(
      "channel not registered: import the bridge's channel.ts (setChannel) before using the gateway runtime",
    );
  }
  if (registry.size > 1) {
    throw new Error(
      `多渠道路由下必须显式指定 cid（已注册: ${[...registry.keys()].join(", ")}）——` +
        `HTTP 请求请用 "<cid>/<模型>" 形式的模型 id`,
    );
  }
  return registry.values().next().value as Channel;
}

/** 是否已注册（供测试/工具探测，不抛错）。传 cid 则判断该渠道是否已注册。 */
export function hasChannel(cid?: string): boolean {
  return cid === undefined ? registry.size > 0 : registry.has(cid);
}

/** 清空注册表（**仅供测试**：一个进程内反复注册不同渠道时用）。 */
export function clearChannels(): void {
  registry.clear();
}

/** 已注册渠道数（1 = 单渠道模式）。 */
export function channelCount(): number {
  return registry.size;
}
