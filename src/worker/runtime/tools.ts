// Tool adapter layer.
//
// Tools are invoked exclusively through `runTool`. Every invocation is wrapped in
// a `Tooling.called` request action and a `Tooling.completed` (or `Tooling.failed`)
// attestation, both of which are recorded in the workspace action log.

import { cerebrasGenerate } from "./cerebras";

export type ToolEnv = {
  AI?: { run: (m: string, i: unknown, o?: unknown) => Promise<unknown> };
  CEREBRAS_API_KEY?: string;
};

export type ToolStreamWriter = {
  token(text: string): void;
};

export type ToolResult = {
  output?: unknown;
  error?: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  usage?: string;
  run: (
    env: ToolEnv,
    input: Record<string, unknown>,
    ctx: ToolCallContext
  ) => Promise<ToolResult>;
};

// Lookups that tools may need from the surrounding workspace.
export type ToolHostQueries = {
  searchMemory(query: string): unknown[];
  // File / handler operations against the *actor* agent's BehaviorAgent.
  // Implemented by the workspace; returns null if no agent is in scope.
  writeAgentFile?(input: {
    actorAgentId: string;
    path: string;
    content: string;
    contentType?: string;
  }): Promise<unknown>;
  readAgentFile?(input: {
    actorAgentId: string;
    path: string;
  }): Promise<unknown>;
  listAgentFiles?(input: { actorAgentId: string }): Promise<unknown>;
  deleteAgentFile?(input: {
    actorAgentId: string;
    path: string;
  }): Promise<unknown>;
  setAgentHandler?(input: {
    actorAgentId: string;
    method: string;
    path: string;
    spec: unknown;
  }): Promise<unknown>;
  listAgentHandlers?(input: { actorAgentId: string }): Promise<unknown>;
  // Per-agent uploaded knowledge corpus.
  searchAgentDocuments?(input: {
    actorAgentId: string;
    query: string;
    limit?: number;
  }): Promise<unknown>;
  listAgentDocuments?(input: { actorAgentId: string }): Promise<unknown>;
  readAgentDocument?(input: {
    actorAgentId: string;
    id: string;
  }): Promise<unknown>;
  // Workspace introspection / orchestration so the agentic loop can
  // discover and reuse other agents.
  listAgents?(): Promise<
    {
      id: string;
      name: string;
      kind: string;
      purpose: string | null;
      parentAgentId: string | null;
    }[]
  >;
  searchAgents?(query: string): Promise<
    {
      id: string;
      name: string;
      kind: string;
      purpose: string | null;
      behaviorSummary: string;
    }[]
  >;
  getAgentBehavior?(agentId: string): Promise<{
    name: string;
    purpose: string | null;
    rawText: string;
  } | null>;
  spawnAgent?(input: {
    actorAgentId: string;
    name: string;
    purpose?: string;
    behaviorText?: string;
    fromAgentId?: string;
    runId: string;
    causedByActionId: string;
    userInput?: string;
  }): Promise<{ childAgentId: string; output: string }>;
  updateAgentBehavior?(input: {
    actorAgentId: string;
    behaviorText: string;
  }): Promise<{ behaviorVersionId: string }>;
  // Initiate a multi-turn conversation with another agent on behalf of the
  // actor. Returns once the initiator's planner reports satisfaction or the
  // turn budget is exhausted. The sink lets timeline events broadcast live;
  // the user-facing summary is suppressed (the agentic loop decides what to
  // surface to the user).
  communicateAgent?(input: {
    actorAgentId: string;
    recipient: string;
    message?: string;
    topic?: string;
    runId: string;
    causedByActionId: string;
    sink?: { send(chunk: unknown): void };
  }): Promise<{
    conversationId: string;
    satisfied: boolean;
    reason: string;
    summary: string;
    turnCount: number;
  }>;
};

// Tools may need to know which agent invoked them (for self-extension tools).
export type ToolCallContext = {
  stream?: ToolStreamWriter;
  // Live run sink. Concepts that drive sub-agent dialogue (e.g.
  // agent.communicate) need this to broadcast timeline events. Kept optional
  // so non-run tool calls (one-off) work without it.
  sink?: { send(chunk: unknown): void };
  host: ToolHostQueries;
  actorAgentId?: string;
  runId?: string;
  causedByActionId?: string;
};

