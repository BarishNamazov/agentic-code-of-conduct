import { routeAgentRequest } from "agents";
import { WorkspaceAgent } from "./agents/WorkspaceAgent";
import { BehaviorAgent } from "./agents/BehaviorAgent";
import { handleExternalApi } from "./external-api";

export { WorkspaceAgent, BehaviorAgent };

const AGENT_ROUTE_RE =
  /^\/api\/agents\/([^/]+)\/(files|web|handle|handlers)(?:\/(.*))?$/;

async function getWorkspace(env: Env) {
  const id = env.WorkspaceAgent.idFromName("default");
  return env.WorkspaceAgent.get(id) as unknown as {
    serveAgentRequest: (input: {
      agentId: string;
      kind: "files" | "web" | "handle";
      path: string;
      method: string;
      body?: string;
      contentType?: string;
    }) => Promise<{ status: number; contentType: string; body: string }>;
    listAgentHandlers: (agentId: string) => Promise<unknown>;
    setAgentHandler: (input: {
      agentId: string;
      method: string;
      path: string;
      spec: unknown;
    }) => Promise<unknown>;
    deleteAgentHandler: (
      agentId: string,
      id: string
    ) => Promise<unknown>;
  };
}

async function handleAgentApi(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  const m = AGENT_ROUTE_RE.exec(url.pathname);
  if (!m) return null;
  const [, agentId, kind, rest = ""] = m;
  const stub = await getWorkspace(env);

  // /handlers (CRUD list/set/delete) — distinct from /handle (invoke).
  if (kind === "handlers") {
    if (request.method === "GET") {
      const list = await stub.listAgentHandlers(agentId!);
      return new Response(JSON.stringify(list), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    if (request.method === "POST" || request.method === "PUT") {
      const text = await request.text();
      let parsed: { method?: string; path?: string; spec?: unknown } = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      const result = await stub.setAgentHandler({
        agentId: agentId!,
        method: parsed.method ?? "GET",
        path: parsed.path ?? "/",
        spec: parsed.spec,
      });
      return new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    if (request.method === "DELETE") {
      const id = rest;
      if (!id) {
        return new Response(JSON.stringify({ error: "Missing handler id" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      const result = await stub.deleteAgentHandler(agentId!, id);
      return new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return new Response("Method not allowed", { status: 405 });
  }

  const body =
    request.method === "GET" || request.method === "DELETE"
      ? undefined
      : await request.text();

  const result = await stub.serveAgentRequest({
    agentId: agentId!,
    kind: kind as "files" | "web" | "handle",
    path: rest,
    method: request.method,
    body,
    contentType: request.headers.get("content-type") ?? undefined,
  });

  const headers: Record<string, string> = { "content-type": result.contentType };
  if (result.status === 301 || result.status === 302) {
    headers["location"] = result.body;
    return new Response(null, { status: result.status, headers });
  }
  return new Response(result.body, { status: result.status, headers });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const externalResponse = await handleExternalApi(request, env);
    if (externalResponse) return externalResponse;

    const apiResponse = await handleAgentApi(request, env);
    if (apiResponse) return apiResponse;

    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // Static assets are served by the [assets] binding (see wrangler.jsonc).
    if (env.ASSETS) return env.ASSETS.fetch(request);

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
