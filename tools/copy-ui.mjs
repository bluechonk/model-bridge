#!/usr/bin/env node
/**
 * 把 packages/ui/dist 拷到 packages/core/gateway/dist/ui，供 console server 静态托管。
 * 根 `npm run build` 在 tsc -b 与 CLI bundle 之后调用本脚本。
 */

import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)); // tools/
const repo = dirname(root);
const src = join(repo, "packages", "ui", "dist");
const dest = join(repo, "packages", "core", "gateway", "dist", "ui");

if (!existsSync(join(src, "index.html"))) {
  console.error(`[copy-ui] missing ${join(src, "index.html")}; run packages/ui build first`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-ui] ${src} -> ${dest}`);