export async function generatePlannerText(
  env: ToolEnv,
  prompt: string,
  caller = "planner"
): Promise<{ text: string; error?: string }> {
  if (!env.CEREBRAS_API_KEY) {
    return { text: `[no CEREBRAS_API_KEY] ${prompt.slice(0, 800)}` };
  }
  return cerebrasGenerate(env.CEREBRAS_API_KEY, prompt, caller);
}

const llmGenerate: ToolDefinition = {
  name: "llm.generate",
  description:
    "Free-form text generation via Cerebras (or echo fallback when API key is missing).",
  usage: `input: { "prompt": "Text to send to the model" }`,
  async run(env, input, ctx) {
    const prompt = String(input.prompt ?? input.input ?? "");
    if (!prompt) return { error: "Missing 'prompt'." };
    if (!env.CEREBRAS_API_KEY) {
      const echoed = `[no CEREBRAS_API_KEY] ${prompt.slice(0, 800)}`;
      ctx.stream?.token(echoed);
      return { output: echoed };
    }
    const { text, error } = await cerebrasGenerate(
      env.CEREBRAS_API_KEY,
      prompt,
      "llm.generate"
    );
    if (error) return { error };
    ctx.stream?.token(text);
    return { output: text };
  },
};

const memorySearch: ToolDefinition = {
  name: "memory.search",
  description:
    "Search the workspace's action log for prior actions whose serialized arguments contain the query string.",
  usage: `input: { "query": "string to search for" }`,
  async run(_env, input, ctx) {
    const q = String(input.query ?? "").trim();
    if (!q) return { output: [] };
    return { output: ctx.host.searchMemory(q) };
  },
};

const httpFetch: ToolDefinition = {
  name: "http.fetch",
  description:
    "Fetch a URL with GET. Limited to https:// for safety. Returns truncated body.",
  usage: `input: { "url": "https://example.com/path" }`,
  async run(_env, input) {
    const url = String(input.url ?? "");
    if (!url.startsWith("https://")) {
      return { error: "Only https:// URLs are allowed." };
    }
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { "user-agent": "behaving-agents/0.1" },
      });
      const body = await res.text();
      return {
        output: {
          status: res.status,
          contentType: res.headers.get("content-type"),
          body: body.slice(0, 4000),
        },
      };
    } catch (e) {
      return { error: errorMessage(e) };
    }
  },
};

// ---- Self-extension tools ----
// Each operates on the running agent's own BehaviorAgent storage. The
// workspace wires the host implementations.

const agentWriteFile: ToolDefinition = {
  name: "agent.writeFile",
  description:
    "Write or overwrite a file in this agent's durable storage. " +
    "Files are addressable at /api/agents/<id>/files/<path> and " +
    "served as static web content at /api/agents/<id>/web/<path>.",
  usage:
    `input: { "path": "index.html", "content": "<!doctype html>...", ` +
    `"contentType": "text/html; charset=utf-8" }`,
  async run(_env, input, ctx) {
    if (!ctx.actorAgentId || !ctx.host.writeAgentFile) {
      return { error: "agent.writeFile is unavailable in this context." };
    }
    const path = String(input.path ?? "");
    const content = String(input.content ?? "");
    if (!path) return { error: "Missing 'path'." };
    const meta = await ctx.host.writeAgentFile({
      actorAgentId: ctx.actorAgentId,
      path,
      content,
      contentType:
        typeof input.contentType === "string" ? input.contentType : undefined,
    });
    return { output: meta };
  },
};

const agentReadFile: ToolDefinition = {
  name: "agent.readFile",
  description: "Read a file from this agent's durable storage.",
  usage: `input: { "path": "index.html" }`,
  async run(_env, input, ctx) {
    if (!ctx.actorAgentId || !ctx.host.readAgentFile) {
      return { error: "agent.readFile is unavailable in this context." };
    }
    const path = String(input.path ?? "");
    if (!path) return { error: "Missing 'path'." };
    const file = await ctx.host.readAgentFile({
      actorAgentId: ctx.actorAgentId,
      path,
    });
    return { output: file };
  },
};

