// Cloudflare Worker bindings & ambient declarations.
// `Env` is the type referenced by `Agent<Env, State>` from the `agents` SDK.

import type { BehaviorAgent } from "./agents/BehaviorAgent";
import type { WorkspaceAgent } from "./agents/WorkspaceAgent";

declare global {
  interface Env {
    AI?: { run: (m: string, i: unknown, o?: unknown) => Promise<unknown> };
    ASSETS?: { fetch: (req: Request) => Promise<Response> };
    WorkspaceAgent: DurableObjectNamespace<WorkspaceAgent>;
  }

  // Make Cloudflare's namespace alias resolve to our Env so the Agents SDK
  // generic defaults (`Cloudflare.Env`) line up with our bindings.
  namespace Cloudflare {
    interface Env extends globalThis.Env {}
  }
}

export type { BehaviorAgent, WorkspaceAgent };
