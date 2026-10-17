import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { ReactElement } from "react";

/**
 * 可点击复制的模型 chip：显示 `display`，点击复制 `value`（完整调用名）。
 *
 * 复制成功后短暂显示对勾反馈。剪贴板 API 需要安全上下文 —— 控制台跑在
 * `http://127.0.0.1` 下属于安全上下文，可用。
 */
export function CopyChip({ value, display }: { value: string; display?: string }): ReactElement {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // 剪贴板不可用（非安全上下文等）：静默失败，不打断浏览
    }
  };

  return (
    <button
      type="button"
      title={`点击复制：${value}`}
      onClick={() => void copy()}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-xs transition-colors ${
        copied
          ? "border-green-700 bg-green-950/60 text-green-300"
          : "border-gray-800 bg-gray-950 text-gray-300 hover:border-sky-700 hover:text-sky-300"
      }`}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3 opacity-50" />}
      {display ?? value}
    </button>
  );
}
