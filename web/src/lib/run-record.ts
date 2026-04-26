import type { RunChunk, TimelineEvent } from "@shared/types";

// Renderable timeline event with associated tool/spawn details for the UI.
export type RunRecord = {
  runId: string | null;
  status: "running" | "completed" | "failed";
  events: TimelineEvent[];
  tools: Map<
    string,
    {
      id: string;
      tool: string;
      input: unknown;
      output?: unknown;
      error?: string;
      status: "requested" | "running" | "completed" | "failed";
      actorAgentId: string;
      tokens: string;
    }
  >;
  text: string; // streaming aggregated text (LLM output)
  spawned: { childAgentId: string; childName: string; parentAgentId: string }[];
  errors: string[];
};

export function emptyRunRecord(): RunRecord {
  return {
    runId: null,
    status: "running",
    events: [],
    tools: new Map(),
    text: "",
    spawned: [],
    errors: [],
  };
}

export function reduceChunk(rec: RunRecord, chunk: RunChunk): RunRecord {
  switch (chunk.type) {
    case "event":
      return { ...rec, events: [...rec.events, chunk.event] };
    case "token": {
      const tools = new Map(rec.tools);
      if (chunk.toolCallId) {
        const t = tools.get(chunk.toolCallId);
        if (t) tools.set(chunk.toolCallId, { ...t, tokens: t.tokens + chunk.text });
      }
      return { ...rec, tools, text: rec.text + chunk.text };
    }
    case "tool": {
      const tools = new Map(rec.tools);
      tools.set(chunk.toolCallId, {
        id: chunk.toolCallId,
        tool: chunk.tool,
        input: chunk.input,
        status: "running",
        actorAgentId: chunk.actorAgentId,
        tokens: "",
      });
      return { ...rec, tools };
    }
    case "tool_result": {
      const tools = new Map(rec.tools);
      const t = tools.get(chunk.toolCallId);
      if (t) {
        tools.set(chunk.toolCallId, {
          ...t,
          status: chunk.status,
          output: chunk.output,
          error: chunk.error,
        });
      }
      return { ...rec, tools };
    }
    case "spawn":
      return {
        ...rec,
        spawned: [
          ...rec.spawned,
          {
            childAgentId: chunk.childAgentId,
            childName: chunk.childName,
            parentAgentId: chunk.parentAgentId,
          },
        ],
      };
    case "graph":
      return rec;
    case "error":
      return { ...rec, errors: [...rec.errors, chunk.message], status: "failed" };
    case "done":
      return {
        ...rec,
        runId: chunk.runId,
        status: rec.status === "failed" ? "failed" : "completed",
      };
    default:
      return rec;
  }
}
