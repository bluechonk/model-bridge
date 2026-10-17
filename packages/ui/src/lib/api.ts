import type {
  ChannelInfo,
  ChannelPool,
  CommandResult,
  PoolRow,
  UiSnapshot,
} from "./types";

/**
 * 后端基地址：单端口模式下 UI 挂在网关的 `/web` 前缀下，
 * 控制台 API 相应地位于 `/web/api/*`（见 `core/gateway/src/http/console.ts`）。
 */
const BASE = typeof window === "undefined" ? "" : window.location.origin;
const API_BASE = `${BASE}/web`;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json() as T;
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const payload = (await res.json()) as { error?: string };
      if (payload.error) msg = payload.error;
    } catch {
      // 非 JSON 响应体就按状态码处理
    }
    throw new Error(msg);
  }
  return await res.json() as T;
}

export interface WebApi {
  getState(): Promise<UiSnapshot>;
  setTheme(mode: string): Promise<{ ok: boolean }>;
  retryLogin(): Promise<{ ok: boolean }>;
  readonly commands: {
    /** 各方法返回**已解包 data 的扁平对象**（含 ok / message / error）。 */
    login(cid: string, force: boolean): Promise<CommandData>;
    status(cid?: string): Promise<CommandData>;
    models(cid?: string): Promise<CommandData>;
    billing(cid?: string): Promise<CommandData>;
    accounts(cid?: string): Promise<CommandData>;
    activateAccount(cid: string, key: string): Promise<CommandData>;
    removeAccount(cid: string, key: string): Promise<CommandData>;
    syncPool(cid: string): Promise<CommandData>;
    /**
     * 提交用户粘回的回调链接（一次性 code 的兜底通道）。
     *
     * 回调页线上是 404，`code` 只在浏览器地址栏里；长轮询拿不到时靠这个完成登录。
     */
    pasteCallback(url: string): Promise<CommandData>;
  };
}

/** 命令返回值：后端 `data` 的字段与 `ok` / `message` / `error` 平级。 */
export interface CommandData extends Record<string, unknown> {
  ok: boolean;
  message?: string;
  error?: string;
}

/**
 * 统一命令载荷：`{ action, cid?, args }`。
 *
 * ⚠ `args` 必须是**独立字段** —— 后端 `console.ts` 只取顶层的 `action` / `cid` / `args`，
 * 把参数字段扁平拼到顶层会被静默丢弃（登录 force、账号 key 都传不到）。
 *
 * ⚠ **返回值会自动解包 `data`** —— 后端统一信封是 `{ ok, data?, message?, error? }`，
 * 调用方拿到的就是 `data`。早期版本把整个信封返回，导致各页面按 `res.channels` 读取
 * 而实际在 `res.data.channels`，表现为「（无渠道）」「（无数据）」（实测踩过）。
 */
async function command(
  action: string,
  cid: string | undefined,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { action, args };
  if (cid !== undefined) body["cid"] = cid;
  const envelope = (await post("/api/commands", body)) as {
    ok: boolean;
    data?: unknown;
    message?: string;
    error?: string;
  };
  const data = envelope.data;
  const merged =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  // 保留 ok / message / error，便于调用方按需读取（data 的字段与它们平级）
  return { ...merged, ok: envelope.ok, ...(envelope.message ? { message: envelope.message } : {}), ...(envelope.error ? { error: envelope.error } : {}) };
}

export const api: WebApi = {
  getState: () => get("/api/state"),
  setTheme: (mode) => post("/api/theme", { mode }),
  retryLogin: () => post("/api/retry-login"),
  commands: {
    login: (cid, force) => command("login", cid, { force }),
    status: (cid) => command("status", cid),
    models: (cid) => command("models", cid),
    billing: (cid) => command("billing", cid),
    accounts: (cid) => command("accounts", cid),
    activateAccount: (cid, key) => command("activateAccount", cid, { key }),
    removeAccount: (cid, key) => command("removeAccount", cid, { key }),
    syncPool: (cid) => command("syncPool", cid),
    pasteCallback: (url) => command("pasteCallback", undefined, { url }),
  },
};
