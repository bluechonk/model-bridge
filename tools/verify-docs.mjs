#!/usr/bin/env node
/**
 * 文档归属检查（规则见根 `AGENTS.md` §2）。
 *
 * **所有 `.md` 必须落在 `docs/` 里**，只有三类按固定路径加载的文件例外：
 *   1. `plugins/model-bridge/**`      —— 插件的命令/技能/说明
 *   2. `channels/<cid>/README.md`     —— 包根指针（只许指向 docs/）
 *   3. `channels/<cid>/AGENTS.md`     —— 目录级工具指令
 *
 * 这个检查把「docs 统一管理 md」从口头约定变成会失败的测试 —— 有 md 散落在
 * 别处时 `npm test` 直接红，而不是等人发现。
 *
 * 用法：node tools/verify-docs.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const workspaceRoot = dirname(import.meta.dirname);

/** 允许留在 docs/ 之外的 md（固定路径白名单）。 */
const ALLOWED = [
  /^docs\//,
  /^AGENTS\.md$/, // 规则文件本身：工具从仓库根读，不能搬
  /^plugins\/model-bridge\//, // 插件：ZCode / 技能加载器按固定路径读
  /^channels\/[a-z0-9-]+\/README\.md$/, // 包根指针 README
  /^channels\/[a-z0-9-]+\/AGENTS\.md$/, // 目录级工具指令
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".tmp", ".box-agent", ".box-agent-scratch"]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") {
      // 跳过所有隐藏目录（.git 等），但隐藏文件仍要检查
      if (entry.isDirectory()) continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path, out);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(path);
  }
  return out;
}

const problems = [];
let checked = 0;

for (const abs of walk(workspaceRoot)) {
  const rel = relative(workspaceRoot, abs).split(sep).join("/");
  if (SKIP_DIRS.has(rel.split("/")[0])) continue;
  checked += 1;
  if (ALLOWED.some((re) => re.test(rel))) continue;
  problems.push(`${rel} —— md 必须放进 docs/（规则见 AGENTS.md §2）`);
}

// 指针 README 必须真的指向 docs/（防止有人又把它当正文写回去）
const channelsDir = join(workspaceRoot, "channels");
if (existsSync(channelsDir)) {
  for (const name of readdirSync(channelsDir)) {
    const pointer = join(channelsDir, name, "README.md");
    if (!existsSync(pointer) || !statSync(pointer).isFile()) {
      problems.push(`channels/${name}/README.md —— 缺包根指针 README（应指向 docs/bridges/${name}.md）`);
      continue;
    }
    const body = readFileSync(pointer, "utf8");
    if (!body.includes("../docs/")) {
      problems.push(`channels/${name}/README.md —— 指针 README 必须链接到 docs/（正文应写在 docs/bridges/${name}.md）`);
    }
  }
}

if (problems.length > 0) {
  console.error(`✗ 文档归属检查失败（${problems.length} 项）：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`✓ 文档归属检查通过：${checked} 份 md，全部在 docs/ 或固定路径白名单内`);
