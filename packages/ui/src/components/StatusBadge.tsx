import type { ReactElement } from "react";
/** 状态徽标（登录/运行状态）。 */
export function StatusBadge({ state }: { state: string }): ReactElement {
  const styles: Record<string, string> = {
    running: "bg-green-100 text-green-800",
    ok: "bg-green-100 text-green-800",
    login: "bg-yellow-100 text-yellow-800",
    warning: "bg-yellow-100 text-yellow-800",
    probing: "bg-gray-100 text-gray-600",
    error: "bg-red-100 text-red-800",
  };
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${styles[state] ?? "bg-gray-100 text-gray-600"}`}>
      {state}
    </span>
  );
}
