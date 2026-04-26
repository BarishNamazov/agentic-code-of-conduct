// Runtime types shared between the orchestrator (run-loop) and concept handlers.

import type {
  ActingEnvelope,
  AgentGraph,
  BCIR,
  RunChunk,
  ToolStatus,
} from "../../shared/types";
import type { ToolHostQueries } from "./tools";

export type RunSink = {
  send(chunk: RunChunk): void;
};

// LLM env subset that runtime helpers need. Kept narrow so tests / non-CF
// hosts can pass a stub.
export type RuntimeEnv = {
  AI?: { run: (m: string, i: unknown, o?: unknown) => Promise<unknown> };
  CEREBRAS_API_KEY?: string;
};

// The fixed-per-run context every concept handler receives.
export type RunContext = {
  agentId: string;
  bcir: BCIR;
  behaviorVersionId: string;
  runId: string;
};

// Hooks the workspace gives to the run loop. Decoupled so the loop is testable
// and so concept handlers receive a single dependency object.
export type RunHooks = {
  // Persist an action and broadcast it. Returns the inserted action id.
  logAction: (env: Omit<ActingEnvelope, "id" | "createdAt">) => Promise<string>;
  // Mirror action to the actor's local_actions table.
  mirrorActionToChild: (
    childAgentId: string,
    envelope: ActingEnvelope
  ) => Promise<void>;
  // Workspace-scoped lookups that tools/concepts may need.
  toolHost: ToolHostQueries;
  // Tool-call lifecycle persistence.
  insertToolCall: (input: {
    id: string;
    runId: string;
    actorAgentId: string;
    toolName: string;
    requestActionId: string;
    inputJson: string;
  }) => void;
  updateToolCall: (input: {
    id: string;
    status: ToolStatus;
    outputJson?: string | null;
    errorText?: string | null;
    completedAt?: string | null;
    startedAt?: string | null;
  }) => void;
  // Spawn a child behavior agent. Returns child agent id.
  spawnChild: (input: {
    parentAgentId: string;
    name: string;
    behavior: BCIR;
    runId: string;
    causedByActionId: string;
  }) => Promise<{ childAgentId: string }>;
  // Run any agent (child or sibling) to completion. Used by Spawning and
  // Communicating. The caller-provided sink decides whether tokens leak to the
  // user or are captured silently.
  runChild: (input: {
    childAgentId: string;
    userInput: string;
    runId: string;
    sink: RunSink;
    causedByActionId?: string | null;
  }) => Promise<void>;
  // Normalize a free-form child behavior text into a BCIR.
  normalizeChildBehavior: (input: {
    name: string;
    rawText: string;
  }) => Promise<BCIR>;
  // Refresh and broadcast the workspace graph projection.
  refreshGraph: () => Promise<AgentGraph>;
};

export type RunInput = {
  runId: string;
  agentId: string;
  bcir: BCIR;
  behaviorVersionId: string;
  userInput: string;
};

// Mutable per-run binding for variable resolution between reaction steps.
export type RunBinding = Record<string, unknown>;
