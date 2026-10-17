#!/usr/bin/env node
/**
 * 工程契约校验（条文见 docs/CONTRACT-TS.md §1/§2/§4）。
 *
 * 把「渠道包形态、依赖白名单、池模型恒定」这类**机器可查**的契约从文档搬进会失败的
 * 测试 —— 文档只保留编译器与本校验器都管不到的语义约定。
 *
 * 用法：node scripts/verify-contract.mjs（由 npm test 自动执行）
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)); // scripts/
const repo = dirname(root);
const read = (p) => readFileSync(join(repo, p), "utf8");

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

/** 渠道包 src/ 的 7 文件契约（CONTRACT-TS §1）。 */
const REQUIRED_SRC = ["billing.ts", "catalog.ts", "channel.ts", "cli.ts", "cred.ts", "index.ts", "upstream.ts"];
const DEP_ALLOW = ["@modelmux/gateway"];
/** 渠道包命名：`@modelmux/<cid>`（目录名与 cid 一致，见 CONTRACT-TS §1）。 */
const CHANNEL_PKG_RE = /^@modelmux\/[a-z0-9-]+$/;
const DEV_ALLOW = ["typescript", "@types/node"];

const channelsDir = join(repo, "packages", "core", "channels");
const channelDirs = readdirSync(channelsDir).filter((n) => existsSync(join(channelsDir, n, "package.json")));

let registeredImports = 0;

for (const cid of channelDirs) {
  const where = `packages/core/channels/${cid}`;

  // src/ 恰 7 文件：多出来的都是共享层旧副本残留
  const srcDir = join(channelsDir, cid, "src");
  check(existsSync(srcDir), `${where}: 缺 src/`);
  const srcFiles = existsSync(srcDir)
    ? readdirSync(srcDir).filter((f) => f.endsWith(".ts")).sort()
    : [];
  const extra = srcFiles.filter((f) => !REQUIRED_SRC.includes(f));
  const missing = REQUIRED_SRC.filter((f) => !srcFiles.includes(f));
  check(extra.length === 0, `${where}: src/ 出现契约外文件 ${extra.join(", ")}（只允许 7 文件，见 CONTRACT-TS §1）`);
  check(missing.length === 0, `${where}: src/ 缺少 ${missing.join(", ")}`);

  // 依赖白名单（CONTRACT-TS §2）：渠道只许依赖共享包
  const pkg = JSON.parse(read(`${where}/package.json`));
  const deps = Object.keys(pkg.dependencies ?? {});
  check(
    deps.every((d) => DEP_ALLOW.includes(d)),
    `${where}: dependencies 含非白名单包 ${deps.filter((d) => !DEP_ALLOW.includes(d)).join(", ")}（只允许 ${DEP_ALLOW.join("/")}）`,
  );
  const devDeps = Object.keys(pkg.devDependencies ?? {});
  check(
    devDeps.every((d) => DEV_ALLOW.includes(d)),
    `${where}: devDependencies 含非白名单包 ${devDeps.filter((d) => !DEV_ALLOW.includes(d)).join(", ")}`,
  );

  // 渠道 bin 恰为 `<cid>`（单渠道调试入口；双名 modelmux/mx 属仓库级 packages/cli）
  const bin = pkg.bin ?? {};
  check(
    Object.keys(bin).length === 1 && bin[cid] === "./dist/cli.js",
    `${where}: bin 必须恰为 { "${cid}": "./dist/cli.js" }，当前 ${JSON.stringify(bin)}`,
  );

  // cid 与目录名一致（防两套名字漂移）
  const channelSrc = read(`${where}/src/channel.ts`);
  const cidDecl = channelSrc.match(/cid:\s*"([a-z0-9-]+)"/);
  check(cidDecl !== null, `${where}: src/channel.ts 未声明 cid`);
  check(cidDecl?.[1] === cid, `${where}: 目录名与 cid "${cidDecl?.[1]}" 不一致`);
}

// 仓库级入口：bin 双名 + 注册清单与渠道目录一致
const cliPkg = JSON.parse(read("packages/cli/package.json"));
check(
  cliPkg.bin?.["modelmux"] === "./dist/cli.bundle.js" && cliPkg.bin?.["mx"] === "./dist/cli.bundle.js",
  "packages/cli: bin 必须同时提供 modelmux 与 mx，且都指向 dist/cli.bundle.js",
);
const cliDeps = Object.keys(cliPkg.dependencies ?? {});
check(
  cliDeps.every((d) => DEP_ALLOW.includes(d) || CHANNEL_PKG_RE.test(d)),
  `packages/cli: dependencies 含意外包 ${cliDeps.filter((d) => !DEP_ALLOW.includes(d) && !CHANNEL_PKG_RE.test(d)).join(", ")}`,
);
const registered = [...read("packages/cli/src/channels.ts").matchAll(/import\s+"(@modelmux\/[a-z0-9-]+)"/g)].map((m) => m[1]);
registeredImports = registered.length;
for (const cid of channelDirs) {
  check(registered.includes(`@modelmux/${cid}`), `packages/core/channels/${cid}: 未在 packages/cli/src/channels.ts 注册`);
}
check(
  registered.length === channelDirs.length,
  `注册清单（${registered.length}）与渠道目录数（${channelDirs.length}）不一致`,
);

