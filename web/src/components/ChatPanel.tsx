import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentSummary, ChatSessionRecord, RunChunk } from "@shared/types";
import {
  buildPromptWithHistory,
  deriveChatTitle,
  deserializeChatSession,
  emptyAssistantTurn,
  newChatSession,
  reduceChunk,
  serializeChatSession,
  type AssistantTurn,
  type Attachment,
  type ChatSession,
  type ChatTurn,
  type SubThread,
  type ToolRecord,
} from "../lib/chat";
import { Timeline } from "./Timeline";
import { AutoTextarea } from "./AutoTextarea";
import { JsonViewer } from "./JsonViewer";

const TEXT_ATTACHMENT_MAX_BYTES = 256 * 1024;
const IMAGE_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;

export function ChatPanel({
  rootAgent,
  allAgents,
  chatStore,
  onRun,
  onAfterRun,
}: {
  rootAgent: AgentSummary;
  allAgents: AgentSummary[];
  chatStore: {
    listChats(agentId: string): Promise<ChatSessionRecord[]>;
    saveChatSession(session: ChatSessionRecord): Promise<void>;
    deleteChatSession(
      agentId: string,
      sessionId: string
    ): Promise<{ ok: boolean }>;
  };
  onRun: (
    userInput: string,
    handlers: {
      onChunk: (c: RunChunk) => void;
      onDone?: (final: { type: "done"; runId: string }) => void;
      onError?: (msg: string) => void;
    }
  ) => Promise<unknown>;
  onAfterRun?: () => void;
}) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<Attachment[]>([]);
  const [running, setRunning] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<{
    agentId: string;
    session: ChatSession;
  } | null>(null);

  const flushPendingSave = () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pendingSave = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (!pendingSave || pendingSave.session.turns.length === 0) return;
    void chatStore
      .saveChatSession(serializeChatSession(pendingSave.session))
      .catch((e) => console.warn("chat save failed", e));
  };

  const scheduleSave = (session: ChatSession, immediate = false) => {
    if (session.turns.length === 0) return;
    pendingSaveRef.current = { agentId: rootAgent.id, session };
    if (immediate) {
      flushPendingSave();
      return;
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushPendingSave, 500);
  };

  // Reload sessions when navigating to a different agent.
  useEffect(() => {
    flushPendingSave();
    let cancelled = false;
    setLoaded(false);
    setSessions([]);
    setActiveId("");
    setInput("");
    setPending([]);
    setHistoryOpen(false);
    chatStore
      .listChats(rootAgent.id)
      .then((records) => {
        if (cancelled) return;
        const next =
          records.length > 0
            ? records.map(deserializeChatSession)
            : [newChatSession(rootAgent.id)];
        setSessions(next);
        setActiveId(next[0]?.id ?? "");
        setLoaded(true);
      })
      .catch((e) => {
        console.warn("chat load failed", e);
        if (cancelled) return;
        const fresh = newChatSession(rootAgent.id);
        setSessions([fresh]);
        setActiveId(fresh.id);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
      flushPendingSave();
    };
  }, [rootAgent.id]);

  // Make sure we always have an active session.
  useEffect(() => {
    if (sessions.length === 0) return;
    if (!sessions.some((s) => s.id === activeId)) {
      setActiveId(sessions[0].id);
    }
  }, [sessions, activeId]);

  const activeSession =
    sessions.find((s) => s.id === activeId) ?? sessions[0];
  const turns: ChatTurn[] = activeSession?.turns ?? [];

  const agentNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of allAgents) m.set(a.id, a.name);
    return m;
  }, [allAgents]);

  // Auto-scroll to bottom on new content.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns]);

  const updateActiveSession = (mut: (s: ChatSession) => ChatSession) => {
    setSessions((prev) => {
      let updated: ChatSession | null = null;
      const next = prev.map((s) => {
        if (s.id !== activeId) return s;
        updated = mut(s);
        return updated;
      });
      if (updated) scheduleSave(updated);
      return next;
    });
  };

  const newChat = () => {
    if (running) return;
    // Drop empty existing chats so we don't leak placeholders.
    const empty = sessions.filter((s) => s.turns.length === 0);
    for (const s of empty) {
      void chatStore.deleteChatSession(rootAgent.id, s.id).catch(() => {});
    }
    const cleaned = sessions.filter((s) => s.turns.length > 0);
    const fresh = newChatSession(rootAgent.id);
    const next = [fresh, ...cleaned];
    setSessions(next);
    setActiveId(fresh.id);
    setInput("");
    setPending([]);
    setHistoryOpen(false);
  };

  const switchTo = (id: string) => {
    if (running) return;
    setActiveId(id);
    setHistoryOpen(false);
  };

  const deleteSession = (id: string) => {
    if (running) return;
    void chatStore.deleteChatSession(rootAgent.id, id).catch((e) => {
      console.warn("chat delete failed", e);
    });
    const remaining = sessions.filter((s) => s.id !== id);
    if (remaining.length === 0) {
      const fresh = newChatSession(rootAgent.id);
      setSessions([fresh]);
      setActiveId(fresh.id);
    } else {
      setSessions(remaining);
      if (id === activeId) setActiveId(remaining[0].id);
    }
  };

  const onPickFiles = () => fileInputRef.current?.click();

  const onFilesSelected = async (files: FileList | null) => {
    if (!files) return;
    const next: Attachment[] = [];
    for (const f of Array.from(files)) {
      try {
        next.push(await readAttachment(f));
      } catch (e) {
        console.warn("attachment failed", f.name, e);
      }
    }
    setPending((prev) => [...prev, ...next]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removePending = (id: string) =>
    setPending((prev) => prev.filter((a) => a.id !== id));

  const start = async () => {
    if (!activeSession) return;
    const text = input.trim();
    if ((!text && pending.length === 0) || running) return;
    setRunning(true);

    const turnId = `turn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const attachments = pending;
    const userMsg: ChatTurn["user"] = {
      text,
      createdAt: new Date().toISOString(),
      attachments: attachments.length ? attachments : undefined,
    };
    let assistant: AssistantTurn = emptyAssistantTurn();
    const newTurn: ChatTurn = { id: turnId, user: userMsg, assistant };

    const historyForPrompt = turns;
    updateActiveSession((s) => ({
      ...s,
      title: s.turns.length === 0 ? deriveChatTitle([newTurn]) : s.title,
      updatedAt: new Date().toISOString(),
      turns: [...s.turns, newTurn],
    }));
    setInput("");
    setPending([]);

    const fullPrompt = buildPromptWithHistory(historyForPrompt, text, attachments);

    const updateAssistant = (next: AssistantTurn) => {
      assistant = next;
      updateActiveSession((s) => ({
        ...s,
        updatedAt: new Date().toISOString(),
        turns: s.turns.map((t) => (t.id === turnId ? { ...t, assistant: next } : t)),
      }));
    };

    try {
      const final = await onRun(fullPrompt, {
        onChunk: (chunk) => {
          updateAssistant(reduceChunk(assistant, chunk, rootAgent.id, agentNames));
        },
        onDone: (final) => {
          updateAssistant(reduceChunk(assistant, final, rootAgent.id, agentNames));
        },
        onError: (msg) => {
          updateAssistant(
            reduceChunk(
              assistant,
              { type: "error", message: msg },
              rootAgent.id,
              agentNames
            )
          );
        },
      });
      if (isDoneChunk(final)) {
        updateAssistant(reduceChunk(assistant, final, rootAgent.id, agentNames));
      }
    } finally {
      flushPendingSave();
      setRunning(false);
      onAfterRun?.();
    }
  };

  const sortedSessions = [...sessions].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  );

  if (!loaded) {
    return (
      <section className="relative flex h-[72vh] min-h-[520px] items-center justify-center overflow-hidden rounded-xl border border-neutral-800/80 bg-surface-raised/60 text-sm text-neutral-500 shadow-card backdrop-blur-sm">
        Loading chat history…
      </section>
    );
  }

  return (
    <section className="relative flex h-[72vh] min-h-[520px] flex-col overflow-hidden rounded-xl border border-neutral-800/80 bg-surface-raised/60 shadow-card backdrop-blur-sm">
      <header className="flex items-center justify-between gap-2 border-b border-neutral-800/80 bg-neutral-900/40 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="relative h-2.5 w-2.5 shrink-0">
            <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/40" />
            <span className="absolute inset-0 rounded-full bg-emerald-400" />
          </span>
          <h2 className="font-display truncate text-sm font-semibold tracking-tight">
            Chat with {rootAgent.name}
          </h2>
          <span className="badge shrink-0">
            {turns.length} turn{turns.length === 1 ? "" : "s"}
          </span>
          {activeSession && activeSession.turns.length > 0 && (
            <span
              className="hidden truncate text-[11px] text-neutral-500 md:inline"
              title={activeSession.title}
            >
              · {activeSession.title}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setHistoryOpen((v) => !v)}
            disabled={running}
            className="btn"
            title="Browse previous chats"
          >
            History ({sessions.length})
          </button>
          <button onClick={newChat} disabled={running} className="btn">
            New chat
          </button>
        </div>
      </header>

      {historyOpen && (
        <div className="border-b border-neutral-800 bg-neutral-950/70">
          <ul className="max-h-56 divide-y divide-neutral-900 overflow-y-auto">
            {sortedSessions.map((s) => (
              <li
                key={s.id}
                className={`flex items-center gap-2 px-4 py-2 text-xs ${
                  s.id === activeId ? "bg-neutral-900/60" : "hover:bg-neutral-900/40"
                }`}
              >
                <button
                  onClick={() => switchTo(s.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span
                    className={`badge ${s.id === activeId ? "badge-active" : ""}`}
                  >
                    {s.turns.length} turn{s.turns.length === 1 ? "" : "s"}
                  </span>
                  <span className="truncate text-neutral-200">{s.title}</span>
                  <span className="ml-auto mono shrink-0 text-[10px] text-neutral-500">
                    {new Date(s.updatedAt).toLocaleString()}
                  </span>
                </button>
                <button
                  onClick={() => deleteSession(s.id)}
                  disabled={running}
                  className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-[10px] text-neutral-500 hover:border-red-500/40 hover:text-red-300"
                  title="Delete chat"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {turns.length === 0 && <EmptyState />}
        {turns.map((t) => (
          <TurnView
            key={t.id}
            turn={t}
            rootAgent={rootAgent}
            agentNames={agentNames}
          />
        ))}
        {running && turns.length > 0 &&
          turns[turns.length - 1].assistant.text === "" &&
          turns[turns.length - 1].assistant.tools.size === 0 && (
            <TypingIndicator label={rootAgent.name} />
          )}
      </div>

      <div className="border-t border-neutral-800/80 bg-neutral-900/40 px-4 py-3">
        {pending.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-2">
            {pending.map((a) => (
              <li
                key={a.id}
                className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-300"
              >
                {a.kind === "image" && a.dataUrl ? (
                  <img
                    src={a.dataUrl}
                    alt={a.name}
                    className="h-6 w-6 rounded object-cover"
                  />
                ) : (
                  <span className="text-neutral-500">
                    {a.kind === "text" ? "📄" : "📎"}
                  </span>
                )}
                <span className="mono max-w-[160px] truncate" title={a.name}>
                  {a.name}
                </span>
                <span className="text-neutral-500">{formatBytes(a.size)}</span>
                <button
                  onClick={() => removePending(a.id)}
                  className="text-neutral-500 hover:text-red-300"
                  title="Remove attachment"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        <AutoTextarea
          value={input}
          onChange={setInput}
          onSubmit={start}
          disabled={running}
          placeholder={`Message ${rootAgent.name}…  (Enter to send · Shift+Enter for newline)`}
          minRows={2}
          maxRows={10}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => onFilesSelected(e.target.files)}
        />
        <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-neutral-500">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onPickFiles}
              disabled={running}
              className="btn"
              title="Attach files or images"
            >
              📎 Attach
            </button>
            <span>
              Reactions, tools and spawned children stream live as side effects.
            </span>
          </div>
          <button
            onClick={start}
            disabled={running || (!input.trim() && pending.length === 0)}
            className="btn btn-primary"
          >
            {running ? "Running…" : "Send"}
          </button>
        </div>
      </div>
    </section>
  );
}

function isDoneChunk(value: unknown): value is { type: "done"; runId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "done" &&
    typeof (value as { runId?: unknown }).runId === "string"
  );
}

async function readAttachment(file: File): Promise<Attachment> {
  const id = `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const mime = file.type || "application/octet-stream";
  const base = {
    id,
    name: file.name,
    mimeType: mime,
    size: file.size,
  };
  if (mime.startsWith("image/") && file.size <= IMAGE_ATTACHMENT_MAX_BYTES) {
    const dataUrl = await readAsDataUrl(file);
    return { ...base, kind: "image", dataUrl };
  }
  if (
    (mime.startsWith("text/") ||
      /(json|xml|yaml|csv|javascript|typescript|markdown|x-sh)/.test(mime) ||
      /\.(md|txt|json|ya?ml|csv|tsv|js|ts|tsx|jsx|py|rb|go|rs|java|c|cpp|h|hpp|sh|toml|ini|env|html|css)$/i.test(
        file.name
      )) &&
    file.size <= TEXT_ATTACHMENT_MAX_BYTES
  ) {
    const content = await file.text();
    return { ...base, kind: "text", content };
  }
  return { ...base, kind: "binary" };
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 py-16 text-center text-sm text-neutral-500">
      <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500/15 to-sky-500/10 ring-1 ring-emerald-500/30 shadow-glow">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <path
            d="M21 12a8 8 0 1 1-3.4-6.5L21 4l-1 4.6"
            stroke="currentColor"
            className="text-emerald-300"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className="font-display font-semibold text-neutral-200">
        Start the conversation
      </div>
      <p className="max-w-sm">
        Anything you send fires the agent's behavior. Reactions, tool calls and
        spawned sub-agents stream live below each reply — open the trace to
        inspect them.
      </p>
    </div>
  );
}

function TypingIndicator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-neutral-500">
      <span className="badge badge-active">{label}</span>
      <span className="dot-pulse flex gap-1">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
      </span>
      <span>thinking…</span>
    </div>
  );
}

