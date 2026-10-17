import { AlertCircle, CheckCircle2, ExternalLink, Lightbulb, Loader2, QrCode, X } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

/**
 * 「添加账号」登录弹窗（模态）。
 *
 * ⚠ 只有右上角的关闭按钮能关闭 —— 遮罩点击 / ESC 一律不关（登录进行中误触
 * 丢流程比关不掉更糟）。步骤渲染成时间线：授权页渲染成**按钮**而不是裸 URL。
 */
export interface LoginSnapshot {
  ui_state: string;
  message: string;
  auth_url: string;
  qr_url: string;
}

export function LoginModal({
  cid,
  display,
  snapshot,
  submitting,
  onStartLogin,
  onSubmitCallback,
  onClose,
}: {
  cid: string;
  display?: string;
  snapshot: LoginSnapshot | undefined;
  submitting: boolean;
  /** 弹窗打开时触发一次（走一次授权流程）。 */
  onStartLogin: (cid: string) => void;
  onSubmitCallback: (url: string) => void;
  onClose: () => void;
}): ReactElement {
  // 打开即触发一轮登录（父组件负责防重入）
  useEffect(() => {
    onStartLogin(cid);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开/换渠道时触发一次
  }, [cid]);

  const authUrl = snapshot?.auth_url ?? "";
  const qrUrl = snapshot?.qr_url ?? "";
  const message = snapshot?.message ?? "";
  const preparing = !authUrl && !qrUrl;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`添加账号：${cid}`}
      // 刻意不绑 onClick 关闭：登录进行中误触遮罩会丢流程（需求：仅关闭键可关）
    >
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-gray-700 bg-gray-900 shadow-2xl">
        {/* 头部 */}
        <div className="flex items-center gap-3 border-b border-gray-800 px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/15 text-sky-400">
            <QrCode className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-gray-100">
              添加账号
              <span className="ml-2 font-mono text-sky-300">{cid}</span>
            </div>
            {display && <div className="truncate text-xs text-gray-500">{display}</div>}
          </div>
          {/* 唯一的关闭入口 */}
          <button
            type="button"
            aria-label="关闭"
            className="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-800 hover:text-gray-200"
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* 步骤时间线 */}
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          {qrUrl ? (
            <Steps
              items={[
                {
                  title: "用微信扫这张二维码",
                  body: (
                    <div className="inline-block rounded-lg border border-gray-700 bg-white p-2">
                      <img src={qrUrl} alt="登录二维码" className="h-40 w-40" />
                    </div>
                  ),
                },
                { title: "在手机上确认登录", body: null },
                {
                  title: "等待自动完成",
                  body: (
                    <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      授权成功后账号会自动入池，本弹窗可随时关闭
                    </span>
                  ),
                },
              ]}
            />
          ) : authUrl ? (
            <Steps
              items={[
                {
                  title: "打开授权页",
                  body: (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-500"
                      onClick={() => window.open(authUrl, "_blank", "noopener")}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      打开授权页（新窗口）
                    </button>
                  ),
                },
                { title: "在官方页面完成登录 / 授权", body: null },
                {
                  title: "复制回调链接",
                  body: (
                    <span className="text-xs text-gray-500">
                      授权后浏览器会跳到一个<strong className="text-gray-300">打不开的回调页</strong>
                      （自定义协议），这是正常的 —— 复制地址栏里的整条链接。
                    </span>
                  ),
                },
                {
                  title: "粘贴并提交",
                  body: (
                    <CallbackForm
                      onSubmit={onSubmitCallback}
                      submitting={submitting}
                      placeholder="粘贴地址栏里的整条回调链接"
                    />
                  ),
                },
              ]}
            />
          ) : (
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
              正在准备登录会话…
            </div>
          )}

          {/* 温馨提醒 */}
          <div className="rounded-lg border border-amber-900/50 bg-amber-950/40 p-3 text-xs text-amber-200/90">
            <div className="mb-1 flex items-center gap-1.5 font-medium">
              <Lightbulb className="h-3.5 w-3.5" />
              温馨提醒
            </div>
            <ul className="list-disc space-y-1 pl-4">
              <li>如果浏览器拦截了新窗口，回到步骤 1 再点一次「打开授权页」即可。</li>
              <li>回调页打不开是正常现象（自定义协议），链接照样能复制。</li>
              <li>登录成功后账号自动入池并设为生效；失败时本弹窗会显示原因。</li>
            </ul>
          </div>

          {/* 后端状态 / 错误 */}
          {message && (
            <div className="flex items-start gap-2 rounded-lg border border-gray-800 bg-gray-950 p-3 text-xs text-gray-400">
              {snapshot?.ui_state === "error" ? (
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
              ) : (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-400" />
              )}
              <span className="min-w-0 break-words">{message || (snapshot?.ui_state === "error" ? "登录失败" : "进行中…")}</span>
            </div>
          )}
          {preparing && message && <div className="text-xs text-gray-600">{message}</div>}
        </div>
      </div>
    </div>
  );
}

/** 步骤时间线：数字圆点 + 标题 + 可选正文。 */
function Steps({
  items,
}: {
  items: Array<{ title: string; body: ReactElement | null }>;
}): ReactElement {
  return (
    <ol className="space-y-4">
      {items.map((item, i) => (
        <li key={item.title} className="flex gap-3">
          <div className="flex flex-col items-center">
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                item.body ? "bg-sky-500/20 text-sky-300" : "bg-gray-800 text-gray-400"
              }`}
            >
              {i + 1}
            </span>
            {i < items.length - 1 && <span className="mt-1 w-px flex-1 bg-gray-700" />}
          </div>
          <div className="min-w-0 flex-1 pb-1">
            <div className="text-sm font-medium text-gray-200">{item.title}</div>
            {item.body && <div className="mt-1.5">{item.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** 回调链接粘贴表单。 */
function CallbackForm({
  onSubmit,
  submitting,
  placeholder,
}: {
  onSubmit: (url: string) => void;
  submitting: boolean;
  placeholder: string;
}): ReactElement {
  return (
    <CallbackFormInner onSubmit={onSubmit} submitting={submitting} placeholder={placeholder} />
  );
}

function CallbackFormInner({
  onSubmit,
  submitting,
  placeholder,
}: {
  onSubmit: (url: string) => void;
  submitting: boolean;
  placeholder: string;
}): ReactElement {
  const [value, setValue] = useState("");
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSubmit(value.trim());
      }}
    >
      <input
        className="min-w-0 flex-1 rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 transition-colors focus:border-sky-500 focus:outline-none"
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button
        type="submit"
        className="shrink-0 rounded-lg bg-sky-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
        disabled={submitting || !value.trim()}
      >
        完成登录
      </button>
    </form>
  );
}
