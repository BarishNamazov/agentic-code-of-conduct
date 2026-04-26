import { useEffect, useMemo, useState } from "react";
import type { TimelineEvent, WorkspaceState } from "@shared/types";
import type { WorkspaceAgentClient } from "../lib/agent-client";
import { Timeline } from "../components/Timeline";

const FILTERS: { id: string; label: string; match?: (a: string) => boolean }[] = [
  { id: "all", label: "All" },
  {
    id: "reactions",
    label: "Reactions",
    match: (a) => a.startsWith("Reacting"),
  },
  {
    id: "tools",
    label: "Tools",
    match: (a) => a.startsWith("Tooling"),
  },
  {
    id: "spawning",
    label: "Spawning",
    match: (a) => a.startsWith("Spawning"),
  },
  {
    id: "runs",
    label: "Runs",
    match: (a) => a.startsWith("Running"),
  },
  {
    id: "failed",
    label: "Failures",
    match: (a) => a.startsWith("Tooling.failed") || a.endsWith(".failed"),
  },
];

export function TimelineView({
  state,
  agent,
}: {
  state: WorkspaceState;
  agent: WorkspaceAgentClient;
}) {
  const [events, setEvents] = useState<TimelineEvent[]>(state.recentEvents);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    agent.stub.getRecentActions(200).then((rows) => {
      if (!cancelled) setEvents(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [agent, state.recentEvents.length]);

  const filtered = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter);
    const q = query.trim().toLowerCase();
    return events.filter((e) => {
      if (f?.match && !f.match(e.action)) return false;
      if (!q) return true;
      const hay = `${e.action} ${e.actorAgentId} ${JSON.stringify(e.args)}`.toLowerCase();
      return hay.includes(q);
    });
  }, [events, filter, query]);

  // Show events newest-last for a "live console" feeling.
  const ordered = [...filtered].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of FILTERS) {
      c[f.id] = !f.match
        ? events.length
        : events.filter((e) => f.match!(e.action)).length;
    }
    return c;
  }, [events]);

  return (
    <div className="space-y-6">
      <header>
        <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-300/80">
          Audit log
        </div>
        <h1 className="font-display mt-1 text-2xl font-semibold tracking-tight">
          Timeline
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-neutral-400">
          The append-only action log. Every reaction, tool call and spawn is
          recorded here together with its causal chain.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg border border-neutral-800/80 bg-neutral-900/40 p-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                filter === f.id
                  ? "bg-emerald-500/15 text-emerald-200"
                  : "text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-100"
              }`}
            >
              {f.label}
              <span className="ml-1.5 text-[10px] text-neutral-500">
                {counts[f.id]}
              </span>
            </button>
          ))}
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter events…"
          className="input ml-auto w-full max-w-xs"
        />
      </div>

      {ordered.length === 0 ? (
        <div className="card py-12 text-center text-sm text-neutral-500">
          {events.length === 0
            ? "No actions yet."
            : "No events match the current filter."}
        </div>
      ) : (
        <div className="card p-3">
          <Timeline events={ordered} />
        </div>
      )}
    </div>
  );
}
