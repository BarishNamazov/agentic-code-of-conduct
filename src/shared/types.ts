// Shared types between worker and web UI.
// Importing from this file is safe in both runtimes (no Cloudflare-specific deps).

export type AgentKind = "top_level" | "spawned" | "tool" | "system";
export type AgentStatus = "draft" | "active" | "paused" | "archived";
export type RunStatus = "running" | "completed" | "failed" | "cancelled";
export type ToolStatus = "requested" | "running" | "completed" | "failed";

// ----- BCIR: Behavioral Code Intermediate Representation -----

export type ConceptIR = {
  name: string;
  purpose: string;
  principle?: string;
  state?: string;
  actions: { name: string; params: string[] }[];
};

export type ObservationPatternIR = {
  bind?: string;
  action: string; // "Concept.action"
  args: Record<string, string>;
};

export type StatePredicateIR = {
  concept: string;
  text: string;
  variables: string[];
};

export type ThenActionIR =
  | { posture: "request"; action: string; args: Record<string, string> }
  | { posture: "attest"; action: string; args: Record<string, string> };

export type ReactionIR = {
  id: string;
  name: string;
  prose: string;
  formal: string;
  when: ObservationPatternIR[];
  where: StatePredicateIR[];
  then: ThenActionIR[];
};

export type ToolSpecIR = {
  name: string;
  description: string;
  inputSchema?: unknown;
  requiresApproval?: boolean;
};

export type PermissionIR = {
  capability: string;
  scope: string;
};

export type BCIR = {
  schemaVersion: "bcir.v0";
  agent: { name: string; purpose?: string };
  raw: { format: BehaviorFormat; text: string };
  concepts: ConceptIR[];
  reactions: ReactionIR[];
  tools: ToolSpecIR[];
  permissions: PermissionIR[];
};

export type BehaviorFormat =
  | "behavioral-dsl"
  | "markdown"
  | "json"
  | "yaml"
  | "unknown";

export type CompilerWarning = {
  level: "info" | "warn" | "error";
  message: string;
  ref?: string;
};

export type ValidationResult = {
  ok: boolean;
  warnings: CompilerWarning[];
  errors: CompilerWarning[];
};

export type CompiledBehavior = {
  entrypoints: { reactionId: string; trigger: string }[];
  runtime: {
    mode: "llm-assisted" | "deterministic";
    maxSteps: number;
    allowSpawn: boolean;
    allowTools: string[];
  };
};

// ----- Action envelope -----

export type ActingEnvelope = {
  id: string;
  by: string; // actor agent id
  action: string; // "Concept.action"
  args: Record<string, unknown>;
  behaviorVersionId?: string | null;
  causedByActionId?: string | null;
  causedByReactionId?: string | null;
  runId?: string | null;
  createdAt: string;
};

// ----- Projections used by the UI -----

export type AgentSummary = {
  id: string;
  name: string;
  kind: AgentKind;
  parentAgentId: string | null;
  currentBehaviorVersionId: string | null;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
};

export type RunSummary = {
  id: string;
  rootAgentId: string;
  status: RunStatus;
  inputText: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type GraphNode = {
  id: string;
  type: "agent" | "tool" | "artifact" | "action";
  label: string;
  status?: string;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  type: "spawned" | "called" | "requested" | "fulfilled" | "attested";
  actionId?: string;
};

export type AgentGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

export type TimelineEvent = {
  id: string;
  actorAgentId: string;
  action: string;
  args: Record<string, unknown>;
  runId: string | null;
  behaviorVersionId: string | null;
  causedByActionId: string | null;
  causedByReactionId: string | null;
  createdAt: string;
};

export type WorkspaceState = {
  agents: AgentSummary[];
  activeRuns: RunSummary[];
  graph: AgentGraph;
  recentEvents: TimelineEvent[];
};

// ----- Stream chunk types from runAgent -----

export type RunChunk =
  | { type: "token"; text: string; toolCallId?: string }
  | { type: "event"; event: TimelineEvent }
  | {
      type: "tool";
      toolCallId: string;
      tool: string;
      input: unknown;
      actorAgentId: string;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      output?: unknown;
      error?: string;
      status: ToolStatus;
    }
  | {
      type: "spawn";
      childAgentId: string;
      childName: string;
      parentAgentId: string;
    }
  | { type: "graph"; graph: AgentGraph }
  | { type: "error"; message: string }
  | { type: "done"; runId: string };

// ----- API payloads -----

export type CompileBehaviorInput = {
  rawText: string;
  rawFormat?: BehaviorFormat;
};

export type CompileBehaviorResult = {
  normalized: BCIR;
  validation: ValidationResult;
};

export type CreateAgentInput = {
  name: string;
  normalized: BCIR;
};

export type CreateAgentResult = {
  agentId: string;
  behaviorVersionId: string;
};

export type ReviseBehaviorInput = {
  agentId: string;
  normalized: BCIR;
};

export type AgentDetail = {
  agent: AgentSummary;
  behavior: BCIR;
  versions: { id: string; versionNumber: number; createdAt: string }[];
  children: AgentSummary[];
  recentRuns: RunSummary[];
};
