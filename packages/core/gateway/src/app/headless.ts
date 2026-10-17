/**
 * 无窗口（headless）运行时：`login` / `serve` 子命令的实现。
 *
 * 与桌面窗口模式平行的入口层：登录/网关/控制台逻辑全部复用
 * auth-flow / cred / gateway / console，只把界面替换为 stdout 输出
 * （人类可读，或 `--json` 事件行供插件解析）与内存状态机。
 *
 * 渠道差异由注册的 `Channel` 提供。
 */

import * as authFlow from "../auth/auth-flow.js";
import { startAutoSignin } from "../auth/auto-signin.js";
import { syncPool } from "../runtime/account-pool.js";
import { runInChannel } from "../runtime/channel-context.js";
import { channels, getChannel, type Channel } from "../runtime/channel.js";
import * as console_ from "../http/console.js";
import * as gateway from "../http/gateway.js";
import { REPO_UI_PREFIX } from "../runtime/cli-consts.js";
import { credentialsPath } from "../runtime/paths.js";

/** 输出一行 JSON 事件。解析方应跳过无法解析的行（第三方库也可能打印 stdout）。 */
function emit(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event));
}

/** `auth-flow.LoginUi` 协议的无界面实现：状态打到 stdout。 */
class StdoutLoginUi implements authFlow.LoginUi {
  authUrl = "";
  constructor(
    private readonly jsonMode: boolean,
    /** 多渠道路由时带上渠道 id，便于解析方区分（单渠道为 undefined）。 */
    private readonly cid?: string,
    /**
     * 额外观察者。控制台触发的登录没有终端可看，必须把状态同步进
     * `ServiceState`，否则 `GET /web/api/state` 的 auth_url 恒为空 ——
     * 页面承诺「授权链接通过轮询获取」却永远等不到。
     */
    private readonly observer?: authFlow.LoginUi,
  ) {}

  setState(state: string, message = "", url = ""): void {
    if (url) this.authUrl = url;
    this.observer?.setState(state, message, url);
    const tag = this.cid ? `[${this.cid}] ` : "";
    if (this.jsonMode) {
      const event: Record<string, unknown> = { event: "login", state, message };
      if (this.cid) event["cid"] = this.cid;
      if (url) event["auth_url"] = url;
      emit(event);
    } else {
      console.log(`[login] ${tag}${state}: ${message}`);
      // 裸 URL 单独成行：终端里可 Ctrl+点击直接打开，也可整行复制（带前缀会被一起复制走）
      if (url) console.log(url);
    }
  }
}

/** serve 模式的状态机 + 控制台桥（无界面部分）。 */
class ServiceState {
  readonly base: string;
  readonly baseUrl: string;
  readonly chatUrl: string;
  private uiState = "probing"; // 状态取值（英文枚举）：probing / login / error / running
  private stateMessage = "";
  private authUrl = "";
  private gatewayError = "";
  private modelsShown: string[] = [];
  retryRequested = false;
  quitting = false;

  constructor(addr: string) {
    const described = gateway.describe(addr);
    this.base = described.base;
    this.baseUrl = `${described.url}/v1`;
    this.chatUrl = `${described.url}/v1/chat/completions`;
  }

  setState(state: string, message = "", url = ""): void {
    this.uiState = state;
    this.stateMessage = message;
    if (url) this.authUrl = url; // 后续状态不带 url 时沿用上一条授权链接
    if (state === "running") this.gatewayError = "";
  }

  setGatewayError(error: string): void {
    this.gatewayError = error;
  }

  snapshot(): console_.UiSnapshot {
    const base = console_.emptySnapshot();
    return {
      ...base,
      ui_state: this.uiState,
      message: this.stateMessage,
      auth_url: this.authUrl,
      base_url: this.baseUrl,
      chat_url: this.chatUrl,
      models: [...this.modelsShown],
      gateway_error: this.gatewayError,
    };
  }

  setModels(ids: string[]): void {
    this.modelsShown = ids;
  }
}

