// Centralised typed binding to the WorkspaceAgent over WebSocket.
// Keeps the rest of the UI decoupled from the agents/react import.

import { useAgent } from "agents/react";
import type {
  AgentContextPreview,
  AgentDetail,
  BCIR,
  ChatSessionRecord,
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
  previewAgentContext(
    agentId: string,
    userInput: string
  ): Promise<AgentContextPreview>;
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
  listChats(agentId: string): Promise<ChatSessionRecord[]>;
  saveChatSession(session: ChatSessionRecord): Promise<void>;
  deleteChatSession(
    agentId: string,
    sessionId: string
  ): Promise<{ ok: boolean }>;
  deleteAgent(agentId: string): Promise<void>;

  // Files & handlers (UI façade over BehaviorAgent durable storage).
  listAgentFiles(agentId: string): Promise<
    {
      path: string;
      contentType: string;
      size: number;
      createdAt: string;
      updatedAt: string;
    }[]
  >;
  readAgentFile(
    agentId: string,
    path: string
  ): Promise<{
    path: string;
    content: string;
    contentType: string;
    size: number;
    updatedAt: string;
  } | null>;
  writeAgentFile(input: {
    agentId: string;
    path: string;
    content: string;
    contentType?: string;
  }): Promise<{
    path: string;
    contentType: string;
    size: number;
    createdAt: string;
    updatedAt: string;
  }>;
  deleteAgentFile(agentId: string, path: string): Promise<{ ok: boolean }>;
  listAgentHandlers(agentId: string): Promise<
    {
      id: string;
      method: string;
      path: string;
      spec: unknown;
      createdAt: string;
      updatedAt: string;
    }[]
  >;
  setAgentHandler(input: {
    agentId: string;
    method: string;
    path: string;
    spec: unknown;
  }): Promise<{
    id: string;
    method: string;
    path: string;
    spec: unknown;
    createdAt: string;
    updatedAt: string;
  }>;
  deleteAgentHandler(agentId: string, id: string): Promise<{ ok: boolean }>;

  // Documents (uploaded knowledge corpus).
  listAgentDocuments(agentId: string): Promise<
    {
      id: string;
      title: string;
      mimeType: string;
      tags: string[];
      size: number;
      createdAt: string;
      updatedAt: string;
    }[]
  >;
  addAgentDocument(input: {
    agentId: string;
    id?: string;
    title: string;
    content: string;
    mimeType?: string;
    tags?: string[];
  }): Promise<{
    id: string;
    title: string;
    mimeType: string;
    tags: string[];
    size: number;
    createdAt: string;
    updatedAt: string;
  }>;
  deleteAgentDocument(agentId: string, id: string): Promise<{ ok: boolean }>;
  getAgentDocument(
    agentId: string,
    id: string
  ): Promise<{
    id: string;
    title: string;
    mimeType: string;
    tags: string[];
    content: string;
    size: number;
    createdAt: string;
    updatedAt: string;
  } | null>;
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
  ): Promise<unknown>;
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
        streamOptions: {
          onChunk: (chunk: RunChunk) => void;
          onDone?: (v: { type: "done"; runId: string }) => void;
          onError?: (e: string) => void;
        }
      ) => Promise<unknown>;
    }).call("runAgent", [input], {
      onChunk: handlers.onChunk,
      onDone: handlers.onDone,
      onError: handlers.onError,
    });

  return client;
}
