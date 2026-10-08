/**
 * 无窗口（headless）运行时：`login` / `serve` 子命令的实现。
 *
 * 与桌面窗口模式平行的入口层：登录/网关/控制台逻辑全部复用
 * auth-flow / cred / gateway / console，只把界面替换为 stdout 输出
 * （人类可读，或 `--json` 事件行供插件解析）与内存状态机。
 *
 * 渠道差异由注册的 `Channel` 提供。
 */

import * as authFlow from "./auth-flow.js";
import { syncPool } from "./account-pool.js";
import { runInChannel } from "./channel-context.js";
import { channels, getChannel, type Channel } from "./channel.js";
import * as console_ from "./console.js";
import * as gateway from "./gateway.js";
import { credentialsPath } from "./paths.js";

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
  ) {}

  setState(state: string, message = "", url = ""): void {
    if (url) this.authUrl = url;
    const tag = this.cid ? `[${this.cid}] ` : "";
    if (this.jsonMode) {
      const event: Record<string, unknown> = { event: "login", state, message };
      if (this.cid) event["cid"] = this.cid;
      if (url) event["auth_url"] = url;
      emit(event);
    } else {
      const suffix = url ? `（授权链接: ${url}）` : "";
      console.log(`[login] ${tag}${state}: ${message}${suffix}`);
    }
  }
}

/** serve 模式的状态机 + 控制台桥（无界面部分）。 */
class ServiceState {
  readonly base: string;
  readonly baseUrl: string;
  readonly chatUrl: string;
  private uiState = "probing"; // probing / login / error / running
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
} = {}): Promise<number> {
  const { force = false, json = false, realm = "auto", cid } = options;
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
  const ui = new StdoutLoginUi(json, cid);
  if (json) emit({ event: "start", mode: "login", force, realm, ...(cid ? { cid } : {}) });

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
    console.log("[login] 完成。");
  }
  return ok ? 0 : 1;
}

export interface ServeOptions {
  addr: string;
  uiPort: number;
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
 * 默认只**被动探测**登录状态（不弹浏览器）；`ensureLogin`/`forceLogin` 时
 * 未登录会打开浏览器走交互授权。
 *
 * 多渠道路由（未指定 `cid` 且注册了多个渠道）时：逐个渠道探测/引导登录，
 * **任一渠道登录成功即启动网关** —— 未登录的渠道在请求时由网关返回 503
 * `not_authenticated`，不影响其它渠道。
 */
export async function runServe(options: ServeOptions): Promise<number> {
  const {
    addr,
    uiPort,
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
  if (json) emit({ event: "start", mode: "serve", addr, ui_port: uiPort, ...(cid ? { cid } : {}) });

  const bridge: console_.ControlBridge = {
    provider: () => state.snapshot(),
    setTheme: () => {}, // 无窗口模式没有主题
    retryLogin: () => {
      state.retryRequested = true;
    },
  };
  const consoleServer = consoleEnabled ? await console_.start(uiPort, bridge, undefined, cid) : null;

  let running: gateway.RunningGateway | null = null;
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    state.quitting = true;
    await running?.close().catch(() => {});
    await consoleServer?.close().catch(() => {});
  };

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
          console.log(`${prefix} [${channel.config.cid}] ${ok ? "已登录" : "未登录"}`);
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
      });
    } catch (err) {
      state.setGatewayError(String(err));
      state.setState("error", `网关启动失败：${String(err)}`);
      if (json) emit({ event: "error", message: `网关启动失败：${String(err)}` });
      return;
    }
    state.setState("running");
    if (json) {
      emit({
        event: "ready",
        gateway: `http://${state.base}`,
        console: consoleServer?.url ?? "",
      });
    }
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
    console.error(`${prefix} worker 异常: ${String(err)}`);
  });

  // 主线程阻塞直到信号
  await new Promise<void>((resolve) => {
    const onSignal = (): void => resolve();
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.on("SIGHUP", onSignal);
  });

  await shutdown();
  if (json) emit({ event: "stopped" });
  return 0;
}
