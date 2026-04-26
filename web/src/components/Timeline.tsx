import { useState } from "react";
import type { TimelineEvent } from "@shared/types";
import { JsonViewer } from "./JsonViewer";

export function Timeline({
  events,
  density = "comfortable",
  agentNames,
}: {
  events: TimelineEvent[];
  density?: "comfortable" | "compact";
  agentNames?: Map<string, string>;
}) {
  const idIndex = new Map(events.map((e) => [e.id, e]));
  return (
    <ol className={density === "compact" ? "space-y-0.5" : "space-y-1"}>
      {events.map((e) => (
        <TimelineRow
          key={e.id}
          event={e}
          idIndex={idIndex}
          density={density}
          agentNames={agentNames}
        />
      ))}
    </ol>
  );
}

function TimelineRow({
  event: e,
  idIndex,
  density,
  agentNames,
}: {
  event: TimelineEvent;
  idIndex: Map<string, TimelineEvent>;
  density: "comfortable" | "compact";
  agentNames?: Map<string, string>;
}) {
  const actorName = agentNames?.get(e.actorAgentId) ?? e.actorAgentId;
  const actorTooltip =
    actorName === e.actorAgentId ? e.actorAgentId : `${actorName} · ${e.actorAgentId}`;
  const [open, setOpen] = useState(false);
  const cause = e.causedByActionId ? idIndex.get(e.causedByActionId) : null;
  const summary = summarizeArgs(e.args);
  const stripeColor = categoryColor(e.action);
  return (
    <li
      className={`group relative overflow-hidden rounded-md border transition ${
        open
          ? "border-neutral-700 bg-neutral-900/60"
          : "border-neutral-800/70 bg-neutral-950/40 hover:border-neutral-700 hover:bg-neutral-900/40"
      }`}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-0.5"
        style={{ background: stripeColor }}
      />
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-start gap-2 pl-3 pr-3 text-left ${
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
        <span
          className="mono shrink-0 text-[11px] text-neutral-400"
          title={actorTooltip}
        >
          {actorName}
        </span>
        <span className="mono min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-neutral-300">
          {summary}
        </span>
        <span className="shrink-0 text-[10px] text-neutral-600 transition group-hover:text-neutral-400">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="animate-fade-in border-t border-neutral-800/80 p-3 text-[11px]">
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            <Field label="id" value={e.id} mono />
            <Field
              label="actor"
              value={
                actorName !== e.actorAgentId
                  ? `${actorName} (${e.actorAgentId})`
                  : e.actorAgentId
              }
              mono
            />
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
          </div>
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
      <span
        className={`min-w-0 truncate text-neutral-200 ${mono ? "mono" : ""}`}
      >
        {value}
      </span>
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

function categoryColor(action: string): string {
  if (action.startsWith("Tooling.completed")) return "rgb(var(--emerald-400))";
  if (action.startsWith("Tooling.failed") || action.endsWith(".failed"))
    return "rgb(var(--red-400))";
  if (action.startsWith("Spawning")) return "rgb(var(--yellow-400))";
  if (action.startsWith("Running")) return "rgb(var(--sky-400))";
  if (action.startsWith("Reacting")) return "rgb(var(--violet-400))";
  return "rgb(var(--neutral-600))";
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
