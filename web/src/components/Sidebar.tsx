import type { WorkspaceState } from "@shared/types";
import type { Route } from "../App";

export function Sidebar({
  route,
  navigate,
  state,
}: {
  route: Route;
  navigate: (r: Route) => void;
  state: WorkspaceState;
}) {
  const agents = state.agents.filter((a) => a.kind === "top_level");
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950/80 px-4 py-6">
      <div className="mb-6 flex items-center gap-2">
        <Logo />
        <div>
          <div className="text-sm font-semibold tracking-tight">Behaving Agents</div>
          <div className="text-[10px] uppercase tracking-widest text-neutral-500">
            workspace · default
          </div>
        </div>
      </div>

      <nav className="space-y-1 text-sm">
        <NavLink active={route.name === "dashboard"} onClick={() => navigate({ name: "dashboard" })}>
          Dashboard
        </NavLink>
        <NavLink active={route.name === "create"} onClick={() => navigate({ name: "create" })}>
          + New agent
        </NavLink>
        <NavLink active={route.name === "graph"} onClick={() => navigate({ name: "graph" })}>
          Graph
        </NavLink>
        <NavLink active={route.name === "timeline"} onClick={() => navigate({ name: "timeline" })}>
          Timeline
        </NavLink>
      </nav>

      <div className="mt-8">
        <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-widest text-neutral-500">
          Agents
        </div>
        <div className="space-y-1 text-sm">
          {agents.length === 0 && (
            <div className="px-2 text-xs text-neutral-500">No agents yet.</div>
          )}
          {agents.map((a) => (
            <NavLink
              key={a.id}
              active={route.name === "agent" && route.agentId === a.id}
              onClick={() => navigate({ name: "agent", agentId: a.id })}
            >
              <span className="truncate">{a.name}</span>
              <span className="ml-auto text-[10px] text-neutral-500">{a.status}</span>
            </NavLink>
          ))}
        </div>
      </div>

      <div className="mt-auto pt-6 text-[10px] text-neutral-600">
        v0.1 · MVP · {state.agents.length} agents · {state.activeRuns.length} runs
      </div>
    </aside>
  );
}

function NavLink({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition ${
        active
          ? "bg-emerald-500/10 text-emerald-300"
          : "text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100"
      }`}
    >
      {children}
    </button>
  );
}

function Logo() {
  return (
    <svg width="24" height="24" viewBox="0 0 64 64" fill="none">
      <circle cx="32" cy="32" r="28" fill="#111827" />
      <circle cx="24" cy="28" r="4" fill="#34d399" />
      <circle cx="40" cy="28" r="4" fill="#34d399" />
      <path
        d="M22 42 Q32 50 42 42"
        stroke="#34d399"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
