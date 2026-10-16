import { type ReactElement, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { LoginForm } from "../components/LoginForm";
import type { ChannelInfo } from "../lib/types";

/** 登录页：选渠道 → 触发登录 → 轮询 auth_url。 */
export function Login(): ReactElement {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [authUrl, setAuthUrl] = useState("");

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
      setAuthUrl("");
      return await api.commands.login(cid, force);
    },
    onSuccess: (res) => {
      if (res.ok) {
        setMessage(res.message ?? "登录指令已提交");
        if (typeof res.data === "object" && res.data !== null && "auth_url" in (res.data as Record<string, unknown>)) {
          const url = (res.data as Record<string, unknown>)["auth_url"];
          if (typeof url === "string" && url) setAuthUrl(url);
        }
      } else {
        setMessage(res.error ?? "登录失败");
      }
      void qc.invalidateQueries({ queryKey: ["logins"] });
      void qc.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (err) => setMessage(String(err)),
    onSettled: () => setBusy(false),
  });

  if (state.data?.auth_url && !authUrl) setAuthUrl(state.data.auth_url);

  const loginChannels = logins.data ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">登录</h1>
      <LoginForm
        channels={loginChannels}
        authUrl={authUrl}
        message={message}
        busy={busy}
        noLoginChannels={loginChannels.length === 0}
        onLogin={(cid, force) => doLogin.mutate({ cid, force })}
      />
    </div>
  );
}
