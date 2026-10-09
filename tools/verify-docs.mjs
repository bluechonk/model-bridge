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

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const workspaceRoot = dirname(import.meta.dirname);

/** 允许留在 docs/ 之外的 md（固定路径白名单）。 */
const ALLOWED = [
  /^docs\//,
  /^AGENTS\.md$/, // 规则文件本身：工具从仓库根读，不能搬
  /^README\.md$/, // 仓库门面：GitHub 只渲染根 README，必须留在原处
  /^plugins\/model-bridge\//, // 插件：ZCode / 技能加载器按固定路径读
  /^channels\/[a-z0-9-]+\/README\.md$/, // 包根指针 README
  /^channels\/[a-z0-9-]+\/AGENTS\.md$/, // 目录级工具指令
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".tmp", ".box-agent", ".box-agent-scratch"]);

/**
 * 被 git 忽略的路径（如 `channels/<cid>/reference/` 里 clone 的第三方实现）
 * **不算本仓库的文档**，不参与检查。
 *
 * 为什么需要：那些目录是「clone 下来读源码」的学习材料（各渠道 `.gitignore` 里
 * 明确标了「不入库」），里面必然带着上游自己的 `.md`。要求它们遵守本仓库的
 * 文档规则既不合理、也做不到 —— 而且一 clone 就让 `npm test` 变红。
 *
 * 用 `git check-ignore` 问 git 要答案，而不是在这里重写一遍忽略规则：
 * 忽略规则会演进，抄一份必然漂移。非 git 环境（无 .git）时退化为「不忽略任何东西」。
 */
function gitIgnored(paths) {
  if (paths.length === 0) return new Set();
  try {
    // --stdin 一次问完：几百个文件也只是一次进程调用
    const out = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: workspaceRoot,
      input: paths.join("\n"),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
  } catch (err) {
    // check-ignore 无匹配时退出码为 1（正常）；非 git 环境会抛 ENOENT
    const out = typeof err.stdout === "string" ? err.stdout : "";
    return new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
  }
}

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

const candidates = walk(workspaceRoot)
  .map((abs) => relative(workspaceRoot, abs).split(sep).join("/"))
  .filter((rel) => !SKIP_DIRS.has(rel.split("/")[0]));
const ignored = gitIgnored(candidates);

for (const rel of candidates) {
  if (ignored.has(rel)) continue; // 被忽略的第三方材料：不归本仓库文档规则管
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
