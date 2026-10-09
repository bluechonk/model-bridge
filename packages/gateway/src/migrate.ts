/**
 * 存储迁移：把历史顶层目录收拢进统一存储根，收敛渠道层内的历史文件名，
 * 并维护权限基线。
 *
 * 设计约束（见 docs/STORAGE-CONVENTION.md §6）：
 *
 * - **只搬移/补齐，绝不删除用户数据**。唯一会删的是「文件级迁移表里显式标注
 *   `action: "delete"` 且**已经空了**的目录/文件」；非空一律保留并记日志。
 * - **幂等**：可重复执行，第二次是空操作。
 * - **失败要退化，不要报错**：旧目录被运行中的进程占着（Windows 下常见）时，
 *   收拢会失败，此时返回旧目录让渠道继续用，而不是抛错或把凭证当不存在。
 * - 本模块只依赖 node:fs / node:path，**不 import paths.ts**（避免循环依赖）。
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/** 渠道层内的历史文件名收敛规则。 */
export interface FileMigration {
  /** 旧文件名（相对渠道层）。 */
  readonly from: string;
  /** 新文件名；与 `action` 二选一。 */
  readonly to?: string;
  /** `delete`：删除该条目（仅当为空时真正删除）。 */
  readonly action?: "delete";
}

export interface CollectOptions {
  /** 统一存储根（`~/.model-bridge` 或 `MODEL_BRIDGE_HOME`）。 */
  readonly root: string;
  /**
   * 搜索历史顶层目录的父目录清单（见 `paths.legacySearchParents`）。
   * 顺序即优先级；**不应**无条件包含用户主目录 —— 那会动到真实数据。
   */
  readonly parents: readonly string[];
  readonly cid: string;
  /** `<root>/<cid>`。 */
  readonly target: string;
  /** 历史顶层目录名（新→旧）。 */
  readonly legacyDirs: readonly string[];
  /**
   * 收拢时**不**要搬过来的条目名（渠道层内已知的废弃物，如 GUI 时代的 `webview/`）。
   * 通常来自 `fileMigrations` 里 `action: "delete"` 的条目 —— 没有理由把垃圾复制一份。
   */
  readonly skipMerge?: readonly string[];
  readonly log?: (message: string) => void;
}

/** 目录是否为空（不存在按空处理）。 */
function isEmptyDir(path: string): boolean {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

/** 把 `source` 里 target 缺失的文件补进 `target`（递归，不覆盖已有文件）。 */
function mergeMissing(
  source: string,
  target: string,
  log: (m: string) => void,
  skip: readonly string[],
  root = true,
): void {
  let entries: string[];
  try {
    entries = readdirSync(source);
  } catch {
    return;
  }
  mkdirSync(target, { recursive: true });
  for (const name of entries) {
    if (root && skip.includes(name)) {
      log(`skipping ${name} (known junk inside the channel dir)`);
      continue;
    }
    const from = join(source, name);
    const to = join(target, name);
    let isDir = false;
    try {
      isDir = statSync(from).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      mergeMissing(from, to, log, skip, false);
      continue;
    }
    if (existsSync(to)) continue; // 目标已有 → 目标为准，不覆盖
    try {
      copyFileSync(from, to);
      try {
        chmodSync(to, statSync(from).mode & 0o777);
      } catch {
        /* Windows 上 chmod 意义有限 */
      }
      log(`filled in ${to}`);
    } catch (err) {
      log(`fill-in failed (kept original): ${from} -> ${to} (${String(err)})`);
    }
  }
}

/**
 * 收拢历史顶层目录。
 *
 * 只收拢**第一个存在**的历史目录（新→旧里的第一个）—— 更旧的是陈旧副本，
 * 搬进来反而可能用旧凭证覆盖新登录态。
 *
 * @returns 实际可用的渠道目录；收拢失败时是旧目录本身。
 */
export function collectLegacyDirs(options: CollectOptions): string {
  const { root, parents, target, legacyDirs, skipMerge = [], log = () => {} } = options;

  for (const parent of parents) {
    for (const name of legacyDirs) {
      const source = join(parent, name);
      if (!existsSync(source)) continue;

      // 已经是目标目录本身（例如 root=<CID>_HOME 且历史名与 cid 层同名）→ 什么都不做
      if (source === target) return target;

      if (!existsSync(target)) {
        try {
          mkdirSync(root, { recursive: true });
          renameSync(source, target);
          log(`collected legacy dir: ${source} -> ${target}`);
          return target;
        } catch (err) {
          log(`whole-dir move failed, merging file by file: ${source} (${String(err)})`);
          mergeMissing(source, target, log, skipMerge);
          if (!isEmptyDir(source)) {
            log(`legacy dir still has content (maybe in use), left in place: ${source}`);
            return target; // 目标已补出一份可用的
          }
          rmdirSync(source);
          return target;
        }
      }

      // 新旧并存：补齐缺失文件，不覆盖
      mergeMissing(source, target, log, skipMerge);
      if (isEmptyDir(source)) {
        try {
          rmdirSync(source);
          log(`removed empty legacy dir: ${source}`);
        } catch {
          /* 留着也无害 */
        }
      } else {
        log(`both old and new dirs exist; filled in missing files, kept legacy: ${source}`);
      }
      return target;
    }
  }
  return target;
}

/** 收敛渠道层内的历史文件名（幂等）。 */
export function migrateChannelFiles(
  dir: string,
  migrations: readonly FileMigration[],
  log: (m: string) => void = () => {},
): void {
  if (!existsSync(dir)) return;
  for (const rule of migrations) {
    const from = join(dir, rule.from);
    if (!existsSync(from)) continue;

    if (rule.action === "delete") {
      let isDir = false;
      try {
        isDir = statSync(from).isDirectory();
      } catch {
        continue;
      }
      if (isDir && !isEmptyDir(from)) {
        log(`skipping delete of ${from}: dir not empty, needs manual review`);
        continue;
      }
      try {
        rmSync(from, { recursive: true, force: true });
        log(`removed legacy artifact: ${from}`);
      } catch (err) {
        log(`cleanup failed: ${from} (${String(err)})`);
      }
      continue;
    }

    if (!rule.to) continue;
    const to = join(dir, rule.to);
    if (existsSync(to)) continue; // 新名已存在 → 不覆盖
    try {
      renameSync(from, to);
      log(`renamed: ${from} -> ${to}`);
    } catch (err) {
      log(`rename failed: ${from} -> ${to} (${String(err)})`);
    }
  }
}

/** 权限基线：根与渠道层 0700，层内文件 0600（Windows 上 chmod 意义有限，忽略失败）。 */
export function enforcePermissions(root: string, dir: string): void {
  try {
    chmodSync(root, 0o700);
  } catch {
    /* ignore */
  }
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* ignore */
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(dir, name);
    try {
      if (statSync(path).isDirectory()) chmodSync(path, 0o700);
      else chmodSync(path, 0o600);
    } catch {
      /* ignore */
    }
  }
  // 再往下一层：`accounts/`（账号池）、`cache/` 等子目录里的文件同样该是 0600
  for (const name of entries) {
    const sub = join(dir, name);
    let subEntries: string[];
    try {
      if (!statSync(sub).isDirectory()) continue;
      subEntries = readdirSync(sub);
    } catch {
      continue;
    }
    for (const inner of subEntries) {
      try {
        const path = join(sub, inner);
        if (statSync(path).isDirectory()) chmodSync(path, 0o700);
        else chmodSync(path, 0o600);
      } catch {
        /* ignore */
      }
    }
  }
}
