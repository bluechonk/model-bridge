import { useQuery } from "@tanstack/react-query";
import { Activity, Boxes, Globe, Link2, MessageSquare, Server } from "lucide-react";
import { CopyChip } from "../components/CopyChip";
import type { ReactElement, ReactNode } from "react";
import { api } from "../lib/api";

/** 仪表盘页：全局状态快照（统计卡 + 端点 + 按渠道分组的模型墙）。 */
export function Dashboard(): ReactElement {
  const { data: state, isLoading, error } = useQuery({
    queryKey: ["state"],
    queryFn: api.getState,
    refetchInterval: 3000,
  });

  if (isLoading) return <Skeleton />;
  if (error) return <Alert tone="error">加载失败：{String(error)}</Alert>;
  if (!state) return <div className="text-gray-500">（无数据）</div>;

  // 模型按渠道分组：`<cid>/<模型>` → { cid: [模型…] }
  const groups = new Map<string, string[]>();
  for (const m of state.models) {
    const slash = m.indexOf("/");
    const cid = slash < 0 ? m : m.slice(0, slash);
    const id = slash < 0 ? m : m.slice(slash + 1);
    const list = groups.get(cid) ?? [];
    list.push(id);
    groups.set(cid, list);
  }
  const running = state.ui_state === "running";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">仪表盘</h1>
        {state.gateway_error && (
          <span className="text-sm text-red-400">网关错误：{state.gateway_error}</span>
        )}
      </div>

      {/* 统计卡 */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard icon={<Activity className="h-4 w-4" />} label="网关状态">
          <span
            className={`inline-flex items-center gap-2 text-lg font-semibold ${
              running ? "text-green-400" : "text-gray-400"
            }`}
          >
            <span className={`h-2.5 w-2.5 rounded-full ${running ? "bg-green-400" : "bg-gray-600"}`} />
            {running ? "运行中" : state.ui_state}
          </span>
        </StatCard>
        <StatCard icon={<Boxes className="h-4 w-4" />} label="可用模型">
          <span className="text-lg font-semibold">{state.models.length}</span>
          <span className="ml-1 text-sm text-gray-500">个</span>
        </StatCard>
        <StatCard icon={<Server className="h-4 w-4" />} label="供给渠道">
          <span className="text-lg font-semibold">{groups.size}</span>
          <span className="ml-1 text-sm text-gray-500">个</span>
        </StatCard>
      </div>

      {/* 端点 */}
      <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-300">
          <Globe className="h-4 w-4 text-sky-400" />
          端点
        </h2>
        <dl className="space-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="flex w-24 shrink-0 items-center gap-1.5 text-gray-500">
              <Server className="h-3.5 w-3.5" /> base_url
            </dt>
            <dd className="break-all font-mono text-gray-200">{state.base_url || "—"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="flex w-24 shrink-0 items-center gap-1.5 text-gray-500">
              <MessageSquare className="h-3.5 w-3.5" /> chat_url
            </dt>
            <dd className="break-all font-mono text-gray-200">{state.chat_url || "—"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="flex w-24 shrink-0 items-center gap-1.5 text-gray-500">
              <Link2 className="h-3.5 w-3.5" /> endpoints
            </dt>
            <dd className="text-gray-400">{state.endpoints.join("，")}</dd>
          </div>
        </dl>
        <p className="mt-4 rounded-lg bg-sky-950/40 px-3 py-2 text-xs text-gray-400">
          任何 OpenAI 兼容客户端把 base url 指到上面的 <span className="font-mono">/v1</span>，
          模型填 <span className="font-mono text-sky-300">渠道/模型</span> 形态即可。
        </p>
      </section>

      {/* 模型墙（按渠道分组） */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-300">
          <Boxes className="h-4 w-4 text-sky-400" />
          可用模型（渠道/模型）
        </h2>
        {state.models.length === 0 ? (
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-5 text-sm text-gray-500">
            （无模型：先在登录页完成渠道授权）
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {[...groups.entries()].map(([cid, ids]) => (
              <div key={cid} className="rounded-xl border border-gray-800 bg-gray-900 p-4">
                <div className="mb-2 flex items-center gap-2">
                  <span className="rounded-md bg-sky-500/10 px-2 py-0.5 font-mono text-xs text-sky-300">{cid}</span>
                  <span className="text-xs text-gray-500">{ids.length} 个模型</span>
                </div>
                <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                  {ids.map((id) => (
                    <CopyChip key={id} value={`${cid}/${id}`} display={id} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {state.message && <div className="text-sm text-gray-400">{state.message}</div>}
      {state.auth_url && (
        <Alert tone="info">
          <span className="font-medium">授权链接：</span>
          <a
            className="ml-1 break-all text-sky-300 underline hover:text-sky-200"
            href={state.auth_url}
            target="_blank"
            rel="noreferrer"
          >
            {state.auth_url}
          </a>
        </Alert>
      )}
    </div>
  );
}

/** 统计卡外壳：图标 + 标签 + 任意内容。 */
function StatCard({
  icon,
  label,
  children,
}: {
  icon: ReactElement;
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
      <div className="mb-2 flex items-center gap-2 text-xs text-gray-500">
        <span className="text-sky-400">{icon}</span>
        {label}
      </div>
      {children}
    </div>
  );
}

/** 语义提示条：info 蓝 / error 红。 */
export function Alert({
  tone,
  children,
}: {
  tone: "info" | "error";
  children: ReactNode;
}): ReactElement {
  const cls =
    tone === "error"
      ? "border-red-900/60 bg-red-950/50 text-red-300"
      : "border-sky-900/60 bg-sky-950/50 text-gray-300";
  return <div className={`rounded-lg border p-3 text-sm ${cls}`}>{children}</div>;
}

/** 加载骨架：三张卡片占位。 */
export function Skeleton(): ReactElement {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-24 animate-pulse rounded-xl border border-gray-800 bg-gray-900" />
      ))}
    </div>
  );
}
