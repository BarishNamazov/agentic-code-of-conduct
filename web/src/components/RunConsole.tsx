import { useState } from "react";
import type { RunChunk } from "@shared/types";
import { emptyRunRecord, reduceChunk, type RunRecord } from "../lib/run-record";
import { Timeline } from "./Timeline";

export function RunConsole({
  onRun,
  onAfterRun,
}: {
  onRun: (
    userInput: string,
    handlers: {
      onChunk: (c: RunChunk) => void;
      onDone?: (final: { type: "done"; runId: string }) => void;
      onError?: (msg: string) => void;
    }
  ) => Promise<void>;
  onAfterRun?: () => void;
}) {
  const [input, setInput] = useState("Review this draft.");
  const [running, setRunning] = useState(false);
  const [record, setRecord] = useState<RunRecord>(emptyRunRecord());

  const start = async () => {
    if (!input.trim() || running) return;
    setRunning(true);
    setRecord(emptyRunRecord());
    let local = emptyRunRecord();
    try {
      await onRun(input, {
        onChunk: (chunk) => {
          local = reduceChunk(local, chunk);
          setRecord(local);
        },
        onDone: (final) => {
          local = reduceChunk(local, final);
          setRecord(local);
        },
        onError: (msg) => {
          local = reduceChunk(local, { type: "error", message: msg });
          setRecord(local);
        },
      });
    } finally {
      setRunning(false);
      onAfterRun?.();
    }
  };

  return (
    <section className="card space-y-4">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
          Run
        </h2>
        {record.runId && (
          <div className="mono text-[10px] text-neutral-500">{record.runId}</div>
        )}
      </header>

      <div className="flex gap-2">
        <input
          className="input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Send input to this agent…"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void start();
            }
          }}
        />
        <button
          onClick={start}
          disabled={running || !input.trim()}
          className="btn btn-primary"
        >
          {running ? "Running…" : "Run"}
        </button>
      </div>

      {record.text && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm leading-relaxed whitespace-pre-wrap">
          {record.text}
        </div>
      )}

      {record.errors.length > 0 && (
        <div className="card border-red-500/40 bg-red-500/5 text-xs text-red-300">
          {record.errors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      )}

      {record.tools.size > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Tool calls
          </h3>
          <ul className="space-y-2">
            {Array.from(record.tools.values()).map((t) => (
              <li
                key={t.id}
                className="rounded-md border border-neutral-800 bg-neutral-950 p-2 text-xs"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="mono text-emerald-300">{t.tool}</span>
                    <span className="ml-2 text-[10px] text-neutral-500">
                      by {t.actorAgentId}
                    </span>
                  </div>
                  <span
                    className={`badge ${
                      t.status === "completed"
                        ? "badge-active"
                        : t.status === "failed"
                          ? "badge-fail"
                          : "badge-warn"
                    }`}
                  >
                    {t.status}
                  </span>
                </div>
                {t.tokens && (
                  <div className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-neutral-300">
                    {t.tokens}
                  </div>
                )}
                {t.error && <div className="mt-1 text-red-300">{t.error}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {record.spawned.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Spawned
          </h3>
          <ul className="space-y-1 text-xs">
            {record.spawned.map((s) => (
              <li key={s.childAgentId} className="mono">
                <span className="text-emerald-300">{s.childName}</span>{" "}
                <span className="text-neutral-500">({s.childAgentId})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {record.events.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Action timeline ({record.events.length})
          </h3>
          <Timeline events={record.events} />
        </div>
      )}
    </section>
  );
}
