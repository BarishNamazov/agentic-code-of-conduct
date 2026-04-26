# Agentic Platform Integration Requirements

This document captures what the external agentic platform needs to support so the current `frontend/` app can fetch agents, let a user chat with a selected agent, and switch to referenced agents inline while preserving useful context.

The current frontend is a Next.js app with a single chat panel. It does not yet have multi-agent selection. Today it posts a conversation to `/api/chat`, receives Server-Sent Events, renders streamed text as Markdown, shows tool-use progress, and extracts a small set of structured references from tool results into clickable dossier chips.

## Current Frontend Contract

The chat UI lives in:

- `frontend/hooks/useAgentStream.ts`
- `frontend/lib/agent-types.ts`
- `frontend/lib/sse-client.ts`
- `frontend/components/chat/*`
- `frontend/app/api/chat/*`

The browser sends:

```json
{
  "messages": [
    { "role": "user", "content": "Where is Daniel Jackson's office?" },
    { "role": "assistant", "content": "..." },
    { "role": "user", "content": "Who has worked with him recently?" }
  ]
}
```

The response is `text/event-stream` with events shaped like:

```ts
type AgentEvent =
  | { type: "turn_start"; turnId: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_use_start"; toolUseId: string; name: string }
  | { type: "input_json_delta"; toolUseId: string; partialJson: string }
  | { type: "tool_result"; toolUseId: string; status: "ok" | "error"; result: unknown; durationMs: number }
  | { type: "turn_end"; turnId: string }
  | { type: "error"; message: string }
  | { type: "done" };
```

Each SSE frame is:

```text
event: text_delta
data: {"delta":"Daniel Jackson is in ..."}

```

The current server implementation is local to the frontend and uses Anthropic-on-Bedrock plus Neo4j-backed CSAIL tools. An external platform can replace this behind `/api/chat`, but should preserve the event stream shape unless the frontend adapter is changed.

## Required Platform Capabilities

### 1. Agent Registry

The platform must expose an API that lets the frontend list, search, and inspect available agents.

Minimum agent shape:

```ts
interface AgentSummary {
  id: string;
  displayName: string;
  description?: string;
  avatarUrl?: string;
  domain?: string;
  capabilities: string[];
  acceptsContext: boolean;
  status?: "available" | "busy" | "offline";
  updatedAt?: string;
}
```

Suggested endpoints:

```http
GET /agents
GET /agents?query=programming%20languages
GET /agents/{agentId}
```

The frontend will need this to add an agent picker and to validate inline agent references before switching.

### 2. Agent Chat

The platform must support sending chat turns to a specific agent.

Suggested endpoint:

```http
POST /agents/{agentId}/chat
Accept: text/event-stream
Content-Type: application/json
```

Suggested request:

```json
{
  "conversationId": "optional-existing-conversation-id",
  "messages": [
    { "role": "user", "content": "Where is Daniel Jackson's office?" }
  ],
  "context": {
    "sourceAgentId": "csail-guide",
    "sourceTurnId": "turn-123",
    "reason": "user_clicked_referring_link",
    "summary": "The user asked about Daniel Jackson's office and collaborators.",
    "entities": [
      {
        "kind": "person",
        "id": "3831",
        "label": "Daniel Jackson",
        "source": "csail_kg"
      }
    ],
    "transcript": [
      { "role": "user", "content": "Where is Daniel Jackson's office?" },
      { "role": "assistant", "content": "Daniel Jackson's office is ..." }
    ]
  }
}
```

The platform should return the same SSE protocol used by the frontend today. If the platform has its own internal stream format, the Next.js `/api/chat` route can act as an adapter.

### 3. Context Acceptance

Because inline references can switch the user from one agent to another, the target agent must be able to accept prior context.

Minimum context fields:

```ts
interface AgentHandoffContext {
  sourceAgentId: string;
  sourceConversationId?: string;
  sourceTurnId?: string;
  reason: "user_clicked_referring_link" | "agent_suggested_handoff" | "manual_agent_switch";
  summary: string;
  transcript?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  entities?: Array<{
    kind: "person" | "group" | "room" | "project" | "paper" | "news" | "area" | "agent" | string;
    id: string;
    label: string;
    source?: string;
    url?: string;
    metadata?: Record<string, unknown>;
  }>;
}
```

The platform should not require the frontend to send the full transcript every time. It should accept either:

- a compact `summary` plus selected entities, or
- a `sourceConversationId` that the platform can resolve server-side, or
- a bounded transcript slice.

### 4. Inline Referring

The platform must support agent outputs that refer to other agents inline. The frontend currently renders assistant text as Markdown, so the referring syntax should be Markdown-compatible and easy to parse.
This means the platform should have a Referral concept baked in in all system prompts and agent outputs.
(Shared system prompt would be ideal, maybe even in Vite level).

Recommended syntax:

```md
Talk to [Daniel Jackson](agent://agent_7f3a?label=Daniel%20Jackson&kind=person&entityId=3831) about this next.
```

Required URI fields:

