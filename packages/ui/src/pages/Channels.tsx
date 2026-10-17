import { useState, type ReactElement } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { StatusBadge } from "../components/StatusBadge";

/** 渠道页：逐渠道状态 / 模型 / 账单用量。 */
export function Channels(): ReactElement {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"status" | "models" | "billing">("status");

  const logins = useQuery({
    queryKey: ["logins"],
    queryFn: async () => {
      const res = await api.commands.status();
      return res as { channels?: Array<{ cid: string; display?: string; present?: boolean }> };
    },
    refetchInterval: 10_000,
  });
  const models = useQuery({
    queryKey: ["models"],
    queryFn: async () => {
      // 后端 models 返回每渠道一条（含 catalog / pool 数组），不是每模型一条
      const res = await api.commands.models();
      return res as { channels?: Array<{ cid: string; display?: string; catalog: string[]; pool: string[]; out_of_pool: number }> };
    },
    refetchInterval: 30_000,
    enabled: tab === "models",
  });
  const billing = useQuery({
    queryKey: ["billing"],
    queryFn: async () => {
      // 后端 billing 返回每模型一条（含 candidates 数组）
      const res = await api.commands.billing();
      return res as { rows?: Array<{ model: string; candidates: Array<{ cid: string; display?: string; exposed_id?: string; used?: number; unit?: string; cooling?: boolean; ok?: number; fail?: number }> }> };
    },
    refetchInterval: 60_000,
    enabled: tab === "billing",
  });
  const refreshBilling = useMutation({
    mutationFn: () => api.commands.billing(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["billing"] });
      void qc.invalidateQueries({ queryKey: ["models"] });
    },
  });

  const loginRows = (logins.data as { channels?: Array<{ cid: string; display?: string; present?: boolean }> } | undefined)?.channels ?? [];
  const modelRows = (models.data?.channels ?? []).slice().sort((a, b) => a.cid.localeCompare(b.cid));
  const billingRows = billing.data?.rows ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">渠道</h1>
      <div className="flex gap-2">
        {(["status", "models", "billing"] as const).map((t) => (
          <button
            key={t}
            className={`rounded px-3 py-1.5 text-sm ${tab === t ? "bg-gray-900 text-white" : "bg-gray-200 hover:bg-gray-300"}`}
            onClick={() => setTab(t)}
          >
            {t === "status" ? "状态" : t === "models" ? "模型" : "账单"}
          </button>
        ))}
      </div>

      {tab === "status" && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {loginRows.length === 0 && <div className="text-gray-500">{logins.isLoading ? "加载中…" : "（无渠道）"}</div>}
          {loginRows.map((row) => (
            <div key={row.cid} className="rounded-lg border border-gray-200 p-4">
              <div className="flex items-center justify-between">
                <span className="font-medium">{row.cid}</span>
                {/* 状态看**凭证是否存在**（后端返回 present）；不是 HTTP 层错误 */}
                <StatusBadge state={row.present ? "ok" : "warning"} />
              </div>
              {row.display && <div className="mt-1 text-xs text-gray-500">{row.display}</div>}
              {!row.present && <div className="mt-1 text-xs text-yellow-800">未登录（该渠道不参与池路由）</div>}
            </div>
          ))}
        </div>
      )}

      {tab === "models" && (
        <div className="space-y-3">
          {models.isLoading && <div className="text-gray-500">加载中…</div>}
          {!models.isLoading && modelRows.length === 0 && <div className="text-gray-500">（无数据）</div>}
          {modelRows.map((row) => (
            <div key={row.cid} className="rounded border border-gray-200 p-3 text-sm">
              <div className="font-medium">
                {row.cid}
                {row.display && <span className="ml-2 text-xs text-gray-500">{row.display}</span>}
              </div>
              <div className="mt-1 text-xs text-gray-600">
                池内 {row.pool.length} / 目录 {row.catalog.length}
                {row.out_of_pool > 0 ? `（目录里有 ${row.out_of_pool} 条未进池）` : ""}
              </div>
              <div className="mt-1 break-all text-xs text-gray-500">
                {row.pool.length > 0 ? row.pool.join("、") : "（该渠道没有池内模型）"}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "billing" && (
        <div className="space-y-3">
          <button
            className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
            disabled={refreshBilling.isPending}
            onClick={() => refreshBilling.mutate()}
          >
            {refreshBilling.isPending ? "刷新中…" : "刷新账单"}
          </button>
          {billing.isLoading && <div className="text-gray-500">加载中…</div>}
          {!billing.isLoading && billingRows.length === 0 && <div className="text-gray-500">（无数据）</div>}
          {billingRows.map((row) => (
            <div key={row.model} className="rounded border border-gray-200 p-3 text-sm">
              <div className="font-medium">{row.model}</div>
              <ul className="mt-1 space-y-0.5 text-xs text-gray-600">
                {row.candidates.map((c) => (
                  <li key={c.cid} className={c.cooling ? "text-yellow-800" : ""}>
                    {c.cid}
                    {c.display && <span className="text-gray-400">（{c.display}）</span>}
                    {" —— "}
                    used={c.used ?? 0} {c.unit ?? ""}
                    {c.ok !== undefined ? ` ok=${c.ok}` : ""}
                    {c.fail !== undefined ? ` fail=${c.fail}` : ""}
                    {c.cooling ? "（冷却中）" : ""}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
