/**
 * `@model-bridge/gateway` 共享层自检（离线，不出网）。
 *
 * 覆盖登录原语（`login.ts`）与三类流程骨架（`login-flow.ts`）——
 * 这两模块是各渠道登录逻辑下沉后的公共地基，必须自己先站得住。
 *
 * ⚠ 不测 `openBrowser()`：它会真的拉起系统浏览器（副作用），
 * 由各渠道的端到端链路覆盖「调用它不阻塞流程」这一点。
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";

import * as login from "../dist/login.js";
import * as flow from "../dist/login-flow.js";

// ── 假 JWT（不验签，只造 payload）──────────────────────────────────────────────

function fakeJwt(payload: Record<string, unknown>, prefix = ""): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${prefix}header.${body}.sig`;
}

describe("1. URL 与取值工具", () => {
  it("hostOf：去 scheme、去 path/query", () => {
    assert.equal(login.hostOf("https://example.com/path?q=1"), "example.com");
    assert.equal(login.hostOf("https://example.com"), "example.com");
    assert.equal(login.hostOf("https://example.com/path"), "example.com");
    assert.equal(login.hostOf("example.com/x"), "example.com");
    assert.equal(login.hostOf("https://host:8443/a"), "host:8443");
  });

  it("str：只放行字符串", () => {
    assert.equal(login.str("a"), "a");
    assert.equal(login.str(""), "");
    assert.equal(login.str(undefined), "");
    assert.equal(login.str(123), "");
    assert.equal(login.str(null), "");
  });

  it("nowIso 是合法 ISO 串", () => {
    assert.ok(Number.isFinite(Date.parse(login.nowIso())));
  });
});

describe("2. JWT 解析（不验签）", () => {
  it("decodeJwtPayload 取 payload；非 JWT 返回 {}", () => {
    assert.deepEqual(login.decodeJwtPayload(fakeJwt({ sub: "u-1", exp: 1900000000 })), {
      sub: "u-1",
      exp: 1900000000,
    });
    assert.deepEqual(login.decodeJwtPayload("not-a-jwt"), {});
    assert.deepEqual(login.decodeJwtPayload("a.!!!invalid!!!.c"), {});
  });

  it("decodeJwtPayload 支持剥离令牌前缀", () => {
    const token = fakeJwt({ sub: "u-2" }, "token-");
    assert.deepEqual(login.decodeJwtPayload(token, "token-"), { sub: "u-2" });
    // 前缀不含点时，parts[1] 仍是 payload —— 剥前缀是防御性写法
    assert.deepEqual(login.decodeJwtPayload(token), { sub: "u-2" });
    // 前缀含点时**必须**剥离，否则会把前缀片段当成 payload 段
    const dotted = fakeJwt({ sub: "u-3" }, "v1.0-");
    assert.deepEqual(login.decodeJwtPayload(dotted, "v1.0-"), { sub: "u-3" });
    assert.deepEqual(login.decodeJwtPayload(dotted), {});
  });

  it("jwtExpMs 返回毫秒；缺失返回 0", () => {
    assert.equal(login.jwtExpMs(fakeJwt({ exp: 1900000000 })), 1_900_000_000_000);
    assert.equal(login.jwtExpMs(fakeJwt({ exp: "1900000000" })), 1_900_000_000_000);
    assert.equal(login.jwtExpMs(fakeJwt({})), 0);
    assert.equal(login.jwtExpMs("garbage"), 0);
  });

  it("jwtSubject 取 sub；缺失返回空串", () => {
    assert.equal(login.jwtSubject(fakeJwt({ sub: "acct-9" })), "acct-9");
    assert.equal(login.jwtSubject(fakeJwt({})), "");
  });
});

describe("3. 时间归一化", () => {
  it("parseExpireTime：秒 / 毫秒 / 数字串 / 日期串", () => {
    assert.equal(login.parseExpireTime(1_900_000_000), 1_900_000_000_000, "秒 → 毫秒");
    assert.equal(login.parseExpireTime(1_900_000_000_000), 1_900_000_000_000, "毫秒原样");
    assert.equal(login.parseExpireTime("1900000000"), 1_900_000_000_000, "数字串（秒）");
    assert.equal(login.parseExpireTime("1900000000000"), 1_900_000_000_000, "数字串（毫秒）");
    assert.equal(
      login.parseExpireTime("2030-01-01T00:00:00Z"),
      Date.parse("2030-01-01T00:00:00Z"),
      "日期串",
    );
  });

  it("parseExpireTime：无法解析 / 非正数返回 null", () => {
    assert.equal(login.parseExpireTime(undefined), null);
    assert.equal(login.parseExpireTime(null), null);
    assert.equal(login.parseExpireTime(""), null);
    assert.equal(login.parseExpireTime("   "), null);
    assert.equal(login.parseExpireTime("not-a-date"), null);
    assert.equal(login.parseExpireTime(0), null);
    assert.equal(login.parseExpireTime(-5), null);
  });

  it("resolveExpiresAtMs：显式字段优先，回落 JWT，都没有返回 null", () => {
    const token = fakeJwt({ exp: 1900000000 });
    assert.equal(login.resolveExpiresAtMs("2030-01-01T00:00:00Z", token), Date.parse("2030-01-01T00:00:00Z"));
    assert.equal(login.resolveExpiresAtMs(undefined, token), 1_900_000_000_000, "回落到 JWT exp");
    assert.equal(login.resolveExpiresAtMs(undefined, "garbage"), null);
  });

  it("isExpiredAt：空值视为未过期；leadMs 提前判", () => {
    assert.equal(login.isExpiredAt(null), false, "无从判断 → 不冒充已失效");
    assert.equal(login.isExpiredAt(undefined), false);
    assert.equal(login.isExpiredAt(0), false);
    assert.equal(login.isExpiredAt(Number.NaN), false);
    assert.equal(login.isExpiredAt(Date.now() - 1000), true, "已过期");
    assert.equal(login.isExpiredAt(Date.now() + 60_000), false, "未过期");
    assert.equal(login.isExpiredAt(Date.now() + 1000, 5000), true, "提前 5s 判过期");
  });
});

describe("4. 网络：fetchWithTimeout", () => {
  it("正常请求返回响应", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const resp = await login.fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, 2000);
      assert.equal(resp.status, 200);
      assert.equal(await resp.text(), "ok");
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("超时抛错（不无限挂起）", async () => {
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end("late");
      }, 1000);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      await assert.rejects(() => login.fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, 60));
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("5. 编码与令牌前缀", () => {
  it("randomHex / sha256Hex / b64url", () => {
    assert.equal(login.randomHex(16).length, 32);
    assert.match(login.randomHex(16), /^[0-9a-f]{32}$/);
    assert.notEqual(login.randomHex(16), login.randomHex(16), "随机性");
    assert.equal(
      login.sha256Hex("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    assert.equal(login.b64url("hi"), Buffer.from("hi").toString("base64url"));
  });

  it("stripTokenPrefix / ensureTokenPrefix", () => {
    assert.equal(login.stripTokenPrefix("token-abc", "token-"), "abc");
    assert.equal(login.stripTokenPrefix("abc", "token-"), "abc");
    assert.equal(login.stripTokenPrefix("abc", ""), "abc");
    assert.equal(login.ensureTokenPrefix("abc", "token-"), "token-abc");
    assert.equal(login.ensureTokenPrefix("token-abc", "token-"), "token-abc", "不重复加");
    assert.equal(login.ensureTokenPrefix("", "token-"), "");
  });
});

describe("6. 骨架 A：本地回调服务器", () => {
  it("取 query 参数（同名取第一个）", async () => {
    const srv = await flow.startCallbackServer();
    try {
      const waiting = srv.wait(5000);
      await fetch(`http://127.0.0.1:${srv.port}/callback?code=C1&state=S1&code=C2`);
      const params = await waiting;
      assert.equal(params["code"], "C1", "同名取第一个");
      assert.equal(params["state"], "S1");
    } finally {
      srv.close();
    }
  });

  it("pathPrefix 之外回 404 且不结算", async () => {
    const srv = await flow.startCallbackServer({ pathPrefix: "/authorize" });
    try {
      const resp = await fetch(`http://127.0.0.1:${srv.port}/other?code=X`);
      assert.equal(resp.status, 404);
      const waiting = srv.wait(5000);
      await fetch(`http://127.0.0.1:${srv.port}/authorize?code=OK`);
      assert.equal((await waiting)["code"], "OK");
    } finally {
      srv.close();
    }
  });

  it("端口被占用时退到随机端口（调用方须用返回的 port）", async () => {
    const busy = createServer(() => {});
    await new Promise<void>((r) => busy.listen(0, "127.0.0.1", () => r()));
    const busyPort = (busy.address() as { port: number }).port;
    try {
      const srv = await flow.startCallbackServer({ port: busyPort });
      try {
        assert.notEqual(srv.port, busyPort, "已退到别的端口");
        assert.ok(srv.port > 0);
      } finally {
        srv.close();
      }
    } finally {
      await new Promise<void>((r) => busy.close(() => r()));
    }
  });

  it("超时抛错", async () => {
    const srv = await flow.startCallbackServer();
    try {
      await assert.rejects(() => srv.wait(50), /超时/);
    } finally {
      srv.close();
    }
  });

  it("close() 让未结算的 wait 拒绝（不挂起）", async () => {
    const srv = await flow.startCallbackServer();
    const waiting = srv.wait(5000);
    srv.close();
    await assert.rejects(() => waiting, /已关闭/);
  });
});

describe("7. 骨架 B：flow 轮询", () => {
  const noSleep = async (): Promise<void> => {};

  it("done 立即返回", async () => {
    let calls = 0;
    const value = await flow.pollFlow<number>({
      intervalMs: 1,
      windowMs: 1000,
      sleep: noSleep,
      attempt: async () => {
        calls += 1;
        return { kind: "done", value: 42 };
      },
    });
    assert.equal(value, 42);
    assert.equal(calls, 1);
  });

  it("pending 后 done；attempt 抛错按 retry 处理", async () => {
    let calls = 0;
    const value = await flow.pollFlow<string>({
      intervalMs: 1,
      windowMs: 1000,
      sleep: noSleep,
      attempt: async () => {
        calls += 1;
        if (calls === 1) return { kind: "pending" };
        if (calls === 2) throw new Error("网络抖动");
        return { kind: "done", value: "ok" };
      },
    });
    assert.equal(value, "ok");
    assert.equal(calls, 3, "抛错不终止，继续重试");
  });

  it("fatal 立即抛出", async () => {
    await assert.rejects(
      () =>
        flow.pollFlow({
          intervalMs: 1,
          windowMs: 1000,
          sleep: noSleep,
          attempt: async () => ({ kind: "fatal" as const, error: new Error("授权被拒") }),
        }),
      /授权被拒/,
    );
  });

  it("超时抛错", async () => {
    await assert.rejects(
      () =>
        flow.pollFlow({
          intervalMs: 1,
          windowMs: 30,
          sleep: async (ms) => new Promise<void>((r) => setTimeout(r, ms)),
          attempt: async () => ({ kind: "pending" as const }),
        }),
      /超时/,
    );
  });
});

describe("8. 骨架 C：设备码 / 扫码轮询", () => {
  it("done 立即返回", async () => {
    const value = await flow.pollDeviceCode<string>({
      intervalMs: 1,
      expiresInSec: 5,
      sleep: async () => {},
      attempt: async () => ({ kind: "done", value: "tok" }),
    });
    assert.equal(value, "tok");
  });

  it("slow_down 累积抬高间隔（不重置）", async () => {
    const seen: number[] = [];
    let calls = 0;
    await flow.pollDeviceCode({
      intervalMs: 1000,
      expiresInSec: 60,
      slowDownStepMs: 500,
      sleep: async (ms) => {
        seen.push(ms);
      },
      attempt: async () => {
        calls += 1;
        if (calls <= 2) return { kind: "slow_down" as const };
        return { kind: "done" as const, value: null };
      },
    });
    assert.deepEqual(seen, [1500, 2000], "两次 slow_down 各抬高一档（累积而非重置）");
    assert.equal(calls, 3);
  });

  it("连续网络失败超过上限即抛错", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        flow.pollDeviceCode({
          intervalMs: 1,
          expiresInSec: 60,
          maxConsecutiveFailures: 3,
          sleep: async () => {},
          attempt: async () => {
            calls += 1;
            throw new Error("ECONNREFUSED");
          },
        }),
      /连续 3 次网络失败/,
    );
    assert.equal(calls, 3);
  });

  it("fatal 立即抛出", async () => {
    await assert.rejects(
      () =>
        flow.pollDeviceCode({
          intervalMs: 1,
          expiresInSec: 60,
          sleep: async () => {},
          attempt: async () => ({ kind: "fatal" as const, error: new Error("expired_token") }),
        }),
      /expired_token/,
    );
  });

  it("过期即抛错", async () => {
    await assert.rejects(
      () =>
        flow.pollDeviceCode({
          intervalMs: 1,
          expiresInSec: 0,
          sleep: async () => {},
          attempt: async () => ({ kind: "pending" as const }),
        }),
      /超时/,
    );
  });
});
