import { type ReactElement, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Users } from "lucide-react";
import { api } from "../lib/api";
import { AccountCard, type AccountPool, type ChannelBilling } from "../components/AccountCard";
import { LoginModal } from "../components/LoginModal";
import { Alert, Skeleton } from "./Dashboard";

interface StatusRow {
  cid: string;
  present?: boolean;
}

interface BillingRow {
  model: string;
  candidates: Array<{
    cid: string;
    display?: string;
    used?: number;
    unit?: string;
    cooling?: boolean;
    ok?: number;
    fail?: number;
    accounts?: Array<{ key: string; ok: number; fail: number }>;
  }>;
}

/**
 * 账号池页（渠道管理中枢）。
 *
 * 添加账号走**模态弹窗**（步骤化引导，仅关闭键可关）；账本按「渠道 × 账号」展示；
 * 授权链接 / 登录状态只出现在弹窗里，不再泄漏到其他页面。
 */
export function Accounts(): ReactElement {
  const qc = useQueryClient();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /** 弹窗目标渠道；null = 关闭。 */
  const [loginChannel, setLoginChannel] = useState<string | null>(null);

  const pools = useQuery({
    queryKey: ["accounts"],
    queryFn: async () => {
      const res = (await api.commands.accounts()) as { channels?: AccountPool[] };
      return res.channels ?? [];
    },
    refetchInterval: 15_000,
  });
  const logins = useQuery({
    queryKey: ["logins"],
    queryFn: async () => {
      const res = (await api.commands.status()) as { channels?: StatusRow[] };
      return res.channels ?? [];
    },
    refetchInterval: 10_000,
  });
  const billing = useQuery({
    queryKey: ["billing"],
    queryFn: async () => {
      const res = (await api.commands.billing()) as { rows?: BillingRow[] };
      return res.rows ?? [];
    },
    refetchInterval: 60_000,
  });
  // 弹窗轮询：登录进度 / 二维码 / 授权链接都从这里来（弹窗关闭即停）
  const state = useQuery({
    queryKey: ["state"],
    queryFn: api.getState,
    refetchInterval: 3000,
    enabled: loginChannel !== null,
  });

  const invalidateAll = (): void => {
    void qc.invalidateQueries({ queryKey: ["accounts"] });
    void qc.invalidateQueries({ queryKey: ["logins"] });
    void qc.invalidateQueries({ queryKey: ["state"] });
    void qc.invalidateQueries({ queryKey: ["billing"] });
  };

  const startLogin = useMutation({
    mutationFn: async (cid: string) => await api.commands.login(cid, false),
    onError: (err) => setError(String(err)),
  });
  const activate = useMutation({
    mutationFn: async ({ cid, key }: { cid: string; key: string }) => {
      setBusyKey(`activate:${key}`);
      return await api.commands.activateAccount(cid, key);
    },
    onSuccess: () => {
      setError("");
      invalidateAll();
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
      invalidateAll();
    },
    onError: (err) => setError(String(err)),
    onSettled: () => setBusyKey(null),
  });
  const submitCallback = useMutation({
    mutationFn: async (url: string) => await api.commands.pasteCallback(url),
    onSuccess: (res) => {
      setNotice(res.ok ? (res.message ?? "已提交回调链接") : (res.error ?? "提交失败"));
      if (res.ok) invalidateAll();
    },
    onError: (err) => setError(String(err)),
  });
  /** 刷新账单（全渠道或单渠道）：后端真实重查一遍上游账单。 */
  const refreshBilling = useMutation({
    mutationFn: async (cid?: string) => await api.commands.billing(cid, { refresh: true }),
    onSuccess: () => {
      setError("");
      void qc.invalidateQueries({ queryKey: ["billing"] });
    },
    onError: (err) => setError(String(err)),
    onSettled: () => setBusyKey(null),
  });

  // 合并三路数据：账号池 + 登录状态 + 渠道账本（都按 cid 对齐）
  const statusMap = new Map((logins.data ?? []).map((r) => [r.cid, Boolean(r.present)]));
  const billingMap = new Map<string, ChannelBilling>();
  for (const row of billing.data ?? []) {
    for (const c of row.candidates) {
      const prev = billingMap.get(c.cid);
      if (prev) {
        prev.models += 1;
        continue;
      }
      billingMap.set(c.cid, {
        used: c.used ?? 0,
        unit: c.unit ?? "",
        cooling: Boolean(c.cooling),
        ok: c.ok ?? 0,
        fail: c.fail ?? 0,
        models: 1,
        accounts: c.accounts ?? [],
        billing_at: null,
      });
    }
  }
  const list = (pools.data ?? []).map((pool) => ({
    pool,
    present: statusMap.get(pool.cid) ?? false,
    billing: billingMap.get(pool.cid),
  }));

  const loginChannels = logins.data ?? [];
  const snapshot = state.data;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Users className="h-6 w-6 text-sky-400" />
          账号池
        </h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500">
            {list.filter((x) => x.present).length} / {Math.max(list.length, loginChannels.length)} 个渠道已登录
          </span>
          <button
            className="flex items-center gap-1.5 rounded-lg bg-gray-800 px-3 py-1.5 text-xs text-gray-200 transition-colors hover:bg-gray-700 disabled:opacity-50"
            disabled={refreshBilling.isPending}
            onClick={() => refreshBilling.mutate(undefined)}
            title="重新请求全部渠道的账单 / 剩余额度"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshBilling.isPending ? "animate-spin" : ""}`} />
            刷新全部账单
          </button>
        </div>
      </div>

      {/* 添加账号入口：点击渠道名打开登录弹窗 */}
      <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="mb-3 text-sm font-semibold text-gray-300">添加账号（登录新账号）</h2>
        <div className="flex flex-wrap gap-2">
          {loginChannels.map((c) => (
            <button
              key={c.cid}
              className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-950 px-3 py-1.5 text-xs text-gray-300 transition-colors hover:border-sky-600 hover:text-sky-300"
              onClick={() => setLoginChannel(c.cid)}
              title={`为 ${c.cid} 走一次授权流程，成功后自动入池`}
            >
              + {c.display || c.cid}
            </button>
          ))}
          {loginChannels.length === 0 && (
            <span className="text-xs text-gray-500">{logins.isLoading ? "加载中…" : "（没有已注册渠道）"}</span>
          )}
        </div>
        <p className="mt-3 text-xs text-gray-600">
          点击渠道名会打开登录引导弹窗，按步骤完成授权后账号自动入池并设为生效。
        </p>
      </section>

      {error && <Alert tone="error">{error}</Alert>}
      {notice && !error && <Alert tone="info">{notice}</Alert>}

      {list.length === 0 && (
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-5 text-sm text-gray-500">
          {pools.isLoading ? <Skeleton /> : "（无渠道账号池；先在上面添加账号）"}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.map(({ pool, present, billing: bill }) => (
          <AccountCard
            key={pool.cid}
            pool={pool}
            present={present}
            billing={bill}
            onActivate={(cid, key) => activate.mutate({ cid, key })}
            onRemove={(cid, key) => remove.mutate({ cid, key })}
            onAdd={(cid) => setLoginChannel(cid)}
            onRefreshBilling={(cid) => refreshBilling.mutate(cid)}
            refreshing={refreshBilling.isPending && refreshBilling.variables === pool.cid}
            busyKey={busyKey}
          />
        ))}
      </div>

      {/* 登录弹窗（仅右上角关闭键可关） */}
      {loginChannel !== null && (
        <LoginModal
          cid={loginChannel}
          display={loginChannels.find((c) => c.cid === loginChannel)?.display}
          snapshot={
            snapshot && {
              ui_state: snapshot.ui_state,
              message: snapshot.message,
              auth_url: snapshot.auth_url,
              qr_url: snapshot.qr_url,
            }
          }
          submitting={submitCallback.isPending}
          onStartLogin={(cid) => {
            setNotice("");
            startLogin.mutate(cid);
          }}
          onSubmitCallback={(url) => submitCallback.mutate(url)}
          onClose={() => setLoginChannel(null)}
        />
      )}
    </div>
  );
}
