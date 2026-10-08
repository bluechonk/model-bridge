#!/usr/bin/env node
/**
 * 存储落点规范的校验器（见 docs/STORAGE-CONVENTION.md §5.3）。
 *
 * 加载工作区内全部渠道包的 `config`，逐条断言「位置 + 命名」规范：
 * 单根分层、cid 命名、调试变量命名、迁移链不跨渠道、端口唯一。
 *
 * 这是把「统一统计」固化成回归测试的那一步 —— 任何渠道的落点跑偏都会在这里失败。
 *
 * 用法：node tools/verify-storage.mjs
 * 前置：先 `npm run build --workspaces`（本脚本读各包的 dist/channel.js）。
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// ── 安全网：把存储根指向临时目录 ──────────────────────────────────────────────
// 本脚本只读 config，但渠道模块的 import 可能触碰路径层；显式隔离，绝不碰真实数据。
process.env["MODEL_BRIDGE_HOME"] = mkdtempSync(join(tmpdir(), "model-bridge-verify-"));

const workspaceRoot = dirname(import.meta.dirname);
const FILENAME_RE = /^[a-z0-9][a-z0-9.-]*$/;

/** 读取工作区的 workspaces 清单（支持字面目录与一层 `dir/*`）。 */
function packageDirs() {
  const pkg = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8"));
  const raw = pkg.workspaces;
  const patterns = Array.isArray(raw) ? raw : (raw?.packages ?? []);
  const out = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string") continue;
    const candidates = [];
    if (pattern.includes("*")) {
      // 目录名不做要求：是不是渠道包由「包名不在 @model-bridge/ 作用域 + 有 src/channel.ts」判定
      const base = join(workspaceRoot, dirname(pattern));
      if (!existsSync(base)) continue;
      for (const name of readdirSync(base)) candidates.push(join(base, name));
    } else {
      candidates.push(join(workspaceRoot, pattern));
    }
    for (const dir of candidates) {
      // 本仓库自己的基础设施包（@model-bridge/gateway、@model-bridge/cli）不是渠道包 ——
      // 注意 packages/gateway/src/channel.ts 是共享层的**注册表模块**，不能按文件名判据放行。
      try {
        const name = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name;
        if (typeof name === "string" && name.startsWith("@")) continue;
      } catch {
        continue;
      }
      out.push(dir);
    }
  }
  return out;
}

const failures = [];
const notes = [];

function check(ok, message) {
  if (!ok) failures.push(message);
}

const bridges = [];
for (const dir of packageDirs()) {
  // 「渠道包」的判据是**有 src/channel.ts**（注册表入口）。仓库级包（如 packages/gateway、
  // packages/cli）没有它，跳过。
  if (!existsSync(join(dir, "src", "channel.ts"))) continue;

  const entry = join(dir, "dist/channel.js");
  if (!existsSync(entry)) {
    failures.push(`${dir}: 缺少 dist/channel.js —— 请先 npm run build --workspaces`);
    continue;
  }
  const mod = await import(pathToFileURL(entry).href);
  if (!mod.config) {
    failures.push(`${dir}: 未导出 config`);
    continue;
  }
  bridges.push({ dir, config: mod.config });
}

if (bridges.length < 2) {
  console.error(`只找到 ${bridges.length} 个渠道包 —— workspaces 或目录结构可能被改坏了`);
  process.exit(1);
}

const { rootDirFor } = await import(
  pathToFileURL(join(workspaceRoot, "packages/gateway/dist/paths.js")).href
);

const cids = new Set(bridges.map((b) => b.config.cid));
const ownDirNames = new Set(bridges.map((b) => `.${b.config.cid}-bridge`));
const debugEnvs = new Map(bridges.map((b) => [b.config.cid, b.config.debugDumpEnv]));
const ports = new Map();

