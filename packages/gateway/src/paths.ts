/**
 * 路径解析：**工作区统一存储根 + 按 cid 分层**。
 *
 * 布局（见 docs/STORAGE-CONVENTION.md §1/§4）：
 *
 *   ~/.model-bridge/             ← 唯一存储根（`MODEL_BRIDGE_HOME` 可覆盖）
 *       prefs.json               （可选）跨渠道共享偏好
 *       <cid>/                   ← 渠道层，cid 取自 BridgeConfig
 *           credentials.json     登录凭证
 *           upstream.json        上游端点与鉴权头名称
 *           prefs.json           渠道内偏好（auto_start 等）
 *           gateway.pid          守护式网关 PID
 *           gateway.log          守护进程 stdout/stderr
 *           cache/  state/  debug/
 *
 * 根目录名与分层规则是共享常量，渠道**不得**自行决定（也不得自行拼绝对路径）——
 * 渠道只能给 `cid` 与历史名清单。首次访问某个根时把历史顶层目录（`legacyDirs`）
 * 收拢进 `<root>/<cid>/`，并收敛渠道层内的历史文件名（`fileMigrations`）。
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { channels, channelCount, channelFor, getChannel, type BridgeConfig } from "./channel.js";
import { activeCid } from "./channel-context.js";
import { collectLegacyDirs, enforcePermissions, migrateChannelFiles } from "./migrate.js";

/** 存储根目录名（用户主目录下）。 */
export const ROOT_DIR_NAME = ".model-bridge";

/** 覆盖存储根的环境变量名（**唯一**；旧的分渠道 `<CID>_HOME` 见 legacyEnvVars）。 */
export const ROOT_ENV = "MODEL_BRIDGE_HOME";

/** 渠道层内的固定文件名（唯一定义处）。 */
export const FILES = {
  credentials: "credentials.json",
  upstream: "upstream.json",
  prefs: "prefs.json",
  pid: "gateway.pid",
  log: "gateway.log",
} as const;

/** 渠道层内的固定子目录。 */
export const SUBDIRS = {
  cache: "cache",
  state: "state",
  debug: "debug",
} as const;

const warned = new Set<string>();

/** 同一进程内同一提示只打一次，避免每次取路径都刷屏。 */
export function noteOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.error(`[model-bridge] ${message}`);
}

/** 解析存储根，并记下它是否由环境变量**显式**指定。 */
function resolveRoot(config?: BridgeConfig): { root: string; fromEnv: boolean } {
  const explicit = process.env[ROOT_ENV];
  if (explicit) return { root: explicit, fromEnv: true };
  // config 省略 = 仓库级（多渠道路由）：根是**共享的**，不需要单个渠道的配置，
  // 历史环境变量按注册顺序逐个检查（任一渠道的历史变量仍按存储根处理）。
  const names = config
    ? (config.legacyEnvVars ?? [])
    : channels().flatMap((c) => c.config.legacyEnvVars ?? []);
  for (const name of names) {
    const value = process.env[name];
    if (!value) continue;
    noteOnce(`env:${name}`, `${name} 已弃用：现在只认 MODEL_BRIDGE_HOME（该变量仍按存储根处理）`);
    return { root: value, fromEnv: true };
  }
  return { root: join(homedir(), ROOT_DIR_NAME), fromEnv: false };
}

/**
 * 存储根（纯函数，**不触发迁移**，供巡检/统计用）。
 *
 * 优先级：`MODEL_BRIDGE_HOME` > 渠道的历史变量（兼容读取，打一次弃用提示）> `~/.model-bridge`。
 */
export function rootDirFor(config: BridgeConfig): string {
  return resolveRoot(config).root;
}

/**
 * 搜索历史顶层目录的父目录清单。
 *
 * ⚠ 只有根**不是**由环境变量显式指定时，才把用户主目录算进来。否则
 * （测试 / 便携模式把根指到别处）迁移会去动真实主目录里的旧目录 ——
 * 那既是意外的读盘，也可能把用户的数据搬进一个临时根。
 */
export function legacySearchParents(config: BridgeConfig): string[] {
  const { root, fromEnv } = resolveRoot(config);
  if (fromEnv || root === homedir()) return [root];
  return [root, homedir()];
}

/** 渠道层目录（纯函数，**不触发迁移**，供巡检/统计用）。 */
export function channelDirFor(config: BridgeConfig): string {
  return join(rootDirFor(config), config.cid);
}

/** 取渠道配置：显式 `cid` > 渠道上下文（`runInChannel`）> 单渠道模式。 */
function configOf(cid?: string): BridgeConfig {
  const resolved = cid ?? activeCid();
  if (resolved !== undefined) return channelFor(resolved).config;
  return getChannel().config;
}

