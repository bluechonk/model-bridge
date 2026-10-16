import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { api } from "../lib/api";
import { StatusBadge } from "../components/StatusBadge";

/** 仪表盘页：全局状态快照。 */
export function Dashboard(): ReactElement {
  const { data: state, isLoading, error } = useQuery({
    queryKey: ["state"],
    queryFn: api.getState,
    refetchInterval: 3000,
  });
  if (isLoading) return <div className="text-gray-500">加载中…</div>;
  if (error) return <div className="text-red-600">加载失败：{String(error)}</div>;
  if (!state) return <div className="text-gray-500">（无数据）</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">仪表盘</h1>
        <div className="mt-2 flex items-center gap-3">
          <StatusBadge state={state.ui_state} />
          {state.gateway_error && (
            <span className="text-sm text-red-600">网关错误：{state.gateway_error}</span>
          )}
        </div>
      </div>
      <div>
        <h2 className="mb-2 text-lg font-medium">端点</h2>
        <dl className="text-sm space-y-1">
          <div><dt className="inline font-medium">base_url：</dt><dd className="inline">{state.base_url || "—"}</dd></div>
          <div><dt className="inline font-medium">chat_url：</dt><dd className="inline">{state.chat_url || "—"}</dd></div>
          <div><dt className="inline font-medium">endpoints：</dt><dd className="inline">{state.endpoints.join("，")}</dd></div>
        </dl>
      </div>
      <div>
        <h2 className="mb-2 text-lg font-medium">可用模型</h2>
        {state.models.length === 0 ? <div className="text-gray-500">（无）</div> : (
          <ul className="list-disc pl-5 text-sm">{state.models.map((m) => <li key={m}>{m}</li>)}</ul>
        )}
      </div>
      {state.message && <div className="text-sm text-gray-600">{state.message}</div>}
      {state.auth_url && (
        <div className="rounded bg-blue-50 p-3 text-sm">
          授权链接：
          <a className="ml-1 break-all text-blue-700 underline" href={state.auth_url} target="_blank" rel="noreferrer">
            {state.auth_url}
          </a>
        </div>
      )}
    </div>
  );
}
