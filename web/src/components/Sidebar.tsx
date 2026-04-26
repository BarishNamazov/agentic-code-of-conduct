import type { WorkspaceState } from "@shared/types";
import type { Route } from "../App";
import type { Theme } from "../lib/theme";
import { identityFor } from "../lib/theme";

export function Sidebar({
  route,
  navigate,
  state,
  theme,
  onToggleTheme,
}: {
  route: Route;
  navigate: (r: Route) => void;
  state: WorkspaceState;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const agents = state.agents.filter((a) => a.kind === "top_level");
  const spawnedCount = state.agents.length - agents.length;

  return (
    <aside className="relative flex h-full w-64 shrink-0 flex-col border-r border-neutral-800/80 bg-neutral-950/70 px-4 py-6 backdrop-blur-md">
      <button
        onClick={() => navigate({ name: "dashboard" })}
        className="focus-ring mb-7 flex items-center gap-2.5 rounded-lg text-left"
        title="Workspace home"
      >
        <Logo />
        <div className="min-w-0">
          <div className="font-display truncate text-sm font-semibold tracking-tight text-neutral-50">
            EthOS
          </div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
            workspace · default
          </div>
        </div>
      </button>

      <nav className="space-y-0.5">
        <NavLink
          icon={<DashboardIcon />}
          active={route.name === "dashboard"}
          onClick={() => navigate({ name: "dashboard" })}
        >
          Dashboard
        </NavLink>
        <NavLink
          icon={<PlusIcon />}
          active={route.name === "create"}
          onClick={() => navigate({ name: "create" })}
        >
          New agent
        </NavLink>
        <NavLink
          icon={<GraphIcon />}
          active={route.name === "graph"}
          onClick={() => navigate({ name: "graph" })}
        >
          Graph
          <span className="ml-auto text-[10px] text-neutral-500">
            {state.graph.nodes.length}
          </span>
        </NavLink>
        <NavLink
          icon={<TimelineIcon />}
          active={route.name === "timeline"}
          onClick={() => navigate({ name: "timeline" })}
        >
          Timeline
          <span className="ml-auto text-[10px] text-neutral-500">
            {state.recentEvents.length}
          </span>
        </NavLink>
      </nav>

      <div className="mt-7 flex items-center justify-between px-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-500">
          Agents
        </div>
        <span className="text-[10px] text-neutral-600">{agents.length}</span>
      </div>

      <div className="mt-2 space-y-0.5 overflow-y-auto pr-1">
        {agents.length === 0 && (
          <div className="rounded-md border border-dashed border-neutral-800 px-2.5 py-3 text-[11px] text-neutral-500">
            No agents yet. Create one to get started.
          </div>
        )}
        {agents.map((a) => {
          const id = identityFor(a.id);
          const active = route.name === "agent" && route.agentId === a.id;
          return (
            <button
              key={a.id}
              onClick={() => navigate({ name: "agent", agentId: a.id })}
              className={`focus-ring group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition ${
                active
                  ? "bg-emerald-500/10 text-emerald-200"
                  : "text-neutral-300 hover:bg-neutral-900/70 hover:text-neutral-100"
              }`}
            >
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold"
                style={{
                  background: id.bg,
                  color: id.color,
                  border: `1px solid ${id.border}`,
                }}
              >
                {id.initials}
              </span>
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
              <StatusDot status={a.status} />
            </button>
          );
        })}
      </div>

      <div className="mt-auto space-y-3 pt-4">
        <div className="grid grid-cols-3 gap-1 rounded-lg border border-neutral-800/80 bg-neutral-900/50 p-1.5 text-center">
          <Mini label="agents" value={state.agents.length} />
          <Mini label="spawned" value={spawnedCount} />
          <Mini label="runs" value={state.activeRuns.length} />
        </div>

        <button
          onClick={onToggleTheme}
          className="focus-ring flex w-full items-center justify-between rounded-md border border-neutral-800/80 bg-neutral-900/50 px-2.5 py-1.5 text-xs text-neutral-300 transition hover:border-neutral-700 hover:bg-neutral-900"
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          <span className="flex items-center gap-2">
            {theme === "dark" ? <MoonIcon /> : <SunIcon />}
            <span className="capitalize">{theme} mode</span>
          </span>
          <span className="text-[10px] text-neutral-500">tap to toggle</span>
        </button>

        <div className="px-1 text-[10px] text-neutral-600">
          v0.1 · MVP build
        </div>
      </div>
    </aside>
  );
}

function NavLink({
  children,
  active,
  onClick,
  icon,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`focus-ring relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition ${
        active
          ? "bg-emerald-500/10 text-emerald-200"
          : "text-neutral-300 hover:bg-neutral-900/70 hover:text-neutral-100"
      }`}
    >
      {active && (
        <span className="absolute left-0 top-1.5 h-5 w-0.5 rounded-r bg-gradient-to-b from-emerald-300 to-emerald-500" />
      )}
      <span
        className={`flex h-4 w-4 items-center justify-center ${
          active ? "text-emerald-300" : "text-neutral-500"
        }`}
      >
        {icon}
      </span>
      {children}
    </button>
  );
}

function StatusDot({ status }: { status: string }) {
  const cls =
    status === "active"
      ? "bg-emerald-400 shadow-[0_0_8px_rgb(var(--emerald-400)/0.7)]"
      : status === "error" || status === "failed"
        ? "bg-red-400"
        : "bg-neutral-500";
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${cls}`} />;
}

function Mini({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md px-1 py-1">
      <div className="font-display text-sm font-semibold text-neutral-100">
        {value}
      </div>
      <div className="text-[9px] uppercase tracking-wider text-neutral-500">
        {label}
      </div>
    </div>
  );
}

function Logo() {
  return (
    <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-neutral-900 to-neutral-950 ring-1 ring-emerald-500/30 shadow-glow">
      <svg width="22" height="22" viewBox="0 0 64 64" fill="none">
        <defs>
          <linearGradient id="logo-grad" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="#34d399" />
            <stop offset="1" stopColor="#0ea5e9" />
          </linearGradient>
        </defs>
        <circle cx="22" cy="28" r="5" fill="url(#logo-grad)" />
        <circle cx="42" cy="28" r="5" fill="url(#logo-grad)" />
        <path
          d="M20 42 Q32 52 44 42"
          stroke="url(#logo-grad)"
          strokeWidth="3.5"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

function DashboardIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path
        d="M3 12 12 4l9 8M5 10v9h5v-6h4v6h5v-9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
function GraphIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="6" cy="6" r="2.2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="18" cy="6" r="2.2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="18" r="2.2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M7.6 7.4 10.7 16M16.4 7.4 13.3 16M8.2 6h7.6"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}
function TimelineIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 7h16M4 12h10M4 17h13"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path
        d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3.5" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