/** 存储根（不触发迁移）。 */
export function rootDir(cid?: string): string {
  if (cid !== undefined) return rootDirFor(channelFor(cid).config);
  // 仓库级：根与任何单个渠道无关，直接解析（不能要求"唯一渠道"，多渠道路由下没有）
  if (channelCount() === 1) return rootDirFor(getChannel().config);
  return resolveRoot().root;
}

/** 每个 (根, cid) 只做一次收拢：缓存键 → 实际渠道目录（收拢失败时可能仍指向旧目录）。 */
const resolvedDirs = new Map<string, string>();

/**
 * 渠道层目录 `<root>/<cid>/`（首次调用时收拢历史顶层目录）。
 *
 * 收拢失败（例如旧目录里还有进程占用的文件）时返回**旧目录**，宁可暂时不在
 * 统一根下，也不让渠道读不到既有凭证。
 */
export function channelDir(cid?: string): string {
  const config = configOf(cid);
  const { root } = resolveRoot(config);
  const cacheKey = `${root}\u0000${config.cid}`;
  const cached = resolvedDirs.get(cacheKey);
  if (cached) return cached;

  const target = join(root, config.cid);
  const fileMigrations = config.fileMigrations ?? [];
  const resolved = collectLegacyDirs({
    root,
    parents: legacySearchParents(config),
    cid: config.cid,
    target,
    legacyDirs: config.legacyDirs ?? [],
    skipMerge: fileMigrations.filter((m) => m.action === "delete").map((m) => m.from),
    log: (message) => noteOnce(`migrate:${message}`, message),
  });
  resolvedDirs.set(cacheKey, resolved);

  if (resolved === target) {
    migrateChannelFiles(target, fileMigrations, (message) =>
      noteOnce(`migrate:${message}`, message),
    );
  }
  return resolved;
}

/** 渠道层目录，缺失时创建（并设权限基线）。 */
export function ensureDir(cid?: string): string {
  const config = configOf(cid);
  const dir = channelDir(cid);
  mkdirSync(dir, { recursive: true });
  enforcePermissions(rootDirFor(config), dir);
  return dir;
}

/**
 * 渠道层内的文件路径。
 *
 * 文件名受校验：全小写、`-`/`.` 分隔（见 STORAGE-CONVENTION.md §4.7），
 * 渠道不得绕过这里自行拼路径。
 */
export function channelFile(name: string, cid?: string): string {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) {
    throw new Error(
      `非法文件名: ${name}（须全小写、仅 a-z0-9.-，见 docs/STORAGE-CONVENTION.md §4.7）`,
    );
  }
  return join(channelDir(cid), name);
}

/** 固定子目录路径（不创建）。 */
export function cacheDir(cid?: string): string {
  return join(channelDir(cid), SUBDIRS.cache);
}
export function stateDir(cid?: string): string {
  return join(channelDir(cid), SUBDIRS.state);
}
export function debugDir(cid?: string): string {
  return join(channelDir(cid), SUBDIRS.debug);
}

/** 固定子目录，缺失时创建。 */
export function ensureCacheDir(cid?: string): string {
  const dir = cacheDir(cid);
  mkdirSync(dir, { recursive: true });
  return dir;
}
export function ensureStateDir(cid?: string): string {
  const dir = stateDir(cid);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 守护式网关的 PID 文件路径。 */
export function pidPath(cid?: string): string {
  return channelFile(FILES.pid, cid);
}

/** 守护式网关的日志路径。 */
export function logPath(cid?: string): string {
  return channelFile(FILES.log, cid);
}

/** 凭证文件路径。 */
export function credentialsPath(cid?: string): string {
  return channelFile(FILES.credentials, cid);
}

/** 上游配置文件路径。 */
export function upstreamPath(cid?: string): string {
  return channelFile(FILES.upstream, cid);
}

/** 渠道内偏好文件路径。 */
export function prefsPath(cid?: string): string {
  return channelFile(FILES.prefs, cid);
}

/** （可选）根级共享偏好路径。 */
export function rootPrefsPath(cid?: string): string {
  return join(rootDir(cid), FILES.prefs);
}

/**
 * 根级运行时文件的路径（**仓库级网关**用）。
 *
 * 一个网关进程服务多个渠道时，它的 PID/日志不属于任何单个渠道，故落在根上：
 * `<root>/gateway.pid`、`<root>/gateway.log`。
 */
export function rootFile(name: string): string {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) {
    throw new Error(`非法文件名: ${name}（见 docs/STORAGE-CONVENTION.md §4.7）`);
  }
  return join(rootDir(), name);
}

/** 仓库级网关的 PID 文件路径。 */
export function rootPidPath(): string {
  return rootFile(FILES.pid);
}

/** 仓库级网关的日志路径。 */
export function rootLogPath(): string {
  return rootFile(FILES.log);
}
