import { useState } from "react";
import type { BCIR, CompileBehaviorResult } from "@shared/types";
import type { WorkspaceAgentClient } from "../lib/agent-client";
import { BehaviorPreview } from "./BehaviorPreview";

export function ReviseDialog({
  agent,
  current,
  onClose,
  onSubmit,
}: {
  agent: WorkspaceAgentClient;
  current: BCIR;
  onClose: () => void;
  onSubmit: (next: BCIR) => Promise<void>;
}) {
  const [text, setText] = useState(current.raw.text);
  const [preview, setPreview] = useState<CompileBehaviorResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const compile = async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await agent.stub.compileBehavior({ rawText: text });
      setPreview(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        ...preview.normalized,
        agent: { ...preview.normalized.agent, name: current.agent.name },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950 shadow-2xl">
        <header className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <div>
            <h3 className="font-display text-sm font-semibold tracking-tight">
              Revise behavior
            </h3>
            <div className="text-[11px] text-neutral-500">
              The new version supersedes — never overwrites — the old one.
            </div>
          </div>
          <button onClick={onClose} className="btn">
            Cancel
          </button>
        </header>

        <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-5 lg:grid-cols-2">
          <div className="flex flex-col">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              className="mono input min-h-[420px] resize-y bg-neutral-950 text-[13px]"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button onClick={compile} disabled={busy} className="btn">
                {busy ? "Compiling…" : "Compile preview"}
              </button>
              <button
                onClick={submit}
                disabled={!preview || !preview.validation.ok || busy}
                className="btn btn-primary"
              >
                Save new version
              </button>
            </div>
            {error && (
              <div className="mt-2 text-xs text-red-300">{error}</div>
            )}
          </div>

          <div>
            {preview ? (
              <BehaviorPreview result={preview} />
            ) : (
              <div className="card text-sm text-neutral-500">
                Compile to preview the normalized behavior.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
