/**
 * 含密文件的写入：**临时文件 + 同目录 rename + 0600**。
 *
 * 为什么要单独一个模块：账号池（`accounts.json` / `accounts/<key>.json`）与签到台账
 * （`state/signin.json`）都是"写坏了会丢登录态/丢记录"的文件，必须同一套原子写 + 权限，
 * 而不是各写一遍。渠道自己的 `cred.save()` 也用同样的模式（见 STORAGE-CONVENTION.md §4.6）。
 *
 * 崩溃语义：写入过程中断只会留下一个 `.tmp`，目标文件要么是旧的完整内容、要么是新的完整内容。
 */

import { chmodSync, renameSync, writeFileSync } from "node:fs";

/** 原子写入（0600）。Windows 上 chmod 意义有限，忽略失败。 */
export function writeSecretFile(path: string, body: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

/** 原子写入 JSON（带缩进与结尾换行，便于人看 diff）。 */
export function writeJsonSecret(path: string, value: unknown): void {
  writeSecretFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
