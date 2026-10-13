/**
 * 路径解析：**工作区统一存储根 + 按 cid 分层**。
 *
 * 布局（见 docs/STORAGE-CONVENTION.md §1/§4）：
 *
 *   ~/.modelmux/                 ← 唯一存储根（`MODELMUX_HOME` 可覆盖）
 *       prefs.json               （可选）跨渠道共享偏好
 *       <cid>/                   ← 渠道层，cid 取自 ChannelConfig
 *           credentials.json     登录凭证
 *           upstream.json        上游端点与鉴权头名称
 *           prefs.json           渠道内偏好（auto_start 等）
 *           gateway.pid          守护式网关 PID
 *           gateway.log          守护进程 stdout/stderr
 *           cache/  state/  debug/
 *
 * 根目录名与分层规则是共享常量，渠道**不得**自行决定（也不得自行拼绝对路径）——
 * 渠道只能给 `cid`。历史布局兼容（legacyDirs / fileMigrations / 旧环境变量）已随
 * modelmux 更名整体移除：只认 `<root>/<cid>/` 这一种布局。
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { channelFor, getChannel, type ChannelConfig } from "./channel.js";
import { activeCid } from "./channel-context.js";
import { enforcePermissions } from "./permissions.js";

/** 存储根目录名（用户主目录下）。 */
export const ROOT_DIR_NAME = ".modelmux";

/** 覆盖存储根的环境变量名（唯一）。 */
export const ROOT_ENV = "MODELMUX_HOME";

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
  console.error(`[modelmux] ${message}`);
}

/** 解析存储根：`MODELMUX_HOME` > `~/.modelmux`。 */
function resolveRoot(): string {
  return process.env[ROOT_ENV] || join(homedir(), ROOT_DIR_NAME);
}

/** 存储根（纯函数）。 */
export function rootDirFor(_config: ChannelConfig): string {
  return resolveRoot();
}

/** 渠道层目录（纯函数，**不触发迁移**，供巡检/统计用）。 */
export function channelDirFor(config: ChannelConfig): string {
  return join(rootDirFor(config), config.cid);
}

/** 取渠道配置：显式 `cid` > 渠道上下文（`runInChannel`）> 单渠道模式。 */
function configOf(cid?: string): ChannelConfig {
  const resolved = cid ?? activeCid();
  if (resolved !== undefined) return channelFor(resolved).config;
  return getChannel().config;
}

/** 存储根。 */
export function rootDir(cid?: string): string {
  void cid; // 根是共享的，与单渠道无关；参数保留供调用方统一形状
  return resolveRoot();
}

/** 渠道层目录 `<root>/<cid>/`（唯一布局，无迁移）。 */
export function channelDir(cid?: string): string {
  const config = configOf(cid);
  return join(resolveRoot(), config.cid);
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
      `invalid file name: ${name} (must be lowercase a-z0-9.- only; see docs/STORAGE-CONVENTION.md §4.7)`,
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
    throw new Error(`invalid file name: ${name} (see docs/STORAGE-CONVENTION.md §4.7)`);
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

/**
 * 公共模型池的渠道账本路径（`<root>/pool-usage.json`）。
 *
 * 它记录**所有渠道**的账单已用量与请求成败，不属于任何单个渠道，故落在根级 ——
 * 与 `<cid>/` 分层并列（见 docs/STORAGE-CONVENTION.md §4）。
 */
export function poolUsagePath(): string {
  return rootFile("pool-usage.json");
}
