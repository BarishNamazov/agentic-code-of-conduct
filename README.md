# behaving-agents

A lean MVP of the **Behavioral-Code Agent Ecosystem** described in
[`docs/design.md`](docs/design.md).

Agents are described by a behavior — not by a system prompt. Each behavior is
compiled to a structured intermediate representation (BCIR), versioned, and
attached to a real Cloudflare Agents SDK Durable Object. A workspace runtime
schedules reactions, executes tools, spawns child behaviors, and writes every
step to an append-only action log.

## Stack

* Cloudflare Workers + Durable Objects
* [`agents`](https://developers.cloudflare.com/agents/) SDK
  (`WorkspaceAgent` + `BehaviorAgent` sub-agents)
* Workers AI (optional — falls back to deterministic echo if no `AI` binding)
* React + Vite + Tailwind UI bound to the workspace via `useAgent`

```
┌───────────────────────────────────────────────────────────────────────┐
│ React UI (web/)                                                       │
│   useAgent("WorkspaceAgent")  ←──── state sync · streaming runs ───┐  │
└──────────────────────────────────────────────────────────────────┐ │  │
                                                                   │ │  │
┌──────────────────────────────────────────────────────────────────▼─▼──┐
│ WorkspaceAgent (Durable Object · src/worker/agents/WorkspaceAgent.ts) │
│   • SQLite: agents, behavior_versions, action_log, tool_calls,        │
│     spawn_edges, run_sessions                                         │
│   • Compiles & validates BCIR · executes the run loop                 │
│   • Streams RunChunks (events, tokens, tool calls, spawns) to clients │
│                                                                       │
│   ┌─ subAgent(BehaviorAgent, agentId) ─────────────────────────────┐  │
│   │ BehaviorAgent (facet · isolated SQLite)                        │  │
│   │   • Stores the installed behavior version                      │  │
│   │   • Mirrors every action it produced for provenance            │  │
│   └────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
```

## Project layout

```
src/
  shared/types.ts          # Types shared by worker + UI (BCIR, envelopes…)
  worker/
    index.ts               # Worker entrypoint (routeAgentRequest + assets)
    agents/
      WorkspaceAgent.ts    # Workspace Durable Object · all callable RPCs
      BehaviorAgent.ts     # Per-agent durable storage + action mirror
    behavior/
      normalize.ts         # Free-form text / Markdown / JSON → BCIR
      validate.ts          # BCIR validator + entrypoint compiler
    runtime/
      run-loop.ts          # Streaming reaction execution loop
      tools.ts             # llm.generate · memory.search · http.fetch
web/                       # Vite + React + Tailwind UI
docs/design.md             # Source of truth for the design
```

## Running locally

Prerequisites: Node 20+, a Cloudflare account if you want to deploy.

```bash
npm install
npm run dev          # runs `wrangler dev` and Vite dev server in parallel
```

* The worker boots at `http://127.0.0.1:8787` (Agents traffic).
* The UI dev server at `http://127.0.0.1:5173` proxies `/agents/*` to it.

To skip Cloudflare bindings entirely the runtime falls back to a deterministic
echo for `llm.generate`, so you can exercise the entire flow without an `AI`
binding.

### Build for production

```bash
npm run build        # vite build → dist/
npm run deploy       # wrangler deploy (requires CF auth)
```

The Worker serves `dist/` via the `assets` binding; the React app talks to the
same origin over WebSocket via `useAgent("WorkspaceAgent")`.

## Concepts at a glance

* **BCIR** — Behavioral-Code Intermediate Representation. JSON-typed reactions,
  concepts, tools, permissions. See `src/shared/types.ts`.
* **Reaction** — `when <observation> [where <state>] then <request|attest>`
  fired by the run loop in response to a triggering action.
* **Action envelope** — every step is logged as `{by, action, args, runId,
  causedByActionId, causedByReactionId}` in the workspace's append-only log.
* **Sub-agents** — children created via `Spawning.spawn` requests become
  first-class `BehaviorAgent` facets with their own SQLite mirror.
* **Tools** — `llm.generate`, `memory.search`, `http.fetch`, plus
  self-extension tools `agent.writeFile`, `agent.readFile`,
  `agent.listFiles`, `agent.deleteFile`, `agent.setHandler`,
  `agent.listHandlers`. Every call is bracketed by `Tooling.called`
  (request) and `Tooling.completed/failed` (attestation).
* **Files & handlers** — every agent has its own durable file system
  and request-handler table. Files are reachable at
  `/api/agents/<id>/files/<path>` (GET/PUT/DELETE list-or-blob) and
  served as static web at `/api/agents/<id>/web/<path>` (with
  `index.html` SPA fallback). Declarative request handlers registered
  via `agent.setHandler` are reachable at
  `/api/agents/<id>/handle/<path>`. Handler specs are JSON
  (`{kind: "text"|"json"|"file"|"redirect"|"llm", ...}`) — interpreted
  safely without `eval`. The agentic tool catalog includes per-tool input
  examples, including concrete `agent.setHandler` specs for `text`, `json`,
  `file`, `redirect`, and `llm` handlers.

## What is intentionally NOT in the MVP

* Multi-tenant workspaces (single `default` workspace for now).
* Human-in-the-loop approval queue (the design lists this — the runtime
  records `Approving.*` actions but always auto-approves).
* Distributed evaluation, observability dashboards, MCP server bridging.

These slot in cleanly because every interaction already flows through the
workspace's append-only action log.
