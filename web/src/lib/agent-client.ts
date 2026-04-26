// Centralised typed binding to the WorkspaceAgent over WebSocket.
// Keeps the rest of the UI decoupled from the agents/react import.

import { useAgent } from "agents/react";
import type {
  AgentDetail,
  BCIR,
  CompileBehaviorInput,
  CompileBehaviorResult,
  CreateAgentInput,
  CreateAgentResult,
  ReviseBehaviorInput,
  RunChunk,
  TimelineEvent,
  WorkspaceState,
} from "@shared/types";

// The shape of the typed stub the WorkspaceAgent exposes via @callable methods.
export interface WorkspaceStub {
  listTools(): Promise<{ name: string; description: string }[]>;
  compileBehavior(input: CompileBehaviorInput): Promise<CompileBehaviorResult>;
  createAgent(input: CreateAgentInput): Promise<CreateAgentResult>;
  reviseBehavior(input: ReviseBehaviorInput): Promise<{ behaviorVersionId: string }>;
  getAgentDetail(agentId: string): Promise<AgentDetail>;
  getBehaviorVersion(versionId: string): Promise<BCIR | null>;
  getRunActions(runId: string): Promise<TimelineEvent[]>;
  getRecentActions(limit?: number): Promise<TimelineEvent[]>;
  getToolCalls(runId: string): Promise<
    {
      id: string;
      runId: string;
      actorAgentId: string;
      tool: string;
      requestActionId: string;
      status: "requested" | "running" | "completed" | "failed";
      input: Record<string, unknown>;
      output: Record<string, unknown> | null;
      error: string | null;
      startedAt: string | null;
      completedAt: string | null;
    }[]
  >;
  deleteAgent(agentId: string): Promise<void>;
}

export type WorkspaceAgentClient = ReturnType<typeof useAgent<WorkspaceState>> & {
  stub: WorkspaceStub;
  // Streaming runAgent helper (manual call -> RunChunk callbacks).
  runAgent(
    input: { agentId: string; userInput: string },
    handlers: {
      onChunk: (chunk: RunChunk) => void;
      onDone?: (final: { type: "done"; runId: string }) => void;
      onError?: (error: string) => void;
    }
  ): Promise<void>;
};

const WORKSPACE_NAME = "default";

export function useWorkspaceAgent(
  onStateUpdate: (state: WorkspaceState) => void
): WorkspaceAgentClient {
  const agent = useAgent<WorkspaceState>({
    agent: "WorkspaceAgent",
    name: WORKSPACE_NAME,
    onStateUpdate,
  });

  // Attach a streaming helper that wraps `agent.call("runAgent", ...)`.
  const client = agent as unknown as WorkspaceAgentClient;
  client.runAgent = (input, handlers) =>
    (agent as unknown as {
      call: (
        method: string,
        args: unknown[],
        opts: {
          stream: {
            onChunk: (chunk: RunChunk) => void;
            onDone?: (v: { type: "done"; runId: string }) => void;
            onError?: (e: string) => void;
          };
        }
      ) => Promise<void>;
    }).call("runAgent", [input], {
      stream: {
        onChunk: handlers.onChunk,
        onDone: handlers.onDone,
        onError: handlers.onError,
      },
    });

  return client;
}