// 工程引用对齐（AGENTS.md §命令：根 tsconfig 是 solution 文件，references 列出全部包）。
// 每个条目恰含一个 path —— 空条目与「单条目多 path」都是脚本化增删渠道留下的畸形残留：
// TS 自己的解析器会保留重复键（编译照过），走标准 JSON.parse 的工具却只认最后一个。
const referencesBlock = (text) => {
  const at = text.indexOf('"references"');
  if (at === -1) return "";
  let depth = 0;
  let start = 0;
  for (let i = text.indexOf("[", at); i < text.length; i++) {
    if (text[i] === "[") {
      if (depth === 0) start = i + 1;
      depth += 1;
    } else if (text[i] === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i);
    }
  }
  return text.slice(start);
};

const tsconfigs = [
  "tsconfig.json",
  ...channelDirs.map((cid) => `packages/core/channels/${cid}/tsconfig.json`),
  "packages/cli/tsconfig.json",
  "packages/core/gateway/tsconfig.json",
];
for (const where of tsconfigs) {
  const block = referencesBlock(read(where));
  const braces = (block.match(/\{/g) ?? []).length;
  const wellFormed = (block.match(/\{\s*"path"\s*:\s*"[^"]+"\s*\}/g) ?? []).length;
  check(braces === wellFormed, `${where}: references 含 ${braces - wellFormed} 个畸形条目（空条目或单条目多 path）`);
}

const solutionPaths = [...referencesBlock(read("tsconfig.json")).matchAll(/"path"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
const packagePaths = [...channelDirs.map((cid) => `packages/core/channels/${cid}`), "packages/cli", "packages/core/gateway"];
const missingRefs = packagePaths.filter((p) => !solutionPaths.includes(p));
const strayRefs = solutionPaths.filter((p) => !packagePaths.includes(p));
check(
  missingRefs.length === 0 && strayRefs.length === 0,
  `tsconfig.json: references 与仓库包不一致（缺 ${missingRefs.join(", ") || "无"}；多 ${strayRefs.join(", ") || "无"}）`,
);

// 共享包自身必须零第三方依赖（CONTRACT-TS §2）
const gwDeps = Object.keys(JSON.parse(read("packages/core/gateway/package.json")).dependencies ?? {});
check(gwDeps.length === 0, `packages/core/gateway: 共享包必须零运行依赖，当前 ${gwDeps.join(", ")}`);

// 公共池模型动态化（全模型池）：不再断言固定 2 个 flash，改为检查动态收集函数存在
const poolTargets = read("packages/core/gateway/src/pool/pool-targets.ts");
check(/export function poolModels\(\)/.test(poolTargets), "pool-targets.ts: 缺 poolModels()（全模型池动态收集）");
check(/function asPoolModel\(/.test(poolTargets), "pool-targets.ts: 缺 asPoolModel()（动态匹配）");
// 共享层代码不得硬编码厂商模型名（AGENTS.md §仓库结构：共享层不许出现渠道知识）。
// 剥离注释后再查 —— JSDoc 里的示例 id 是文档，不是共享层持有的模型知识。
const poolCode = poolTargets
  .replace(/\/\*[\s\S]*?\*\//g, "") // 块注释
  .replace(/^\s*\/\/.*$/gm, ""); // 行注释
check(
  !/"(deepseek|glm|qwen|kimi|doubao)-[a-z0-9.-]+"/i.test(poolCode),
  "pool-targets.ts: 共享层不得硬编码厂商模型名（模型只由各渠道 exposedIds() 提供）",
);

// 池白名单判据定义在共享层（渠道不得自行实现家族过滤，CONTRACT-TS §4）
const modelFamily = read("packages/core/gateway/src/pool/model-family.ts");
check(/FAMILY_ALLOWLIST/.test(modelFamily), "model-family.ts: 缺 FAMILY_ALLOWLIST（池白名单必须在共享层）");
check(/REQUIRED_ALLOWLIST/.test(modelFamily), "model-family.ts: 缺 REQUIRED_ALLOWLIST（型号闸门必须在共享层）");

if (failures.length > 0) {
  console.error(`✗ 工程契约校验失败（${failures.length} 项，渠道 ${channelDirs.length} 个 / 注册 ${registeredImports} 个）：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `✓ 工程契约校验通过：${channelDirs.length} 个渠道（7 文件 + 依赖白名单 + cid 一致），` +
    `bin 双名，工程引用对齐，POOL_MODELS 动态化，池白名单在共享层`,
);