for (const { dir, config } of bridges) {
  const { cid } = config;
  const where = `${cid}`;

  // §4.2 cid 即分层名
  check(/^[a-z0-9-]+$/.test(cid), `${where}: cid 必须匹配 ^[a-z0-9-]+$`);

  // §5.1 落点不再由渠道决定
  check(config.dirName === undefined, `${where}: 不应再有 dirName（落点由共享层按 cid 推导）`);
  check(config.envVar === undefined, `${where}: 不应再有 envVar（只认 MODEL_BRIDGE_HOME）`);

  // §3.3 调试变量命名
  const expectedDebug = `${cid.toUpperCase().replace(/-/g, "_")}_DEBUG_DUMP`;
  check(
    config.debugDumpEnv === expectedDebug,
    `${where}: debugDumpEnv 应为 ${expectedDebug}，实际 ${config.debugDumpEnv}`,
  );

  // §3.1 / §4.8 迁移链只许本渠道的历史名
  for (const name of config.legacyDirs ?? []) {
    check(
      typeof name === "string" && name.includes(cid),
      `${where}: legacyDirs 含非本渠道的目录名 ${name}（跨渠道迁移会劫持数据）`,
    );
    const foreign = [...ownDirNames].filter((d) => d !== `.${cid}-bridge`);
    check(!foreign.includes(name), `${where}: legacyDirs 含其它渠道的现行目录名 ${name}`);
  }

  // §4.3 旧的分渠道 home 变量仍须被识别
  const expectedHome = `${cid.toUpperCase().replace(/-/g, "_")}_HOME`;
  check(
    (config.legacyEnvVars ?? []).includes(expectedHome),
    `${where}: legacyEnvVars 应保留 ${expectedHome}（兼容旧脚本）`,
  );
  for (const name of config.legacyEnvVars ?? []) {
    const isOtherHome = bridges.some(
      (b) => b.config.cid !== cid && name === `${b.config.cid.toUpperCase().replace(/-/g, "_")}_HOME`,
    );
    check(!isOtherHome, `${where}: legacyEnvVars 含其它渠道的变量 ${name}`);
  }
  for (const name of config.legacyDebugDumpEnv ?? []) {
    check(
      ![...debugEnvs].some(([other, env]) => other !== cid && env === name),
      `${where}: legacyDebugDumpEnv 含其它渠道的变量 ${name}`,
    );
  }

  // §4.5 文件级迁移只许落在渠道层内
  for (const rule of config.fileMigrations ?? []) {
    check(FILENAME_RE.test(rule.from), `${where}: fileMigrations.from 命名不合规: ${rule.from}`);
    if (rule.to !== undefined) {
      check(FILENAME_RE.test(rule.to), `${where}: fileMigrations.to 命名不合规: ${rule.to}`);
    }
    check(
      rule.action === undefined || rule.action === "delete",
      `${where}: fileMigrations.action 只允许 "delete"`,
    );
  }

  // §4.9 端口唯一
  const portKey = config.defaultAddr;
  check(!ports.has(portKey), `${where}: defaultAddr 与 ${ports.get(portKey)} 冲突（${portKey}）`);
  ports.set(portKey, cid);
  const uiKey = `ui:${config.uiPort}`;
  check(!ports.has(uiKey), `${where}: uiPort 与 ${ports.get(uiKey)} 冲突（${config.uiPort}）`);
  ports.set(uiKey, cid);

  // §4.1 单根：所有渠道解析到同一个存储根
  const root = rootDirFor(config);
  check(
    root === process.env["MODEL_BRIDGE_HOME"],
    `${where}: 未使用 MODEL_BRIDGE_HOME 作为存储根（${root}）`,
  );

  if (config.version === undefined) notes.push(`${where}: 未声明 version`);
}

check(cids.size === bridges.length, "存在重复的 cid");

if (failures.length > 0) {
  console.error(`✗ 存储落点规范校验失败（${failures.length} 项）：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

const roots = new Set(bridges.map((b) => rootDirFor(b.config)));
console.log(`✓ 存储落点规范校验通过：${bridges.length} 个渠道，共用存储根 ${[...roots][0]}`);
for (const n of notes) console.log(`  · ${n}`);
