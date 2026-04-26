import type { RunChunk, TimelineEvent } from "@shared/types";

// A "turn" in the chat is one user prompt + one streamed assistant response
// plus the side-effect trace produced while answering it.
export type ToolRecord = {
  id: string;
  tool: string;
  input: unknown;
  output?: unknown;
  error?: string;
  status: "requested" | "running" | "completed" | "failed";
  actorAgentId: string;
  tokens: string;
  startedAt: string;
};

export type SpawnRecord = {
  childAgentId: string;
  childName: string;
  parentAgentId: string;
};

export type SubThread = {
  agentId: string;
  agentName: string;
  text: string;
};

export type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "text" | "image" | "binary";
  // For images: a dataURL we can render in the bubble.
  dataUrl?: string;
  // For text-like attachments: full UTF-8 contents (also forwarded to the model).
  content?: string;
};

export type AssistantTurn = {
  runId: string | null;
  status: "running" | "completed" | "failed";
  text: string;
  subThreads: Map<string, SubThread>;
  events: TimelineEvent[];
  tools: Map<string, ToolRecord>;
  spawned: SpawnRecord[];
  errors: string[];
  toolActor: Map<string, string>;
};

export type ChatTurn = {
  id: string;
  user: { text: string; createdAt: string; attachments?: Attachment[] };
  assistant: AssistantTurn;
};

export type ChatSession = {
  id: string;
  agentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: ChatTurn[];
};

export function emptyAssistantTurn(): AssistantTurn {
  return {
    runId: null,
    status: "running",
    text: "",
    subThreads: new Map(),
    events: [],
    tools: new Map(),
    spawned: [],
    errors: [],
    toolActor: new Map(),
  };
}

function resolveActor(turn: AssistantTurn, toolCallId: string | undefined): string | null {
  if (!toolCallId) return null;
  return turn.toolActor.get(toolCallId) ?? null;
}

export function reduceChunk(
  turn: AssistantTurn,
  chunk: RunChunk,
  rootAgentId: string,
  agentNames: Map<string, string>
): AssistantTurn {
  switch (chunk.type) {
    case "event": {
      return { ...turn, events: [...turn.events, chunk.event] };
    }
    case "token": {
      const actor = resolveActor(turn, chunk.toolCallId);
      const tools = new Map(turn.tools);
      if (chunk.toolCallId) {
        const t = tools.get(chunk.toolCallId);
        if (t) tools.set(chunk.toolCallId, { ...t, tokens: t.tokens + chunk.text });
      }

      if (!actor || actor === rootAgentId) {
        return { ...turn, text: turn.text + chunk.text, tools };
      }

      const subThreads = new Map(turn.subThreads);
      const existing = subThreads.get(actor);
      const name = existing?.agentName ?? agentNames.get(actor) ?? actor;
      subThreads.set(actor, {
        agentId: actor,
        agentName: name,
        text: (existing?.text ?? "") + chunk.text,
      });
      return { ...turn, tools, subThreads };
    }
    case "tool": {
      const tools = new Map(turn.tools);
      tools.set(chunk.toolCallId, {
        id: chunk.toolCallId,
        tool: chunk.tool,
        input: chunk.input,
        status: "running",
        actorAgentId: chunk.actorAgentId,
        tokens: "",
        startedAt: new Date().toISOString(),
      });
      const toolActor = new Map(turn.toolActor);
      toolActor.set(chunk.toolCallId, chunk.actorAgentId);
      return { ...turn, tools, toolActor };
    }
    case "tool_result": {
      const tools = new Map(turn.tools);
      const t = tools.get(chunk.toolCallId);
      if (t) {
        tools.set(chunk.toolCallId, {
          ...t,
          status: chunk.status,
          output: chunk.output,
          error: chunk.error,
        });
      }
      const fallbackText =
        t?.actorAgentId === rootAgentId &&
        t.tool === "llm.generate" &&
        chunk.status === "completed" &&
        typeof chunk.output === "string" &&
        turn.text.length === 0
          ? chunk.output
          : turn.text;
      return { ...turn, text: fallbackText, tools };
    }
    case "spawn": {
      const subThreads = new Map(turn.subThreads);
      if (!subThreads.has(chunk.childAgentId)) {
        subThreads.set(chunk.childAgentId, {
          agentId: chunk.childAgentId,
          agentName: chunk.childName,
          text: "",
        });
      }
      return {
        ...turn,
        spawned: [
          ...turn.spawned,
          {
            childAgentId: chunk.childAgentId,
            childName: chunk.childName,
            parentAgentId: chunk.parentAgentId,
          },
        ],
        subThreads,
      };
    }
    case "graph":
      return turn;
    case "error":
      return { ...turn, errors: [...turn.errors, chunk.message], status: "failed" };
    case "done":
      return {
        ...turn,
        runId: chunk.runId,
        status: turn.status === "failed" ? "failed" : "completed",
      };
    default:
      return turn;
  }
}

