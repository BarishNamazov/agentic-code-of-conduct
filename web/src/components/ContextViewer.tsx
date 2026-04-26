import { useEffect, useMemo, useState } from "react";
import type { AgentContextPreview, AgentSummary } from "@shared/types";
import type { WorkspaceAgentClient } from "../lib/agent-client";
import { buildPromptWithHistory, type Attachment, type ChatTurn } from "../lib/chat";

// Approximate tokens-per-character for an at-a-glance budget readout.
const APPROX_CHARS_PER_TOKEN = 4;

type Mode = "rendered" | "structured" | "template" | "user-input";

export function ContextViewer({
  open,
  onClose,
  agent,
  rootAgent,
  turns,
  pendingInput,
  pendingAttachments,
}: {
  open: boolean;
  onClose: () => void;
  agent: WorkspaceAgentClient;
  rootAgent: AgentSummary;
  turns: ChatTurn[];
  pendingInput: string;
  pendingAttachments: Attachment[];
}) {
  const [mode, setMode] = useState<Mode>("rendered");
  const [includePending, setIncludePending] = useState(true);
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState<AgentContextPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // The exact "user input" string that the run loop passes to the planner —
  // identical to what `ChatPanel.start()` sends as `userInput` to `runAgent`.
  const userInputForPlanner = useMemo(() => {
    const text = includePending ? pendingInput : "";
    const atts = includePending ? pendingAttachments : [];
    if (turns.length === 0 && !text && atts.length === 0) return "";
    return buildPromptWithHistory(turns, text, atts);
  }, [turns, pendingInput, pendingAttachments, includePending]);

  // Fetch the rendered planner prompt from the worker whenever the modal is
  // opened or the input changes. Debounced so we don't hammer the worker on
  // every keystroke.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setPreviewError(null);
    const handle = setTimeout(() => {
      agent.stub
        .previewAgentContext(rootAgent.id, userInputForPlanner)
        .then((p) => {
          if (!cancelled) {
            setPreview(p);
            setLoading(false);
          }
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setPreviewError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, agent, rootAgent.id, userInputForPlanner]);

  const rendered = preview?.rendered ?? "";

  const stats = useMemo(() => {
    const chars = rendered.length;
    const lines = rendered ? rendered.split("\n").length : 0;
    const approxTokens = Math.ceil(chars / APPROX_CHARS_PER_TOKEN);
    return { chars, lines, approxTokens };
  }, [rendered]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(rendered);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Context viewer"
    >
      <div
        className="absolute inset-0 bg-neutral-950/80 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative flex h-full max-h-[92vh] w-full max-w-5xl min-h-0 flex-col overflow-hidden rounded-xl border border-neutral-800/80 bg-surface-raised shadow-card">
        <header className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 border-b border-neutral-800/80 bg-neutral-900/60 px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-300/80">
              Full agent context
            </div>
            <h2 className="font-display truncate text-sm font-semibold tracking-tight">
              What {rootAgent.name} sees on the next planner step
            </h2>
          </div>
          <button
            onClick={onClose}
            className="btn btn-ghost shrink-0"
            title="Close (Esc)"
            aria-label="Close context viewer"
          >
            ✕
          </button>
        </header>

        <div className="flex flex-wrap items-center gap-2 border-b border-neutral-800/80 bg-neutral-950/40 px-4 py-2 text-[11px] text-neutral-400">
          <div className="flex flex-wrap items-center gap-1 rounded-lg border border-neutral-800 bg-neutral-900/60 p-1">
            <ModeButton
              active={mode === "rendered"}
              onClick={() => setMode("rendered")}
              label="Rendered"
            />
            <ModeButton
              active={mode === "structured"}
              onClick={() => setMode("structured")}
              label="Structured"
            />
            <ModeButton
              active={mode === "user-input"}
              onClick={() => setMode("user-input")}
              label="Chat history"
            />
            <ModeButton
              active={mode === "template"}
              onClick={() => setMode("template")}
              label="Template"
            />
          </div>
          <Stat label="lines" value={stats.lines} />
          <Stat label="chars" value={stats.chars} />
          <Stat label="≈ tokens" value={stats.approxTokens} highlight />
          <label className="ml-auto inline-flex cursor-pointer select-none items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/60 px-2 py-1 text-[11px] text-neutral-300 hover:border-neutral-700">
            <input
              type="checkbox"
              checked={includePending}
              onChange={(e) => setIncludePending(e.target.checked)}
              className="accent-emerald-500"
            />
            include pending input
          </label>
          <button onClick={onCopy} className="btn shrink-0" disabled={!rendered}>
            {copied ? "Copied" : "Copy rendered"}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-neutral-950/30">
          {previewError ? (
            <ErrorBanner message={previewError} />
          ) : loading && !preview ? (
            <LoadingBanner />
          ) : !preview ? (
            <EmptyContext />
          ) : mode === "rendered" ? (
            <RawView text={preview.rendered} />
          ) : mode === "template" ? (
            <RawView text={preview.promptTemplate} muted />
          ) : mode === "user-input" ? (
            <ChatHistoryView
              turns={turns}
              pendingInput={includePending ? pendingInput : ""}
              pendingAttachments={includePending ? pendingAttachments : []}
              composedUserInput={userInputForPlanner}
            />
          ) : (
            <StructuredView preview={preview} />
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-800/80 bg-neutral-900/40 px-4 py-2 text-[10px] text-neutral-500">
          <span>
            Token estimates use a {APPROX_CHARS_PER_TOKEN} chars/token heuristic;
            the actual planner truncates user input to 4000 chars.
          </span>
          {loading && preview && <span className="text-emerald-300">refreshing…</span>}
        </footer>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
        active
          ? "bg-emerald-500/15 text-emerald-200"
          : "text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-100"
      }`}
    >
      {label}
    </button>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 ${
        highlight
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
          : "border-neutral-800 bg-neutral-950 text-neutral-400"
      }`}
    >
      <span className="font-semibold text-neutral-100">{value.toLocaleString()}</span>{" "}
      {label}
    </span>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="m-4 rounded-md border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-300">
      Failed to load context: {message}
    </div>
  );
}

function LoadingBanner() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-neutral-500">
      Loading context…
    </div>
  );
}

