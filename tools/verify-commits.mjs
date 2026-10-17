/**
 * 提交信息规范校验：`type(scope): 中文描述`。
 *
 * 规范遵循 Conventional Commits 并改中文（见 AGENTS.md §提交信息规范），与 github 插件的
 * `$commit` 技能一致：
 * - type 只允许 feat / fix / docs / style / refactor / perf / test / chore；
 * - scope（`(git事件)`）**必填**，为变更涉及的模块或对象名；
 * - 描述为简体中文，**结尾不加句号**；
 * - 破坏性变更可加 `!`（如 `refactor(repo)!:`）。
 *
 * **merge commit 一并校验**：GitHub 默认生成的 `Merge pull request #N from …`
 * 不含 type/scope/中文，属违规。仓库设置已改为 `merge_commit_title=PR_TITLE`
 * （见 AGENTS.md §提交信息规范），合并前本地 `git merge -m "merge(scope): 中文"` 也必须合规。
 *
 * **跳过 GitHub 的合成提交**：GitHub Actions 在 `pull_request` 事件里会构造一个
 * 临时合并提交（标题形如 `Merge <sha> into <sha>`），它不在任何人的 git 历史里、
 * 也不可修改 —— 校验它只会让 PR 检查必然变红（历史事故：PR #5 / #6 的检查全红）。
 * 这类提交按固定标题模式识别并跳过，`Merge pull request #N from …` 仍照常拦截。
 *
 * 用法：`node tools/verify-commits.mjs [<range>]`，默认校验「本地领先 origin/main 的提交」。
 * range 例：`HEAD~5..HEAD`、`origin/main..HEAD`。
 */
import { execFileSync } from "node:child_process";

const TYPES = new Set(["feat", "fix", "docs", "style", "refactor", "perf", "test", "chore"]);
const SUBJECT = /^([a-z]+)(\(([^)]*)\))?(!)?: (.+)$/;
const CJK = /[\u3400-\u9fff]/;

/**
 * GitHub 生成的合成合并提交：`Merge <40位sha> into <40位sha>`。
 * 仅此模式跳过 —— 人工写的 `Merge pull request #N from xxx` 仍会被拦下。
 */
const SYNTHETIC_MERGE = /^Merge [0-9a-f]{40} into [0-9a-f]{40}$/;

const range = process.argv[2] ?? defaultRange();
// 不过滤 merge（--no-merges 会让 GitHub 生成的英文 merge 标题漏网）
const args = ["log", "--pretty=format:%h%x09%s", ...(range ? [range] : [])];

/**
 * 默认校验范围：**本地领先远端 main 的提交**（即「本次要推的」）。
 *
 * 为什么不校验全部历史：规则收紧（如开始约束 merge 标题）时，既有历史必然不合规，
 * 但那已不可改写 —— 对历史报错只会让校验器无法通过，从而被绕过。
 * 口径与 CI 一致：只管新增的这批。
 * 读不到 origin/main 时退化为校验 HEAD 全部历史（单机上仍可用）。
 */
function defaultRange() {
  try {
    execFileSync("git", ["rev-parse", "--verify", "origin/main"], { stdio: "ignore" });
    return "origin/main..HEAD";
  } catch {
    return "";
  }
}

let out;
try {
  out = execFileSync("git", args, { encoding: "utf8" });
} catch (err) {
  console.error("verify-commits: 无法读取提交历史（不是 git 仓库？）：" + String(err));
  process.exit(1);
}

const lines = out.split("\n").filter((l) => l.trim() !== "");
const problems = [];
let skipped = 0;

for (const line of lines) {
  const tab = line.indexOf("\t");
  const hash = tab === -1 ? line : line.slice(0, tab);
  const subject = tab === -1 ? "" : line.slice(tab + 1);
  // GitHub Actions 构造的临时合并提交：不在任何人历史里、不可修改，跳过
  if (SYNTHETIC_MERGE.test(subject)) {
    skipped++;
    continue;
  }
  const m = subject.match(SUBJECT);
  if (!m) {
    problems.push(`${hash}  格式不符（应为 type(scope): 中文描述）：${subject}`);
    continue;
  }
  const [, type, scopeGroup, scope, , desc] = m;
  if (!TYPES.has(type)) problems.push(`${hash}  type 不在白名单（feat/fix/docs/style/refactor/perf/test/chore）：${subject}`);
  if (!scopeGroup || scope.trim() === "") problems.push(`${hash}  缺少 scope（type(模块): …）：${subject}`);
  if (!CJK.test(desc)) problems.push(`${hash}  描述应为简体中文：${subject}`);
  if (/[.。]$/.test(desc)) problems.push(`${hash}  描述结尾不应加句号：${subject}`);
}

if (problems.length > 0) {
  console.error(`提交信息校验未通过（${problems.length}/${lines.length} 条）：`);
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}

const skipNote = skipped > 0 ? `（跳过 ${skipped} 条 GitHub 合成合并提交）` : "";
console.log(
  `提交信息校验通过：${lines.length - skipped} 条提交全部符合 type(scope): 中文描述${skipNote}${range ? `（范围 ${range}）` : ""}`,
);
