/**
 * `killTree` 必须**等进程真的死掉**再返回。
 *
 * win32 的 taskkill 是异步的：「发出去就返回」会让紧随其后的 `start()` 探到
 * 还活着的旧进程 → 报「已在运行」却不换代码（实测踩过：`restart` 声称成功，
 * 端口上跑的还是旧进程）。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, describe, it } from "node:test";

import { killTree } from "../dist/daemon.js";

/** 存活探测（与 daemon 内部同款判据）。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("killTree", () => {
  const spawned: number[] = [];

  after(() => {
    for (const pid of spawned) {
      if (alive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* 已退出 */
        }
      }
    }
  });

  it("真进程：返回 true 时进程必须已经死了", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const pid = child.pid;
    assert.ok(pid, "子进程应当有 PID");
    spawned.push(pid);
    assert.equal(alive(pid), true, "子进程应当已启动");

    const dead = await killTree(pid);
    assert.equal(dead, true, "killTree 应当报「已死」");
    assert.equal(alive(pid), false, "killTree 返回后进程不应再存活");
  });

  it("不存在的 PID：视为已死（返回 true）", async () => {
    const dead = await killTree(2 ** 30);
    assert.equal(dead, true);
  });
});
