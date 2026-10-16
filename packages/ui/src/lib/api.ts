import type {
  ChannelInfo,
  ChannelPool,
  CommandResult,
  PoolRow,
  UiSnapshot,
} from "./types";

const BASE = typeof window === "undefined" ? "" : window.location.origin;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json() as T;
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
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
    login(cid: string, force: boolean): Promise<CommandResult>;
    status(cid?: string): Promise<CommandResult>;
    models(cid?: string): Promise<CommandResult>;
    billing(cid?: string): Promise<CommandResult>;
    accounts(cid?: string): Promise<CommandResult>;
    activateAccount(cid: string, key: string): Promise<CommandResult>;
    removeAccount(cid: string, key: string): Promise<CommandResult>;
    syncPool(cid: string): Promise<CommandResult>;
  };
}

function command(action: string, cid: string | undefined, args: Record<string, unknown> = {}): Promise<CommandResult> {
  const body: Record<string, unknown> = { action, ...(args) };
  if (cid !== undefined) body["cid"] = cid;
  return post("/api/commands", body) as Promise<CommandResult>;
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
  },
};
