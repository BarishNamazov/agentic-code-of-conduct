import { useEffect, useState } from "react";
import type { AgentDetail, BCIR, RunChunk, WorkspaceState } from "@shared/types";
import type { WorkspaceAgentClient } from "../lib/agent-client";
import type { Route } from "../App";
import { BCIRView } from "../components/BehaviorPreview";
import { RunConsole } from "../components/RunConsole";
import { ReviseDialog } from "../components/ReviseDialog";

export function AgentDetailView({
  agentId,
  state,
  agent,
  navigate,
}: {
  agentId: string;
  state: WorkspaceState;
  agent: WorkspaceAgentClient;
  navigate: (r: Route) => void;
}) {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runVersion, setRunVersion] = useState(0);
  const [showRevise, setShowRevise] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    agent.stub
      .getAgentDetail(agentId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
    // re-fetch when sidebar shows new versions / runs
  }, [agent, agentId, runVersion, state.agents.length]);

  const onRun = async (
    userInput: string,
    handlers: {
      onChunk: (c: RunChunk) => void;
      onDone?: (final: { type: "done"; runId: string }) => void;
      onError?: (msg: string) => void;
    }
  ) => agent.runAgent({ agentId, userInput }, handlers);

  const onDeleteAgent = async () => {
    if (!confirm("Delete this agent and all of its descendants?")) return;
    await agent.stub.deleteAgent(agentId);
    navigate({ name: "dashboard" });
  };

  const onRevise = async (normalized: BCIR) => {
    await agent.stub.reviseBehavior({ agentId, normalized });
    setShowRevise(false);
    setRunVersion((v) => v + 1);
  };

  if (error) {
    return <div className="card text-sm text-red-300">{error}</div>;
  }

  if (!detail) {
    return <div className="text-sm text-neutral-500">Loading agent…</div>;
  }

  const childRows = detail.children;

  return (
    <div className="space-y-8">
      <header className="flex items-start justify-between gap-6">
        <div>
          <div className="text-xs uppercase tracking-wider text-neutral-500">
            Agent · {detail.agent.kind}
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {detail.agent.name}
          </h1>
          <div className="mono mt-1 text-[11px] text-neutral-500">{detail.agent.id}</div>
          {detail.behavior.agent.purpose && (
            <p className="mt-3 max-w-2xl text-sm text-neutral-300">
              {detail.behavior.agent.purpose}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <span
            className={`badge ${detail.agent.status === "active" ? "badge-active" : ""}`}
          >
            {detail.agent.status}
          </span>
          <button onClick={() => setShowRevise(true)} className="btn">
            Revise behavior
          </button>
          <button onClick={onDeleteAgent} className="btn btn-danger">
            Delete
          </button>
        </div>
      </header>

      <RunConsole
        key={detail.agent.id + ":" + runVersion}
        onRun={onRun}
        onAfterRun={() => setRunVersion((v) => v + 1)}
      />

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <BCIRView bcir={detail.behavior} />
        </div>
        <div className="space-y-4">
          <div className="card">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
              Behavior versions
            </h3>
            <ul className="mt-3 space-y-2 text-sm">
              {detail.versions.map((v) => (
                <li
                  key={v.id}
                  className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2"
                >
                  <div>
                    <div className="font-semibold">v{v.versionNumber}</div>
                    <div className="mono text-[11px] text-neutral-500">{v.id}</div>
                  </div>
                  <div className="text-xs text-neutral-500">
                    {new Date(v.createdAt).toLocaleString()}
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="card">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
              Spawned children ({childRows.length})
            </h3>
            {childRows.length === 0 ? (
              <div className="mt-2 text-sm text-neutral-500">
                None yet. Children appear when this agent's behavior triggers a
                <span className="mono"> Spawning.spawn</span> request.
              </div>
            ) : (
              <ul className="mt-3 space-y-2 text-sm">
                {childRows.map((c) => (
                  <li key={c.id}>
                    <button
                      onClick={() => navigate({ name: "agent", agentId: c.id })}
                      className="flex w-full items-center justify-between rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-left transition hover:border-emerald-500/40"
                    >
                      <div>
                        <div className="font-semibold">{c.name}</div>
                        <div className="mono text-[11px] text-neutral-500">{c.id}</div>
                      </div>
                      <span className="badge">{c.status}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
              Recent runs
            </h3>
            {detail.recentRuns.length === 0 ? (
              <div className="mt-2 text-sm text-neutral-500">No runs yet.</div>
            ) : (
              <ul className="mt-3 space-y-2 text-sm">
                {detail.recentRuns.map((r) => (
                  <li
                    key={r.id}
                    className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2"
                  >
                    <div className="flex items-center justify-between">
                      <div className="mono text-[11px] text-neutral-400">{r.id}</div>
                      <span
                        className={`badge ${
                          r.status === "completed"
                            ? "badge-active"
                            : r.status === "failed"
                              ? "badge-fail"
                              : ""
                        }`}
                      >
                        {r.status}
                      </span>
                    </div>
                    {r.inputText && (
                      <div className="mt-1 truncate text-xs text-neutral-300">
                        {r.inputText}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {showRevise && (
        <ReviseDialog
          agent={agent}
          current={detail.behavior}
          onClose={() => setShowRevise(false)}
          onSubmit={onRevise}
        />
      )}
    </div>
  );
}