function EmptyContext() {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-sm text-neutral-500">
      Context is empty.
    </div>
  );
}

function RawView({ text, muted }: { text: string; muted?: boolean }) {
  return (
    <pre
      className={`mono whitespace-pre-wrap break-words px-4 py-4 text-[12px] leading-relaxed ${
        muted ? "text-neutral-400" : "text-neutral-100"
      }`}
    >
      {text || <span className="text-neutral-600 italic">(empty)</span>}
    </pre>
  );
}

function StructuredView({ preview }: { preview: AgentContextPreview }) {
  return (
    <div className="space-y-3 p-4">
      <Section title="Identity">
        <KeyVal k="agent name" v={preview.agentName} />
        <KeyVal k="agent id" v={preview.agentId} mono />
        {preview.agentPurpose && (
          <RawBlock label="purpose" text={preview.agentPurpose} />
        )}
      </Section>
      {preview.reactions && (
        <Section title="Behavioral reactions">
          <RawBlock text={preview.reactions} />
        </Section>
      )}
      <Section title="Tool catalog">
        <RawBlock text={preview.toolCatalog} />
      </Section>
      <Section title="User input (composed for the planner)">
        <RawBlock text={preview.userInput} />
      </Section>
      {preview.goal && (
        <Section title="Goal for this step">
          <RawBlock text={preview.goal} />
        </Section>
      )}
      <Section title="Work history so far">
        <RawBlock text={preview.history} />
      </Section>
      <Section title="Decision schema">
        <p className="text-[12px] leading-relaxed text-neutral-300">
          The planner must reply with a JSON object — either{" "}
          <code className="mono text-emerald-300">
            {`{"thought": "...", "tool": "tool.name", "input": {…}}`}
          </code>{" "}
          to call a tool, or{" "}
          <code className="mono text-emerald-300">
            {`{"thought": "...", "respond": "final answer"}`}
          </code>{" "}
          when finished. Loop runs at most 8 steps.
        </p>
      </Section>
    </div>
  );
}

