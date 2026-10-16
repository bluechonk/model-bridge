#!/usr/bin/env node
/**
 * OrcaTerm 证据提取（只读，复现 [docs/FINDINGS.md](../docs/FINDINGS.md) 的方法论）。
 *
 * 从本机已安装的 OrcaTerm 数据目录里读出：
 *   - 登录 cookie（`ot_session`）与 `data.bin` 的登录态键
 *   - WebView2 Code Cache 里的端点/供应商字面量
 *
 * **只读，不联网，不改动任何文件。** 输出含真实凭据，仅限本机排查，切勿粘贴入库。
 *
 * 用法：node channels/orcaterm/research/extract-evidence.mjs
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const LOCAL = join(HOME, "AppData", "Local", "com.orcaterm-desktop.app");
const ROAMING = join(HOME, "AppData", "Roaming", "com.orcaterm-desktop.app");

const line = (s = "") => console.log(s);

function mask(s) {
  if (typeof s !== "string" || s.length <= 24) return s;
  return `${s.slice(0, 16)}…${s.slice(-8)}（共 ${s.length} 字符）`;
}

function decodeJwt(tok) {
  try {
    const [h, p] = tok.split(".");
    const dec = (x) => JSON.parse(Buffer.from(x, "base64url").toString("utf8"));
    return { header: dec(h), payload: dec(p) };
  } catch {
    return null;
  }
}

// ── 1. 登录 cookie ───────────────────────────────────────────────
line("== 1. `.cookies` 里的 ot_session ==");
const cookieFile = join(LOCAL, ".cookies");
if (existsSync(cookieFile)) {
  const raw = JSON.parse(readFileSync(cookieFile, "utf8"));
  for (const c of raw) {
    const name = (c.raw_cookie.match(/^([^=]+)=/) ?? [])[1];
    if (name === "ot_session") {
      const jwt = c.raw_cookie.match(/ot_session=([^;]+)/)?.[1] ?? "";
      const d = decodeJwt(jwt);
      line(`  domain : ${JSON.stringify(c.domain)}`);
      line(`  token  : ${mask(jwt)}`);
      if (d) {
        const { providerAccessToken, ...rest } = d.payload;
        line(`  payload: ${JSON.stringify(rest)}`);
        line(`  providerAccessToken: ${mask(providerAccessToken)}`);
      }
    } else {
      line(`  - ${name} @ ${JSON.stringify(c.domain)}`);
    }
  }
} else {
  line("  （未找到 .cookies）");
}

// ── 2. data.bin 登录态 ──────────────────────────────────────────
line("\n== 2. `data.bin` 登录态键 ==");
const dataFile = join(ROAMING, "data.bin");
if (existsSync(dataFile)) {
  const d = JSON.parse(readFileSync(dataFile, "utf8"));
  for (const k of ["oauth_access_token", "oauth_expires_at", "auth_identity", "auth_identity_updated_at", "userId", "userAccountType", "userAccountLoginMethod"]) {
    if (k in d) line(`  ${k} = ${k === "oauth_access_token" ? mask(d[k]) : d[k]}`);
  }
} else {
  line("  （未找到 data.bin）");
}

// ── 3. Code Cache 端点/供应商字面量 ─────────────────────────────
line("\n== 3. Code Cache 中的端点与供应商 ==");
const codeCache = join(LOCAL, "EBWebView", "Default", "Code Cache");
if (existsSync(codeCache)) {
  const pats = {
    "cgi 路径": /\/cgi\/[A-Za-z0-9_/.?=&-]{2,60}/g,
    "对话路径": /\/messages?[A-Za-z0-9_/-]{0,40}/g,
    "OAuth": /https:\/\/orcaterm\.com\/oauth\/[A-Za-z0-9_/?=&-]+/g,
    "供应商": /https:\/\/[A-Za-z0-9.-]+\/(?:anthropic|api\/anthropic|coding\/v[0-9]|api\/v[0-9]|v[0-9])[A-Za-z0-9/._-]*/g,
  };
  const hits = new Map(Object.keys(pats).map((k) => [k, new Set()]));
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const data = readFileSync(p);
        for (const [k, re] of Object.entries(pats)) {
          for (const m of data.toString("latin1").matchAll(re)) hits.get(k).add(m[0]);
        }
      }
    }
  };
  walk(codeCache);
  for (const [k, set] of hits) {
    line(`  [${k}]`);
    for (const s of [...set].sort()) line(`    ${s}`);
  }
} else {
  line("  （未找到 Code Cache —— 应用需先运行过一次）");
}

line("\n完成。敏感值已打码；完整凭据仅在 .cookies / data.bin 中，勿入库。");
