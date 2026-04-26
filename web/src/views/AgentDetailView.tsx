import { useEffect, useState } from "react";
import type { AgentDetail, BCIR, RunChunk, WorkspaceState } from "@shared/types";
import type { WorkspaceAgentClient } from "../lib/agent-client";
import type { Route } from "../App";
import { BCIRView } from "../components/BehaviorPreview";
import { ChatPanel } from "../components/ChatPanel";
import { ReviseDialog } from "../components/ReviseDialog";

type SideTab = "behavior" | "versions" | "children" | "runs";

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
  const [tab, setTab] = useState<SideTab>("behavior");
  const [railOpen, setRailOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // Only blank the panel when the user navigates to a different agent.
    // Re-fetches triggered by `runVersion` keep the previous detail visible
    // (and the chat mounted) until the fresh detail arrives.
    setDetail((prev) => (prev && prev.agent.id === agentId ? prev : null));
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
  }, [agent, agentId, runVersion, state.agents.length]);

  const onRun = async (
    userInput: string,
    handlers: {
      onChunk: (c: RunChunk) => void;
      onDone?: (final: { type: "done"; runId: string }) => void;
      onError?: (msg: string) => void;
    }
  ): Promise<unknown> => agent.runAgent({ agentId, userInput }, handlers);

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
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider text-neutral-500">
            Agent · {detail.agent.kind}
          </div>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight">
            {detail.agent.name}
          </h1>
          <div className="mono mt-1 text-[11px] text-neutral-500">
            {detail.agent.id}
          </div>
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
          <div className="flex gap-2">
            <button onClick={() => setShowRevise(true)} className="btn">
              Revise
            </button>
            <button onClick={onDeleteAgent} className="btn btn-danger">
              Delete
            </button>
          </div>
          <button
            onClick={() => setRailOpen((v) => !v)}
            className="text-[11px] text-neutral-500 hover:text-neutral-300"
          >
            {railOpen ? "Hide details ▸" : "◂ Show details"}
          </button>
        </div>
      </header>

      <div
        className={`grid gap-5 ${
          railOpen ? "grid-cols-1 lg:grid-cols-[1fr_360px]" : "grid-cols-1"
        }`}
      >
        <ChatPanel
          rootAgent={detail.agent}
          allAgents={state.agents}
          onRun={onRun}
          onAfterRun={() => setRunVersion((v) => v + 1)}
        />

        {railOpen && (
          <aside className="space-y-3">
            <div className="flex items-center gap-1 rounded-lg border border-neutral-800 bg-neutral-900/40 p-1">
              <TabButton
                active={tab === "behavior"}
                onClick={() => setTab("behavior")}
              >
                Behavior
              </TabButton>
              <TabButton
                active={tab === "versions"}
                onClick={() => setTab("versions")}
              >
                Versions
                <span className="ml-1 text-[10px] text-neutral-500">
                  {detail.versions.length}
                </span>
              </TabButton>
              <TabButton
                active={tab === "children"}
                onClick={() => setTab("children")}
              >
                Children
                <span className="ml-1 text-[10px] text-neutral-500">
                  {childRows.length}
                </span>
              </TabButton>
              <TabButton active={tab === "runs"} onClick={() => setTab("runs")}>
                Runs
                <span className="ml-1 text-[10px] text-neutral-500">
                  {detail.recentRuns.length}
                </span>
              </TabButton>
            </div>

            <div className="max-h-[72vh] overflow-y-auto">
              {tab === "behavior" && <BCIRView bcir={detail.behavior} />}

              {tab === "versions" && (
                <div className="card">
                  {detail.versions.length === 0 ? (
                    <div className="text-sm text-neutral-500">No versions.</div>
                  ) : (
                    <ul className="space-y-2 text-sm">
                      {detail.versions.map((v) => (
                        <li
                          key={v.id}
                          className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2"
                        >
                          <div>
                            <div className="font-semibold">v{v.versionNumber}</div>
                            <div className="mono text-[11px] text-neutral-500">
                              {v.id}
                            </div>
                          </div>
                          <div className="text-[10px] text-neutral-500">
                            {new Date(v.createdAt).toLocaleString()}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {tab === "children" && (
                <div className="card">
                  {childRows.length === 0 ? (
                    <div className="text-sm text-neutral-500">
                      None yet. Children appear when this agent's behavior triggers
                      a <span className="mono">Spawning.spawn</span> request.
                    </div>
                  ) : (
                    <ul className="space-y-2 text-sm">
                      {childRows.map((c) => (
                        <li key={c.id}>
                          <button
                            onClick={() =>
                              navigate({ name: "agent", agentId: c.id })
                            }
                            className="flex w-full items-center justify-between rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-left transition hover:border-emerald-500/40"
                          >
                            <div>
                              <div className="font-semibold">{c.name}</div>
                              <div className="mono text-[11px] text-neutral-500">
                                {c.id}
                              </div>
                            </div>
                            <span className="badge">{c.status}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {tab === "runs" && (
                <div className="card">
                  {detail.recentRuns.length === 0 ? (
                    <div className="text-sm text-neutral-500">No runs yet.</div>
                  ) : (
                    <ul className="space-y-2 text-sm">
                      {detail.recentRuns.map((r) => (
                        <li
                          key={r.id}
                          className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2"
                        >
                          <div className="flex items-center justify-between">
                            <div className="mono text-[11px] text-neutral-400">
                              {r.id}
                            </div>
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
                            <div className="mt-1 line-clamp-2 text-xs text-neutral-300">
                              {r.inputText}
                            </div>
                          )}
                          <div className="mt-1 text-[10px] text-neutral-500">
                            {new Date(r.startedAt).toLocaleString()}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

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

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-md px-2 py-1.5 text-xs font-semibold transition ${
        active
          ? "bg-emerald-500/15 text-emerald-300"
          : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
      }`}
    >
      {children}
    </button>
  );
}
