import { NavLink, Outlet } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard, Server, Users } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { api } from "../lib/api";

/** 侧栏导航项：图标 + 文案。 */
const NAV = [
  { to: "/", label: "仪表盘", icon: LayoutDashboard },
  { to: "/accounts", label: "账号池", icon: Users },
];

/**
 * 左侧栏导航 + 主内容区布局（深色主题）。
 *
 * 侧栏底部常驻网关状态灯（3 秒轮询 /api/state，失败即灰）。
 */
export function Layout({ children }: { children?: ReactNode }): ReactElement {
  const state = useQuery({
    queryKey: ["state"],
    queryFn: api.getState,
    refetchInterval: 3000,
    retry: 1,
  });
  const running = state.data?.ui_state === "running";

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-gray-800/80 bg-gray-900/40 p-4">
        <div className="mb-8 flex items-center gap-3 px-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/15 text-sky-400">
            <Server className="h-5 w-5" />
          </div>
          <div>
            <div className="text-base font-bold leading-tight">modelmux</div>
            <div className="text-xs text-gray-500">多渠道路由网关</div>
          </div>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? "bg-sky-500/15 font-medium text-sky-300"
                    : "text-gray-400 hover:bg-gray-800/70 hover:text-gray-200"
                }`
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-950 px-3 py-2 text-xs">
          <span className={`h-2 w-2 shrink-0 rounded-full ${running ? "bg-green-400" : state.isError ? "bg-red-500" : "bg-gray-600"}`} />
          <span className="text-gray-400">网关 {running ? "运行中" : state.isError ? "离线" : "…"}</span>
          <span className="ml-auto font-mono text-gray-600">4412</span>
        </div>
      </aside>
      <main className="flex-1 overflow-auto p-8">
        <div className="mx-auto max-w-6xl">{children ?? <Outlet />}</div>
      </main>
    </div>
  );
}
