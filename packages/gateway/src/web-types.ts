/** Web 层专用数据形状（`/api/commands` 的请求与响应、渠道池快照视图）。 */

export interface WebCommandBody {
  action: string;
  cid?: string;
  args?: Record<string, unknown>;
}

export interface WebCommandResult {
  ok: boolean;
  message?: string;
  error?: string;
  data?: unknown;
}

export interface WebChannelStatus {
  cid: string;
  display: string;
  present: boolean;
}

/** 把 `PoolIndex` 转换成 Web 展示形态（独立于 account-cli.ts 的 render）。 */
export function renderChannelPool(cid: string, display: string, index: { version: 1; active: string | null; accounts: Array<{ key: string; label: string; uid: string; health: string; expires_at: number | null }> }): Record<string, unknown> {
  return {
    cid,
    display,
    index: {
      version: index.version,
      active: index.active,
      accounts: index.accounts.map((a) => ({
        key: a.key,
        label: a.label,
        uid: a.uid,
        health: a.health,
        expires_at: a.expires_at,
      })),
    },
  };
}
