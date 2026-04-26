# Behaving Agents — External API

This document is the integration contract for any external frontend that wants
to drive a `behaving-agents` workspace as a generic agentic platform: list
agents, chat with one over Server-Sent Events, and follow inline referrals
from one agent to another.

It is the single source of truth for the public surface. The platform is
deliberately **entity-agnostic** — it knows nothing about specific domains,
people, rooms, or knowledge schemas. Specific behavior lives in each agent's
own behavior text.

The shape of the chat event stream is compatible with the spec described in
[`docs/external_platform.md`](./external_platform.md), so an existing
frontend that already implements that contract can talk to this platform with
only configuration changes.

> **Knowledge / documents are not part of this API.** Per-agent reference
> documents are uploaded inside the workspace UI. Agents read them
> internally during a run; the external frontend never sees them and never
> needs to manage them.---

## 1. Base URL & versioning

All endpoints are mounted under a single, versioned prefix:

```
https://behaving-agents.barish2003.workers.dev/api/v1/external
```

For local development with `wrangler dev` the base URL is typically
`http://127.0.0.1:8787`. In production it is the URL of the deployed Worker.

The `/v1` segment is part of the contract — incompatible changes will be
released under a new prefix.

---

## 2. Authentication

Every request **must** carry a bearer token in the `Authorization` header:

```
Authorization: Bearer <EXTERNAL_API_KEY>
```

The token is a single shared secret configured on the platform side via the
environment variable `EXTERNAL_API_KEY` (loaded from `.dev.vars` locally or
from `wrangler secret put EXTERNAL_API_KEY` in production). Hold the secret
on the frontend's server, never in the browser.

Possible auth responses:

| Status | When                                                                |
| ------ | ------------------------------------------------------------------- |
| `401`  | Missing or wrong bearer token.                                      |
| `503`  | Server has no `EXTERNAL_API_KEY` configured (external API disabled). |

`OPTIONS` preflights are answered with `204 No Content` and the CORS headers
below; they do not require auth.

### CORS

The platform sends permissive CORS headers on every response so a browser
client can call it directly if you choose to. In practice we recommend
proxying through your own server route to keep the bearer token out of the
browser.

```
access-control-allow-origin: *
access-control-allow-headers: authorization, content-type, accept, x-conversation-id
access-control-allow-methods: GET, POST, DELETE, OPTIONS
access-control-max-age: 600
```

---

## 3. Endpoint summary

| Method | Path                                  | Purpose                       |
| ------ | ------------------------------------- | ----------------------------- |
| GET    | `/agents`                             | List top-level agents.        |
| GET    | `/agents?query=<text>`                | Search top-level agents.      |
| GET    | `/agents/{agentId}`                   | Get one agent's full detail.  |
| POST   | `/agents/{agentId}/chat`              | Stream a chat turn (SSE).     |

All bodies are JSON unless noted. All responses include
`content-type: application/json; charset=utf-8` except for `/chat` (which
returns `text/event-stream`).

---

## 4. Agent registry

### 4.1 `GET /agents`

Returns the list of top-level agents available in the workspace. Helper
agents that were spawned by a parent run are intentionally excluded.

Query parameters:

| Name    | Type   | Required | Description                                                |
| ------- | ------ | -------- | ---------------------------------------------------------- |
| `query` | string | no       | Case-insensitive substring filter over name and behavior.  |

Response body:

```json
{
  "agents": [
    {
      "id": "agent_abc123",
      "displayName": "Research Concierge",
      "description": "Helps users locate and contextualize ongoing projects.",
      "status": "available",
      "updatedAt": "2026-04-26T12:34:56.000Z"
    }
  ]
}
```

`AgentSummary` shape:

```ts
interface AgentSummary {
  id: string;
  displayName: string;
  description?: string;
  status: "available" | "busy" | "offline";
  updatedAt: string; // ISO-8601
}
```

Notes:

* `status` maps from the agent's lifecycle: `active` → `available`,
  `paused`/`archived` → `offline`.
