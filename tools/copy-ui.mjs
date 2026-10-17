#!/usr/bin/env node
/**
 * 把 packages/ui/dist 的构建产物拷到**两个**运行时落点：
 *   1. packages/core/gateway/dist/ui —— gateway 作为独立进程托管（`serve` / 单渠道 CLI）
 *   2. packages/cli/dist/ui           —— CLI bundle 托管（全局 `mx web`）
 *
 * 为什么要两份：console.ts 的 WEB_UI_ROOT 按「与当前 js 平级」解析。
 * gateway 的 dist/console.js 平级取到 gateway/dist/ui；而 bundle 后整包内联进
 * cli/dist/cli.bundle.js，此时 `import.meta.url` 指向 bundle，平级只能是 cli/dist/ui。
 * 少拷一份，`npm i -g` 装的 `mx web` 就会报「UI 未构建」。
 *
 * 根 `npm run build` 在 tsc -b 与 CLI bundle 之后调用本脚本。
 */

import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)); // tools/
const repo = dirname(root);
const src = join(repo, "packages", "ui", "dist");

if (!existsSync(join(src, "index.html"))) {
  console.error(`[copy-ui] missing ${join(src, "index.html")}; run packages/ui build first`);
  process.exit(1);
}

const dests = [
  join(repo, "packages", "core", "gateway", "dist", "ui"),
  join(repo, "packages", "cli", "dist", "ui"),
];

for (const dest of dests) {
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  console.log(`[copy-ui] ${src} -> ${dest}`);
}
