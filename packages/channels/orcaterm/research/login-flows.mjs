#!/usr/bin/env node
/**
 * OrcaTerm 两条登录路径的可运行实现（微信扫码 / 腾讯云开放平台）。
 *
 * 结论来源见 ../docs/PROTOCOL.md §1 与 ../docs/FINDINGS.md。
 * 本脚本只发登录所需的请求，不落盘任何凭据（除非显式 --qr 输出二维码图片）。
 *
 * 用法：
 *   node login-flows.mjs wechat  [--qr out.png] [--wait] [--dry]
 *   node login-flows.mjs txcloud [--dry]
 *
 * 运行时输出为英文（仓库规范：运行时日志英文）。
 */

const ORCA = "https://orcaterm.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** 腾讯云开放平台给 OrcaTerm 的 app_id（客户端可见，非密钥）。 */
const TXCLOUD_APP_ID = "100045893348";
/** 微信开放平台给 OrcaTerm 的 appid（客户端可见，非密钥）。 */
const WECHAT_CONFIG = `${ORCA}/oauth/wechat/config?source=desktop`;

import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const mode = (args[0] ?? "").toLowerCase();
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res;
}

/** 微信分支：config → qrconnect → 二维码 → （可选）长轮询等扫码。 */
async function wechat() {
  const cfg = await (await get(WECHAT_CONFIG)).json();
  if (cfg.code !== 0) throw new Error(`config failed: ${JSON.stringify(cfg)}`);
  const { appid, redirect_uri, scope, state } = cfg.data;
  console.log(`[wechat] appid=${appid} state=${state}`);

  const qrConnect =
    "https://open.weixin.qq.com/connect/qrconnect" +
    `?appid=${appid}` +
    `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
    "&response_type=code" +
    `&scope=${scope}` +
    `&state=${state}`;
  console.log(`[wechat] qrconnect=${qrConnect}`);

  const xml = await (await get(qrConnect + "&f=xml")).text();
  const uuid = xml.match(/<uuid>(?:<!\[CDATA\[)?([^<\]]+)/)?.[1];
  if (!uuid) throw new Error(`uuid not found in XML: ${xml.slice(0, 200)}`);
  console.log(`[wechat] uuid=${uuid}`);

  const qrUrl = `https://open.weixin.qq.com/connect/qrcode/${uuid}`;
  if (flag("--dry")) {
    console.log(`[wechat] dry-run, qr=${qrUrl}`);
    return { appid, redirect_uri, scope, state, uuid, qrUrl };
  }

  const out = opt("--qr");
  if (out) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(out, Buffer.from(await (await get(qrUrl)).arrayBuffer()));
    console.log(`[wechat] qr saved -> ${out}`);
  }

  if (!flag("--wait")) return { appid, redirect_uri, scope, state, uuid, qrUrl };

  // 长轮询扫码状态：408 等待 / 404 已扫待确认 / 405 已确认 / 403 取消 / 402 过期
  const longPoll = `https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=${uuid}`;
  const deadline = Date.now() + 300_000;
  let last = "";
  while (Date.now() < deadline) {
    let text;
    try {
      text = await (await get(longPoll + (last ? `&last=${last}` : ""))).text();
    } catch (err) {
      console.log(`[wechat] poll error: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    const errcode = text.match(/wx_errcode\s*=\s*(\d+)/)?.[1] ?? "";
    if (errcode !== last && errcode) console.log(`[wechat] state=${errcode}`);
    if (errcode === "405") {
      const code = text.match(/wx_code\s*=\s*'([^']*)'/)?.[1];
      console.log(`[wechat] confirmed, wx_code=${code}`);
      return { appid, redirect_uri, scope, state, uuid, code };
    }
    if (errcode === "402" || errcode === "403") {
      console.log(`[wechat] terminated (${errcode === "402" ? "expired" : "canceled"})`);
      return { state, uuid, terminated: errcode };
    }
    last = errcode || last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("[wechat] timeout");
  return { state, uuid, timeout: true };
}

/** 在响应 JSON 里递归找 `AccessToken`（包层不固定，别写死路径）。 */
function findAccessToken(value) {
  if (Array.isArray(value)) return value.map(findAccessToken).find(Boolean) ?? "";
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "AccessToken" && typeof v === "string" && v.split(".").length === 3) return v;
      const hit = findAccessToken(v);
      if (hit) return hit;
    }
  }
  return "";
}

/**
 * 腾讯云分支：自建授权入口 + 用**自己生成的** `sessionId` 轮询换 token。
 *
 * 实测依据（见 ../docs/PROTOCOL.md §1.3）：`/oauth/authorize` 带任意 `session_id`
 * 即 302 到腾讯云授权页；浏览器登录完成后，`POST /cgi/api {action:OAuthExchangeToken}`
 * 用同一个 `sessionId` 即可换到 `AccessToken`。
 */
async function txcloud() {
  const sessionId = randomUUID();
  const entry = `${ORCA}/oauth/authorize?provider=txcloud&source=desktop&session_id=${sessionId}`;
  const res = await fetch(entry, { headers: { "User-Agent": UA }, redirect: "manual" });
  const loginUrl = res.headers.get("location") ?? "";
  console.log(`[txcloud] sessionId=${sessionId}`);
  console.log(`[txcloud] login_url=${loginUrl}`);
  if (flag("--dry")) return { sessionId, loginUrl };
  console.log("[txcloud] open the URL above, log in + authorize; polling for the token…");

  for (let i = 0; i < 300; i++) {
    const r = await fetch(`${ORCA}/cgi/api`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ action: "OAuthExchangeToken", data: { sessionId } }),
    });
    const json = await r.json().catch(() => ({}));
    const token = findAccessToken(json);
    if (token) {
      console.log(`[txcloud] AccessToken acquired (len ${token.length})`);
      return { sessionId, token };
    }
    if (i % 5 === 0) console.log(`[txcloud] waiting… ${JSON.stringify(json).slice(0, 120)}`);
    await new Promise((r2) => setTimeout(r2, 2000));
  }
  console.log("[txcloud] timeout");
  return { sessionId };
}

const run = mode === "wechat" ? wechat : mode === "txcloud" ? txcloud : null;
if (!run) {
  console.log("usage: node login-flows.mjs <wechat|txcloud> [--qr out.png] [--wait] [--state <uuid>] [--dry]");
  process.exit(2);
}
Promise.resolve(run()).catch((err) => {
  console.error(`[${mode}] failed: ${err.stack ?? err}`);
  process.exit(1);
});
