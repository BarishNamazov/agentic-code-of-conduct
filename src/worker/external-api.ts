// External agentic-platform HTTP API.
//
// Spec: docs/api.md. The intent is that a different frontend (e.g. a
// Next.js app) can drive this workspace as if it were a generic agent
// platform: list agents and chat with one over SSE.
//
// This file is intentionally entity-agnostic — it knows nothing about any
// specific agent, domain, or knowledge schema. Specific behavior lives in
// each agent. Per-agent knowledge upload is *not* part of this API; it
// happens in the workspace UI, and agents read it via internal tools.

import type { ExternalAgentDetail, ExternalAgentSummary } from "./agents/WorkspaceAgent";

const ROUTE_PREFIX = "/api/v1/external";

type WorkspaceStub = {
  describeAgentsForExternal: (query?: string) => Promise<ExternalAgentSummary[]>;
  describeAgentForExternal: (
    agentId: string
  ) => Promise<ExternalAgentDetail | null>;
  runExternalChat: (input: {
    agentId: string;
    userInput: string;
  }) => Promise<ReadableStream<Uint8Array>>;
};

function getWorkspace(env: Env): WorkspaceStub {
  const id = env.WorkspaceAgent.idFromName("default");
  return env.WorkspaceAgent.get(id) as unknown as WorkspaceStub;
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers":
      "authorization, content-type, accept, x-conversation-id",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-max-age": "600",
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function unauthorized(message = "Unauthorized"): Response {
  return jsonResponse(401, { error: message });
}

function authorize(request: Request, env: Env): Response | null {
  const expected = env.EXTERNAL_API_KEY?.trim();
  if (!expected) {
    return jsonResponse(503, {
      error:
        "External API is disabled: set EXTERNAL_API_KEY in .dev.vars or as a Worker secret.",
    });
  }
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const provided = match?.[1]?.trim();
  if (!provided || provided !== expected) {
    return unauthorized();
  }
  return null;
}

// Pull the latest user message out of the chat-platform body shape.
type PlatformChatRequest = {
  conversationId?: string;
  messages?: { role: "user" | "assistant" | "system"; content: string }[];
};

function buildUserInput(req: PlatformChatRequest): string {
  const messages = req.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const userText = lastUser?.content?.trim() ?? "";

  const parts: string[] = [];

  // Earlier turns of THIS conversation, capped to keep the window small.
  const priorTurns = messages.slice(0, -1).slice(-10);
  if (priorTurns.length > 0) {
    const lines = priorTurns.map((t) => `${t.role}: ${t.content}`).join("\n");
    parts.push(`[conversation-history]\n${lines}\n[/conversation-history]`);
  }

  parts.push(userText);
  return parts.join("\n\n").trim();
}

async function handleListAgents(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams.get("query") ?? undefined;
  const ws = getWorkspace(env);
  const agents = await ws.describeAgentsForExternal(query || undefined);
  return jsonResponse(200, { agents });
}

async function handleGetAgent(env: Env, agentId: string): Promise<Response> {
  const ws = getWorkspace(env);
  const detail = await ws.describeAgentForExternal(agentId);
  if (!detail) return jsonResponse(404, { error: `Unknown agent ${agentId}` });
  return jsonResponse(200, detail);
}

async function handleChat(
  request: Request,
  env: Env,
  agentId: string
): Promise<Response> {
  let body: PlatformChatRequest;
  try {
    body = (await request.json()) as PlatformChatRequest;
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }
  const userInput = buildUserInput(body);
  if (!userInput) {
    return jsonResponse(400, {
      error: "Body must include a messages array with at least one user message.",
    });
  }
  const ws = getWorkspace(env);
  // Pre-flight: existence check so we 404 cleanly *before* opening SSE.
  const detail = await ws.describeAgentForExternal(agentId);
  if (!detail) return jsonResponse(404, { error: `Unknown agent ${agentId}` });

  const stream = await ws.runExternalChat({ agentId, userInput });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      ...corsHeaders(),
    },
  });
}

export async function handleExternalApi(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(ROUTE_PREFIX)) return null;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const auth = authorize(request, env);
  if (auth) return auth;

  const path = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, "");
  // /agents
  if (path === "/agents" || path === "/agents/") {
    if (request.method === "GET") return handleListAgents(request, env);
    return jsonResponse(405, { error: "Method not allowed" });
  }

  // /agents/{id}[/sub...]
  const m = /^\/agents\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!m) return jsonResponse(404, { error: "Not found" });
  const agentId = m[1]!;
  const sub = m[2] ?? "";

  if (sub === "" || sub === "/") {
    if (request.method === "GET") return handleGetAgent(env, agentId);
    return jsonResponse(405, { error: "Method not allowed" });
  }

  if (sub === "chat") {
    if (request.method === "POST") return handleChat(request, env, agentId);
    return jsonResponse(405, { error: "Method not allowed" });
  }

  return jsonResponse(404, { error: "Not found" });
}

export { ROUTE_PREFIX as EXTERNAL_API_PREFIX };