- scheme: `agent://`
- host/path: target platform agent id, for example `agent_7f3a`
- `label`: human-readable display label
- `kind`: optional entity kind, such as `person`, `group`, or `project`
- `entityId`: optional knowledge-graph or platform entity id

The frontend can then render the link as a normal inline text link that switches the selected agent when clicked. The click handler should create a handoff context from the current conversation and call `/agents/{agentId}/chat` with that context.

If Markdown links are too limiting, the platform can also emit structured reference events alongside text:

```text
event: reference
data: {"refId":"ref-1","target":{"type":"agent","agentId":"agent_7f3a","label":"Daniel Jackson","entity":{"kind":"person","id":"3831"}}}

event: text_delta
data: {"delta":"Talk to "}

event: ref_delta
data: {"refId":"ref-1","text":"Daniel Jackson"}

event: text_delta
data: {"delta":" about this next."}
```

That structured stream is more robust, but it requires frontend changes beyond the current `AgentEvent` union. The Markdown URI form is the lowest-friction path.

### 5. Tool and Reference Provenance

The frontend already displays tool steps from streamed events. The platform should expose tool progress and final tool results in a UI-safe way.

Tool event requirements:

- `tool_use_start` must include a stable `toolUseId` and readable `name`.
- `input_json_delta` should stream partial JSON input when available.
- `tool_result` should include `status`, `durationMs`, and a JSON-serializable `result`.
- Tool results that mention CSAIL entities should include stable ids, not only labels.

For CSAIL graph entities, use these kinds where possible:

```ts
type EntityKind = "person" | "group" | "room" | "project" | "paper" | "news" | "area";
```

Known id conventions in the frontend:

- person: CSAIL `nodeId`, for example `"3831"`
- group: group slug or group id
- room: room id, for example `"32-G7xx"`
- paper/news/project/area: graph id or slug accepted by the matching `/api/kg/...` route

### 6. Conversation State

The frontend currently stores turns in client memory only. The platform should be prepared for either stateless or stateful operation.

Minimum support:

- accept full `messages` arrays for stateless chat
- optionally return `conversationId`
- accept `conversationId` on later turns
- support an explicit `agentId` per turn
- support changing `agentId` while preserving prior context through `AgentHandoffContext`

Suggested additional stream event:

```text
event: conversation_state
data: {"conversationId":"conv_123","agentId":"agent_7f3a"}
```

This event is not implemented in the frontend today, but it would make persistence and agent switching cleaner.

### 7. Error, Cancellation, and Limits

The platform should return errors as both HTTP status codes and stream events.

For streaming failures after headers are sent:

```text
event: error
data: {"message":"Agent timed out"}

event: done
data: {}
```

The platform should enforce and report:

- maximum context size
- maximum transcript turns
- stream timeout
- agent availability
- unauthorized agent access
- tool execution failures

The frontend has a single `busy` flag today, so only one active chat request is expected per browser session.

## Recommended Frontend Integration Shape

Keep the browser pointed at frontend-owned routes and make those routes adapt to the external platform:

```text
Browser
  -> frontend /api/agents
       -> platform GET /agents

Browser
  -> frontend /api/chat
       -> platform POST /agents/{agentId}/chat
       -> normalize platform stream into AgentEvent SSE
```

This keeps platform credentials off the browser and preserves the existing `useAgentStream` client hook.

Expected frontend changes:

- add selected-agent state to `useAgentStream` or a new chat store
- add `/api/agents` proxy route
- extend `/api/chat` request body with `agentId`, `conversationId`, and optional `context`
- teach `AnswerMarkdown` to intercept `agent://...` links
- add a handoff function that switches agents and sends `AgentHandoffContext`
- optionally add `reference`, `ref_delta`, and `conversation_state` to `AgentEvent`

## Authentication and Deployment

The frontend runs server routes under Next.js and can keep platform secrets server-side. The platform should support one of:

- bearer token from the frontend server
- signed service-to-service requests
- user-scoped session token if per-user agent permissions matter

Required environment variables will likely include:

```text
AGENT_PLATFORM_BASE_URL=
AGENT_PLATFORM_API_KEY=
```

The current local chat code also uses:

```text
AWS_REGION=
BEDROCK_MODEL_ID=
NEO4J_URI=
NEO4J_USER=
NEO4J_PASSWORD=
```

Those may no longer be needed by the frontend once chat moves fully behind the external platform, unless the frontend keeps local CSAIL KG tools.

## Acceptance Checklist

The platform is ready for this frontend when all of the following are true:

- The frontend can fetch available agents and display stable ids, names, descriptions, and status.
- The frontend can send a message to a selected agent and receive `turn_start`, `text_delta`, `turn_end`, `done`, and `error` events.
- Tool progress can be streamed with `tool_use_start`, `input_json_delta`, and `tool_result`.
- Agent output can include inline Markdown `agent://...` links for referring to other agents.
- Clicking an inline agent reference can start or continue a conversation with the target agent.
- The target agent receives prior context as a summary, selected entities, and optionally transcript turns.
- Agent and entity references use stable ids, not display names as identifiers.
- Stream failures are represented with an `error` event followed by `done`.
- Platform credentials are usable from Next.js server routes without exposing secrets to the browser.


