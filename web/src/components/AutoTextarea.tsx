import { useEffect, useRef } from "react";

export function AutoTextarea({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  minRows = 2,
  maxRows = 12,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  disabled?: boolean;
  minRows?: number;
  maxRows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Reset, then size to scrollHeight bounded by maxRows.
    el.style.height = "auto";
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight || "20") || 20;
    const padding = 16; // approx vertical padding
    const max = lineHeight * maxRows + padding;
    el.style.height = Math.min(el.scrollHeight, max) + "px";
  }, [value, maxRows]);

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      rows={minRows}
      spellCheck={false}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          onSubmit?.();
        }
      }}
      className="block w-full resize-none rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm leading-relaxed text-neutral-100 placeholder-neutral-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-50"
    />
  );
}
