/**
 * qoder-bridge 自检（离线，不出网）。
 *
 * 本渠道的 cred / upstream / catalog / billing **尚未实现**，是刻意让调用**立即
 * 失败并说明原因**的桩（见各模块文件头）。故本测试锁定两件事：
 *
 *  1. 渠道装配正确：共享 gateway 层通过 `setChannel()` 拿到本渠道，
 *     路径/展示名等静态配置就位。
 *  2. 桩语义正确：每个未实现函数**立即抛错且消息含指引**，而不是返回空值 ——
 *     返回空值会让网关看起来在工作（模型列表恒为空、请求静默失败），
 *     比直接报错更难排查。
 *
 * 数据目录用 QODER_HOME 隔离，绝不碰真实凭据。
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// 必须在 import 被测模块之前设置（paths 每次调用都重新解析存储根）
const HOME = mkdtempSync(join(tmpdir(), "qoder-selftest-"));
process.env["MODEL_BRIDGE_HOME"] = HOME;

// 共享层来自工作区包；先注册本渠道（副作用）再引渠道模块
const gw = await import("@model-bridge/gateway");
await import("../dist/channel.js");
const billing = await import("../dist/billing.js");
const catalog = await import("../dist/catalog.js");
const cred = await import("../dist/cred.js");
const upstream = await import("../dist/upstream.js");

/** 桩抛错的判据：消息里必须同时有「尚未实现」与实现依据指引。 */
const TODO_RE = /尚未实现/;
const GUIDE_RE = /PROTOCOL\.md/;

describe("1. 渠道装配", () => {
  it("注册进共享 gateway 层，静态配置就位", () => {
    assert.equal(gw.hasChannel(), true);
    const channel = gw.getChannel();
    assert.equal(channel.config.cid, "qoder");
    assert.equal(channel.config.display, "Qoder");
    assert.equal(channel.config.legacyDirs[0], ".qoder-bridge");
    assert.equal(channel.upstream.DISPLAY_NAME, "Qoder");
  });

  it("存储目录隔离在 MODEL_BRIDGE_HOME 下（不碰真实主目录）", () => {
    assert.equal(gw.paths.rootDir(), HOME);
    assert.equal(gw.paths.channelDir(), join(HOME, "qoder"));
    assert.equal(gw.paths.credentialsPath(), join(HOME, "qoder", "credentials.json"));
  });
});

describe("2. 桩语义：立即失败并说明原因（不返回空值）", () => {
  it("catalog 未实现即抛错", () => {
    assert.throws(() => catalog.exposedIds(), TODO_RE);
    assert.throws(() => catalog.resolveModel("any-model"), TODO_RE);
    assert.throws(() => catalog.exposedIds(), GUIDE_RE);
  });

  it("upstream 未实现即抛错", () => {
    assert.throws(() => upstream.defaultConfig(), TODO_RE);
    assert.throws(() => upstream.chatUrl(), TODO_RE);
    assert.throws(() => upstream.modelsUrl(), TODO_RE);
    assert.throws(() => upstream.buildHeaders({}), TODO_RE);
    assert.throws(() => upstream.buildChatBody({}, "m"), TODO_RE);
    assert.throws(() => upstream.resolveConfig({}), TODO_RE);
  });

  it("upstream 的异步接口未实现即拒绝", async () => {
    await assert.rejects(() => upstream.saveConfig({ baseUrl: "x" }), TODO_RE);
    await assert.rejects(() => upstream.fetchModels({}), TODO_RE);
  });

  it("cred 未实现即抛错/拒绝", async () => {
    assert.throws(() => cred.load(), TODO_RE);
    assert.throws(() => cred.resolveBaseUrl(), TODO_RE);
    assert.equal(cred.DEFAULT_BASE_URL, "https://example.invalid", "占位基址不得指向真实服务");
    await assert.rejects(() => cred.save({ accessToken: "t", uid: "u", domain: "" }), TODO_RE);
    await assert.rejects(() => cred.login("https://example.invalid"), TODO_RE);
    await assert.rejects(() => cred.refresh({ accessToken: "t", uid: "u", domain: "" }), TODO_RE);
  });

  it("billing 未实现即拒绝", async () => {
    await assert.rejects(() => billing.fetchCredits(), TODO_RE);
  });
});
