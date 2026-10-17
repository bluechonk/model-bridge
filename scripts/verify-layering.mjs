#!/usr/bin/env node
/**
 * 分层依赖校验：`core/gateway/src` 内的 import 方向必须**单向向下**。
 *
 * ## 分层
 *
 * ```
 * runtime (0)   渠道 SDK：channel / paths / account-pool / secret-file / catalog-cache / cli-consts
 * pool  (1)     模型池与账本：pool-targets / pool-usage / model-family / model-pool
 * auth  (1)     登录链路：login / login-flow / auth-flow / auto-signin / signin-ledger
 * http  (2)     HTTP 层：gateway / chat-relay / console / sse-stream / portfree / web-*
 * app   (3)     进程编排：cli / daemon / process-utils / headless / supervisor / …
 * ```
 *
 * 规则：**只能 import 层级 ≤ 自己的目录**（同层与向下都允许，向上禁止）。
 * `index.ts`（桶导出，在 src 根）不受限 —— 它的职责就是聚合全部层。
 *
 * ## 为什么需要它
 *
 * 目录分层只是约定，靠人眼审查必然退化成「谁需要就 import 谁」。
 * 这个脚本让越界 import 在 `npm test` / CI 直接失败，把约定变成构建期硬约束。
 *
 * ## 已知违例（白名单）
 *
 * 极少数跨层引用有正当理由时列入 `ALLOWLIST`（**必须写理由**）。新增条目要慎重：
 * 白名单是例外，不是绕过规则的后门。
 *
 * **当前为空** —— 历史上唯一一条（`web-command-handler` 动态 import `headless`）
 * 已改为经 `ControlBridge.triggerLogin` 回调注入，层级违例彻底消除。
 *
 * 用法：`node scripts/verify-layering.mjs`
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SRC = "packages/core/gateway/src";

/** 目录 → 层级（数值越小越底层）。未列出的目录不参与校验。 */
const LAYER = {
  runtime: 0,
  pool: 1,
  auth: 1,
  http: 2,
  app: 3,
};

/** 层级的可读名（错误信息里用）。 */
const LAYER_NOTE = {
  0: "渠道 SDK（最底层，不许依赖任何兄弟层）",
  1: "模型池 / 登录链路",
  2: "HTTP 层",
  3: "进程编排（最顶层）",
};

/**
 * 已知违例白名单：`<from 相对路径> -> <to 相对路径>` → 理由。**当前为空**（见文件头说明）。
 *
 * 只允许「有真实技术约束且短期无法消除」的条目。每一条都要在代码里留注释说明。
 */
const ALLOWLIST = new Map();


/** 递归收集 src 下的 .ts 文件（相对 SRC 的 posix 路径）。 */
function collect(dir, base = SRC, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collect(p, base, out);
    else if (name.endsWith(".ts")) out.push(relative(base, p).split(sep).join("/"));
  }
  return out;
}

/** 相对路径 → 所属层级；src 根（index.ts）返回 null（不参与校验）。 */
function layerOf(rel) {
  const seg = rel.split("/");
  if (seg.length === 1) return null; // index.ts
  const name = seg[0];
  return Object.hasOwn(LAYER, name) ? { dir: name, level: LAYER[name] } : null;
}

const files = collect(SRC);
const problems = [];
let checked = 0;

for (const rel of files) {
  const from = layerOf(rel);
  if (!from) continue; // index.ts 不受限

  const abs = join(SRC, rel);
  const text = readFileSync(abs, "utf8");

  // 覆盖静态 import / export ... from / 动态 import()
  const re = /(?:from\s+|import\()"(\.\.?\/[^"]+?)\.js"/g;
  for (const m of text.matchAll(re)) {
    const targetAbs = resolve(dirname(abs), `${m[1]}.ts`);
    const targetRel = relative(SRC, targetAbs).split(sep).join("/");
    // 只关心 src 内的引用（跨包引用不是本校验的对象）
    if (targetRel.startsWith("..")) continue;
    const to = layerOf(targetRel);
    if (!to) continue;
    checked++;

    // 向上依赖 = 违例
    if (to.level > from.level) {
      const key = `${rel} -> ${targetRel}`;
      if (ALLOWLIST.has(key)) continue;
      problems.push(
        `${rel}\n` +
          `    引用了更高层的 ${targetRel}\n` +
          `      来源层 ${from.dir}(${from.level}) —— ${LAYER_NOTE[from.level]}\n` +
          `      目标层 ${to.dir}(${to.level}) —— ${LAYER_NOTE[to.level]}\n` +
          `    修法：把需要的动作下沉到下层，或经回调注入（见 AGENTS.md 的分层约定）`,
      );
    }
  }
}

// 白名单条目失效提醒：目标不再是向上依赖时应当删除
for (const key of ALLOWLIST.keys()) {
  const [f, t] = key.split(" -> ");
  if (!files.includes(f)) {
    problems.push(`白名单条目已失效（文件不存在）：${key}\n    修法：从 scripts/verify-layering.mjs 的 ALLOWLIST 删除`);
    continue;
  }
  const fl = layerOf(f);
  const tl = layerOf(t);
  if (fl && tl && tl.level <= fl.level) {
    problems.push(`白名单条目已失效（不再是向上依赖）：${key}\n    修法：从 ALLOWLIST 删除`);
  }
}

if (problems.length > 0) {
  console.error(`✗ 分层校验失败（${problems.length} 处越界 import）：\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}

console.log(
  `✓ 分层校验通过：${files.length} 个源文件的 ${checked} 条内部引用全部单向向下` +
    `（runtime < pool/auth < http < app；白名单 ${ALLOWLIST.size} 条已知例外）`,
);
