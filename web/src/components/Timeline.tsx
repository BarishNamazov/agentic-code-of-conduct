import { useState } from "react";
import type { TimelineEvent } from "@shared/types";
import { JsonViewer } from "./JsonViewer";

export function Timeline({
  events,
  density = "comfortable",
}: {
  events: TimelineEvent[];
  density?: "comfortable" | "compact";
}) {
  const idIndex = new Map(events.map((e) => [e.id, e]));
  return (
    <ol className={density === "compact" ? "space-y-1" : "space-y-1.5"}>
      {events.map((e) => (
        <TimelineRow key={e.id} event={e} idIndex={idIndex} density={density} />
      ))}
    </ol>
  );
}

function TimelineRow({
  event: e,
  idIndex,
  density,
}: {
  event: TimelineEvent;
  idIndex: Map<string, TimelineEvent>;
  density: "comfortable" | "compact";
}) {
  const [open, setOpen] = useState(false);
  const cause = e.causedByActionId ? idIndex.get(e.causedByActionId) : null;
  const summary = summarizeArgs(e.args);
  return (
    <li
      className={`rounded-md border border-neutral-800 bg-neutral-950/60 transition ${
        open ? "border-neutral-700" : ""
      }`}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-start gap-2 px-3 text-left ${
          density === "compact" ? "py-1" : "py-1.5"
        }`}
      >
        <span className="mono w-[78px] shrink-0 text-[10px] text-neutral-500">
          {new Date(e.createdAt).toLocaleTimeString()}
        </span>
        <span
          className={`badge shrink-0 ${eventBadgeClass(e.action)}`}
          title={e.action}
        >
          {e.action}
        </span>
        <span className="mono shrink-0 text-[11px] text-neutral-400">
          {e.actorAgentId}
        </span>
        <span className="mono min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-neutral-300">
          {summary}
        </span>
        <span className="shrink-0 text-[10px] text-neutral-600">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="border-t border-neutral-800/80 p-3 text-[11px]">
          <Field label="id" value={e.id} mono />
          <Field label="actor" value={e.actorAgentId} mono />
          {e.runId && <Field label="run" value={e.runId} mono />}
          {e.behaviorVersionId && (
            <Field label="behavior" value={e.behaviorVersionId} mono />
          )}
          {e.causedByReactionId && (
            <Field label="reaction" value={e.causedByReactionId} mono />
          )}
          {cause && (
            <Field
              label="caused by"
              value={`${cause.action} (${cause.id})`}
              mono
            />
          )}
          <div className="mt-2">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">
              args
            </div>
            <JsonViewer value={e.args} collapsed={false} />
          </div>
        </div>
      )}
    </li>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex gap-2 text-[11px]">
      <span className="w-20 shrink-0 text-neutral-500">{label}</span>
      <span className={mono ? "mono text-neutral-200" : "text-neutral-200"}>{value}</span>
    </div>
  );
}

function summarizeArgs(args: Record<string, unknown>): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    let val: string;
    if (typeof v === "string") val = v;
    else if (v == null) val = "—";
    else val = JSON.stringify(v);
    out.push(`${k}=${val}`);
  }
  return out.join("  ");
}

function eventBadgeClass(action: string): string {
  if (action.startsWith("Tooling.completed")) return "badge-active";
  if (action.startsWith("Tooling.failed") || action.endsWith(".failed"))
    return "badge-fail";
  if (action.startsWith("Spawning")) return "badge-warn";
  if (action.startsWith("Running")) return "badge-active";
  if (action.startsWith("Reacting")) return "badge-info";
  return "";
}
