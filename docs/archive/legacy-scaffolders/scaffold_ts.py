"""把 workbuddy-bridge 的共享 TS 模块参数化复制到其余 <渠道>-bridge 项目。

设计：**共享模块逐字复制 + 少量参数替换**。
渠道差异只应出现在 cred/upstream/catalog/billing 四个模块里，
其余模块在 11 个项目里是同一份。

用法：
    python scaffold_ts.py              # 同步全部
    python scaffold_ts.py zcode trae   # 只同步指定渠道
    python scaffold_ts.py --check      # 只检查漂移，不写
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE_CID = "workbuddy-bridge"

# 渠道定义：id、展示名、网关端口、控制台端口、HOME 环境变量
CHANNELS: dict[str, dict[str, object]] = {
    "qoder": {"display": "Qoder", "port": 8801, "ui_port": 8802, "env": "QODER_HOME"},
    "zcode": {"display": "ZCode", "port": 8803, "ui_port": 8804, "env": "ZCODE_HOME"},
    "trae": {"display": "TRAE", "port": 8805, "ui_port": 8806, "env": "TRAE_HOME"},
    "codearts": {"display": "CodeArts", "port": 8807, "ui_port": 8808, "env": "CODEARTS_HOME"},
    "lobsterai": {"display": "LobsterAI", "port": 8809, "ui_port": 8810, "env": "LOBSTERAI_HOME"},
    "cline": {"display": "Cline", "port": 8811, "ui_port": 8812, "env": "CLINE_HOME"},
    "loomy": {"display": "Loomy", "port": 8813, "ui_port": 8814, "env": "LOOMY_HOME"},
    "raccoon": {"display": "Raccoon", "port": 8815, "ui_port": 8816, "env": "RACCOON_HOME"},
    "minimax": {"display": "MiniMax Code", "port": 8817, "ui_port": 8818, "env": "MINIMAX_HOME"},
    "gemini": {"display": "Gemini Code Assist", "port": 8819, "ui_port": 8820, "env": "GEMINI_HOME"},
}

# 逐字复制的共享模块（src/ 下 .ts，根目录下其余）
SHARED_SRC = (
    "paths.ts",
    "portfree.ts",
    "sse-stream.ts",
    "console.ts",
    "auth-flow.ts",
    "gateway.ts",
    "daemon.ts",
    "headless.ts",
    "cli.ts",
    "cli-consts.ts",
    "index.ts",
    "model-family.ts",
)
SHARED_ROOT = ("tsconfig.json",)

# 渠道特有模块（缺失时写类型正确的占位，保证先能 build）
CHANNEL_MODULES = ("cred.ts", "upstream.ts", "catalog.ts", "billing.ts")


def substitutions(cid: str, meta: dict[str, object]) -> list[tuple[str, str]]:
    """构造替换表（长串先替换，避免前缀被吃掉）。"""
    display = str(meta["display"])
    env = str(meta["env"])
    home = env.replace("_HOME", "")
    return [
        # 环境变量
        ("WORKBUDDY_HOME", env),
        ("WBAI2API_HOME", env),
        ("ZCB_HOME", env),
        ("WBAI_DEBUG_DUMP", f"{home}_DEBUG_DUMP"),
        ("WBAI_MODELS_FILE", f"{home}_MODELS_FILE"),
        # 服务标识与日志前缀（先长后短）
        ('SERVICE_NAME = "workbuddy-bridge"', f'SERVICE_NAME = "{cid}-bridge"'),
        ('"workbuddy-bridge"', f'"{cid}-bridge"'),
        ("[workbuddy-bridge] ", f"[{cid}-bridge] "),
        ("[workbuddy] ", f"[{cid}] "),
        # 数据目录
        (".workbuddy-bridge", f".{cid}-bridge"),
        # CLI 名（用法文本与提示串）
        ("`workbuddy ", f"`{cid} "),
        ("workbuddy --version", f"{cid} --version"),
        ("workbuddy status", f"{cid} status"),
        ("workbuddy start", f"{cid} start"),
        ("workbuddy stop", f"{cid} stop"),
        ("workbuddy restart", f"{cid} restart"),
        ("workbuddy models", f"{cid} models"),
        ("workbuddy credits", f"{cid} credits"),
        ("workbuddy login", f"{cid} login"),
        ("workbuddy serve", f"{cid} serve"),
        ("workbuddy logs", f"{cid} logs"),
        ("用 workbuddy ", f"用 {cid} "),
        ("运行 workbuddy ", f"运行 {cid} "),
        ("prog: workbuddy", f"prog: {cid}"),
        ("prog: WORKBUDDY", f"prog: {cid.upper()}"),
        # 展示名（先长后短）
        ("WorkBuddyAI", display),
        ("workbuddyai", cid),
        ("WorkBuddy", display),
        # 默认地址与端口
        ('DEFAULT_ADDR = "127.0.0.1:8787"', f'DEFAULT_ADDR = "127.0.0.1:{meta["port"]}"'),
        ("DEFAULT_UI_PORT = 8788", f"DEFAULT_UI_PORT = {meta['ui_port']}"),
        ("127.0.0.1:8787", f"127.0.0.1:{meta['port']}"),
        ("127.0.0.1:8788", f"127.0.0.1:{meta['ui_port']}"),
        # 版本
        ('VERSION = "0.4.0"', 'VERSION = "0.1.0"'),
    ]


def substitute(text: str, subs: list[tuple[str, str]]) -> str:
    for old, new in subs:
        text = text.replace(old, new)
    return text


# ── 渠道特有模块的占位 ────────────────────────────────────────────────────────
#
# 占位必须**导出完整接口**，否则 `tsc` 会因为 gateway.ts 引用了不存在的成员而报错，
# 项目连 build 都过不去（那样 agent 就没法在可编译的基础上迭代）。
# 所有函数体抛错而非返回空值 —— 后者会让网关"看起来在工作"。

PLACEHOLDER_HEADER = '''/**
 * @DISPLAY@ 渠道的 @NAME@（**待实现**）。
 *
 * 实现依据：`docs/PROTOCOL.md`（协议规格）与 `../docs/CONTRACT-TS.md`（接口契约）。
 *
 * ⚠ 占位刻意让调用**立即失败并说明原因**，而不是返回空值 ——
 * 返回空值会让网关看起来在工作（模型列表恒为空、请求静默失败），
 * 比直接报错更难排查。
 */

const TODO = "@CID@-bridge 的 @NAME@ 尚未实现；请按 docs/PROTOCOL.md 实现本模块。";

function todo(what: string): never {
  throw new Error(`${TODO}（${what}）`);
}
'''

PLACEHOLDER_CRED = PLACEHOLDER_HEADER + '''
export const DEFAULT_BASE_URL = "https://example.invalid";

export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
}

export interface Credentials {
  readonly accessToken: string;
  readonly uid: string;
  readonly domain: string;
}

export function load(): Credentials {
  todo("cred.load");
}

export async function save(_c: Credentials): Promise<void> {
  todo("cred.save");
}

export async function login(
  _baseUrl?: string,
  _options?: { onUrl?: (url: string) => void; onStatus?: (msg: string) => void },
): Promise<Credentials> {
  todo("cred.login");
}

export async function refresh(_c: Credentials): Promise<Credentials> {
  todo("cred.refresh");
}

export function resolveBaseUrl(_realm = "auto"): string {
  todo("cred.resolveBaseUrl");
}
'''

PLACEHOLDER_UPSTREAM = PLACEHOLDER_HEADER + '''
export const DEFAULT_BASE_URL = "https://example.invalid";

/** 上游线型：`openai`（标准 SSE delta）或 `custom`（需翻译层）。 */
export const WIRE: "openai" | "custom" = "openai";

/** 展示名（状态页与日志用）。 */
export const DISPLAY_NAME = "{display}";

export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

export interface Config {
  baseUrl: string;
}

export function defaultConfig(): Config {
  todo("upstream.defaultConfig");
}

export function loadConfig(): [Config, boolean] {
  todo("upstream.loadConfig");
}

export async function saveConfig(_cfg: Config): Promise<void> {
  todo("upstream.saveConfig");
}

export function chatUrl(_cfg?: Config): string {
  todo("upstream.chatUrl");
}

export function modelsUrl(_cfg?: Config): string {
  todo("upstream.modelsUrl");
}

export function buildHeaders(_credential: unknown): Record<string, string> {
  todo("upstream.buildHeaders");
}

export function buildChatBody(
  _req: Record<string, unknown>,
  _upstreamModel: string,
): Record<string, unknown> {
  todo("upstream.buildChatBody");
}

export async function fetchModels(_credential: unknown): Promise<Record<string, unknown>> {
  todo("upstream.fetchModels");
}

/** 从模型载荷推导连接配置（登录成功后由 auth-flow 调用）。 */
export function resolveConfig(_data: Record<string, unknown>, _fallback?: Config): Config {
  todo("upstream.resolveConfig");
}

/** 仅 `WIRE === "custom"` 时需要实现。 */
export interface StreamTranslator {
  feed(chunk: Buffer): Array<Buffer | string>;
  finish(): Array<Buffer | string>;
}

export function newTranslator(): StreamTranslator {
  todo("upstream.newTranslator");
}
'''

PLACEHOLDER_CATALOG = PLACEHOLDER_HEADER + '''
/** 对外暴露的模型 id（短名）。 */
export function exposedIds(): string[] {
  todo("catalog.exposedIds");
}

/** 短名 → 上游 slug；未知名称原样返回。 */
export function resolveModel(_name: string): string {
  todo("catalog.resolveModel");
}
'''

PLACEHOLDER_BILLING = PLACEHOLDER_HEADER + '''
export class CreditsError extends Error {
  override name = "CreditsError";
}

export interface CreditPackage {
  name: string;
  remain: number;
  size: number;
  used?: number;
  unit?: string;
  days_left?: number | null;
  [key: string]: unknown;
}

export interface CreditsResult {
  ok: true;
  total: {
    remain: number;
    size: number;
    used: number;
    unit: string;
    remain_percent: number;
  };
  packages: CreditPackage[];
  claimable?: Array<Record<string, unknown>>;
}

export async function fetchCredits(
  _options?: { refreshOn401?: boolean },
): Promise<CreditsResult> {
  todo("billing.fetchCredits");
}
'''

PLACEHOLDERS = {
    "cred.ts": PLACEHOLDER_CRED,
    "upstream.ts": PLACEHOLDER_UPSTREAM,
    "catalog.ts": PLACEHOLDER_CATALOG,
    "billing.ts": PLACEHOLDER_BILLING,
}


def write_placeholder(path: Path, name: str, cid: str, display: str) -> None:
    """写占位模块。

    ⚠ 用标记替换而非 `str.format` —— TypeScript 源码里全是 `{` `}`，
    format 会把它们当占位符（实测直接 KeyError）。
    """
    text = (
        PLACEHOLDERS[name]
        .replace("@DISPLAY@", display)
        .replace("@NAME@", name)
        .replace("@CID@", cid)
    )
    path.write_text(text, encoding="utf-8")


def package_json_for(cid: str, meta: dict[str, object], template: str) -> str:
    """按渠道生成 package.json（JSON 需真实处理，不能靠字符串替换）。"""
    data = json.loads(template)
    data["name"] = f"{cid}-bridge"
    data["version"] = "0.1.0"
    data["description"] = (
        f"{meta['display']} 的本地 OpenAI Chat Completion 透明代理网关"
        "（TypeScript，无窗口，ZCode 插件引擎）"
    )
    data["bin"] = {cid: "./dist/cli.js"}
    # 渠道特有的 npm 关键词
    keywords = ["gateway", "openai", "proxy", "cli", "typescript", cid]
    data["keywords"] = keywords
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def sync_channel(cid: str, meta: dict[str, object], *, check: bool) -> list[str]:
    project = ROOT / f"{cid}-bridge"
    src_dir = project / "src"
    if not src_dir.is_dir():
        return [f"[skip] {cid}-bridge：src/ 不存在"]

    subs = substitutions(cid, meta)
    changes: list[str] = []

    # 共享 TS 模块
    for name in SHARED_SRC:
        source = ROOT / SOURCE_CID / "src" / name
        if not source.is_file():
            changes.append(f"[warn] {cid}: 模板缺 src/{name}")
            continue
        want = substitute(source.read_text(encoding="utf-8"), subs)
        target = src_dir / name
        if check:
            current = target.read_text(encoding="utf-8") if target.is_file() else ""
            if current != want:
                changes.append(f"[drift] {cid}-bridge/src/{name}")
        else:
            if target.is_file() and target.read_text(encoding="utf-8") == want:
                continue
            target.write_text(want, encoding="utf-8")
            changes.append(f"[sync]  {cid}-bridge/src/{name}")

    # 根目录共享文件
    for name in SHARED_ROOT:
        source = ROOT / SOURCE_CID / name
        if not source.is_file():
            continue
        want = substitute(source.read_text(encoding="utf-8"), subs)
        target = project / name
        if check:
            current = target.read_text(encoding="utf-8") if target.is_file() else ""
            if current != want:
                changes.append(f"[drift] {cid}-bridge/{name}")
        else:
            if target.is_file() and target.read_text(encoding="utf-8") == want:
                continue
            target.write_text(want, encoding="utf-8")
            changes.append(f"[sync]  {cid}-bridge/{name}")

    # package.json（JSON 处理）
    template = (ROOT / SOURCE_CID / "package.json").read_text(encoding="utf-8")
    want_pkg = package_json_for(cid, meta, template)
    target_pkg = project / "package.json"
    if check:
        current = target_pkg.read_text(encoding="utf-8") if target_pkg.is_file() else ""
        same = False
        if current:
            try:
                same = json.loads(current) == json.loads(want_pkg)
            except ValueError:
                same = False
        if not same:
            changes.append(f"[drift] {cid}-bridge/package.json")
    else:
        if not (target_pkg.is_file() and target_pkg.read_text(encoding="utf-8") == want_pkg):
            target_pkg.write_text(want_pkg, encoding="utf-8")
            changes.append(f"[sync]  {cid}-bridge/package.json")

    # 渠道特有模块：缺失时写占位；**仍是占位则刷新**（占位模板会随契约演进而更新，
    # 不刷新会让老占位缺新成员、编译失败）。已实现的模块不动 —— 判据是占位签名。
    for name in CHANNEL_MODULES:
        target = src_dir / name
        if target.is_file():
            text = target.read_text(encoding="utf-8")
            is_stub = 'const TODO = "' in text
            if not is_stub:
                continue  # 已实现，不碰
            if check:
                changes.append(f"[stub?] {cid}-bridge/src/{name}（仍是占位）")
                continue
            write_placeholder(target, name, cid, str(meta["display"]))
            changes.append(f"[stub] {cid}-bridge/src/{name} 已刷新占位")
            continue
        if not check:
            write_placeholder(target, name, cid, str(meta["display"]))
            changes.append(f"[stub] {cid}-bridge/src/{name}")
        else:
            changes.append(f"[miss] {cid}-bridge/src/{name}")

    return changes


def main() -> int:
    check = "--check" in sys.argv
    wanted = [a for a in sys.argv[1:] if not a.startswith("--")]
    targets = wanted or list(CHANNELS)

    unknown = [t for t in targets if t not in CHANNELS]
    if unknown:
        print(f"未知渠道: {unknown}")
        return 2

    total = 0
    for cid in targets:
        for line in sync_channel(cid, CHANNELS[cid], check=check):
            print(line)
            total += 1
    print(f"\n{'漂移' if check else '变更'} {total} 项。")
    return 1 if (check and total) else 0


if __name__ == "__main__":
    sys.exit(main())
