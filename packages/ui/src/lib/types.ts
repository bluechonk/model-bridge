/** 前端自己的 API 数据类型子集（与共享层快照字段对齐）。 */

export interface UiSnapshot {
  ui_state: string;
  message: string;
  /** 授权页 URL。⚠ 不要在这里扫码（每次加载都是新的二维码会话）。 */
  auth_url: string;
  /** 二维码图片 URL，扫码用这一张（对应登录流程本轮轮询的 uuid）。 */
  qr_url: string;
  base_url: string;
  chat_url: string;
  endpoints: string[];
  models: string[];
  theme_mode: string;
  resolved_theme: string;
  gateway_error: string;
}

export interface PoolAccount {
  key: string;
  uid: string;
  domain: string;
  label: string;
  added_at: string;
  last_used_at: string;
  expires_at: number | null;
  health: string;
  health_at: string;
}

export interface ChannelPool {
  cid: string;
  display: string;
  index: {
    version: 1;
    active: string | null;
    accounts: PoolAccount[];
  };
}

export interface PoolRow {
  model: string;
  candidates: Array<{
    cid: string;
    display: string;
    exposed_id: string;
    score: number;
    used: number;
    unit: string;
    cooling: boolean;
    ok: number;
    fail: number;
    billing_at: string | null;
  }>;
}

export interface ChannelInfo {
  cid: string;
  display: string;
  /** 凭证是否存在（后端 `status` action 的字段名是 `present`）。 */
  present: boolean;
  uid?: string;
}

export interface StatusRow {
  cid: string;
  display: string;
  present: boolean;
}

export interface CreditRow {
  cid: string;
  ok: boolean;
  error?: string;
  used?: number;
  unit?: string;
}

export interface CommandResult {
  ok: boolean;
  message?: string;
  error?: string;
  data?: unknown;
}
