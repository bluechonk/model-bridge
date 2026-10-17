import { Database, Plus, Trash2, UserCheck } from "lucide-react";
import type { PoolAccount } from "../lib/types";
import type { ReactElement } from "react";
import { StatusBadge } from "./StatusBadge";

/** 账号池卡片的数据形状（直接吃 /api/commands 的宽松 JSON）。 */
export interface AccountPool {
  cid: string;
  display?: string;
  index: {
    active: string | null;
    accounts: PoolAccount[] | Array<Record<string, unknown>>;
  };
}

/** 渠道级账本条（billing action 聚合后的形状）。 */
export interface ChannelBilling {
  used: number;
  unit: string;
  cooling: boolean;
  ok: number;
  fail: number;
  models: number;
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

/** 健康度圆点颜色：ok 绿 / unauthorized 红 / 其他灰。 */
function healthDot(health: string): string {
  if (health === "ok") return "bg-green-400";
  if (health === "unauthorized") return "bg-red-500";
  return "bg-gray-600";
}

/**
 * 单渠道账号池卡片：登录状态 + 账号列表（激活/删除）+ 渠道账本条 + 添加账号入口。
 *
 * 账本是**渠道级**的（记在当前生效账号头上），所以账单条标注「当前生效账号」。
 */
export function AccountCard({
  pool,
  present,
  billing,
  onActivate,
  onRemove,
  onAdd,
  busyKey,
}: {
  pool: AccountPool;
  present: boolean;
  billing?: ChannelBilling;
  onActivate: (cid: string, key: string) => void;
  onRemove: (cid: string, key: string) => void;
  onAdd: (cid: string) => void;
  busyKey: string | null;
}): ReactElement {
  return (
    <div className="flex flex-col rounded-xl border border-gray-800 bg-gray-900 p-4 transition-colors hover:border-gray-700">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400">
          <Database className="h-3.5 w-3.5" />
        </span>
        <span className="font-mono text-sm font-medium">{pool.cid}</span>
        {pool.display && <span className="truncate text-xs text-gray-500">{pool.display}</span>}
        <span className="ml-auto">
          <StatusBadge state={present ? "ok" : "warning"} />
        </span>
      </div>

      <div className="mb-2 text-xs text-gray-500">
        当前生效：
        <span className="ml-1 font-mono text-gray-300">{pool.index.active ?? "（无）"}</span>
      </div>

      {pool.index.accounts.length === 0 ? (
        <div className="mb-2 text-xs text-gray-600">（空池：添加账号后会自动入池）</div>
      ) : (
        <ul className="mb-2 space-y-1.5">
          {pool.index.accounts.map((raw) => {
            const account = rowOf(raw);
            const key = account.key;
            const active = key === pool.index.active;
            return (
              <li
                key={key}
                className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs ${
                  active ? "bg-sky-500/10" : "bg-gray-950/60"
                }`}
              >
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className={`font-mono ${active ? "font-semibold text-sky-300" : "text-gray-300"}`}>{key}</span>
                  {account.label && <span className="text-gray-500">{account.label}</span>}
                  <span className="flex items-center gap-1 text-gray-500">
                    <span className={`h-1.5 w-1.5 rounded-full ${healthDot(account.health)}`} />
                    {account.health}
                  </span>
                </span>
                <span className="flex shrink-0 gap-1">
                  {!active && (
                    <button
                      className="flex items-center gap-1 rounded-md bg-gray-800 px-2 py-0.5 text-gray-300 transition-colors hover:bg-gray-700 disabled:opacity-50"
                      disabled={busyKey !== null}
                      onClick={() => onActivate(pool.cid, key)}
                      title="切换为生效账号"
                    >
                      <UserCheck className="h-3 w-3" />
                      {busyKey === `activate:${key}` ? "切换中…" : "切换"}
                    </button>
                  )}
                  <button
                    className="flex items-center gap-1 rounded-md bg-red-950 px-2 py-0.5 text-red-300 transition-colors hover:bg-red-900 disabled:opacity-50"
                    disabled={busyKey !== null}
                    onClick={() => onRemove(pool.cid, key)}
                    title={active ? "删除生效账号 = 同时登出" : "从池中删除"}
                  >
                    <Trash2 className="h-3 w-3" />
                    {busyKey === `remove:${key}` ? "删除中…" : "删除"}
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {billing && (
        <div className="mt-auto rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2 text-xs text-gray-400">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${billing.cooling ? "bg-yellow-400" : "bg-green-400"}`} />
              账单
              <span className="font-medium text-gray-200">
                {billing.used}
                {billing.unit ? ` ${billing.unit}` : ""}
              </span>
            </span>
            <span>
              ok=<span className="text-green-400">{billing.ok}</span>
              <span className="text-gray-600"> / </span>
              fail=<span className={billing.fail > 0 ? "text-red-400" : "text-gray-500"}>{billing.fail}</span>
            </span>
            <span className="text-gray-600">供给 {billing.models} 个池模型</span>
            {billing.cooling && <span className="text-yellow-400">冷却中</span>}
          </div>
          <div className="mt-1 text-gray-600">账本记在当前生效账号头上</div>
        </div>
      )}

      <button
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-700 px-3 py-2 text-xs text-gray-400 transition-colors hover:border-sky-600 hover:text-sky-300 disabled:opacity-50"
        disabled={busyKey !== null}
        onClick={() => onAdd(pool.cid)}
      >
        <Plus className="h-3.5 w-3.5" />
        添加账号（走授权流程，成功后自动入池）
      </button>
    </div>
  );
}