const agentListFiles: ToolDefinition = {
  name: "agent.listFiles",
  description: "List files in this agent's durable storage.",
  usage: `input: {}`,
  async run(_env, _input, ctx) {
    if (!ctx.actorAgentId || !ctx.host.listAgentFiles) {
      return { error: "agent.listFiles is unavailable in this context." };
    }
    const files = await ctx.host.listAgentFiles({
      actorAgentId: ctx.actorAgentId,
    });
    return { output: files };
  },
};

const agentDeleteFile: ToolDefinition = {
  name: "agent.deleteFile",
  description: "Delete a file from this agent's durable storage.",
  usage: `input: { "path": "index.html" }`,
  async run(_env, input, ctx) {
    if (!ctx.actorAgentId || !ctx.host.deleteAgentFile) {
      return { error: "agent.deleteFile is unavailable in this context." };
    }
    const path = String(input.path ?? "");
    if (!path) return { error: "Missing 'path'." };
    const result = await ctx.host.deleteAgentFile({
      actorAgentId: ctx.actorAgentId,
      path,
    });
    return { output: result };
  },
};

const agentSetHandler: ToolDefinition = {
  name: "agent.setHandler",
  description:
    "Register or replace a request handler on this agent. Use this to expose " +
    "served content or an endpoint at /api/agents/<id>/handle/<path>. " +
    "Path matching is exact, or prefix-based when the registered path ends in /*.",
  usage:
    `input: { "method": "GET", "path": "/counter", "spec": { ... } }\n` +
    `spec variants:\n` +
    `- text: { "kind": "text", "body": "hello", "contentType": "text/plain; charset=utf-8", "status": 200 }\n` +
    `- json: { "kind": "json", "body": { "ok": true }, "status": 200 }\n` +
    `- file: { "kind": "file", "path": "index.html", "status": 200 } (serves a file previously written with agent.writeFile)\n` +
    `- redirect: { "kind": "redirect", "location": "https://example.com", "status": 302 }\n` +
    `- llm: { "kind": "llm", "prompt": "Answer requests for this endpoint.", "contentType": "text/plain; charset=utf-8" }\n` +
    `example static page: first call agent.writeFile({ "path": "index.html", "content": "...", "contentType": "text/html; charset=utf-8" }), then agent.setHandler({ "method": "GET", "path": "/", "spec": { "kind": "file", "path": "index.html" } })`,
  async run(_env, input, ctx) {
    if (!ctx.actorAgentId || !ctx.host.setAgentHandler) {
      return { error: "agent.setHandler is unavailable in this context." };
    }
    const method = String(input.method ?? "GET");
    const path = String(input.path ?? "/");
    const spec = input.spec ?? input.response ?? null;
    if (!spec) return { error: "Missing handler 'spec'." };
    const result = await ctx.host.setAgentHandler({
      actorAgentId: ctx.actorAgentId,
      method,
      path,
      spec,
    });
    return { output: result };
  },
};

const agentListHandlers: ToolDefinition = {
  name: "agent.listHandlers",
  description: "List request handlers registered on this agent.",
  usage: `input: {}`,
  async run(_env, _input, ctx) {
    if (!ctx.actorAgentId || !ctx.host.listAgentHandlers) {
      return { error: "agent.listHandlers is unavailable in this context." };
    }
    const list = await ctx.host.listAgentHandlers({
      actorAgentId: ctx.actorAgentId,
    });
    return { output: list };
  },
};

const agentList: ToolDefinition = {
  name: "agent.list",
  description:
    "List all agents in the workspace (id, name, kind, purpose). Use this to discover " +
    "agents you might delegate work to via agent.spawn(fromAgentId).",
  usage: `input: {}`,
  async run(_env, _input, ctx) {
    if (!ctx.host.listAgents) {
      return { error: "agent.list is unavailable in this context." };
    }
    return { output: await ctx.host.listAgents() };
  },
};

const agentSearch: ToolDefinition = {
  name: "agent.search",
  description:
    "Search the workspace's agents by name / purpose / behavior text. Returns the matching " +
    "agents with a short summary of their behavior.",
  usage: `input: { "query": "agent name, purpose, or behavior terms" }`,
  async run(_env, input, ctx) {
    if (!ctx.host.searchAgents) {
      return { error: "agent.search is unavailable in this context." };
    }
    const q = String(input.query ?? "").trim();
    return { output: await ctx.host.searchAgents(q) };
  },
};

