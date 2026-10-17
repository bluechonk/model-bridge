import { type ReactElement, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Plus, QrCode, Send, Users } from "lucide-react";
import { api } from "../lib/api";
import { AccountCard, type AccountPool, type ChannelBilling } from "../components/AccountCard";
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
  }>;
}

/**
 * 账号池页（渠道管理中枢）：添加账号（登录）/ 账号列表 / 渠道账本。
 *
 * 登录进行中时展示二维码与回调粘贴入口；账本是渠道级的，
 * 记在当前生效账号头上（见 AccountCard 的账单条）。
 */
export function Accounts(): ReactElement {
  const qc = useQueryClient();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pasted, setPasted] = useState("");

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
  // 登录进行中才有二维码 / 授权链接（3 秒轮询共享 state key）
  const state = useQuery({ queryKey: ["state"], queryFn: api.getState, refetchInterval: 3000 });

  const invalidateAll = (): void => {
    void qc.invalidateQueries({ queryKey: ["accounts"] });
    void qc.invalidateQueries({ queryKey: ["logins"] });
    void qc.invalidateQueries({ queryKey: ["state"] });
    void qc.invalidateQueries({ queryKey: ["billing"] });
  };

  const addAccount = useMutation({
    mutationFn: async (cid: string) => {
      setBusyKey(`add:${cid}`);
      return await api.commands.login(cid, false);
    },
    onSuccess: (res) => {
      setMessage(res.ok ? (res.message ?? "添加账号流程已启动") : (res.error ?? "添加账号失败"));
      invalidateAll();
    },
    onError: (err) => setMessage(String(err)),
    onSettled: () => setBusyKey(null),
  });
  const reauthorize = useMutation({
    mutationFn: async (cid: string) => {
      setBusyKey(`reauth:${cid}`);
      return await api.commands.login(cid, true);
    },
    onSuccess: (res) => {
      setMessage(res.ok ? (res.message ?? "重新授权流程已启动") : (res.error ?? "重新授权失败"));
      invalidateAll();
    },
    onError: (err) => setMessage(String(err)),
    onSettled: () => setBusyKey(null),
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
      setMessage(res.ok ? (res.message ?? "已提交回调链接") : (res.error ?? "提交失败"));
      if (res.ok) setPasted("");
      invalidateAll();
    },
    onError: (err) => setMessage(String(err)),
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
      });
    }
  }
  const list = (pools.data ?? []).map((pool) => ({
    pool,
    present: statusMap.get(pool.cid) ?? false,
    billing: billingMap.get(pool.cid),
  }));

  const qrUrl = state.data?.qr_url ?? "";
  const authUrl = state.data?.auth_url ?? "";
  const uiState = state.data?.ui_state ?? "";

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Users className="h-6 w-6 text-sky-400" />
          账号池
        </h1>
        <span className="text-xs text-gray-500">
          {list.filter((x) => x.present).length} / {Math.max(list.length, (logins.data ?? []).length)} 个渠道已登录
        </span>
      </div>

      {/* 添加账号：选渠道触发授权（等价 mx accounts add / mx login <cid>） */}
      <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-300">
          <Plus className="h-4 w-4 text-sky-400" />
          添加账号
        </h2>
        <div className="flex flex-wrap gap-2">
          {(logins.data ?? []).map((c) => (
            <button
              key={c.cid}
              className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-950 px-3 py-1.5 text-xs text-gray-300 transition-colors hover:border-sky-600 hover:text-sky-300 disabled:opacity-50"
              disabled={busyKey !== null}
              onClick={() => addAccount.mutate(c.cid)}
              title={`为 ${c.cid} 走一次授权流程，成功后自动入池`}
            >
              <Plus className="h-3 w-3" />
              {busyKey === `add:${c.cid}` ? "启动中…" : c.cid}
            </button>
          ))}
          {(logins.data ?? []).length === 0 && (
            <span className="text-xs text-gray-500">{logins.isLoading ? "加载中…" : "（没有已注册渠道）"}</span>
          )}
        </div>
        <p className="mt-3 text-xs text-gray-600">
          点击渠道名走一次授权流程（浏览器授权 / 扫码），成功后账号自动入池并设为生效；
          已登录的渠道再点一次即重走授权（清掉现有凭据后重新登录）。
        </p>
      </section>

      {/* 登录进行中：二维码 / 授权链接 / 回调粘贴 */}
      {qrUrl && (
        <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium">
            <QrCode className="h-4 w-4 text-sky-400" />
            扫码登录（用微信扫这张）
          </div>
          <div className="flex flex-wrap items-start gap-4">
            <div className="rounded-lg border border-gray-700 bg-white p-2">
              <img src={qrUrl} alt="微信登录二维码" className="h-40 w-40" />
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              {state.data?.message && <div className="text-sm text-gray-400">{state.data.message}</div>}
              <div className="text-xs text-gray-500">
                授权后浏览器会跳到 404 页，这是正常的。请在那一页按 Ctrl+L 再 Ctrl+C，
                把地址栏整条链接粘到下面的「回调链接」框完成登录。
              </div>
            </div>
          </div>
        </section>
      )}

      {authUrl && (
        <Alert tone="info">
          <div className="flex items-start gap-2">
            <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
            <div>
              <span className="font-medium">授权页已打开：</span>
              <a
                className="ml-1 break-all text-sky-300 underline hover:text-sky-200"
                href={authUrl}
                target="_blank"
                rel="noreferrer"
              >
                {authUrl}
              </a>
              {!qrUrl && (
                <div className="mt-1 text-xs text-gray-500">
                  完成授权后浏览器会跳到一个打不开的回调页（自定义协议），这是正常的 ——
                  把地址栏整条链接复制到下面的「回调链接」框提交即可。
                </div>
              )}
              {qrUrl && (
                <div className="mt-1 text-xs text-gray-500">
                  注意：这一页显示的二维码与本轮登录不是同一个会话，请以上方的「二维码」为准。
                </div>
              )}
            </div>
          </div>
        </Alert>
      )}

      {(qrUrl || authUrl) && (
        <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (pasted.trim()) submitCallback.mutate(pasted.trim());
            }}
          >
            <input
              className="min-w-0 flex-1 rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 transition-colors focus:border-sky-500 focus:outline-none"
              placeholder="回调链接（浏览器地址栏整条复制，如 office-raccoon://auth/callback?code=…）"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
            />
            <button
              type="submit"
              className="flex shrink-0 items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
              disabled={submitCallback.isPending || !pasted.trim()}
            >
              <Send className="h-4 w-4" />
              完成登录
            </button>
          </form>
        </section>
      )}

      {uiState === "login" && !qrUrl && !authUrl && (
        <div className="text-sm text-gray-500">正在准备二维码…</div>
      )}

      {error && <Alert tone="error">{error}</Alert>}
      {message && !error && <Alert tone="info">{message}</Alert>}

      {/* 渠道卡片：账号列表 + 账本 + 逐卡片重新授权 */}
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
            onAdd={(cid) => addAccount.mutate(cid)}
            busyKey={busyKey}
          />
        ))}
      </div>
    </div>
  );
}
