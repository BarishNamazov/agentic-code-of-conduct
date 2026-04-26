import { useMemo, useState } from "react";
import type { AgentGraph, WorkspaceState } from "@shared/types";
import type { Route } from "../App";
import { identityFor } from "../lib/theme";

type Positioned = {
  id: string;
  x: number;
  y: number;
  node: AgentGraph["nodes"][number];
};

export function GraphView({
  state,
  navigate,
}: {
  state: WorkspaceState;
  navigate: (r: Route) => void;
}) {
  const graph = state.graph;
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const W = Math.max(960, layout.width);
  const H = Math.max(440, layout.height);
  const [hover, setHover] = useState<string | null>(null);

  const nodeMap = new Map(layout.nodes.map((n) => [n.id, n]));
  const neighborSet = useMemo(() => {
    if (!hover) return null;
    const s = new Set<string>([hover]);
    for (const e of graph.edges) {
      if (e.source === hover) s.add(e.target);
      if (e.target === hover) s.add(e.source);
    }
    return s;
  }, [hover, graph.edges]);

  const agentCount = graph.nodes.filter((n) => n.type === "agent").length;
  const toolCount = graph.nodes.filter((n) => n.type === "tool").length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-300/80">
            Topology
          </div>
          <h1 className="font-display mt-1 text-2xl font-semibold tracking-tight">
            Agent graph
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-neutral-400">
            Each agent is a real Durable Object node with its own behavior and
            storage. Spawned children appear as separate nodes — never as
            helper labels. Hover a node to highlight its neighbors.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="chip">
            <Dot color="rgb(var(--emerald-400))" /> {agentCount} agent
            {agentCount === 1 ? "" : "s"}
          </span>
          <span className="chip">
            <Dot color="rgb(var(--neutral-400))" /> {toolCount} tool
            {toolCount === 1 ? "" : "s"}
          </span>
          <span className="chip">
            {graph.edges.length} edge{graph.edges.length === 1 ? "" : "s"}
          </span>
        </div>
      </header>

      {layout.nodes.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="card relative overflow-hidden p-0">
          <div className="absolute inset-0 -z-10 opacity-60 [background-image:radial-gradient(circle_at_1px_1px,rgb(var(--neutral-700))_1px,transparent_0)] [background-size:24px_24px]" />
          <div className="overflow-x-auto">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="block h-auto w-full"
              onMouseLeave={() => setHover(null)}
            >
              <defs>
                <marker
                  id="arrow-default"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L10,5 L0,10 z" fill="rgb(var(--neutral-500))" />
                </marker>
                <marker
                  id="arrow-spawned"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L10,5 L0,10 z" fill="rgb(var(--yellow-400))" />
                </marker>
                <marker
                  id="arrow-called"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L10,5 L0,10 z" fill="rgb(var(--sky-400))" />
                </marker>
              </defs>

              {graph.edges.map((e) => {
                const a = nodeMap.get(e.source);
                const b = nodeMap.get(e.target);
                if (!a || !b) return null;
                const dim =
                  neighborSet !== null &&
                  !(neighborSet.has(e.source) && neighborSet.has(e.target));
                const color = edgeColor(e.type);
                const dashed = e.type === "called";
                const arrow =
                  e.type === "spawned"
                    ? "url(#arrow-spawned)"
                    : e.type === "called"
                      ? "url(#arrow-called)"
                      : "url(#arrow-default)";
                return (
                  <g key={e.id} opacity={dim ? 0.18 : 1}>
                    <path
                      d={curvedPath(a.x, a.y, b.x, b.y)}
                      stroke={color}
                      strokeWidth={1.6}
                      strokeDasharray={dashed ? "5 4" : undefined}
                      fill="none"
                      markerEnd={arrow}
                    />
                  </g>
                );
              })}

              {layout.nodes.map((n) => {
                const isAgent = n.node.type === "agent";
                const isTool = n.node.type === "tool";
                const dim = neighborSet !== null && !neighborSet.has(n.id);
                const isHover = hover === n.id;
                return (
                  <g
                    key={n.id}
                    transform={`translate(${n.x}, ${n.y})`}
                    className={isAgent ? "cursor-pointer" : "cursor-default"}
                    opacity={dim ? 0.25 : 1}
                    onMouseEnter={() => setHover(n.id)}
                    onClick={() => {
                      if (isAgent && n.id.startsWith("agent_")) {
                        navigate({ name: "agent", agentId: n.id });
                      }
                    }}
                  >
                    {isAgent && (
                      <AgentNode
                        id={n.id}
                        label={n.node.label}
                        status={n.node.status}
                        highlighted={isHover}
                      />
                    )}
                    {isTool && (
                      <ToolNode label={n.node.label} highlighted={isHover} />
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
        </div>
      )}

      <Legend />
    </div>
  );
}

function AgentNode({
  id,
  label,
  status,
  highlighted,
}: {
  id: string;
  label: string;
  status?: string;
  highlighted: boolean;
}) {
  const ident = identityFor(id);
  const r = 26;
  const isActive = status === "active";
  return (
    <g>
      {highlighted && (
        <circle
          r={r + 8}
          fill="none"
          stroke={ident.color}
          strokeOpacity={0.35}
          strokeWidth={1}
        />
      )}
      <circle
        r={r}
        fill="rgb(var(--surface-raised))"
        stroke={ident.color}
        strokeWidth={1.8}
        filter={highlighted ? "drop-shadow(0 4px 16px rgba(0,0,0,0.4))" : undefined}
      />
      <circle r={r - 4} fill={ident.bg} />
      <text
        textAnchor="middle"
        y={4}
        fontSize="10"
        fontWeight={600}
        fill="rgb(var(--neutral-100))"
      >
        {truncate(label, 14)}
      </text>
      {isActive && (
        <circle
          cx={r - 5}
          cy={-r + 5}
          r={3.5}
          fill="rgb(var(--emerald-400))"
        >
          <animate
            attributeName="opacity"
            values="0.4;1;0.4"
            dur="1.6s"
            repeatCount="indefinite"
          />
        </circle>
      )}
    </g>
  );
}

function ToolNode({
  label,
  highlighted,
}: {
  label: string;
  highlighted: boolean;
}) {
  return (
    <g>
      <rect
        x={-58}
        y={-13}
        width={116}
        height={26}
        rx={8}
        fill="rgb(var(--neutral-900))"
        stroke={
          highlighted ? "rgb(var(--neutral-400))" : "rgb(var(--neutral-700))"
        }
        strokeWidth={1.2}
      />
      <text
        textAnchor="middle"
        y={4}
        fontSize="10"
        fill="rgb(var(--neutral-200))"
      >
        {truncate(label, 18)}
      </text>
    </g>
  );
}

function EmptyState() {
  return (
    <div className="card flex flex-col items-center gap-3 py-16 text-center">
      <div className="relative h-14 w-28">
        <svg viewBox="0 0 120 60" className="h-full w-full">
          <line
            x1="20"
            y1="30"
            x2="60"
            y2="30"
            stroke="rgb(var(--neutral-700))"
            strokeWidth="1.5"
            strokeDasharray="4 4"
          />
          <line
            x1="60"
            y1="30"
            x2="100"
            y2="30"
            stroke="rgb(var(--neutral-700))"
            strokeWidth="1.5"
            strokeDasharray="4 4"
          />
          <circle cx="20" cy="30" r="9" fill="rgb(var(--neutral-900))" stroke="rgb(var(--neutral-600))" />
          <circle cx="60" cy="30" r="9" fill="rgb(var(--neutral-900))" stroke="rgb(var(--emerald-500))" />
          <circle cx="100" cy="30" r="9" fill="rgb(var(--neutral-900))" stroke="rgb(var(--neutral-600))" />
        </svg>
      </div>
      <div className="font-display text-base font-semibold tracking-tight">
        No graph yet
      </div>
      <p className="max-w-sm text-sm text-neutral-500">
        The graph populates automatically as agents react, call tools, and
        spawn children. Create an agent to get started.
      </p>
    </div>
  );
}

function Legend() {
  return (
    <div className="card flex flex-wrap gap-x-5 gap-y-2 text-xs text-neutral-400">
      <LegendItem
        swatch={
          <span className="inline-block h-3 w-3 rounded-full border border-emerald-400 bg-emerald-500/15" />
        }
        label="agent"
      />
      <LegendItem
        swatch={
          <span className="inline-block h-3 w-5 rounded-sm border border-neutral-500 bg-neutral-800" />
        }
        label="tool"
      />
      <LegendItem
        swatch={<EdgeSwatch color="rgb(var(--yellow-400))" />}
        label="spawned edge"
      />
      <LegendItem
        swatch={<EdgeSwatch color="rgb(var(--sky-400))" dashed />}
        label="called edge"
      />
      <span className="ml-auto text-[11px] text-neutral-500">
        Click any agent node to jump to its detail view.
      </span>
    </div>
  );
}

function EdgeSwatch({ color, dashed }: { color: string; dashed?: boolean }) {
  return (
    <svg width="36" height="8">
      <line
        x1={0}
        y1={4}
        x2={36}
        y2={4}
        stroke={color}
        strokeWidth={2}
        strokeDasharray={dashed ? "4 4" : undefined}
      />
    </svg>
  );
}

function LegendItem({
  swatch,
  label,
}: {
  swatch: React.ReactNode;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      {swatch}
      {label}
    </span>
  );
}

function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block h-2 w-2 rounded-full"
      style={{ background: color }}
    />
  );
}

function edgeColor(type: AgentGraph["edges"][number]["type"]): string {
  switch (type) {
    case "spawned":
      return "rgb(var(--yellow-400))";
    case "called":
      return "rgb(var(--sky-400))";
    default:
      return "rgb(var(--neutral-600))";
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function curvedPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): string {
  // Cubic bezier with control points offset horizontally — produces a clean
  // sweeping arc that works well for the layered layout.
  const dx = x2 - x1;
  const cx1 = x1 + dx * 0.5;
  const cy1 = y1;
  const cx2 = x2 - dx * 0.5;
  const cy2 = y2;
  return `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
}

// Simple layered layout: agents grouped by depth (root → spawned children),
// tool nodes stacked to the right of their callers.
function layoutGraph(graph: AgentGraph): {
  nodes: Positioned[];
  width: number;
  height: number;
} {
  const COL_W = 220;
  const ROW_H = 110;
  const TOP = 70;
  const LEFT = 90;

  const agentNodes = graph.nodes.filter((n) => n.type === "agent");
  const toolNodes = graph.nodes.filter((n) => n.type === "tool");

  const parentOf = new Map<string, string>();
  for (const e of graph.edges) {
    if (e.type === "spawned") parentOf.set(e.target, e.source);
  }
  const depth = new Map<string, number>();
  for (const n of agentNodes) {
    let d = 0;
    let cur = n.id;
    while (parentOf.has(cur) && d < 10) {
      cur = parentOf.get(cur)!;
      d++;
    }
    depth.set(n.id, d);
  }
  const byDepth = new Map<number, string[]>();
  for (const n of agentNodes) {
    const d = depth.get(n.id) ?? 0;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(n.id);
  }

  const positioned: Positioned[] = [];
  const idToNode = new Map(graph.nodes.map((n) => [n.id, n]));
  let maxDepth = 0;
  byDepth.forEach((ids, d) => {
    if (d > maxDepth) maxDepth = d;
    ids.forEach((id, i) => {
      positioned.push({
        id,
        x: LEFT + d * COL_W,
        y: TOP + i * ROW_H,
        node: idToNode.get(id)!,
      });
    });
  });

  const toolColX = LEFT + (maxDepth + 1) * COL_W;
  toolNodes.forEach((n, i) => {
    positioned.push({
      id: n.id,
      x: toolColX,
      y: TOP + i * ROW_H,
      node: n,
    });
  });

  const rowsMax = Math.max(
    ...Array.from(byDepth.values()).map((ids) => ids.length),
    toolNodes.length,
    1
  );
  const height = rowsMax * ROW_H + TOP + 40;
  const width = toolColX + 120;

  return { nodes: positioned, width, height };
}
