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
      const res = await api.commands.status() as { channels?: Array<{ cid: string; display?: string; present?: boolean; error?: string }> };
      return res;
    },
    refetchInterval: 10_000,
  });
  const models = useQuery({
    queryKey: ["models"],
    queryFn: async () => {
      const res = await api.commands.models() as { rows?: Array<Record<string, unknown>> };
      return res;
    },
    refetchInterval: 30_000,
    enabled: tab === "models",
  });
  const billing = useQuery({
    queryKey: ["billing"],
    queryFn: async () => {
      const res = await api.commands.billing() as { rows?: Array<Record<string, unknown>> };
      return res;
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

  const loginRows = (logins.data as { channels?: Array<{ cid: string; error?: string }> } | undefined)?.channels ?? [];

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
                <StatusBadge state={row.error ? "error" : "ok"} />
              </div>
              {row.error && <div className="mt-1 text-xs text-red-600">{row.error}</div>}
            </div>
          ))}
        </div>
      )}

      {tab === "models" && (
        <div className="space-y-3">
          {(models.data as { rows?: Array<{ model?: string; cid?: string; exposed_id?: string; used?: number; cooling?: boolean }> } | undefined)?.rows?.map((r, i) => (
            <div key={i} className="rounded border border-gray-200 p-3 text-sm">
              <div className="font-medium">{r.model}</div>
              <div className="text-xs text-gray-600">
                {r.cid} —— 暴露 id：{r.exposed_id ?? "—"} {r.cooling ? "（冷却中）" : ""}
              </div>
            </div>
          ))}
          {models.data === undefined && <div className="text-gray-500">{models.isLoading ? "加载中…" : "（无数据）"}</div>}
        </div>
      )}

      {tab === "billing" && (
        <div className="space-y-3">
          <button
            className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700"
            disabled={refreshBilling.isPending}
            onClick={() => refreshBilling.mutate()}
          >
            {refreshBilling.isPending ? "刷新中…" : "刷新账单"}
          </button>
          {(billing.data as { rows?: Array<{ cid?: string; used?: number; unit?: string; ok?: number; fail?: number }> } | undefined)?.rows?.map((r, i) => (
            <div key={i} className="rounded border border-gray-200 p-3 text-sm">
              <div className="font-medium">{r.cid}</div>
              <div className="text-xs text-gray-600">
                used={r.used ?? 0} {r.unit ?? ""}
                {r.ok !== undefined ? ` ok=${r.ok}` : ""}
                {r.fail !== undefined ? ` fail=${r.fail}` : ""}
              </div>
            </div>
          ))}
          {billing.data === undefined && <div className="text-gray-500">{billing.isLoading ? "加载中…" : "（无数据）"}</div>}
        </div>
      )}
    </div>
  );
}
