import { useState } from "react";

export function JsonViewer({
  value,
  collapsed = true,
  className = "",
}: {
  value: unknown;
  collapsed?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(!collapsed);
  if (value === undefined || value === null) {
    return <span className="text-neutral-500">—</span>;
  }
  let pretty: string;
  try {
    pretty = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    pretty = String(value);
  }
  const isShort = pretty.length < 80 && !pretty.includes("\n");
  if (isShort) {
    return (
      <code className={`mono text-[11px] text-neutral-300 ${className}`}>{pretty}</code>
    );
  }
  return (
    <div className={`rounded-md border border-neutral-800 bg-neutral-950 ${className}`}>
      <div className="flex items-center justify-between px-2 py-1 text-[10px] uppercase tracking-wider text-neutral-500">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 hover:text-neutral-300"
        >
          <span>{open ? "▼" : "▶"}</span>
          <span>{open ? "hide" : "show"}</span>
          <span className="text-neutral-600">· {pretty.length} chars</span>
        </button>
        <button
          onClick={() => void navigator.clipboard.writeText(pretty)}
          className="hover:text-emerald-300"
        >
          copy
        </button>
      </div>
      {open && (
        <pre className="mono max-h-72 overflow-auto whitespace-pre-wrap break-words px-2 pb-2 text-[11px] text-neutral-200">
          {pretty}
        </pre>
      )}
    </div>
  );
}