/** 无窗口完成登录并保存凭证；成功返回 0。 */
export async function runLogin(options: {
  force?: boolean;
  json?: boolean;
  realm?: string;
  /** 渠道 id（多渠道路由时必须给；单渠道可省）。 */
  cid?: string;
  /** 微信扫码登录（渠道声明 `cred.loginWechat` 才支持，如 loomy）。 */
  wechat?: boolean;
  /**
   * 状态观察者：把登录状态额外同步给调用方（控制台需要它填 `auth_url`）。
   * 省略时行为与以前一致，只打 stdout。
   */
  observer?: authFlow.LoginUi;
} = {}): Promise<number> {
  const { force = false, json = false, realm = "auto", cid, wechat = false, observer } = options;
  const target = getChannel(cid);
  const { cred } = target;
  if (force) {
    try {
      const fs = await import("node:fs");
      fs.unlinkSync(credentialsPath(cid));
    } catch {
      /* 本来就没有 */
    }
  }

  // 微信路径：渠道自己声明了 loginWechat 才能走（共享层不含渠道知识）
  if (wechat) {
    const loginWechat = (cred as { loginWechat?: (baseUrl?: string, options?: Record<string, unknown>) => Promise<unknown> }).loginWechat;
    if (!loginWechat) {
      console.error(`[login] channel ${target.config.cid} does not support --wechat login`);
      return 1;
    }
    const ui = new StdoutLoginUi(json, cid, observer);
    if (json) emit({ event: "start", mode: "login", force, realm, wechat: true, ...(cid ? { cid } : {}) });
    let ok = false;
    try {
      await runInChannel(target.config.cid, () =>
        loginWechat.call(cred, cred.resolveBaseUrl(realm), {
          onUrl: (url: string) => ui.setState("login", "open this URL and scan the QR code with WeChat", url),
          onStatus: (msg: string) => ui.setState("login", msg),
        }),
      );
      ok = true;
    } catch (err) {
      ui.setState("error", `wechat login failed: ${String(err)}`);
    }
    if (ok && target) runInChannel(target.config.cid, () => syncPool(target.config.cid));
    if (json) {
      const done: Record<string, unknown> = { event: "done", ok };
      if (ui.authUrl) done["auth_url"] = ui.authUrl;
      if (ok) {
        try {
          const c = cred.load();
          done["uid"] = c.uid;
          done["domain"] = c.domain;
          done["obtained_at"] = (c as { obtainedAt?: string }).obtainedAt ?? "";
        } catch {
          /* 读不到就不附 */
        }
      }
      emit(done);
    } else if (ok) {
      console.log("[login] done.");
    }
    return ok ? 0 : 1;
  }

  const ui = new StdoutLoginUi(json, cid, observer);
  if (json) emit({ event: "start", mode: "login", force, realm, ...(cid ? { cid } : {}) });

  // 已有凭据且未 force：login 是幂等的，不会重新授权 —— 必须明确说清，
  // 否则用户看到 "done" 以为重登成功，实际用的还是旧凭据（实测踩过：
  // codearts token 过期后 `login` 秒回 done，浏览器根本没开）。
  if (!force) {
    let existing: ReturnType<typeof cred.load> | null = null;
    try {
      existing = runInChannel(target.config.cid, () => cred.load());
    } catch {
      /* 未登录：走正常登录流程 */
    }
    if (existing) {
      const uid = (existing as { uid?: string }).uid ?? "";
      if (json) {
        emit({ event: "done", ok: true, already_logged_in: true, note: "use `relogin` to re-authorize" });
      } else {
        console.log(
          `[login] 已有凭据${uid ? `（uid ${uid}）` : ""}，未做任何操作；` +
            `要重新授权（如 token 过期）用：mx relogin ${cid ?? "<cid>"}`,
        );
      }
      return 0;
    }
  }

  const ok = await runInChannel(target.config.cid, () =>
    authFlow.ensureLogin(ui, {
      interactive: true,
      baseUrl: cred.resolveBaseUrl(realm),
      ...(cid !== undefined ? { cid } : {}),
    }),
  );

  // 登录即入池：把刚拿到的凭证收进账号池（幂等；失败不影响登录结果）。
  // ⚠ 必须包 `runInChannel`：`syncPool` 内部走 `cred.load()` → `paths.*`，
  // 而这些在多渠道模式下靠 ALS 上下文才知道为谁解析。裸调用会静默收不到
  // （`loadLive` 的 catch 吞掉「无上下文」），表现为「登录了但池子是空的」。
  if (ok && target) runInChannel(target.config.cid, () => syncPool(target.config.cid));

  if (json) {
    const done: Record<string, unknown> = { event: "done", ok };
    if (ui.authUrl) done["auth_url"] = ui.authUrl;
    if (ok) {
      try {
        const c = cred.load();
        done["uid"] = c.uid;
        done["domain"] = c.domain;
        // obtainedAt 是可选字段（契约只要求 accessToken/uid/domain）
        done["obtained_at"] = (c as { obtainedAt?: string }).obtainedAt ?? "";
      } catch {
        /* 读不到就不附 */
      }
    }
    emit(done);
  } else if (ok) {
    console.log("[login] done.");
  }
  return ok ? 0 : 1;
}