function ChatHistoryView({
  turns,
  pendingInput,
  pendingAttachments,
  composedUserInput,
}: {
  turns: ChatTurn[];
  pendingInput: string;
  pendingAttachments: Attachment[];
  composedUserInput: string;
}) {
  const hasPending = pendingInput.trim().length > 0 || pendingAttachments.length > 0;
  return (
    <div className="space-y-3 p-4">
      <Section title="Composed user input string">
        <p className="mb-2 text-[11px] text-neutral-500">
          This is the single string the run loop binds as <code className="mono">?input</code>{" "}
          and passes to the planner under "User input for this run".
        </p>
        <RawBlock text={composedUserInput} />
      </Section>
      {turns.length > 0 && (
        <Section title={`Conversation so far (${turns.length} turn${turns.length === 1 ? "" : "s"})`}>
          <div className="space-y-2">
            {turns.map((t, i) => (
              <TurnCard key={t.id} turn={t} index={i} />
            ))}
          </div>
        </Section>
      )}
      {hasPending && (
        <Section title="Current message (pending)" highlight>
          <PendingCard text={pendingInput} attachments={pendingAttachments} />
        </Section>
      )}
      {turns.length === 0 && !hasPending && <EmptyContext />}
    </div>
  );
}

function Section({
  title,
  children,
  highlight,
}: {
  title: string;
  children: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <section
      className={`rounded-lg border ${
        highlight
          ? "border-emerald-500/30 bg-emerald-500/5"
          : "border-neutral-800/80 bg-neutral-950/40"
      }`}
    >
      <div
        className={`border-b px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] ${
          highlight
            ? "border-emerald-500/20 text-emerald-200"
            : "border-neutral-800/60 text-neutral-500"
        }`}
      >
        {title}
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

function KeyVal({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex gap-2 text-[12px]">
      <span className="w-28 shrink-0 text-neutral-500">{k}</span>
      <span className={`min-w-0 break-words text-neutral-100 ${mono ? "mono" : ""}`}>
        {v}
      </span>
    </div>
  );
}

function RawBlock({ label, text }: { label?: string; text: string }) {
  return (
    <div>
      {label && (
        <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">
          {label}
        </div>
      )}
      <pre className="mono whitespace-pre-wrap break-words rounded-md border border-neutral-800/60 bg-neutral-950/60 px-3 py-2 text-[12px] leading-relaxed text-neutral-200">
        {text || <span className="text-neutral-600 italic">(empty)</span>}
      </pre>
    </div>
  );
}

function TurnCard({ turn, index }: { turn: ChatTurn; index: number }) {
  const userText = renderUserText(turn.user.text, turn.user.attachments);
  const assistantText = turn.assistant.text;
  return (
    <div className="rounded-md border border-neutral-800/80 bg-neutral-950/60">
      <div className="flex items-center justify-between border-b border-neutral-800/60 px-3 py-1 text-[10px] uppercase tracking-wider text-neutral-500">
        <span>Turn {index + 1}</span>
        <span className="mono text-neutral-600">{turn.id}</span>
      </div>
      <Block role="user" text={userText} />
      {assistantText.trim().length > 0 && (
        <Block role="assistant" text={assistantText} />
      )}
    </div>
  );
}

function PendingCard({
  text,
  attachments,
}: {
  text: string;
  attachments: Attachment[];
}) {
  const rendered = renderUserText(text, attachments);
  return (
    <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5">
      <Block role="user" text={rendered} pending />
    </div>
  );
}

function Block({
  role,
  text,
  pending,
}: {
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
}) {
  const isUser = role === "user";
  return (
    <div className="flex gap-3 px-3 py-2.5">
      <span
        className={`shrink-0 self-start rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
          pending
            ? "border-emerald-400/50 bg-emerald-500/15 text-emerald-200"
            : isUser
              ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-200"
              : "border-neutral-700 bg-neutral-900 text-neutral-300"
        }`}
      >
        {role}
      </span>
      <pre className="mono min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-neutral-100">
        {text || <span className="text-neutral-600 italic">(empty)</span>}
      </pre>
    </div>
  );
}

function renderUserText(text: string, attachments?: Attachment[]): string {
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
