import { routeAgentRequest } from "agents";
import { WorkspaceAgent } from "./agents/WorkspaceAgent";
import { BehaviorAgent } from "./agents/BehaviorAgent";

export { WorkspaceAgent, BehaviorAgent };

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // Static assets are served by the [assets] binding (see wrangler.jsonc).
    if (env.ASSETS) return env.ASSETS.fetch(request);

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
