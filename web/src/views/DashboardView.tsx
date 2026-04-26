import { useEffect, useMemo, useState } from "react";
import type { TimelineEvent, WorkspaceState } from "@shared/types";
import type { WorkspaceAgentClient } from "../lib/agent-client";
import type { Route } from "../App";
import { identityFor } from "../lib/theme";

export function DashboardView({
  state,
  agent,
  navigate,
}: {
  state: WorkspaceState;
  agent: WorkspaceAgentClient;
  navigate: (r: Route) => void;
}) {
  const topLevel = state.agents.filter((a) => a.kind === "top_level");
  const spawned = state.agents.length - topLevel.length;

  // The workspace pushes `recentEvents` only at run boundaries, so when the
  // dashboard mounts (or the run/agent count changes) we additionally pull
  // fresh actions over RPC. This guarantees the activity chart and KPIs are
  // never stale for an active workspace.
  const [fetchedEvents, setFetchedEvents] = useState<TimelineEvent[] | null>(
    null
  );
  useEffect(() => {
    let cancelled = false;
    agent.stub
      .getRecentActions(200)
      .then((rows) => {
        if (!cancelled) setFetchedEvents(rows);
      })
      .catch(() => {
        if (!cancelled) setFetchedEvents(null);
      });
    return () => {
      cancelled = true;
    };
  }, [agent, state.agents.length, state.activeRuns.length, state.recentEvents.length]);

  const events = fetchedEvents ?? state.recentEvents;

  const stats = useMemo(() => deriveStats(events), [events]);
  const buckets = useMemo(() => bucketEvents(events, 24), [events]);
  const breakdown = useMemo(() => actionBreakdown(events), [events]);
  const lastActivity = useMemo(() => latestPerAgent(events), [events]);
  const liveAgents = state.agents.filter((a) => a.status === "active").length;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-300/80">
            Workspace
          </div>
          <h1 className="font-display mt-1 bg-gradient-to-br from-neutral-50 to-neutral-300 bg-clip-text text-3xl font-semibold tracking-tight text-transparent">
            EthOS Dashboard
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-neutral-400">
            Behavioral-code agents you have created. Every agent has stored,
            versioned behavior. Spawned children appear under their parent in
            the graph.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => navigate({ name: "graph" })}
            className="btn"
          >
            View graph
          </button>
          <button
            onClick={() => navigate({ name: "create" })}
            className="btn btn-primary"
          >
            <PlusIcon /> Create agent
          </button>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard
          label="Top-level agents"
          value={topLevel.length}
          tone="emerald"
          spark={buckets.map((b) => b.count)}
          sub={`${liveAgents} active now`}
        />
        <KpiCard
          label="Spawned children"
          value={spawned}
          tone="violet"
          sub={spawned === 0 ? "No spawns yet" : "Auto-organised in the graph"}
        />
        <KpiCard
          label="Active runs"
          value={state.activeRuns.length}
          tone="sky"
          sub={
            state.activeRuns.length === 0
              ? "Idle workspace"
              : "Streaming live results"
          }
        />
        <KpiCard
          label="Recent events"
          value={events.length}
          tone="yellow"
          sub={
            stats.uniqueActors > 0
              ? `${stats.uniqueActors} actor${stats.uniqueActors === 1 ? "" : "s"} · ${stats.failures} failed`
              : "Awaiting activity"
          }
        />
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold tracking-tight">
                Activity over the last 24 buckets
              </h2>
              <p className="mt-0.5 text-[11px] text-neutral-500">
                Each bar is one time-bucket of recorded actions across all
                agents.
              </p>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-neutral-500">
              <span className="chip">peak {stats.peak}</span>
              <span className="chip">avg {stats.avg.toFixed(1)}</span>
            </div>
          </div>
          <ActivityBarChart buckets={buckets} />
        </div>

        <div className="card">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-tight">
              Action mix
            </h2>
            <span className="text-[10px] text-neutral-500">
              {events.length} total
            </span>
          </div>
          {breakdown.length === 0 ? (
            <EmptyHint>
              When agents react and call tools, the distribution of actions
              will show up here.
            </EmptyHint>
          ) : (
            <ul className="space-y-2.5">
              {breakdown.slice(0, 7).map((b) => (
                <li key={b.action}>
                  <div className="mb-1 flex items-center justify-between text-[11px]">
                    <span className="mono truncate text-neutral-300">
                      {b.action}
                    </span>
                    <span className="text-neutral-500">{b.count}</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800/70">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${(b.count / breakdown[0].count) * 100}%`,
                        background: actionGradient(b.action),
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-end justify-between">
          <div>
            <h2 className="font-display text-lg font-semibold tracking-tight">
              Agents
            </h2>
            <p className="text-[11px] text-neutral-500">
              {topLevel.length === 0
                ? "Nothing to show yet."
                : "Click an agent to inspect its behavior, runs and children."}
            </p>
          </div>
        </div>
        {topLevel.length === 0 ? (
          <EmptyState onCreate={() => navigate({ name: "create" })} />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {topLevel.map((a) => {
              const id = identityFor(a.id);
              const last = lastActivity.get(a.id);
              return (
                <button
                  key={a.id}
                  onClick={() => navigate({ name: "agent", agentId: a.id })}
                  className="card card-hoverable group flex flex-col gap-3 text-left"
                >
                  <div className="flex items-start gap-3">
                    <span
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-xs font-semibold tracking-wide"
                      style={{
                        background: id.bg,
                        color: id.color,
                        border: `1px solid ${id.border}`,
                      }}
                    >
                      {id.initials}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className="truncate font-display font-semibold tracking-tight text-neutral-100">
                          {a.name}
                        </div>
                        <span
                          className={`badge shrink-0 ${a.status === "active" ? "badge-active" : ""}`}
                        >
                          {a.status}
                        </span>
                      </div>
                      <div className="mono mt-0.5 truncate text-[10px] text-neutral-500">
                        {a.id}
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[11px] text-neutral-400">
                    <Field
                      label="Updated"
                      value={timeAgo(a.updatedAt)}
                    />
                    <Field
                      label="Last action"
                      value={
                        last ? `${last.action} · ${timeAgo(last.createdAt)}` : "—"
                      }
                    />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-end justify-between">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            Recent activity
          </h2>
          <button
            onClick={() => navigate({ name: "timeline" })}
            className="text-[11px] font-medium text-neutral-400 hover:text-emerald-300"
          >
            View full timeline →
          </button>
        </div>
        <div className="card">
          {events.length === 0 ? (
            <EmptyHint>
              No actions yet. Create an agent and run it to see live events
              here.
            </EmptyHint>
          ) : (
            <ul className="divide-y divide-neutral-800/70">
              {events.slice(0, 8).map((e) => (
                <li key={e.id} className="flex items-center gap-3 py-2">
                  <CategoryStripe action={e.action} />
                  <span className="mono w-[68px] shrink-0 text-[10px] text-neutral-500">
                    {new Date(e.createdAt).toLocaleTimeString()}
                  </span>
                  <span
                    className={`badge shrink-0 ${eventBadgeClass(e.action)}`}
                  >
                    {e.action}
                  </span>
                  <span className="mono shrink-0 text-[11px] text-neutral-400">
                    {shortAgentId(e.actorAgentId)}
                  </span>
                  <span className="mono min-w-0 flex-1 truncate text-[11px] text-neutral-500">
                    {summarize(e)}
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

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-neutral-800/60 bg-neutral-900/40 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-neutral-500">
        {label}
      </div>
      <div className="mt-0.5 truncate text-neutral-200">{value}</div>
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-sm text-neutral-500">
      {children}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="card relative overflow-hidden py-12">
      <div className="absolute inset-0 -z-10 bg-grid-fade opacity-70" />
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500/20 to-sky-500/20 ring-1 ring-emerald-500/30 shadow-glow">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 4v16M4 12h16"
              stroke="currentColor"
              className="text-emerald-300"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <div className="font-display text-base font-semibold tracking-tight">
          No agents yet
        </div>
        <p className="max-w-md text-sm text-neutral-400">
          An agent is a behavior, not a prompt. Paste a description of how the
          agent should react to events and you'll get a normalized, runnable
          behavior version.
        </p>
        <button onClick={onCreate} className="btn btn-primary mt-2">
          Create your first agent
        </button>
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  tone,
  spark,
}: {
  label: string;
  value: number;
  sub?: string;
  tone: "emerald" | "violet" | "sky" | "yellow";
  spark?: number[];
}) {
  const toneRing = {
    emerald: "ring-emerald-500/20",
    violet: "ring-violet-500/20",
    sky: "ring-sky-500/20",
    yellow: "ring-yellow-500/20",
  }[tone];
  const toneText = {
    emerald: "text-emerald-300",
    violet: "text-violet-300",
    sky: "text-sky-300",
    yellow: "text-yellow-300",
  }[tone];
  const toneStroke = {
    emerald: "rgb(var(--emerald-400))",
    violet: "rgb(var(--violet-400))",
    sky: "rgb(var(--sky-400))",
    yellow: "rgb(var(--yellow-400))",
  }[tone];
  return (
    <div className={`card relative overflow-hidden ring-1 ${toneRing}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-500">
            {label}
          </div>
          <div className="font-display mt-1.5 text-3xl font-semibold tracking-tight">
            {value}
          </div>
          {sub && (
            <div className={`mt-1 text-[11px] ${toneText}`}>{sub}</div>
          )}
        </div>
        {spark && spark.length > 0 && (
          <Sparkline values={spark} stroke={toneStroke} />
        )}
      </div>
    </div>
  );
}

function Sparkline({ values, stroke }: { values: number[]; stroke: string }) {
  const w = 72;
  const h = 32;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const points = values
    .map((v, i) => `${i * step},${h - (v / max) * (h - 4) - 2}`)
    .join(" ");
  const area = `0,${h} ${points} ${w},${h}`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="opacity-90">
      <defs>
        <linearGradient id={`spark-${stroke}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#spark-${stroke})`} />
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ActivityBarChart({ buckets }: { buckets: Bucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const total = buckets.reduce((s, b) => s + b.count, 0);
  if (total === 0) {
    return (
      <div className="flex h-32 items-end gap-1">
        {buckets.map((b, i) => (
          <div
            key={`${b.label}-${i}`}
            className="flex-1 rounded-sm bg-neutral-800/40"
            style={{ height: "8%" }}
            title={`${b.label} · 0 events`}
          />
        ))}
        <div className="absolute right-6 mt-12 text-[11px] text-neutral-500">
          Awaiting first events
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="flex h-32 items-end gap-1">
        {buckets.map((b, i) => {
          const h = (b.count / max) * 100;
          return (
            <div
              key={`${b.label}-${i}`}
              className="group relative flex h-full flex-1 cursor-default items-end"
              title={`${b.label} · ${b.count} event${b.count === 1 ? "" : "s"}`}
            >
              <div
                className="w-full rounded-sm bg-gradient-to-t from-emerald-500/80 via-emerald-400/70 to-sky-400/60 transition group-hover:from-emerald-400 group-hover:via-emerald-300 group-hover:to-sky-300"
                style={{ height: `${Math.max(h, 3)}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-neutral-500">
        <span>{buckets[0]?.label ?? ""}</span>
        <span>{buckets[Math.floor(buckets.length / 2)]?.label ?? ""}</span>
        <span>{buckets[buckets.length - 1]?.label ?? "now"}</span>
      </div>
    </div>
  );
}

function CategoryStripe({ action }: { action: string }) {
  const c = actionCategoryColor(action);
  return (
    <span
      className="h-6 w-0.5 shrink-0 rounded-full"
      style={{ background: c }}
    />
  );
}

function actionCategoryColor(action: string): string {
  if (action.startsWith("Tooling.completed")) return "rgb(var(--emerald-400))";
  if (action.startsWith("Tooling.failed") || action.endsWith(".failed"))
    return "rgb(var(--red-400))";
  if (action.startsWith("Spawning")) return "rgb(var(--yellow-400))";
  if (action.startsWith("Running")) return "rgb(var(--sky-400))";
  if (action.startsWith("Reacting")) return "rgb(var(--violet-400))";
  return "rgb(var(--neutral-600))";
}

function actionGradient(action: string): string {
  const c = actionCategoryColor(action);
  return `linear-gradient(90deg, ${c}, ${c} 70%, transparent)`;
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

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ----- Helpers -----

type Bucket = { label: string; count: number };

function bucketEvents(events: TimelineEvent[], bucketCount: number): Bucket[] {
  if (events.length === 0) {
    return Array.from({ length: bucketCount }, (_, i) => ({
      label: `${i + 1}`,
      count: 0,
    }));
  }
  const times = events.map((e) => new Date(e.createdAt).getTime());
  const max = Math.max(...times);
  const min = Math.min(...times);
  // If all events landed in the same instant or within < 1s, force a small
  // span so the chart still spreads them out a bit.
  const span = Math.max(max - min, 60_000);
  const start = max - span;
  const buckets: Bucket[] = Array.from({ length: bucketCount }, (_, i) => {
    const from = start + (span / bucketCount) * i;
    const to = start + (span / bucketCount) * (i + 1);
    const date = new Date(to);
    return {
      label: date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      count: 0,
    };
  });
  for (const t of times) {
    const idx = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor(((t - start) / span) * bucketCount))
    );
    buckets[idx].count++;
  }
  return buckets;
}

function deriveStats(events: TimelineEvent[]) {
  const actors = new Set(events.map((e) => e.actorAgentId));
  const failures = events.filter(
    (e) => e.action.startsWith("Tooling.failed") || e.action.endsWith(".failed")
  ).length;
  const counts = bucketEvents(events, 24).map((b) => b.count);
  const peak = Math.max(0, ...counts);
  const avg = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
  return { uniqueActors: actors.size, failures, peak, avg };
}

function actionBreakdown(events: TimelineEvent[]) {
  const m = new Map<string, number>();
  for (const e of events) m.set(e.action, (m.get(e.action) ?? 0) + 1);
  return Array.from(m.entries())
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count);
}

function latestPerAgent(events: TimelineEvent[]) {
  const m = new Map<string, TimelineEvent>();
  for (const e of events) {
    const cur = m.get(e.actorAgentId);
    if (!cur || cur.createdAt < e.createdAt) m.set(e.actorAgentId, e);
  }
  return m;
}

function shortAgentId(id: string): string {
  if (id.length <= 14) return id;
  return id.slice(0, 6) + "…" + id.slice(-4);
}

function summarize(e: TimelineEvent): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(e.args)) {
    let val: string;
    if (typeof v === "string") val = v.length > 40 ? v.slice(0, 40) + "…" : v;
    else if (v == null) val = "—";
    else val = JSON.stringify(v).slice(0, 40);
    out.push(`${k}=${val}`);
    if (out.join("  ").length > 120) break;
  }
  return out.join("  ");
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 30_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}
