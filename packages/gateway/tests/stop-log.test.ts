/**
 * `stop` 的终止记录：成功停掉守护进程后，往该 scope 的日志追加一行
 * `{"event":"stop","pid":…}` —— 日志平时只有网关子进程自己写的 start/ready，
 * 不补这行时间线就没有“下线”痕迹（手动停与崩溃分不出来）。
 *
 * 完全离线：只起一个本地 dummy 进程当“网关”，不碰网络与真实主目录。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { stop } from "../dist/daemon.js";

describe("stop：终止记录写入日志", () => {
  let root = "";
  let savedRoot: string | undefined;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "mb-stoplog-"));
    savedRoot = process.env["MODEL_BRIDGE_HOME"];
    process.env["MODEL_BRIDGE_HOME"] = root;
  });
  after(() => {
    if (savedRoot === undefined) delete process.env["MODEL_BRIDGE_HOME"];
    else process.env["MODEL_BRIDGE_HOME"] = savedRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it("成功停止后日志追加 stop 行（原有内容保留），PID 文件清除", async () => {
    // 一个活着的本地进程冒充网关守护进程
    const dummy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
      const pidPath = join(root, "gateway.pid");
      const logPath = join(root, "gateway.log");
      writeFileSync(pidPath, String(dummy.pid), "utf8");
      writeFileSync(logPath, `{"event":"ready","gateway":"http://127.0.0.1:8787"}\n`, "utf8");

      const code = await stop({ quiet: true });
      assert.equal(code, 0, "stop 应成功");
      assert.ok(!existsSync(pidPath), "PID 文件应被清除");
      const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");
      assert.equal(lines[0], `{"event":"ready","gateway":"http://127.0.0.1:8787"}`, "原有日志必须保留");
      const last = JSON.parse(lines[lines.length - 1] ?? "{}") as { event?: string; pid?: number };
      assert.equal(last.event, "stop", "末行应是终止记录");
      assert.equal(last.pid, dummy.pid, "终止记录要带被停的 PID");
    } finally {
      dummy.kill("SIGKILL"); // 兜底：killTree 失败时也别留孤儿进程
    }
  });

  it("进程已死（PID 失效）也如实补记录，不误报失败", async () => {
    const pidPath = join(root, "gateway.pid");
    const logPath = join(root, "gateway.log");
    // 起一个立刻退出的进程，拿到一个已死亡的 pid 写进 PID 文件
    const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const gonePid = gone.pid ?? 0;
    await new Promise((r) => gone.once("exit", r));
    writeFileSync(pidPath, String(gonePid), "utf8");
    writeFileSync(logPath, "", "utf8");

    const code = await stop({ quiet: true });
    assert.equal(code, 0, "已死的实例按已停止处理");
    const last = readFileSync(logPath, "utf8").trim();
    assert.ok(last.includes(`"event":"stop"`), `日志应有终止记录：${last}`);
  });
});
