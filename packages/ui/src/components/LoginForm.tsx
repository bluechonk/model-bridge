import type { ChannelInfo } from "../lib/types";
import type { ReactElement } from "react";

/** 登录流程面板。 */
export function LoginForm({
  channels,
  authUrl,
  message,
  onLogin,
  busy,
  noLoginChannels,
}: {
  channels: ChannelInfo[];
  authUrl: string;
  message: string;
  onLogin: (cid: string, force: boolean) => void;
  busy: boolean;
  noLoginChannels: boolean;
}): ReactElement {
  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-sm font-medium">选择渠道</label>
        <select
          className="w-full rounded border border-gray-300 px-3 py-2"
          defaultValue=""
          id="login-channel-select"
          disabled={busy}
        >
          <option value="" disabled>请选择…</option>
          {channels.map((c) => (
            <option key={c.cid} value={c.cid}>
              {c.display}（{c.logged_in ? "已登录" : "未登录"}）
            </option>
          ))}
        </select>
      </div>
      <div className="flex gap-2">
        <button
          className="rounded bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
          disabled={busy || noLoginChannels}
          onClick={() => {
            const select = document.getElementById("login-channel-select") as HTMLSelectElement;
            if (select.value) onLogin(select.value, false);
          }}
        >
          {busy ? "登录中…" : "登录"}
        </button>
        <button
          className="rounded bg-gray-200 px-4 py-2 text-sm hover:bg-gray-300 disabled:opacity-50"
          disabled={busy || noLoginChannels}
          onClick={() => {
            const select = document.getElementById("login-channel-select") as HTMLSelectElement;
            if (select.value) onLogin(select.value, true);
          }}
        >
          重新授权
        </button>
      </div>
      {message && <div className="text-sm">{message}</div>}
      {authUrl && (
        <div className="rounded bg-blue-50 p-3 text-sm">
          授权链接：
          <a className="ml-1 break-all text-blue-700 underline" href={authUrl} target="_blank" rel="noreferrer">
            {authUrl}
          </a>
        </div>
      )}
    </div>
  );
}