* The platform deliberately does **not** expose a `capabilities` array.
  Every agent on this platform speaks the same chat protocol; agent-specific
  behavior is described in `description` / `purpose` and demonstrated in
  the actual responses.

### 4.2 `GET /agents/{agentId}`

Returns detail for a single agent. Returns `404` if `agentId` does not
exist.

Response body extends `AgentSummary`:

```ts
interface AgentDetail extends AgentSummary {
  purpose: string | null;        // First-class purpose string from behavior, if any.
  behaviorSummary: string;       // First ~1200 chars of the agent's behavior text.
}
```

Example:

```json
{
  "id": "agent_abc123",
  "displayName": "Research Concierge",
  "description": "Helps users locate and contextualize ongoing projects.",
  "status": "available",
  "updatedAt": "2026-04-26T12:34:56.000Z",
  "purpose": "Help users locate and contextualize ongoing projects.",
  "behaviorSummary": "When the user asks about a project, look it up via knowledge.search ..."
}
```

---

## 5. Agent chat

### 5.1 `POST /agents/{agentId}/chat`

Streams a single chat turn from the agent over Server-Sent Events.

Request headers:

```
Authorization: Bearer <EXTERNAL_API_KEY>
Content-Type:  application/json
Accept:        text/event-stream
```

Request body:

```ts
interface ChatRequest {
  conversationId?: string;
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string;
  }>;
}
```

Behavior:

* The platform takes the **last `user` message** as the new user turn.
* All earlier messages (up to the last 10) are joined and prepended to the
  agent's input as a `[conversation-history]` block, so the agent has prior
  turns even though every request is logically stateless.
* `conversationId` is accepted for forward compatibility but is currently
  not required; each chat call starts a new run on the platform side. The
  platform emits a server-generated `conversationId` in the
  `conversation_state` event (§5.2) which clients may store and re-send.

Response status codes:

| Status | When                                                                  |
| ------ | --------------------------------------------------------------------- |
| `200`  | Stream opened. SSE frames follow.                                     |
| `400`  | Body is not JSON or `messages` has no user message.                   |
| `401`  | Missing/invalid bearer token.                                         |
| `404`  | `agentId` does not exist.                                             |

Response headers (on success):

```
content-type: text/event-stream; charset=utf-8
cache-control: no-cache, no-transform
x-accel-buffering: no
```

### 5.2 Event stream

Each frame is a standard SSE record:

```
event: <type>
data: <json>

```

Frames are emitted in this canonical order for a successful turn:

1. `turn_start`
2. `conversation_state`
3. Zero or more of: `text_delta`, `tool_use_start`, `input_json_delta`,
   `tool_result`.
4. `turn_end`
5. `done`

If the run fails after the headers have been sent, the platform emits an
`error` event and still ends the stream cleanly with `turn_end` + `done`.

`AgentEvent` union:

```ts
type AgentEvent =
  | { type: "turn_start";          turnId: string }
  | { type: "conversation_state";  conversationId: string; agentId: string }
  | { type: "text_delta";          delta: string }
  | { type: "tool_use_start";      toolUseId: string; name: string }
  | { type: "input_json_delta";    toolUseId: string; partialJson: string }
  | { type: "tool_result";         toolUseId: string; status: "ok" | "error"; result: unknown; durationMs: number }
  | { type: "turn_end";            turnId: string }
  | { type: "error";               message: string }
  | { type: "done" };
```

Per-event semantics:

* `turn_start` — fires exactly once. `turnId` doubles as the `runId` and the
  `conversationId` and is stable for the lifetime of this stream.
* `conversation_state` — emitted once, immediately after `turn_start`. The
  client can persist `conversationId` to correlate later turns.
* `text_delta` — incremental assistant text. **Concatenate `delta` strings
  in order to reconstruct the final answer.** The platform does not emit a
  separate "final message" event; the assistant message is the
  concatenation of all `text_delta.delta` values.
* `tool_use_start` — the agent is about to call an internal platform tool
  (e.g. `agent.searchAgents`, `knowledge.search`, `web.fetch`). `toolUseId` is
  unique within the turn.
