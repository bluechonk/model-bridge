import type { PoolAccount } from "../lib/types";
import type { ReactElement } from "react";

/** 账号池卡片的数据形状（直接吃 /api/commands 的宽松 JSON）。 */
export interface AccountPool {
  cid: string;
  display?: string;
  index: {
    active: string | null;
    accounts: PoolAccount[] | Array<Record<string, unknown>>;
  };
}

function rowOf(account: PoolAccount | Record<string, unknown>): PoolAccount {
  const row = account as PoolAccount;
  return {
    ...row,
    uid: String(row.uid ?? ""),
    label: String(row.label ?? ""),
    health: String(row.health ?? "unknown"),
  };
}

/** 单渠道账号池卡片：active 标记 / 激活 / 删除。 */
export function AccountCard({
  pool,
  onActivate,
  onRemove,
  busyKey,
}: {
  pool: AccountPool;
  onActivate: (cid: string, key: string) => void;
  onRemove: (cid: string, key: string) => void;
  busyKey: string | null;
}): ReactElement {
  return (
    <div className="rounded-lg border border-gray-200 p-4">
      <div className="mb-2 font-medium">
        {pool.cid}
        {pool.display && <span className="ml-2 text-sm text-gray-500">{pool.display}</span>}
      </div>
      <div className="mb-2 text-xs text-gray-500">当前生效：{pool.index.active ?? "（无）"}</div>
      {pool.index.accounts.length === 0 ? (
        <div className="text-sm text-gray-400">（空池：登录后会自动入池）</div>
      ) : (
        <ul className="space-y-1">
          {pool.index.accounts.map((raw) => {
            const account = rowOf(raw);
            const key = account.key;
            return (
              <li key={key} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <span className={key === pool.index.active ? "font-bold" : ""}>{key}</span>
                  <span className="text-xs text-gray-500">{account.label || account.uid}</span>
                  <span className={`text-xs ${account.health === "ok" ? "text-green-700" : "text-gray-400"}`}>{account.health}</span>
                </span>
                <span className="flex gap-1">
                  {key !== pool.index.active && (
                    <button
                      className="rounded bg-gray-200 px-2 py-0.5 text-xs hover:bg-gray-300 disabled:opacity-50"
                      disabled={busyKey !== null}
                      onClick={() => onActivate(pool.cid, key)}
                    >
                      {busyKey === `activate:${key}` ? "切换中…" : "切换"}
                    </button>
                  )}
                  <button
                    className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-700 hover:bg-red-200 disabled:opacity-50"
                    disabled={busyKey !== null}
                    onClick={() => onRemove(pool.cid, key)}
                  >
                    {busyKey === `remove:${key}` ? "删除中…" : "删除"}
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