function TurnView({
  turn,
  rootAgent,
  agentNames,
}: {
  turn: ChatTurn;
  rootAgent: AgentSummary;
  agentNames: Map<string, string>;
}) {
  return (
    <div className="space-y-3">
      <UserBubble user={turn.user} />
      <AssistantBubble
        turn={turn.assistant}
        rootAgent={rootAgent}
        agentNames={agentNames}
      />
    </div>
  );
}

function UserBubble({ user }: { user: ChatTurn["user"] }) {
  const { text, createdAt, attachments } = user;
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%]">
        {attachments && attachments.length > 0 && (
          <ul className="mb-1 flex flex-wrap justify-end gap-2">
            {attachments.map((a) => (
              <li
                key={a.id}
                className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-50"
              >
                {a.kind === "image" && a.dataUrl ? (
                  <img
                    src={a.dataUrl}
                    alt={a.name}
                    className="max-h-40 max-w-[240px] rounded object-contain"
                  />
                ) : (
                  <div className="flex items-center gap-2">
                    <span>{a.kind === "text" ? "📄" : "📎"}</span>
                    <span className="mono">{a.name}</span>
                    <span className="text-emerald-200/70">
                      {formatBytes(a.size)}
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {text && (
          <div className="rounded-2xl rounded-br-sm border border-emerald-500/30 bg-gradient-to-br from-emerald-500/15 to-emerald-500/5 px-4 py-2.5 text-sm leading-relaxed text-emerald-50 whitespace-pre-wrap shadow-soft">
            {text}
          </div>
        )}
        <div className="mr-1 mt-1 text-right text-[10px] text-neutral-500">
          you · {new Date(createdAt).toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}

function AssistantBubble({
  turn,
  rootAgent,
  agentNames,
}: {
  turn: AssistantTurn;
  rootAgent: AgentSummary;
  agentNames: Map<string, string>;
}) {
  const [traceOpen, setTraceOpen] = useState(false);
  const reactionCount = turn.events.filter((e) => e.action === "Reacting.fired")
    .length;
  const toolCount = turn.tools.size;
  const failedTools = Array.from(turn.tools.values()).filter(
    (t) => t.status === "failed"
  ).length;
  const spawnedCount = turn.spawned.length;
  const isStreaming = turn.status === "running";
  const visibleText = turn.text || primaryGeneratedText(turn, rootAgent.id);

  const subThreads = Array.from(turn.subThreads.values()).filter(
    (s) => s.text.trim().length > 0 || s.agentId !== rootAgent.id
  );

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] flex-1 space-y-2">
        <div className="flex items-center gap-2 text-[11px] text-neutral-500">
          <span className="badge badge-active">{rootAgent.name}</span>
          {isStreaming && <span className="text-emerald-400">streaming…</span>}
          {turn.status === "failed" && (
            <span className="badge badge-fail">failed</span>
          )}
          {turn.runId && (
            <span className="mono text-neutral-600">{turn.runId}</span>
          )}
        </div>

        {visibleText || isStreaming ? (
          <div className="rounded-2xl rounded-bl-sm border border-neutral-800/80 bg-neutral-900/80 px-4 py-3 text-sm leading-relaxed text-neutral-100 whitespace-pre-wrap shadow-soft">
            {visibleText}
            {isStreaming && <Caret />}
          </div>
        ) : null}

        {subThreads.map((sub) => (
          <SubBubble key={sub.agentId} sub={sub} agentNames={agentNames} />
        ))}

        {turn.errors.length > 0 && (
          <div className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
            {turn.errors.map((e, i) => (
              <div key={i}>{e}</div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 text-[11px] text-neutral-500">
          <Stat label="reactions" value={reactionCount} />
          <Stat label="tools" value={toolCount} alert={failedTools > 0} />
          {spawnedCount > 0 && <Stat label="spawned" value={spawnedCount} />}
          <Stat label="events" value={turn.events.length} />
          <button
            onClick={() => setTraceOpen((v) => !v)}
            className="ml-auto rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-[10px] uppercase tracking-wider text-neutral-400 hover:border-neutral-700 hover:text-neutral-200"
          >
            {traceOpen ? "Hide trace" : "Show trace"}
          </button>
        </div>

        {traceOpen && <Trace turn={turn} />}
      </div>
    </div>
  );
}

function primaryGeneratedText(turn: AssistantTurn, rootAgentId: string): string {
  const generated = Array.from(turn.tools.values()).filter(
    (tool) => tool.tool === "llm.generate"
  );
  const rootGenerated =
    generated.find((tool) => tool.actorAgentId === rootAgentId && tool.tokens) ??
    generated.find((tool) => tool.actorAgentId === rootAgentId);
  const fallback = rootGenerated ?? generated.find((tool) => tool.tokens) ?? generated[0];
  if (!fallback) return "";
  if (fallback.tokens) return fallback.tokens;
  return typeof fallback.output === "string" ? fallback.output : "";
}

function Caret() {
  return (
    <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-[2px] animate-pulse bg-emerald-400" />
  );
}

function Stat({
  label,
  value,
  alert,
}: {
  label: string;
  value: number;
  alert?: boolean;
}) {
  if (value === 0 && !alert) return null;
  return (
    <span
      className={`rounded-full border px-2 py-0.5 ${
        alert
          ? "border-red-500/40 bg-red-500/10 text-red-300"
          : "border-neutral-800 bg-neutral-950 text-neutral-400"
      }`}
    >
      <span className="font-semibold text-neutral-200">{value}</span> {label}
    </span>
  );
}

function SubBubble({
  sub,
  agentNames,
}: {
  sub: SubThread;
  agentNames: Map<string, string>;
}) {
  const name = agentNames.get(sub.agentId) ?? sub.agentName;
  return (
    <div className="ml-6 border-l-2 border-yellow-500/40 pl-3">
      <div className="mb-1 flex items-center gap-2 text-[11px] text-neutral-500">
        <span className="badge badge-warn">spawned · {name}</span>
        <span className="mono text-neutral-600">{sub.agentId}</span>
      </div>
      <div className="rounded-2xl rounded-bl-sm border border-yellow-500/20 bg-yellow-500/5 px-4 py-2.5 text-sm leading-relaxed text-yellow-50/90 whitespace-pre-wrap">
        {sub.text || <span className="text-neutral-500 italic">no output</span>}
      </div>
    </div>
  );
}

function Trace({ turn }: { turn: AssistantTurn }) {
  const tools = Array.from(turn.tools.values());
  return (
    <div className="space-y-3 rounded-md border border-neutral-800 bg-neutral-950/50 p-3">
      {tools.length > 0 && (
        <section>
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Tool calls ({tools.length})
          </h4>
          <ul className="space-y-2">
            {tools.map((t) => (
              <ToolRow key={t.id} tool={t} />
            ))}
          </ul>
        </section>
      )}
      {turn.spawned.length > 0 && (
        <section>
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Spawned ({turn.spawned.length})
          </h4>
          <ul className="space-y-1 text-xs">
            {turn.spawned.map((s) => (
              <li key={s.childAgentId} className="mono">
                <span className="text-yellow-300">{s.childName}</span>{" "}
                <span className="text-neutral-500">({s.childAgentId})</span>{" "}
                <span className="text-neutral-600">← {s.parentAgentId}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {turn.events.length > 0 && (
        <section>
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Action timeline ({turn.events.length})
          </h4>
          <Timeline events={turn.events} density="compact" />
        </section>
      )}
    </div>
  );
}

function ToolRow({ tool }: { tool: ToolRecord }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-md border border-neutral-800 bg-neutral-950">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left text-xs"
      >
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <span className="mono shrink-0 text-emerald-300">{tool.tool}</span>
          <span className="mono shrink-0 text-[10px] text-neutral-600">
            {tool.actorAgentId}
          </span>
          {tool.tokens && (
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-neutral-400">
              {tool.tokens}
            </span>
          )}
        </div>
        <span
          className={`badge shrink-0 ${
            tool.status === "completed"
              ? "badge-active"
              : tool.status === "failed"
                ? "badge-fail"
                : "badge-warn"
          }`}
        >
          {tool.status}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-neutral-800 px-3 py-2 text-[11px]">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">
              input
            </div>
            <JsonViewer value={tool.input} collapsed={false} />
          </div>
          {tool.tokens && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">
                streamed tokens
              </div>
              <pre className="mono max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-[11px] text-neutral-200">
                {tool.tokens}
              </pre>
            </div>
          )}
          {tool.output !== undefined && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">
                output
              </div>
              <JsonViewer value={tool.output} collapsed={false} />
            </div>
          )}
          {tool.error && (
            <div className="rounded-md border border-red-500/40 bg-red-500/5 p-2 text-red-300">
              {tool.error}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
