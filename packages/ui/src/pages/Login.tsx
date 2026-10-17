import { type ReactElement, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { LoginForm } from "../components/LoginForm";
import type { ChannelInfo } from "../lib/types";

/**
 * 登录页：选渠道 → 触发登录 → 轮询状态。
 *
 * ⚠ **扫码要用「二维码」那张图，不是「授权页」那个链接。**
 * 授权页每次加载都会新生成一个二维码会话（实测同一 state 连开 3 次得 3 个
 * 不同 uuid），而后端轮询的是它自己那一次；用户去授权页扫码会扫到另一次
 * 会话的码，表现为「手机上确认了但页面一直卡在等待」。
 *
 * 另外：扫码授权后浏览器会跳到 `loomy.xunfei.cn` 的 **404 页**，这是正常的
 * （官方 Electron 客户端在内嵌窗口里拦下跳转，我们没有浏览器，`code` 只在
 * 地址栏里）。所以在那一页 Ctrl+L / Ctrl+C 把整条链接粘回来即可完成登录。
 */
export function Login(): ReactElement {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pasted, setPasted] = useState("");

  // 状态轮询：二维码与登录进度都从这里来（后端把它写进 ServiceState）
  const state = useQuery({ queryKey: ["state"], queryFn: api.getState, refetchInterval: 3000 });
  const logins = useQuery({
    queryKey: ["logins"],
    queryFn: async () => {
      const res = await api.commands.status() as { channels?: ChannelInfo[] };
      return res.channels ?? [];
    },
    refetchInterval: 15_000,
  });

  const doLogin = useMutation({
    mutationFn: async ({ cid, force }: { cid: string; force: boolean }) => {
      setBusy(true);
      setPasted("");
      return await api.commands.login(cid, force);
    },
    onSuccess: (res) => {
      setMessage(res.ok ? (res.message ?? "登录指令已提交") : (res.error ?? "登录失败"));
      void qc.invalidateQueries({ queryKey: ["logins"] });
      void qc.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (err) => setMessage(String(err)),
    onSettled: () => setBusy(false),
  });

  const submitCallback = useMutation({
    mutationFn: async (url: string) => await api.commands.pasteCallback(url),
    onSuccess: (res) => {
      setMessage(res.ok ? (res.message ?? "已提交回调链接") : (res.error ?? "提交失败"));
      if (res.ok) setPasted("");
      void qc.invalidateQueries({ queryKey: ["logins"] });
      void qc.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (err) => setMessage(String(err)),
  });

  const loginChannels = logins.data ?? [];
  const qrUrl = state.data?.qr_url ?? "";
  const authUrl = state.data?.auth_url ?? "";
  const uiState = state.data?.ui_state ?? "";

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">登录</h1>
      <LoginForm
        channels={loginChannels}
        message={message}
        busy={busy}
        noLoginChannels={loginChannels.length === 0}
        onLogin={(cid, force) => doLogin.mutate({ cid, force })}
      />

      {qrUrl && (
        <div className="space-y-2 rounded border border-gray-200 p-4">
          <div className="text-sm font-medium">扫码登录（用微信扫这张）</div>
          <img src={qrUrl} alt="微信登录二维码" className="h-48 w-48" />
          {state.data?.message && <div className="text-sm text-gray-600">{state.data.message}</div>}
          <div className="text-xs text-gray-500">
            授权后浏览器会跳到 404 页，这是正常的。请在那一页按 Ctrl+L 再 Ctrl+C，
            把地址栏整条链接粘到下面。
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (pasted.trim()) submitCallback.mutate(pasted.trim());
            }}
          >
            <input
              className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
              placeholder="粘贴回调链接（https://loomy.xunfei.cn/oauth/wechat/callback?code=…）"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
            />
            <button
              type="submit"
              className="rounded bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
              disabled={submitCallback.isPending || !pasted.trim()}
            >
              完成登录
            </button>
          </form>
        </div>
      )}

      {!qrUrl && authUrl && (
        <div className="rounded bg-blue-50 p-3 text-sm">
          授权页：
          <a className="ml-1 break-all text-blue-700 underline" href={authUrl} target="_blank" rel="noreferrer">
            {authUrl}
          </a>
          <div className="mt-1 text-xs text-gray-600">
            注意：这一页显示的二维码与本轮登录不是同一个会话，请以页面上的「二维码」为准。
          </div>
        </div>
      )}

      {uiState === "login" && !qrUrl && (
        <div className="text-sm text-gray-500">正在准备二维码…</div>
      )}
    </div>
  );
}
