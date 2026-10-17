import type { ReactElement } from "react";
/** 状态徽标（登录/运行状态）。 */
export function StatusBadge({ state }: { state: string }): ReactElement {
  const styles: Record<string, string> = {
    running: "bg-green-900/40 text-green-300",
    ok: "bg-green-900/40 text-green-300",
    login: "bg-yellow-900/40 text-yellow-300",
    warning: "bg-yellow-900/40 text-yellow-300",
    probing: "bg-gray-800 text-gray-400",
    error: "bg-red-900/40 text-red-300",
  };
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${styles[state] ?? "bg-gray-800 text-gray-400"}`}>
      {state}
    </span>
  );
}
