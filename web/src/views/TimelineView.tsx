import { useEffect, useState } from "react";
import type { TimelineEvent, WorkspaceState } from "@shared/types";
import type { WorkspaceAgentClient } from "../lib/agent-client";
import { Timeline } from "../components/Timeline";

export function TimelineView({
  state,
  agent,
}: {
  state: WorkspaceState;
  agent: WorkspaceAgentClient;
}) {
  const [events, setEvents] = useState<TimelineEvent[]>(state.recentEvents);

  useEffect(() => {
    let cancelled = false;
    agent.stub.getRecentActions(200).then((rows) => {
      if (!cancelled) setEvents(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [agent, state.recentEvents.length]);

  // Show events newest-last for a "live console" feeling.
  const ordered = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Timeline</h1>
        <p className="mt-1 text-sm text-neutral-400">
          The append-only action log. Every reaction, tool call and spawn is recorded
          here together with its causal chain.
        </p>
      </header>
      {ordered.length === 0 ? (
        <div className="card text-sm text-neutral-500">No actions yet.</div>
      ) : (
        <div className="card">
          <Timeline events={ordered} />
        </div>
      )}
    </div>
  );
}
