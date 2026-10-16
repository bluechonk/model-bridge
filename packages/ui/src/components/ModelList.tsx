import type { ReactElement } from "react";
/** 模型列表（带候选渠道）。 */
import type { PoolRow } from "../lib/types";

export function ModelList({ rows }: { rows: PoolRow[] }): ReactElement {
  if (rows.length === 0) return <div className="text-gray-500">（无模型）</div>;
  return (
    <ul className="space-y-3">
      {rows.map((row) => (
        <li key={row.model}>
          <div className="font-medium">{row.model}</div>
          <ul className="mt-1 text-xs text-gray-600">
            {row.candidates.length === 0
              ? <li>（没有渠道提供它）</li>
              : row.candidates.map((c) => (
                  <li key={c.cid} className={c.cooling ? "opacity-50" : ""}>
                    {c.cid} —— used={c.used}{c.unit ? ` ${c.unit}` : ""}
                    {c.cooling ? "（冷却中）" : ""}
                    {c.fail > 0 ? ` fail=${c.fail}` : ""}
                    {c.ok > 0 ? ` ok=${c.ok}` : ""}
                  </li>
                ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