const agentGetBehavior: ToolDefinition = {
  name: "agent.getBehavior",
  description:
    "Return the full raw behavior text of another agent (by id) so you can decide whether to " +
    "spawn from it.",
  usage: `input: { "agentId": "agent id" }`,
  async run(_env, input, ctx) {
    if (!ctx.host.getAgentBehavior) {
      return { error: "agent.getBehavior is unavailable in this context." };
    }
    const id = String(input.agentId ?? input.id ?? "");
    if (!id) return { error: "Missing 'agentId'." };
    return { output: await ctx.host.getAgentBehavior(id) };
  },
};

const agentSpawn: ToolDefinition = {
  name: "agent.spawn",
  description:
    "Spawn a child agent and run it to completion. Provide either `fromAgentId` (clone an " +
    "existing agent's behavior) or `behavior` (free-form behavioral description). `userInput` " +
    "is the task data passed to the child. Returns the child's final output.",
  usage:
    `input: { "name": "Helper", "purpose": "optional purpose", ` +
    `"behavior": "behavior text or instructions", "userInput": "task data" }\n` +
    `or input: { "name": "Helper", "fromAgentId": "existing agent id", "userInput": "task data" }`,
  async run(_env, input, ctx) {
    if (!ctx.actorAgentId || !ctx.host.spawnAgent) {
      return { error: "agent.spawn is unavailable in this context." };
    }
    if (!ctx.runId || !ctx.causedByActionId) {
      return { error: "agent.spawn requires a run context." };
    }
    const name = String(input.name ?? input.role ?? "Helper");
    const purpose =
      typeof input.purpose === "string" ? input.purpose : undefined;
    const behaviorText =
      typeof input.behavior === "string"
        ? input.behavior
        : typeof input.behaviorText === "string"
          ? input.behaviorText
          : undefined;
    const fromAgentId =
      typeof input.fromAgentId === "string" ? input.fromAgentId : undefined;
    const userInput =
      typeof input.userInput === "string"
        ? input.userInput
        : typeof input.input === "string"
          ? input.input
          : typeof input.task === "string"
            ? input.task
            : undefined;
    const result = await ctx.host.spawnAgent({
      actorAgentId: ctx.actorAgentId,
      name,
      purpose,
      behaviorText,
      fromAgentId,
      runId: ctx.runId,
      causedByActionId: ctx.causedByActionId,
      userInput,
    });
    return { output: result };
  },
};

const agentUpdateBehavior: ToolDefinition = {
  name: "agent.updateBehavior",
  description:
    "Replace this agent's own behavior with new behavioral text. The new behavior takes effect " +
    "for subsequent runs (the current run continues with the active step plan). Use this to " +
    "permanently encode patterns the agent has learned.",
  usage: `input: { "behaviorText": "complete replacement behavior text" }`,
  async run(_env, input, ctx) {
    if (!ctx.actorAgentId || !ctx.host.updateAgentBehavior) {
      return { error: "agent.updateBehavior is unavailable in this context." };
    }
    const behaviorText = String(input.behaviorText ?? input.behavior ?? "");
    if (!behaviorText.trim()) return { error: "Missing 'behaviorText'." };
    return {
      output: await ctx.host.updateAgentBehavior({
        actorAgentId: ctx.actorAgentId,
        behaviorText,
      }),
    };
  },
};

