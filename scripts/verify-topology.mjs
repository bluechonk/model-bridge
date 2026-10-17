#!/usr/bin/env node
/**
 * 提交拓扑校验：**禁止冗余 merge**。
 *
 * 判据：一个 merge commit 若其 tree 与**任一副父**的 tree 逐字节相同，
 * 则该 merge 不承载任何内容差异 —— 它只是「单提交 PR」的 fast-forward 包装，
 * 会让同一条改动在 `git log --oneline` 里出现两次（标题也往往重复）。
 *
 * 为什么需要它：这类冗余 merge 靠人工发现太晚（历史上已清理过 6 个，之后又出现了
 * 一次）。规则化的检测比一次性清理可靠 —— 会直接在 `npm test` 里失败。
 *
 * 允许的真实合并：两父各自承载了不同改动（tree 不等于任一父）时保留。
 *
 * 用法：`node scripts/verify-topology.mjs [<range>]`。
 *
 * ⚠ **默认范围是「全部可达的 merge」而非 `origin/main..HEAD`** —— 这一条是踩坑后的修正：
 * GitHub 在 PR 合并时生成的 merge commit **从不经过本地校验**（它诞生在服务端、直接进 main），
 * 用「领先 origin/main 的提交」作范围会永远漏掉它。全历史范围则能在下一次 push 的
 * WSL 门禁里把它抓住。
 *
 * 存量已清理干净，所以全历史范围不会误报。
 */
import { execFileSync } from "node:child_process";

/** GitHub Actions 在 pull_request 事件里构造的临时合并提交（不在真实历史里，跳过）。 */
const SYNTHETIC_MERGE = /^Merge [0-9a-f]{40} into [0-9a-f]{40}$/;

const range = process.argv[2];
const args = ["rev-list", "--merges", ...(range ? [range] : ["HEAD"])];

let hashes;
try {
  const out = execFileSync("git", args, { encoding: "utf8" }).trim();
  hashes = out ? out.split("\n") : [];
} catch (err) {
  console.error("verify-topology: 无法读取提交历史（不是 git 仓库？）：" + String(err));
  process.exit(1);
}

const problems = [];
let checked = 0;

for (const hash of hashes) {
  const meta = execFileSync("git", ["log", "-1", "--format=%h%x09%p%x09%s", hash], {
    encoding: "utf8",
  }).trim();
  const [short, parentsRaw, subject] = meta.split("\t");
  if (SYNTHETIC_MERGE.test(subject ?? "")) continue;

  const parents = (parentsRaw ?? "").split(" ").filter(Boolean);
  if (parents.length < 2) continue;

  const tree = execFileSync("git", ["rev-parse", `${hash}^{tree}`], { encoding: "utf8" }).trim();
  checked++;

  for (const p of parents) {
    const ptree = execFileSync("git", ["rev-parse", `${p}^{tree}`], { encoding: "utf8" }).trim();
    if (tree === ptree) {
      problems.push(
        `${short}  冗余 merge（tree 与父 ${p.slice(0, 7)} 完全相同）：${subject}\n` +
          `          修法：合并时避免单提交 PR 的 fast-forward 包装，或本地 git rebase 后快进`,
      );
      break;
    }
  }
}

if (problems.length > 0) {
  console.error(`提交拓扑校验未通过（${problems.length}/${checked} 个 merge 存在冗余）：`);
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}

console.log(
  `提交拓扑校验通过：${checked} 个合并提交均为真实合并（tree 不等于任一副父）` +
    `${range ? `（范围 ${range}）` : ""}`,
);
