/**
 * 日志跟随的增量读取语义（`readAppended`）：完整行边界、截断重置、多字节安全。
 *
 * 只碰 mkdtemp 临时目录，完全离线；不启动任何网关进程。
 */

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { readAppended } from "../dist/daemon.js";

describe("logs --follow：增量读取 readAppended", () => {
  let dir: string;
  let file: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "mb-follow-"));
    file = join(dir, "gateway.log");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("半行不输出（含未写完的多字节字符）；补齐换行后整行产出", () => {
    writeFileSync(file, "");
    assert.deepEqual(readAppended(file, 0), { text: "", offset: 0 });

    appendFileSync(file, "中文"); // 无换行 = 半行
    assert.deepEqual(readAppended(file, 0), { text: "", offset: 0 });

    appendFileSync(file, "日志\n");
    const done = readAppended(file, 0);
    assert.equal(done.text, "中文日志\n", "多字节字符必须完整解码");
    assert.equal(done.offset, Buffer.byteLength("中文日志\n"));

    // 偏移已推进：再读为空，不重复输出
    assert.deepEqual(readAppended(file, done.offset), { text: "", offset: done.offset });
  });

  it("追加只产出新增部分（偏移量语义）", () => {
    writeFileSync(file, "第一行\n第二行\n");
    const first = readAppended(file, 0);
    assert.equal(first.text, "第一行\n第二行\n");

    appendFileSync(file, "第三行\n");
    const second = readAppended(file, first.offset);
    assert.equal(second.text, "第三行\n");
    assert.ok(second.offset > first.offset);
  });

  it("文件被截断（size < offset）时从 0 重读，不永久失明", () => {
    writeFileSync(file, "旧的旧行\n");
    const before = readAppended(file, 0);
    assert.equal(before.text, "旧的旧行\n");

    writeFileSync(file, "新起头\n"); // 截断重写：size 可能小于旧 offset
    const after = readAppended(file, before.offset);
    assert.equal(after.text, "新起头\n");
    assert.equal(after.offset, Buffer.byteLength("新起头\n"));
  });

  it("文件不存在时保持偏移（刚轮转的场景）", () => {
    assert.deepEqual(readAppended(join(dir, "missing.log"), 7), { text: "", offset: 7 });
  });
});