const agentCommunicate: ToolDefinition = {
  name: "agent.communicate",
  description:
    "Hold a multi-turn conversation with another agent until you (the initiator) are satisfied. " +
    "Use this when you need a back-and-forth dialogue (clarification, debate, peer review) rather than " +
    "delegating an entire task via agent.spawn. Returns the conversation summary, satisfaction, and turn count.",
  usage:
    `input: { "recipient": "<agent id or name>", "message": "your opening message", ` +
    `"topic": "optional short goal/topic" }`,
  async run(_env, input, ctx) {
    if (!ctx.actorAgentId || !ctx.host.communicateAgent) {
      return { error: "agent.communicate is unavailable in this context." };
    }
    if (!ctx.runId || !ctx.causedByActionId) {
      return { error: "agent.communicate requires a run context." };
    }
    const recipient = String(
      input.recipient ?? input.with ?? input.to ?? input.agent ?? input.agentId ?? ""
    );
    if (!recipient) return { error: "Missing 'recipient'." };
    const message =
      typeof input.message === "string"
        ? input.message
        : typeof input.question === "string"
          ? input.question
          : undefined;
    const topic =
      typeof input.topic === "string"
        ? input.topic
        : typeof input.goal === "string"
          ? input.goal
          : undefined;
    const result = await ctx.host.communicateAgent({
      actorAgentId: ctx.actorAgentId,
      recipient,
      message,
      topic,
      runId: ctx.runId,
      causedByActionId: ctx.causedByActionId,
      sink: ctx.sink,
    });
    return { output: result };
  },
};

const knowledgeSearch: ToolDefinition = {
  name: "knowledge.search",
  description:
    "Search the documents the user has uploaded to THIS agent. Returns ranked hits with " +
    "title, tags, and a content snippet. Use this whenever the user's request might be " +
    "grounded in their uploaded data.",
  usage: `input: { "query": "search terms", "limit": 8 }`,
  async run(_env, input, ctx) {
    if (!ctx.actorAgentId || !ctx.host.searchAgentDocuments) {
      return { error: "knowledge.search is unavailable in this context." };
    }
    const query = String(input.query ?? "").trim();
    if (!query) return { error: "Missing 'query'." };
    const limit = typeof input.limit === "number" ? input.limit : undefined;
    const hits = await ctx.host.searchAgentDocuments({
      actorAgentId: ctx.actorAgentId,
      query,
      limit,
    });
    return { output: hits };
  },
};

const knowledgeList: ToolDefinition = {
  name: "knowledge.list",
  description:
    "List the documents the user has uploaded to THIS agent (id, title, tags, size). " +
    "Use this to discover what corpus you have available before searching.",
  usage: `input: {}`,
  async run(_env, _input, ctx) {
    if (!ctx.actorAgentId || !ctx.host.listAgentDocuments) {
      return { error: "knowledge.list is unavailable in this context." };
    }
    return {
      output: await ctx.host.listAgentDocuments({
        actorAgentId: ctx.actorAgentId,
      }),
    };
  },
};

const knowledgeRead: ToolDefinition = {
  name: "knowledge.read",
  description:
    "Read the full content of a single uploaded document by id. Prefer knowledge.search " +
    "first; only call this when you need the entire document body.",
  usage: `input: { "id": "doc id from knowledge.list / knowledge.search" }`,
  async run(_env, input, ctx) {
    if (!ctx.actorAgentId || !ctx.host.readAgentDocument) {
      return { error: "knowledge.read is unavailable in this context." };
    }
    const id = String(input.id ?? "").trim();
    if (!id) return { error: "Missing 'id'." };
    return {
      output: await ctx.host.readAgentDocument({
        actorAgentId: ctx.actorAgentId,
        id,
      }),
    };
  },
};

export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  [llmGenerate.name]: llmGenerate,
  [memorySearch.name]: memorySearch,
  [httpFetch.name]: httpFetch,
  [agentWriteFile.name]: agentWriteFile,
  [agentReadFile.name]: agentReadFile,
  [agentListFiles.name]: agentListFiles,
  [agentDeleteFile.name]: agentDeleteFile,
  [agentSetHandler.name]: agentSetHandler,
  [agentListHandlers.name]: agentListHandlers,
  [agentList.name]: agentList,
  [agentSearch.name]: agentSearch,
  [agentGetBehavior.name]: agentGetBehavior,
  [agentSpawn.name]: agentSpawn,
  [agentUpdateBehavior.name]: agentUpdateBehavior,
  [agentCommunicate.name]: agentCommunicate,
  [knowledgeSearch.name]: knowledgeSearch,
  [knowledgeList.name]: knowledgeList,
  [knowledgeRead.name]: knowledgeRead,
};

export function listAvailableTools() {
  return Object.values(TOOL_REGISTRY).map((t) => ({
    name: t.name,
    description: t.description,
    usage: t.usage,
  }));
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
