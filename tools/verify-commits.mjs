/**
 * 提交信息规范校验：`type(scope): 中文描述`。
 *
 * 规范遵循 Conventional Commits 并改中文（见 AGENTS.md §7），与 github 插件的
 * `$commit` 技能一致：
 * - type 只允许 feat / fix / docs / style / refactor / perf / test / chore；
 * - scope（`(git事件)`）**必填**，为变更涉及的模块或对象名；
 * - 描述为简体中文，**结尾不加句号**；
 * - 破坏性变更可加 `!`（如 `refactor(repo)!:`）。
 *
 * **merge commit 一并校验**：GitHub 默认生成的 `Merge pull request #N from …`
 * 不含 type/scope/中文，属违规。仓库设置已改为 `merge_commit_title=PR_TITLE`
 * （见 AGENTS.md §7），合并前本地 `git merge -m "merge(scope): 中文"` 也必须合规。
 *
 * 用法：`node tools/verify-commits.mjs [<range>]`，默认校验 HEAD 可达的全部提交
 * （含 merge）。range 例：`HEAD~5..HEAD`、`origin/main..HEAD`。
 */
import { execFileSync } from "node:child_process";

const TYPES = new Set(["feat", "fix", "docs", "style", "refactor", "perf", "test", "chore"]);
const SUBJECT = /^([a-z]+)(\(([^)]*)\))?(!)?: (.+)$/;
const CJK = /[\u3400-\u9fff]/;

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

for (const line of lines) {
  const tab = line.indexOf("\t");
  const hash = tab === -1 ? line : line.slice(0, tab);
  const subject = tab === -1 ? "" : line.slice(tab + 1);
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

console.log(`提交信息校验通过：${lines.length} 条提交全部符合 type(scope): 中文描述${range ? `（范围 ${range}）` : ""}`);
