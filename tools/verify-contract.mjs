#!/usr/bin/env node
/**
 * 工程契约校验（条文见 docs/CONTRACT-TS.md §1/§2/§4）。
 *
 * 把「渠道包形态、依赖白名单、池模型恒定」这类**机器可查**的契约从文档搬进会失败的
 * 测试 —— 文档只保留编译器与本校验器都管不到的语义约定。
 *
 * 用法：node tools/verify-contract.mjs（由 npm test 自动执行）
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)); // tools/
const repo = dirname(root);
const read = (p) => readFileSync(join(repo, p), "utf8");

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

/** 渠道包 src/ 的 7 文件契约（CONTRACT-TS §1）。 */
const REQUIRED_SRC = ["billing.ts", "catalog.ts", "channel.ts", "cli.ts", "cred.ts", "index.ts", "upstream.ts"];
const DEP_ALLOW = ["@model-bridge/gateway"];
const DEV_ALLOW = ["typescript", "@types/node"];

const channelsDir = join(repo, "channels");
const channelDirs = readdirSync(channelsDir).filter((n) => existsSync(join(channelsDir, n, "package.json")));

let registeredImports = 0;

for (const cid of channelDirs) {
  const where = `channels/${cid}`;

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

  // cid 与目录名一致（防两套名字漂移）
  const channelSrc = read(`${where}/src/channel.ts`);
  const cidDecl = channelSrc.match(/cid:\s*"([a-z0-9-]+)"/);
  check(cidDecl !== null, `${where}: src/channel.ts 未声明 cid`);
  check(cidDecl?.[1] === cid, `${where}: 目录名与 cid "${cidDecl?.[1]}" 不一致`);
}

// 仓库级入口：bin 双名 + 注册清单与渠道目录一致
const cliPkg = JSON.parse(read("packages/cli/package.json"));
check(
  cliPkg.bin?.["mb"] === "./dist/cli.bundle.js" && cliPkg.bin?.["model-bridge"] === "./dist/cli.bundle.js",
  "packages/cli: bin 必须同时提供 mb 与 model-bridge，且都指向 dist/cli.bundle.js",
);
const cliDeps = Object.keys(cliPkg.dependencies ?? {});
check(
  cliDeps.every((d) => DEP_ALLOW.includes(d) || d.endsWith("-bridge")),
  `packages/cli: dependencies 含意外包 ${cliDeps.filter((d) => !DEP_ALLOW.includes(d) && !d.endsWith("-bridge")).join(", ")}`,
);
const registered = [...read("packages/cli/src/channels.ts").matchAll(/import\s+"([a-z0-9-]+)"/g)].map((m) => m[1]);
registeredImports = registered.length;
for (const cid of channelDirs) {
  check(registered.includes(`${cid}-bridge`), `channels/${cid}: 未在 packages/cli/src/channels.ts 注册`);
}
check(
  registered.length === channelDirs.length,
  `注册清单（${registered.length}）与渠道目录数（${channelDirs.length}）不一致`,
);

// 共享包自身必须零第三方依赖（CONTRACT-TS §2）
const gwDeps = Object.keys(JSON.parse(read("packages/gateway/package.json")).dependencies ?? {});
check(gwDeps.length === 0, `packages/gateway: 共享包必须零运行依赖，当前 ${gwDeps.join(", ")}`);

// 公共池模型恒定两个（CONTRACT-TS §4）：从源码文本提取，不依赖构建产物
const poolTargets = read("packages/gateway/src/pool-targets.ts");
const poolDecl = poolTargets.match(/POOL_MODELS[^=]*=\s*\[([^\]]*)\]/);
check(poolDecl !== null, "pool-targets.ts: 未找到 POOL_MODELS 声明");
const poolModels = (poolDecl?.[1] ?? "").match(/"(deepseek-v4\.1-flash|glm-5\.3-flash)"/g) ?? [];
check(
  poolModels.length === 2 &&
    poolModels[0] === '"deepseek-v4.1-flash"' &&
    poolModels[1] === '"glm-5.3-flash"',
  `POOL_MODELS 必须恒为 ["deepseek-v4.1-flash", "glm-5.3-flash"]，当前 ${poolDecl?.[1]?.trim() ?? "(无)"}`,
);

// 池白名单判据定义在共享层（渠道不得自行实现家族过滤，CONTRACT-TS §4）
const modelFamily = read("packages/gateway/src/model-family.ts");
check(/FAMILY_ALLOWLIST/.test(modelFamily), "model-family.ts: 缺 FAMILY_ALLOWLIST（池白名单必须在共享层）");
check(/REQUIRED_ALLOWLIST/.test(modelFamily), "model-family.ts: 缺 REQUIRED_ALLOWLIST（型号闸门必须在共享层）");

if (failures.length > 0) {
  console.error(`✗ 工程契约校验失败（${failures.length} 项，渠道 ${channelDirs.length} 个 / 注册 ${registeredImports} 个）：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `✓ 工程契约校验通过：${channelDirs.length} 个渠道（7 文件 + 依赖白名单 + cid 一致），` +
    `bin 双名，POOL_MODELS 恒定，池白名单在共享层`,
);
