import { type ReactElement, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { AccountCard, type AccountPool } from "../components/AccountCard";

/** 账号池页。 */
export function Accounts(): ReactElement {
  const qc = useQueryClient();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState("");

  const pools = useQuery({
    queryKey: ["accounts"],
    queryFn: async () => {
      const res = await api.commands.accounts() as { channels?: AccountPool[] };
      return res.channels ?? [];
    },
    refetchInterval: 15_000,
  });

  const activate = useMutation({
    mutationFn: async ({ cid, key }: { cid: string; key: string }) => {
      setBusyKey(`activate:${key}`);
      return await api.commands.activateAccount(cid, key);
    },
    onSuccess: () => {
      setError("");
      void qc.invalidateQueries({ queryKey: ["accounts"] });
    },
    onError: (err) => setError(String(err)),
    onSettled: () => setBusyKey(null),
  });
  const remove = useMutation({
    mutationFn: async ({ cid, key }: { cid: string; key: string }) => {
      setBusyKey(`remove:${key}`);
      return await api.commands.removeAccount(cid, key);
    },
    onSuccess: () => {
      setError("");
      void qc.invalidateQueries({ queryKey: ["accounts"] });
    },
    onError: (err) => setError(String(err)),
    onSettled: () => setBusyKey(null),
  });

  const list = pools.data ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">账号池</h1>
      {error && <div className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {list.length === 0 && (
        <div className="text-gray-500">{pools.isLoading ? "加载中…" : "（无渠道账号池；先在渠道上登录）"}</div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((pool) => (
          <AccountCard
            key={pool.cid}
            pool={pool}
            onActivate={(cid, key) => activate.mutate({ cid, key })}
            onRemove={(cid, key) => remove.mutate({ cid, key })}
            busyKey={busyKey}
          />
        ))}
      </div>
    </div>
  );
}