* `input_json_delta` — partial JSON for a tool call's input, streamed in
  arbitrary chunks. Concatenated chunks for a given `toolUseId` form a
  JSON document.
* `tool_result` — the tool finished. `status: "ok"` for success,
  `"error"` otherwise. `result` is JSON-serializable. `durationMs` is the
  wall-clock duration in milliseconds.
* `turn_end` — fires exactly once at the end of the run.
* `error` — non-terminal: the platform always follows it with `turn_end`
  and `done`. If `error` arrives, treat the assistant message as
  incomplete.
* `done` — the very last frame. Close the connection.

Wire example (truncated):

```
event: turn_start
data: {"turnId":"run_8a1b2c3d"}

event: conversation_state
data: {"conversationId":"run_8a1b2c3d","agentId":"agent_abc123"}

event: text_delta
data: {"delta":"For schema design questions, talk to "}

event: text_delta
data: {"delta":"[Daniel Jackson](agent://agent_7f3a?label=Daniel%20Jackson)."}

event: turn_end
data: {"turnId":"run_8a1b2c3d"}

event: done
data: {}
```

### 5.3 No handoff context

Earlier drafts of this contract included a rich `context` / handoff block.
v1 deliberately drops it: the chat endpoint accepts only `messages`. If you
want to pass prior context, fold it into the message stream itself (e.g.
include the prior assistant turn or a system message). The platform stays
entity-agnostic and does not interpret any specific fields.

---

## 6. Inline agent referrals

Agents are taught (in the shared system prompt) two complementary mechanisms
for referring to other agents:

1. A **declarative concept tag** that is the *canonical* server-side
   record:

   ```html
   <concept_call concept="Referring" action="referred">
     {"to":"agent_7f3a","label":"Daniel Jackson","kind":"person","entityId":"3831"}
   </concept_call>
   ```

   The planner loop strips these tags from the user-facing text and writes
   one `Referring.referred(args...)` entry to the workspace action log per
   tag. This works the same way for *all* runs (internal chat, external
   chat, handler invocations) — the external API does no special parsing
   of its own.

2. An optional **clickable Markdown link** rendered alongside the tag, so
   the user has something to click:

   ```md
   Talk to [Daniel Jackson](agent://agent_7f3a?label=Daniel%20Jackson&kind=person&entityId=3831).
   ```

   URI shape: `agent://<agentId>[?label=<text>&kind=<text>&entityId=<text>&...]`.

### 6.1 Frontend responsibilities

The external service is responsible for **parsing and acting on**
the Markdown link form — the platform itself does no special rendering.

When rendering assistant Markdown:

1. Detect `agent://` links. A regex like
   `/\[([^\]]*)\]\((agent:\/\/[^\s)]+)\)/g` is sufficient — these are
   ordinary Markdown links with a custom scheme.
2. Parse the URI:
   - Strip the leading `agent://`.
   - Everything before `?` is the target `agentId`.
   - Decode query params with `decodeURIComponent` (treat `+` as space).
3. Render the link as a clickable inline element. Optionally validate the
   `agentId` against `GET /agents/{agentId}`.
4. On click, start a new chat against the target agent.

A reference parser (TypeScript) is included at the bottom of this document.

### 6.2 Server-side action log

The workspace's internal action log records one `Referring.referred(args)`
entry per `<concept_call concept="Referring" action="referred">` tag the
agent emits, with the issuing agent as the actor and the chat run's
`runId` as the run. External frontends do **not** need to write this
themselves; they can rely on it for audit / observability if they query
the workspace's internal action log.

---

## 7. Errors

Errors before the response stream opens are returned as HTTP responses
with a JSON body:

```json
{ "error": "Unknown agent agent_xyz" }
```

| Status | Meaning                                                       |
| ------ | ------------------------------------------------------------- |
| `400`  | Bad request: malformed body or missing required fields.       |
| `401`  | Missing or wrong bearer token.                                |
| `404`  | Agent does not exist or unknown route.                        |
| `405`  | HTTP method not allowed on that path.                         |
| `503`  | `EXTERNAL_API_KEY` not configured on the platform.            |