export interface ServeOptions {
  addr: string;
  /** 已废弃：单端口模式下控制台与网关共用 `addr`，此字段仅保留签名兼容。 */
  uiPort?: number;
  verbose: boolean;
  ensureLogin?: boolean;
  forceLogin?: boolean;
  json?: boolean;
  consoleEnabled?: boolean;
  realm?: string;
  /** 渠道 id：指定则只服务该渠道；省略 = 全部已注册渠道（仓库级网关）。 */
  cid?: string;
}

/**
 * 无窗口运行：控制台（可选）+ 登录检查 + 网关，直到进程被终止。
 *
 * 默认只**被动探测**登录状态；`ensureLogin`/`forceLogin` 时未登录会引导
 * 交互授权 —— 授权链接打到 stdout（不自动打开浏览器，由用户自行打开）。
 *
 * 多渠道路由（未指定 `cid` 且注册了多个渠道）时：逐个渠道探测/引导登录，
 * **任一渠道登录成功即启动网关** —— 未登录的渠道在请求时由网关返回 503
 * `not_authenticated`，不影响其它渠道。
 */
export async function runServe(options: ServeOptions): Promise<number> {
  const {
    addr,
    verbose,
    ensureLogin = false,
    forceLogin = false,
    json = false,
    consoleEnabled = true,
    realm = "auto",
    cid,
  } = options;
  const targets: Channel[] = cid !== undefined ? [getChannel(cid)] : channels();
  const multi = targets.length > 1;
  const prefix = `[${gateway.serviceName(cid)}]`;

  const state = new ServiceState(addr);
  if (json) emit({ event: "start", mode: "serve", addr, ui_prefix: REPO_UI_PREFIX, ...(cid ? { cid } : {}) });

  const bridge: console_.ControlBridge = {
    provider: () => state.snapshot(),
    setTheme: () => {}, // 无窗口模式没有主题
    retryLogin: () => {
      state.retryRequested = true;
    },
    // 控制台的「登录」按钮经此回调触发真实登录流程（本函数在 app 层，
    // 控制台层不认识它 —— 见 scripts/verify-layering.mjs）
    triggerLogin: (cid, force) => {
      // 把 state 当观察者传给登录流程：控制台没有 stdout 可看，
      // 授权链接必须落到 `/web/api/state`，否则页面永远等不到 auth_url。
      void runLogin({ cid, force, json: true, realm: "auto", observer: state }).catch(() => {
        // 登录失败会反映在后续 /web/api/state 的 auth_url 或 gateway_error 上
      });
    },
  };
  // 单端口模式：控制台 handler 挂载进网关的 /web 前缀（不再起独立 server）。
  // `consoleEnabled=false`（--no-console）时不注入，网关保持纯 API 行为。
  const consoleHandler = consoleEnabled
    ? console_.createConsoleHandler(bridge, REPO_UI_PREFIX)
    : null;

  let running: gateway.RunningGateway | null = null;
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    state.quitting = true;
    await running?.close().catch(() => {});
  };

  // 终止源统一化：SIGINT/SIGTERM/SIGHUP 与「监督者消失（IPC 断开）」都汇入 stopped，
  // 走同一条优雅停机。监督者场景：spawn 带 IPC fd（stdio 第 4 项），监督者被杀即触发
  // disconnect —— worker 干净离场、无人重生（见 docs/DAEMON-SUPERVISOR.md §4）。
  // 裸 `mx serve` 无 IPC，不挂此钩子，保持纯信号语义。
  let stopSignalled = (): void => {};
  const stopped = new Promise<void>((resolve) => {
    stopSignalled = resolve;
  });
  let stopReason: string | undefined;
  process.on("SIGINT", stopSignalled);
  process.on("SIGTERM", stopSignalled);
  process.on("SIGHUP", stopSignalled);
  if (typeof process.send === "function") {
    // IPC 场景 = 有监督进程：① 父端主动断开（disconnect）可瞬时感知；
    // ② 但 Windows 下父进程被杀/自退不保证触发 disconnect（实测），故叠加
    //    应用层心跳超时 —— 收不到监督者的 supervisor-ping 即判父死，保证收敛。
    let lastPing = Date.now();
    process.on("message", (m: unknown) => {
      if (m && typeof m === "object" && (m as { type?: string }).type === "supervisor-ping") {
        lastPing = Date.now();
      }
    });
    process.once("disconnect", () => {
      stopReason = "supervisor-gone";
      stopSignalled();
    });
    const WATCHDOG_MS = 8_000;
    const watchdog = setInterval(() => {
      if (Date.now() - lastPing > WATCHDOG_MS) {
        stopReason = "supervisor-gone";
        stopSignalled();
      }
    }, 2_000);
    watchdog.unref(); // 不阻碍 shutdown 后的事件循环清空退出
  }

  // 登录 + 网关：成功前按 retry 循环（未登录时控制台仍可用）
  const worker = async (): Promise<void> => {
    for (;;) {
      let anyOk = false;
      for (const channel of targets) {
        const { cred } = channel;
        const ui = new StdoutLoginUi(json, multi ? channel.config.cid : cid);
        const ok = await runInChannel(channel.config.cid, () =>
          authFlow.ensureLogin(ui, {
            interactive: ensureLogin || forceLogin,
            ...(ensureLogin || forceLogin ? { baseUrl: cred.resolveBaseUrl(realm) } : {}),
            cid: channel.config.cid,
          }),
        );
        if (ok) anyOk = true;
        if (multi && !json) {
          console.log(`${prefix} [${channel.config.cid}] ${ok ? "logged in" : "not logged in"}`);
        }
        if (state.quitting) return;
      }
      if (state.quitting) return;
      if (anyOk) break;
      // 等「重试登录」意图（或进程被终止）
      while (!state.retryRequested && !state.quitting) {
        await new Promise((r) => setTimeout(r, 500));
      }
      state.retryRequested = false;
      if (state.quitting) return;
    }
    if (state.quitting) return;
    try {
      running = await gateway.start(addr, {
        verbose,
        logger: (m) => console.error(`${prefix} ${m}`),
        ...(consoleHandler ? { console: consoleHandler, consolePrefix: REPO_UI_PREFIX } : {}),
      });
    } catch (err) {
      state.setGatewayError(String(err));
      state.setState("error", `gateway start failed: ${String(err)}`);
      if (json) emit({ event: "error", message: `gateway start failed: ${String(err)}` });
      return;
    }
    state.setState("running");
    if (json) {
      emit({
        event: "ready",
        gateway: `http://${state.base}`,
        console: consoleEnabled ? `http://${state.base}${REPO_UI_PREFIX}/` : "",
      });
    }
    // 网关 ready 即挂自动签到：逐渠道（未登录跳过 / 台账已签跳过 / 连败 3 次当日熔断）
    startAutoSignin((m) => console.error(`${prefix} ${m}`));

    // 目录保鲜：每天后台重拉一次各渠道模型目录（实现了 catalog.refresh 的渠道才拉），
    // 渠道上游加了新模型时无需手动 `--refresh`。失败静默保留旧表（下次再试）。
    const CATALOG_REFRESH_MS = 24 * 60 * 60 * 1000;
    const catalogTimer = setInterval(() => {
      if (state.quitting) return;
      for (const channel of targets) {
        const refresh = channel.catalog.refresh;
        if (!refresh) continue; // 内置表渠道没有远端目录层
        void runInChannel(channel.config.cid, () => refresh.call(channel.catalog)).catch(() => {
          /* 拉取失败：旧表继续用，下个周期再试 */
        });
      }
    }, CATALOG_REFRESH_MS);
    catalogTimer.unref?.(); // 不阻止进程退出
    // 运行态轮询本地 /v1/models 把可用模型喂给控制台
    for (;;) {
      if (state.quitting) return;
      try {
        const resp = await fetch(`http://${state.base}/v1/models`, {
          signal: AbortSignal.timeout(3000),
        });
        if (resp.status === 200) {
          const payload = (await resp.json()) as { data?: Array<{ id?: string }> };
          const ids = (payload.data ?? []).map((m) => m.id ?? "").filter(Boolean);
          if (ids.length > 0) state.setModels(ids);
        }
      } catch {
        /* 轮询失败下轮再试 */
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  };

  void worker().catch((err) => {
    console.error(`${prefix} worker error: ${String(err)}`);
  });

  // 主线程阻塞直到终止源（信号 / 监督者消失）
  await stopped;

  await shutdown();
  if (json) emit({ event: "stopped", ...(stopReason ? { reason: stopReason } : {}) });
  return 0;
}
