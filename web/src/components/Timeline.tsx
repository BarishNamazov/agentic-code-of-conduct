import type { TimelineEvent } from "@shared/types";

export function Timeline({ events }: { events: TimelineEvent[] }) {
  return (
    <ol className="space-y-1.5 text-xs">
      {events.map((e) => (
        <li
          key={e.id}
          className="grid grid-cols-[80px_minmax(140px,auto)_minmax(120px,auto)_1fr] items-start gap-2 rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-1.5"
          title={`Caused by ${e.causedByActionId ?? "—"} · reaction ${e.causedByReactionId ?? "—"}`}
        >
          <span className="mono text-[10px] text-neutral-500">
            {new Date(e.createdAt).toLocaleTimeString()}
          </span>
          <span className="mono text-[11px] text-neutral-300">{e.actorAgentId}</span>
          <span
            className={`badge truncate ${eventBadgeClass(e.action)}`}
            title={e.action}
          >
            {e.action}
          </span>
          <span className="mono truncate text-[11px] text-neutral-400">
            {summarizeArgs(e.args)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function summarizeArgs(args: Record<string, unknown>): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    let val: string;
    if (typeof v === "string") val = v;
    else if (v == null) val = "—";
    else val = JSON.stringify(v);
    out.push(`${k}=${val.length > 60 ? val.slice(0, 60) + "…" : val}`);
    if (out.length >= 3) break;
  }
  return out.join(" ");
}

function eventBadgeClass(action: string): string {
  if (action.startsWith("Tooling.completed")) return "badge-active";
  if (action.startsWith("Tooling.failed") || action.endsWith(".failed")) return "badge-fail";
  if (action.startsWith("Spawning")) return "badge-warn";
  if (action.startsWith("Running")) return "badge-active";
  return "";
}
