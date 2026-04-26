import { useMemo } from "react";
import type { AgentGraph, WorkspaceState } from "@shared/types";
import type { Route } from "../App";

type Positioned = { id: string; x: number; y: number; node: AgentGraph["nodes"][number] };

export function GraphView({
  state,
  navigate,
}: {
  state: WorkspaceState;
  navigate: (r: Route) => void;
}) {
  const graph = state.graph;
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const W = 960;
  const H = Math.max(420, layout.height);

  const nodeMap = new Map(layout.nodes.map((n) => [n.id, n]));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Graph</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Each agent is a real Durable Object node with its own behavior and storage.
          Spawned children appear as separate nodes — never as helper labels.
        </p>
      </header>

      {layout.nodes.length === 0 ? (
        <div className="card text-sm text-neutral-500">
          No nodes yet. Create an agent and run it to populate the graph.
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
            <defs>
              <marker
                id="arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" fill="#525252" />
              </marker>
            </defs>

            {graph.edges.map((e) => {
              const a = nodeMap.get(e.source);
              const b = nodeMap.get(e.target);
              if (!a || !b) return null;
              return (
                <g key={e.id}>
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={edgeColor(e.type)}
                    strokeWidth={1.5}
                    strokeDasharray={e.type === "called" ? "4 4" : undefined}
                    markerEnd="url(#arrow)"
                  />
                </g>
              );
            })}

            {layout.nodes.map((n) => {
              const isAgent = n.node.type === "agent";
              const isTool = n.node.type === "tool";
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x}, ${n.y})`}
                  className="cursor-pointer"
                  onClick={() => {
                    if (isAgent && n.id.startsWith("agent_")) {
                      navigate({ name: "agent", agentId: n.id });
                    }
                  }}
                >
                  {isAgent && (
                    <>
                      <circle r={26} fill="#0f172a" stroke="#34d399" strokeWidth={1.5} />
                      <text
                        textAnchor="middle"
                        y={4}
                        className="fill-emerald-200"
                        fontSize="10"
                        fontWeight={600}
                      >
                        {truncate(n.node.label, 14)}
                      </text>
                    </>
                  )}
                  {isTool && (
                    <>
                      <rect
                        x={-50}
                        y={-12}
                        width={100}
                        height={24}
                        rx={6}
                        fill="#1f2937"
                        stroke="#6b7280"
                      />
                      <text
                        textAnchor="middle"
                        y={4}
                        className="fill-neutral-200"
                        fontSize="10"
                      >
                        {truncate(n.node.label, 16)}
                      </text>
                    </>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      )}

      <Legend />
    </div>
  );
}

function Legend() {
  return (
    <div className="card flex flex-wrap gap-4 text-xs text-neutral-400">
      <LegendItem color="#34d399" label="agent" />
      <LegendItem color="#9ca3af" label="tool" dashed />
      <LegendItem color="#fbbf24" label="spawned edge" />
      <LegendItem color="#60a5fa" label="called edge" dashed />
    </div>
  );
}

function LegendItem({
  color,
  label,
  dashed,
}: {
  color: string;
  label: string;
  dashed?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2">
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
      {label}
    </span>
  );
}

function edgeColor(type: AgentGraph["edges"][number]["type"]): string {
  switch (type) {
    case "spawned":
      return "#fbbf24";
    case "called":
      return "#60a5fa";
    default:
      return "#52525b";
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Simple layered layout: agents grouped by depth (root → spawned children),
// tool nodes stacked to the right of their callers.
function layoutGraph(graph: AgentGraph): { nodes: Positioned[]; height: number } {
  const COL_W = 220;
  const ROW_H = 100;

  const agentNodes = graph.nodes.filter((n) => n.type === "agent");
  const toolNodes = graph.nodes.filter((n) => n.type === "tool");

  // Compute parent map.
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
        x: 80 + d * COL_W,
        y: 60 + i * ROW_H,
        node: idToNode.get(id)!,
      });
    });
  });

  const toolColX = 80 + (maxDepth + 1) * COL_W;
  toolNodes.forEach((n, i) => {
    positioned.push({
      id: n.id,
      x: toolColX,
      y: 60 + i * ROW_H,
      node: n,
    });
  });

  const height =
    Math.max(
      ...Array.from(byDepth.values()).map((ids) => ids.length),
      toolNodes.length,
      1
    ) *
      ROW_H +
    100;

  return { nodes: positioned, height };
}