// Build the userInput we send to the backend, including prior conversation
// history and the current turn's attachments (text content inlined).
export function buildPromptWithHistory(
  history: ChatTurn[],
  current: string,
  attachments?: Attachment[]
): string {
  const lines: string[] = [];
  if (history.length > 0) {
    lines.push("[Conversation so far]");
    for (const t of history) {
      const userText = renderUserMessageForPrompt(t.user.text, t.user.attachments);
      lines.push(`User: ${userText}`);
      if (t.assistant.text.trim()) {
        lines.push(`Assistant: ${t.assistant.text.trim()}`);
      }
    }
    lines.push("", "[Current message]");
  }
  lines.push(renderUserMessageForPrompt(current, attachments));
  return lines.join("\n");
}

function renderUserMessageForPrompt(text: string, attachments?: Attachment[]): string {
  if (!attachments || attachments.length === 0) return text;
  const blocks = attachments.map((a) => {
    if (a.kind === "text" && a.content != null) {
      return `[Attachment: ${a.name} (${a.mimeType}, ${a.size} bytes)]\n${a.content}\n[/Attachment]`;
    }
    if (a.kind === "image") {
      return `[Image attached: ${a.name} (${a.mimeType}, ${a.size} bytes)]`;
    }
    return `[File attached: ${a.name} (${a.mimeType}, ${a.size} bytes)]`;
  });
  return [text, ...blocks].filter(Boolean).join("\n\n");
}

// ----- Persistence -----------------------------------------------------------

const STORAGE_PREFIX = "behave:chats:";

type StoredAssistantTurn = {
  runId: string | null;
  status: AssistantTurn["status"];
  text: string;
  subThreads: SubThread[];
  events: TimelineEvent[];
  tools: ToolRecord[];
  spawned: SpawnRecord[];
  errors: string[];
  toolActor: [string, string][];
};

type StoredTurn = {
  id: string;
  user: ChatTurn["user"];
  assistant: StoredAssistantTurn;
};

type StoredSession = {
  id: string;
  agentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: StoredTurn[];
};

function serializeAssistant(t: AssistantTurn): StoredAssistantTurn {
  return {
    runId: t.runId,
    status: t.status,
    text: t.text,
    subThreads: Array.from(t.subThreads.values()),
    events: t.events,
    tools: Array.from(t.tools.values()),
    spawned: t.spawned,
    errors: t.errors,
    toolActor: Array.from(t.toolActor.entries()),
  };
}

function deserializeAssistant(s: StoredAssistantTurn): AssistantTurn {
  const status =
    s.status === "running"
      ? s.errors.length > 0
        ? "failed"
        : "completed"
      : s.status;
  return {
    runId: s.runId,
    status,
    text: s.text,
    subThreads: new Map(s.subThreads.map((sub) => [sub.agentId, sub])),
    events: s.events,
    tools: new Map(s.tools.map((tr) => [tr.id, tr])),
    spawned: s.spawned,
    errors: s.errors,
    toolActor: new Map(s.toolActor),
  };
}

function serializeSession(s: ChatSession): StoredSession {
  return {
    ...s,
    turns: s.turns.map((t) => ({
      id: t.id,
      user: t.user,
      assistant: serializeAssistant(t.assistant),
    })),
  };
}

function deserializeSession(s: StoredSession): ChatSession {
  return {
    ...s,
    turns: s.turns.map((t) => ({
      id: t.id,
      user: t.user,
      assistant: deserializeAssistant(t.assistant),
    })),
  };
}

export function loadChats(agentId: string): ChatSession[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + agentId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredSession[];
    return parsed.map(deserializeSession);
  } catch {
    return [];
  }
}

export function saveChats(agentId: string, sessions: ChatSession[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    const stored: StoredSession[] = sessions.map(serializeSession);
    localStorage.setItem(STORAGE_PREFIX + agentId, JSON.stringify(stored));
  } catch {
    // Quota exceeded or similar — silently ignore; chat is best-effort persisted.
  }
}

export function newChatSession(agentId: string): ChatSession {
  const now = new Date().toISOString();
  return {
    id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    agentId,
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    turns: [],
  };
}

export function deriveChatTitle(turns: ChatTurn[]): string {
  const firstUser = turns[0]?.user.text?.trim();
  if (!firstUser) return "New chat";
  const oneLine = firstUser.replace(/\s+/g, " ");
  return oneLine.length > 60 ? oneLine.slice(0, 60) + "…" : oneLine;
}
