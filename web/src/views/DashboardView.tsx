import type { WorkspaceState } from "@shared/types";
import type { WorkspaceAgentClient } from "../lib/agent-client";
import type { Route } from "../App";

export function DashboardView({
  state,
  agent: _agent,
  navigate,
}: {
  state: WorkspaceState;
  agent: WorkspaceAgentClient;
  navigate: (r: Route) => void;
}) {
  const topLevel = state.agents.filter((a) => a.kind === "top_level");
  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workspace</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Behavioral-code agents you have created. Every agent has stored, versioned
            behavior. Spawned children appear under their parent in the graph.
          </p>
        </div>
        <button
          onClick={() => navigate({ name: "create" })}
          className="btn btn-primary"
        >
          + Create agent
        </button>
      </header>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Stat label="Top-level agents" value={topLevel.length} />
        <Stat label="Spawned agents" value={state.agents.length - topLevel.length} />
        <Stat label="Total runs" value={state.activeRuns.length} />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-neutral-400">
          Agents
        </h2>
        {topLevel.length === 0 ? (
          <EmptyState onCreate={() => navigate({ name: "create" })} />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {topLevel.map((a) => (
              <button
                key={a.id}
                onClick={() => navigate({ name: "agent", agentId: a.id })}
                className="card group flex flex-col gap-2 text-left transition hover:border-emerald-500/40 hover:bg-neutral-900"
              >
                <div className="flex items-center justify-between">
                  <div className="font-semibold tracking-tight">{a.name}</div>
                  <span
                    className={`badge ${
                      a.status === "active" ? "badge-active" : ""
                    }`}
                  >
                    {a.status}
                  </span>
                </div>
                <div className="mono text-[11px] text-neutral-500">{a.id}</div>
                <div className="text-xs text-neutral-400">
                  Updated {new Date(a.updatedAt).toLocaleString()}
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-neutral-400">
          Recent activity
        </h2>
        <div className="card">
          {state.recentEvents.length === 0 ? (
            <div className="text-sm text-neutral-500">
              No actions yet. Create an agent and run it to see live events here.
            </div>
          ) : (
            <ul className="space-y-2 text-sm">
              {state.recentEvents.slice(0, 12).map((e) => (
                <li key={e.id} className="flex items-start gap-3">
                  <span className="mono mt-0.5 shrink-0 text-[10px] text-neutral-500">
                    {new Date(e.createdAt).toLocaleTimeString()}
                  </span>
                  <span className="badge">{e.action}</span>
                  <span className="mono truncate text-xs text-neutral-400">
                    {e.actorAgentId}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card">
      <div className="text-xs uppercase tracking-wider text-neutral-500">{label}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight">{value}</div>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="card flex flex-col items-center justify-center gap-4 py-12 text-center">
      <div className="text-4xl">🌱</div>
      <div className="font-semibold">No agents yet</div>
      <p className="max-w-md text-sm text-neutral-400">
        An agent is a behavior, not a prompt. Paste a description of how the agent
        should react to events and you'll get a normalized, runnable behavior version.
      </p>
      <button onClick={onCreate} className="btn btn-primary">
        Create your first agent
      </button>
    </div>
  );
}
