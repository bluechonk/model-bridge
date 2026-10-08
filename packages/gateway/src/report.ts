/**
 * 落点巡检与统计：`<cid> paths [--all] [--json]`。
 *
 * 这是「存储位置 + 文件命名」规范的统计出口（见 docs/STORAGE-CONVENTION.md §5.4）：
 * 一条命令列出存储根、cid 分层、渠道层内的固定文件与子目录、权限位，以及
 * **还没收拢的历史目录 / 还没收敛的历史文件名**。
 *
 * ⚠ 全程**只读**：不创建目录、不迁移文件 —— 巡检不能有副作用。
 *    故这里用 `paths` 的纯函数（`*For`）而不是会触发收拢的 `channelDir()`。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { channelCount, channelFor, getChannel, type BridgeConfig } from "./channel.js";
import { FILES, SUBDIRS, channelDirFor, legacySearchParents, rootDirFor } from "./paths.js";
import { findWorkspaceRoot } from "./stale-build.js";

export interface EntryReport {
  name: string;
  path: string;
  exists: boolean;
  bytes?: number;
  mode?: string;
}

export interface ChannelReport {
  cid: string;
  display: string;
  version: string;
  root: string;
  dir: string;
  dirExists: boolean;
  files: EntryReport[];
  subdirs: EntryReport[];
  /** 还没收拢的历史顶层目录（绝对路径）。 */
  legacyPending: string[];
  /** 渠道层里还存在的历史文件名（fileMigrations 的 from）。 */
  staleFiles: string[];
}

function describe(base: string, name: string): EntryReport {
  const path = join(base, name);
  const entry: EntryReport = { name, path, exists: existsSync(path) };
  if (entry.exists) {
    try {
      const st = statSync(path);
      entry.bytes = st.size;
      entry.mode = (st.mode & 0o777).toString(8);
    } catch {
      /* ignore */
    }
  }
  return entry;
}

/** 逐渠道落点报告（只读）。 */
export function inspect(config: BridgeConfig): ChannelReport {
  const root = rootDirFor(config);
  const dir = channelDirFor(config);
  const dirExists = existsSync(dir);

  const legacyPending: string[] = [];
  for (const parent of legacySearchParents(config)) {
    for (const name of config.legacyDirs ?? []) {
      const path = join(parent, name);
      if (existsSync(path) && path !== dir) legacyPending.push(path);
    }
  }

  const staleFiles: string[] = [];
  if (dirExists) {
    for (const rule of config.fileMigrations ?? []) {
      if (existsSync(join(dir, rule.from))) staleFiles.push(rule.from);
    }
  }

  return {
    cid: config.cid,
    display: config.display,
    version: config.version,
    root,
    dir,
    dirExists,
    files: Object.values(FILES).map((name) => describe(dir, name)),
    subdirs: Object.values(SUBDIRS).map((name) => describe(dir, name)),
    legacyPending,
    staleFiles,
  };
}

/** 展开 workspaces（支持字面目录与一层 `dir/*` 通配）。 */
export function expandWorkspaces(root: string, start: string): string[] {
  let patterns: string[];
  try {
    const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      workspaces?: unknown;
    };
    const raw = parsed.workspaces;
    const list = Array.isArray(raw) ? raw : (raw as { packages?: unknown } | null)?.packages;
    patterns = Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith("-bridge") && !pattern.includes("*")) continue; // 只关心渠道包
    if (pattern.includes("*")) {
      const base = join(root, dirname(pattern));
      if (!existsSync(base)) continue;
      for (const name of readdirSync(base)) {
        const dir = join(base, name);
        if (name.endsWith("-bridge") && existsSync(join(dir, "package.json"))) out.push(dir);
      }
    } else {
      const dir = join(root, pattern);
      if (existsSync(join(dir, "package.json"))) out.push(dir);
    }
  }
  void start;
  return out;
}

/** 载入渠道包的 config（优先已构建的 dist，其次源码 TS）。 */
async function loadConfig(pkgDir: string): Promise<BridgeConfig | null> {
  for (const rel of ["dist/channel.js", "src/channel.ts"]) {
    const file = join(pkgDir, rel);
    if (!existsSync(file)) continue;
    try {
      const mod = (await import(pathToFileURL(file).href)) as { config?: BridgeConfig };
      if (mod.config) return mod.config;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

function formatEntry(e: EntryReport): string {
  return e.exists ? `✓ ${e.name} (${e.bytes}B${e.mode ? ` ${e.mode}` : ""})` : `· ${e.name}`;
}

/** 人读渲染。 */
export function renderReport(report: ChannelReport): string {
  const lines: string[] = [
    `${report.cid} (${report.display} v${report.version})`,
    `  存储根   ${report.root}`,
    `  渠道层   ${report.dir}${report.dirExists ? "" : "  （尚未创建：还没登录/启动过）"}`,
    `  文件     ${report.files.map(formatEntry).join("  ")}`,
    `  子目录   ${report.subdirs.map(formatEntry).join("  ")}`,
  ];
  if (report.legacyPending.length > 0) {
    lines.push(`  ⚠ 待收拢 ${report.legacyPending.join(", ")}`);
  }
  if (report.staleFiles.length > 0) {
    lines.push(`  ⚠ 待收敛的历史文件名 ${report.staleFiles.join(", ")}`);
  }
  return lines.join("\n");
}

export interface PathsOptions {
  readonly json?: boolean;
  readonly all?: boolean;
  readonly workspace?: string;
  /** 只报告该渠道（多渠道路由下省略 = 报告全部）。 */
  readonly cid?: string;
}

/** `paths` 子命令实现。返回进程退出码。 */
export async function runPaths(options: PathsOptions = {}): Promise<number> {
  const { json = false, workspace, cid } = options;
  // 多渠道路由且未指定渠道 → 默认就是「统计全部」
  const all = options.all === true || (cid === undefined && channelCount() > 1);

  if (!all) {
    const config = cid !== undefined ? channelFor(cid).config : getChannel().config;
    const report = inspect(config);
    console.log(json ? JSON.stringify(report, null, 2) : renderReport(report));
    return 0;
  }

  const root = findWorkspaceRoot(workspace ?? process.cwd());
  if (!root) {
    console.error(
      "未找到工作区根（需要一个带 workspaces 清单的 package.json）；用 --workspace <目录> 指定",
    );
    return 2;
  }

  const reports: ChannelReport[] = [];
  for (const pkgDir of expandWorkspaces(root, workspace ?? process.cwd())) {
    const config = await loadConfig(pkgDir);
    if (!config) {
      console.error(`[warn] 跳过未构建的渠道包: ${pkgDir}`);
      continue;
    }
    reports.push(inspect(config));
  }

  if (json) console.log(JSON.stringify({ workspace: root, channels: reports }, null, 2));
  else console.log(reports.map(renderReport).join("\n\n"));
  return 0;
}
