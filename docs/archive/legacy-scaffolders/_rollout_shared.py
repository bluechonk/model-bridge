"""一次性：把 workbuddy 的改造铺到其余 10 个渠道（跑完即删）。

每个渠道：
  1. 删除 src/ 下的 12 个共享模块（已迁到 packages/gateway）
  2. 把渠道模块里的 ./paths.js / ./model-family.js import 改指 @model-bridge/gateway
  3. 生成 src/channel.ts（渠道配置 + 装配）、src/cli.ts（薄入口）、src/index.ts（转出）
  4. package.json 加依赖 @model-bridge/gateway
  5. tests/selftest.test.ts 改用工作区包 + 先注册渠道
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

SHARED_SRC = (
    "auth-flow.ts",
    "cli-consts.ts",
    "cli.ts",
    "console.ts",
    "daemon.ts",
    "gateway.ts",
    "headless.ts",
    "index.ts",
    "model-family.ts",
    "paths.ts",
    "portfree.ts",
    "sse-stream.ts",
)

CHANNELS = {
    "zcode": {"display": "ZCode", "port": 8803, "ui": 8804, "env": "ZCODE_HOME"},
    "trae": {"display": "TRAE", "port": 8805, "ui": 8806, "env": "TRAE_HOME"},
    "codearts": {"display": "CodeArts", "port": 8807, "ui": 8808, "env": "CODEARTS_HOME"},
    "lobsterai": {"display": "LobsterAI", "port": 8809, "ui": 8810, "env": "LOBSTERAI_HOME"},
    "cline": {"display": "Cline", "port": 8811, "ui": 8812, "env": "CLINE_HOME"},
    "loomy": {"display": "Loomy", "port": 8813, "ui": 8814, "env": "LOOMY_HOME"},
    "raccoon": {"display": "Raccoon", "port": 8815, "ui": 8816, "env": "RACCOON_HOME"},
    "minimax": {"display": "MiniMax Code", "port": 8817, "ui": 8818, "env": "MINIMAX_HOME"},
    "gemini": {"display": "Gemini Code Assist", "port": 8819, "ui": 8820, "env": "GEMINI_HOME"},
    "qoder": {"display": "Qoder", "port": 8801, "ui": 8802, "env": "QODER_HOME"},
}

CHANNEL_TS = '''/**
 * {display} 渠道装配：静态配置 + 四个渠道独有模块，注册进共享 gateway 层。
 *
 * 本文件是**共享层与渠道层的唯一边界**：`@model-bridge/gateway` 里的
 * gateway / daemon / headless / auth-flow 都通过这里注册的 `Channel` 拿到
 * cred / upstream / catalog / billing。
 *
 * 旧实现里这些配置（目录名/端口/日志前缀…）靠 scaffold 的字符串替换注入到
 * 11 份共享模块副本里；现在集中在这里一处。
 */

import {{ setChannel, type BridgeConfig, type Channel }} from "@model-bridge/gateway";

import * as billing from "./billing.js";
import * as catalog from "./catalog.js";
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

export const config: BridgeConfig = {{
  cid: "{cid}",
  display: "{display}",
  version: "0.1.0",
  defaultAddr: "127.0.0.1:{port}",
  uiPort: {ui},
  dirName: ".{cid}-bridge",
  envVar: "{env}",
  legacyDirs: [
    ".zcode-workbuddy-bridge",
    ".zcode-connect-{cid}",
    ".{cid}2api",
    ".{cid}-gateway",
  ],
  debugDumpEnv: "{prefix}_DEBUG_DUMP",
}};

export const channel: Channel = {{ config, cred, upstream, catalog, billing }};

setChannel(channel);
'''

CLI_TS = '''/**
 * {display} 渠道 CLI 入口（bin 指向 dist/cli.js）。
 *
 * 只做两件事：注册本渠道（`./channel.js` 的副作用）→ 交给共享 CLI。
 * 命令实现全在 `@model-bridge/gateway`。
 */

import "./channel.js"; // 副作用：setChannel(本渠道)
import {{ main }} from "@model-bridge/gateway";

main()
  .then((code) => {{
    process.exitCode = code;
  }})
  .catch((err: unknown) => {{
    console.error(`[{cid}] 未捕获异常: ${{String(err)}}`);
    process.exitCode = 1;
  }});
'''

INDEX_TS = '''/**
 * {display} 本地 OpenAI 兼容网关（无窗口引擎）—— 对外出口。
 *
 * 共享层模块来自 `@model-bridge/gateway`；本渠道独有的是 cred / upstream /
 * catalog / billing。导入本文件会顺带注册渠道（见 `./channel.js`）。
 */

// 共享层（原样转出，保持旧的 import 站点可用）
export {{
  authFlow,
  cli,
  consoleApi,
  daemon,
  gateway,
  headless,
  modelFamily,
  paths,
  portfree,
  sseStream,
  setChannel,
  getChannel,
  hasChannel,
  version,
  defaultAddr,
  defaultUiPort,
  isAllowedFamily,
  filterAllowedFamily,
  allowlistSummary,
}} from "@model-bridge/gateway";

// 渠道独有模块
export * as billing from "./billing.js";
export * as catalog from "./catalog.js";
export * as cred from "./cred.js";
export * as upstream from "./upstream.js";
export * as channel from "./channel.js";
'''

SHARED_IMPORT_RE = re.compile(
    r'from "\./(paths|model-family|cli-consts|sse-stream|portfree|auth-flow|console)\.js"'
)

# 测试里被删掉的共享模块动态 import 行
TEST_SHARED_LINE = re.compile(
    r'^const \w+ = await import\("\.\./dist/(paths|sse-stream|gateway|model-family|portfree|auth-flow|console|daemon|headless|cli|cli-consts|index)\.js"\);\s*$'
)
TEST_HEADER_RE = re.compile(
    r'^const paths = await import\("\.\./dist/paths\.js"\);\s*$', re.MULTILINE
)


def patch_test(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    if "await import(\"../dist/paths.js\")" not in text:
        return False
    lines = text.split("\n")
    kept: list[str] = []
    for line in lines:
        if TEST_SHARED_LINE.match(line.strip()):
            continue
        kept.append(line)
    text = "\n".join(kept)
    # 找渠道模块 import 块的起点（catalog 或 cred 的第一个 dist import）
    marker = re.search(r'^const (catalog|cred) = await import\("\.\./dist/', text, re.MULTILINE)
    assert marker, f"未找到渠道模块 import 锚点: {path}"
    header = (
        '// 共享层来自工作区包；先注册本渠道（副作用）再引渠道模块\n'
        'const { paths, sseStream: sse, gateway } = await import("@model-bridge/gateway");\n'
        'await import("../dist/channel.js");\n'
    )
    text = text[: marker.start()] + header + text[marker.start() :]
    path.write_text(text, encoding="utf-8")
    return True


def patch_package_json(path: Path) -> bool:
    data = json.loads(path.read_text(encoding="utf-8"))
    deps = data.setdefault("dependencies", {})
    deps["@model-bridge/gateway"] = "*"
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return True


def rollout(cid: str, meta: dict[str, object]) -> None:
    proj = ROOT / f"{cid}-bridge"
    src = proj / "src"
    display = str(meta["display"])
    env = str(meta["env"])
    prefix = env.replace("_HOME", "")

    for name in SHARED_SRC:
        target = src / name
        if target.exists():
            target.unlink()

    for name in ("cred.ts", "upstream.ts", "catalog.ts", "billing.ts"):
        f = src / name
        if not f.exists():
            continue
        text = f.read_text(encoding="utf-8")
        new = SHARED_IMPORT_RE.sub('from "@model-bridge/gateway"', text)
        if new != text:
            f.write_text(new, encoding="utf-8")

    (src / "channel.ts").write_text(
        CHANNEL_TS.format(
            cid=cid, display=display, port=meta["port"], ui=meta["ui"], env=env, prefix=prefix
        ),
        encoding="utf-8",
    )
    (src / "cli.ts").write_text(CLI_TS.format(cid=cid, display=display), encoding="utf-8")
    (src / "index.ts").write_text(INDEX_TS.format(display=display), encoding="utf-8")

    patch_package_json(proj / "package.json")

    test = proj / "tests" / "selftest.test.ts"
    if test.exists():
        patch_test(test)
    print(f"[ok] {cid}-bridge")


def main() -> int:
    wanted = sys.argv[1:] or list(CHANNELS)
    for cid in wanted:
        rollout(cid, CHANNELS[cid])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
