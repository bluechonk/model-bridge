/**
 * 单文件发布构建：把 cli + gateway + 全部渠道打成自包含的 ESM bundle。
 *
 * 为什么需要它：`packages/cli` 的运行时依赖是 workspace 软链（`catpaw-bridge` →
 * `channels/catpaw`），全局安装 / 发 registry 时软链断裂、包名在 registry 上不存在。
 * esbuild 从唯一聚合点 `src/cli.ts` 沿静态 import 收编整条依赖图，产物里不再有任何
 * 外部包引用 —— tarball 自包含，`npm i -g` 直接可用。
 *
 * models.json 快照注入：cline / loomy / trae / workbuddy(ai) 的 catalog 用
 * `join(import.meta.url, "..", "..", "models.json")` 定位随包快照（dist/ 上两级 = 包根）。
 * bundle 后该相对路径指向「bundle 所在目录的上两级」，解析不到任何真实文件。
 * 机制必须保真：构建期把各渠道包根的 models.json 原样内联为模块导出，loader 按
 * 「importer 所属包根 + 相对路径」精确匹配替换。
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url)); // packages/cli/scripts
const cliRoot = resolve(here, "..");                  // packages/cli
const repoRoot = resolve(cliRoot, "../..");            // 仓库根

// 携带随包 models.json 快照的渠道（其余渠道无此机制，无需处理）
const SNAPSHOT_CHANNELS = ["cline", "loomy", "trae", "workbuddy", "workbuddyai"];

/** 收集各渠道包根的 models.json：绝对路径 → 内联模块源码。 */
function snapshotModules() {
  const mods = new Map();
  for (const cid of SNAPSHOT_CHANNELS) {
    const pkgDir = join(repoRoot, "channels", cid);
    const content = readFileSync(join(pkgDir, "models.json"), "utf8");
    mods.set(resolve(pkgDir, "models.json"), `export default ${JSON.stringify(JSON.parse(content))};`);
  }
  return mods;
}

await build({
  entryPoints: [join(cliRoot, "src/cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: join(cliRoot, "dist/cli.bundle.js"),
  banner: { js: "#!/usr/bin/env node" },
  // node: 内置模块自动豁免；external 留空 = 全量内联（零第三方运行依赖）
  plugins: [
    {
      name: "inline-channel-models-json",
      setup(b) {
        const mods = snapshotModules();
        b.onResolve({ filter: /\.json$/ }, (args) => {
          if (args.importer.includes("node_modules")) return null;
          // importer 形如 …/channels/cline/src/catalog.ts → 包根 = 上两级
          const pkgDir = resolve(dirname(args.importer), "..", "..");
          const target = resolve(args.path);
          if (!mods.has(target)) return null; // 非快照 json（如 package.json 探测）不拦截
          return { path: target, namespace: "models-snapshot" };
        });
        b.onLoad({ filter: /.*/, namespace: "models-snapshot" }, (args) => ({
          contents: mods.get(args.path) ?? "",
          loader: "js",
        }));
      },
    },
  ],
});

console.log("[bundle] dist/cli.bundle.js built");
