import { useEffect, useMemo, useState } from "react";
import type { WorkspaceState } from "@shared/types";
import { useWorkspaceAgent, type WorkspaceAgentClient } from "./lib/agent-client";
import { useTheme } from "./lib/theme";
import { Sidebar } from "./components/Sidebar";
import { DashboardView } from "./views/DashboardView";
import { CreateAgentView } from "./views/CreateAgentView";
import { AgentDetailView } from "./views/AgentDetailView";
import { GraphView } from "./views/GraphView";
import { TimelineView } from "./views/TimelineView";

export type Route =
  | { name: "dashboard" }
  | { name: "create" }
  | { name: "agent"; agentId: string }
  | { name: "graph" }
  | { name: "timeline" };

const INITIAL_STATE: WorkspaceState = {
  agents: [],
  activeRuns: [],
  graph: { nodes: [], edges: [] },
  recentEvents: [],
};

export function App() {
  const [route, setRoute] = useState<Route>({ name: "dashboard" });
  const [state, setState] = useState<WorkspaceState>(INITIAL_STATE);
  const [connected, setConnected] = useState(false);
  const themeApi = useTheme();

  const agent: WorkspaceAgentClient = useWorkspaceAgent((next) => setState(next));

  useEffect(() => {
    let cancelled = false;
    (agent.ready as Promise<void>)
      .then(() => {
        if (!cancelled) setConnected(true);
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agent]);

  const navigate = (next: Route) => setRoute(next);

  const view = useMemo(() => {
    if (!connected) {
      return <ConnectingScreen />;
    }
    switch (route.name) {
      case "dashboard":
        return <DashboardView state={state} agent={agent} navigate={navigate} />;
      case "create":
        return <CreateAgentView agent={agent} navigate={navigate} />;
      case "agent":
        return (
          <AgentDetailView
            key={route.agentId}
            agentId={route.agentId}
            state={state}
            agent={agent}
            navigate={navigate}
          />
        );
      case "graph":
        return <GraphView state={state} navigate={navigate} />;
      case "timeline":
        return <TimelineView state={state} agent={agent} />;
    }
  }, [route, state, agent, connected]);

  return (
    <div className="flex h-full w-full">
      <Sidebar
        route={route}
        navigate={navigate}
        state={state}
        theme={themeApi.theme}
        onToggleTheme={themeApi.toggle}
      />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl px-6 py-8">{view}</div>
      </main>
    </div>
  );
}

function ConnectingScreen() {
  return (
    <div className="flex h-[60vh] items-center justify-center text-neutral-400">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="relative h-12 w-12">
          <div className="absolute inset-0 animate-ping rounded-full bg-emerald-400/30" />
          <div className="absolute inset-2 rounded-full bg-gradient-to-br from-emerald-400 to-sky-400 shadow-glow" />
        </div>
        <div>
          <div className="text-sm font-medium text-neutral-200">
            Connecting to workspace
          </div>
          <div className="mt-0.5 text-xs text-neutral-500">
            Establishing a session with the agent runtime…
          </div>
        </div>
      </div>
    </div>
  );
}