For chat, errors that occur *after* the SSE response has started are
delivered as in-stream `error` events followed by `turn_end` + `done`
(see §5.2). Treat any `error` event as a non-fatal signal that the
assistant message should be considered incomplete; the connection will
close cleanly via `done` regardless.

---

## 8. Operational notes

* The platform is single-tenant: there is one `default` workspace, and
  every agent belongs to it. All `agentId` values are globally unique
  inside that workspace.
* There are no rate limits enforced at the API layer in v1. The platform
  expects one active chat stream per browser session and serializes
  reasonably under low concurrency.
* The chat stream may run for many seconds. Configure your HTTP client
  (and any reverse proxy) to allow long-lived `text/event-stream`
  responses with no read timeout.
* The platform records every external chat run in its internal
  `run_sessions` table so runs appear in the platform's own UI history
  alongside locally initiated runs, including the trace of action-log
  entries (e.g. `Building.thought`, `Communicating.sent`, and any
  `<concept_call>`-derived actions like `Referring.referred`).

---

## 9. Quickstart

```bash
export BASE="http://127.0.0.1:8787"
export TOKEN="<your EXTERNAL_API_KEY>"

# 1. List agents
curl -s "$BASE/api/v1/external/agents" -H "Authorization: Bearer $TOKEN" | jq

# 2. Get one agent's detail
curl -s "$BASE/api/v1/external/agents/agent_abc123" \
  -H "Authorization: Bearer $TOKEN" | jq

# 3. Chat (SSE; -N disables curl buffering)
curl -N -X POST "$BASE/api/v1/external/agents/agent_abc123/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role":"user","content":"Who can help me with database design?"}]
  }'
```

---

## 10. Reference: TypeScript referral parser

Drop-in helper for the consuming frontend. It mirrors the args the
platform records server-side via the `Referring.referred` action, so
client- and server-side analytics line up.

```ts
export type AgentReferral = {
  href: string;
  agentId: string;
  label: string | null;
  kind: string | null;
  entityId: string | null;
  params: Record<string, string>;
};

export function parseAgentReferrals(text: string): AgentReferral[] {
  if (!text) return [];
  const out: AgentReferral[] = [];
  const seen = new Set<string>();
  const linkRe = /\[([^\]]*)\]\((agent:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(text)) !== null) {
    const linkLabel = m[1] ?? "";
    const href = m[2] ?? "";
    const rest = href.slice("agent://".length);
    const qIdx = rest.indexOf("?");
    const agentId = (qIdx >= 0 ? rest.slice(0, qIdx) : rest).trim();
    if (!agentId) continue;
    const params: Record<string, string> = {};
    if (qIdx >= 0) {
      for (const part of rest.slice(qIdx + 1).split("&")) {
        if (!part) continue;
        const eq = part.indexOf("=");
        const key = decode(eq < 0 ? part : part.slice(0, eq));
        const val = decode(eq < 0 ? "" : part.slice(eq + 1));
        if (key) params[key] = val;
      }
    }
    const dedupeKey = `${href}::${linkLabel}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      href,
      agentId,
      label: linkLabel || params.label || null,
      kind: params.kind ?? null,
      entityId: params.entityId ?? null,
      params,
    });
  }
  return out;
}

function decode(s: string): string {
  try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; }
}
```

---

## 11. Acceptance checklist

A frontend is correctly integrated when all of the following hold:

* It can list and search agents via `GET /agents` and render `AgentSummary`
  fields.
* It can fetch single-agent detail via `GET /agents/{id}`.
* It can chat with any agent via `POST /agents/{id}/chat`, parse the SSE
  stream, and reconstruct the assistant message from `text_delta` frames.
* It surfaces tool progress from `tool_use_start` / `input_json_delta` /
  `tool_result`.
* It detects `agent://` Markdown links in assistant text, renders them
  as clickable elements, and on click starts a new chat with the target
  agent.
* It treats `error` events as non-fatal and still consumes the trailing
  `turn_end` + `done`.
* All requests carry the `Authorization: Bearer ...` header; the bearer
  token is held server-side and never exposed to the browser.
