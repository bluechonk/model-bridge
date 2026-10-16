import { NavLink, Outlet } from "react-router";
import type { ReactElement, ReactNode } from "react";

/** 左侧栏导航 + 主内容区布局。 */
export function Layout({ children }: { children?: ReactNode }): ReactElement {
  const nav = [
    { to: "/", label: "仪表盘" },
    { to: "/channels", label: "渠道" },
    { to: "/accounts", label: "账号池" },
    { to: "/login", label: "登录" },
  ];
  return (
    <div className="flex h-full">
      <aside className="w-48 shrink-0 border-r border-gray-200 bg-gray-50 p-4">
        <div className="mb-6 text-lg font-bold">modelmux</div>
        <nav className="flex flex-col gap-1">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `rounded px-3 py-2 text-sm ${isActive ? "bg-gray-900 text-white" : "text-gray-700 hover:bg-gray-200"}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-auto p-6">{children ?? <Outlet />}</main>
    </div>
  );
}
