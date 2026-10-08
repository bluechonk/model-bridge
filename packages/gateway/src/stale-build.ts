/**
 * 「跑着的网关是不是旧代码」检测。
 *
 * ## 为什么需要它（实测踩过的坑）
 *
 * 改完共享层/渠道代码后 `npm run build` 只更新 `dist/`，**不会**重启已在跑的守护进程。
 * 于是用户（或 agent）继续对着**旧进程**发请求，看到的还是修之前的行为：
 *
 *   - 用户以为是登录/凭证坏了（实际是进程没重启）
 *   - 日志里留着早已修掉的错误（如 `上游返回 HTTP 500`）
 *   - agent 以为自己改的没生效，开始重复排查
 *
 * 实测一次真实事故：网关启动于 21:29:59，修复 21:33 才编译完 —— 那几次请求全打在
 * 旧代码上。**这种「静默陈旧」靠人记是记不住的，必须由工具主动报出来。**
 *
 * ## 判据
 *
 * 比较**构建产物的最新 mtime** 与**守护进程的启动时刻**（pid 文件的 mtime，
 * 因为 pid 文件正是进程启动时写的）：
 *
 *   max(dist/**\/*.js 的 mtime) > pid 文件 mtime  →  进程比代码旧 → 需要 restart
 *
 * 为什么用 pid 文件 mtime 而不是「进程启动时间」：后者要 `wmic`/`ps` 等平台相关调用，
 * 而 pid 文件是 `start` 亲手写的，时刻等价且零依赖。
 *
 * ⚠ 只读、不重启：**报告事实**，把「是否重启」留给用户/调用方决定。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 检测结果。`stale: false` 时其余字段为 null。 */
export interface StaleBuildReport {
  /** 构建产物是否比守护进程新。 */
  stale: boolean;
  /** 最新构建产物的 mtime（毫秒）。 */
  buildMs: number | null;
  /** 守护进程启动时刻（pid 文件 mtime，毫秒）。 */
  pidMs: number | null;
}

const NOT_STALE: StaleBuildReport = { stale: false, buildMs: null, pidMs: null };

/**
 * 从 `start` 向上找**工作区根**：带 `workspaces` 清单的 `package.json`。
 *
 * 早期判据要求 workspaces 里含 `-bridge` 结尾的条目（旧布局 `channels/*-bridge`），
 * 但本仓库早已改成 `packages/*` + `channels/*` —— 判据失配会让查找**永远失败**
 * （`<cid> paths` 因此一直报「未找到工作区根」）。现在只认 `workspaces` 字段本身，
 * 与具体布局解耦。
 *
 * 有 `node_modules` 的祖先目录跳过，避免误认依赖包里的 `package.json`。
 */
export function findWorkspaceRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (dir.split(/[\\/]/).includes("node_modules")) {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        workspaces?: unknown;
      };
      const raw = parsed.workspaces;
      const list: unknown = Array.isArray(raw)
        ? raw
        : raw && typeof raw === "object"
          ? (raw as { packages?: unknown }).packages
          : null;
      if (Array.isArray(list) && list.some((p) => typeof p === "string")) return dir;
    } catch {
      /* 没有 package.json 或不是 JSON：继续往上 */
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 本包在磁盘上的位置（`dist/` 的上一级 = 包根）。 */
function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * 收集「可能被网关加载」的构建产物时间戳。
 *
 * 范围：工作区内每个包/渠道的 `dist/**\/*.js` 的最新 mtime。
 * 找不到工作区根时退化为「只管本包 dist」—— 宁可少报，也不误报。
 */
function newestBuildMs(root: string | null): number | null {
  const dirs: string[] = [];
  if (root) {
    for (const group of ["packages", "channels"]) {
      let names: string[];
      try {
        names = readdirSync(join(root, group));
      } catch {
        continue;
      }
      for (const name of names) dirs.push(join(root, group, name, "dist"));
    }
  } else {
    dirs.push(join(packageRoot(), "dist"));
  }

  let newest: number | null = null;
  const walk = (dir: string, depth = 0): void => {
    if (depth > 2) return;
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      try {
        const ms = statSync(path).mtimeMs;
        if (newest === null || ms > newest) newest = ms;
      } catch {
        /* 读不到就跳过 */
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return newest;
}

/**
 * 判断「正在跑的守护进程」是否在跑旧代码。
 *
 * @param pidPath  守护进程的 pid 文件（它的 mtime = 进程启动时刻）
 * @param start    起点目录（默认为本包位置，用于向上找工作区根）
 */
export function detectStaleBuild(pidPath: string, start?: string): StaleBuildReport {
  let pidMs: number;
  try {
    pidMs = statSync(pidPath).mtimeMs;
  } catch {
    return NOT_STALE; // 没有 pid 文件 = 没有守护进程在跑，无从谈「旧」
  }
  const buildMs = newestBuildMs(findWorkspaceRoot(start ?? packageRoot()));
  if (buildMs === null) return NOT_STALE;
  // 留 1s 容差：start 与 build 可能在同一秒内完成，避免抖动误报
  return { stale: buildMs > pidMs + 1000, buildMs, pidMs };
}

/** 一行人话（供 status 直接打印）。 */
export function staleBuildHint(report: StaleBuildReport): string {
  if (!report.stale) return "";
  const at = (ms: number | null): string =>
    ms === null ? "?" : new Date(ms).toLocaleString("zh-CN", { hour12: false });
  return (
    `⚠ 网关在跑旧代码：构建产物 ${at(report.buildMs)} 比进程启动 ${at(report.pidMs)} 新。` +
    `跑 \`model-bridge restart\` 让修复生效（否则测到的还是旧行为）。`
  );
}
