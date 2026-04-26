import { useCallback, useEffect, useState } from "react";
import type { WorkspaceAgentClient } from "../lib/agent-client";

type FileMeta = {
  path: string;
  contentType: string;
  size: number;
  createdAt: string;
  updatedAt: string;
};

type Handler = {
  id: string;
  method: string;
  path: string;
  spec: unknown;
  createdAt: string;
  updatedAt: string;
};

export function FilesPanel({
  agentId,
  agent,
}: {
  agentId: string;
  agent: WorkspaceAgentClient;
}) {
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const list = await agent.stub.listAgentFiles(agentId);
      setFiles(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [agent, agentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Files</h3>
        <button className="btn" onClick={() => void refresh()} disabled={busy}>
          Refresh
        </button>
      </div>

      <div className="text-[11px] leading-snug text-neutral-500">
        Files are produced by the agent (e.g. via{" "}
        <span className="mono">agent.writeFile</span>). To add or edit one, ask
        the agent in chat. Downloadable at{" "}
        <span className="mono break-all">
          /api/agents/{agentId}/files/&lt;path&gt;
        </span>
        .
      </div>

      {files.length === 0 ? (
        <div className="text-xs text-neutral-500">No files yet.</div>
      ) : (
        <ul className="space-y-1 text-xs">
          {files.map((f) => (
            <li
              key={f.path}
              className="flex min-w-0 items-center gap-2 rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5"
            >
              <a
                className="mono min-w-0 flex-1 truncate text-left hover:text-emerald-300"
                href={`/api/agents/${agentId}/files/${f.path}`}
                target="_blank"
                rel="noreferrer"
                title={f.path}
              >
                {f.path}
              </a>
              <span className="shrink-0 text-[10px] text-neutral-500">
                {f.size}B · {f.contentType.split(";")[0]}
              </span>
            </li>
          ))}
        </ul>
      )}

      {error && <div className="text-xs text-red-300">{error}</div>}
    </div>
  );
}

export function HandlersPanel({
  agentId,
  agent,
}: {
  agentId: string;
  agent: WorkspaceAgentClient;
}) {
  const [handlers, setHandlers] = useState<Handler[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const list = await agent.stub.listAgentHandlers(agentId);
      setHandlers(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [agent, agentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Request handlers</h3>
        <button className="btn" onClick={() => void refresh()} disabled={busy}>
          Refresh
        </button>
      </div>

      <div className="text-[11px] leading-snug text-neutral-500">
        Handlers are registered by the agent (via{" "}
        <span className="mono">agent.setHandler</span>). Ask the agent in chat
        to add or change one. Reachable at{" "}
        <span className="mono break-all">
          /api/agents/{agentId}/handle/&lt;path&gt;
        </span>
        .
      </div>

      {handlers.length === 0 ? (
        <div className="text-xs text-neutral-500">No handlers yet.</div>
      ) : (
        <ul className="space-y-1 text-xs">
          {handlers.map((h) => (
            <li
              key={h.id}
              className="min-w-0 rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5"
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <div className="mono min-w-0 truncate" title={`${h.method} ${h.path}`}>
                  <span className="text-emerald-300">{h.method}</span> {h.path}
                </div>
                <a
                  className="shrink-0 text-[10px] text-neutral-400 hover:text-emerald-300"
                  href={`/api/agents/${agentId}/handle${h.path}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  invoke
                </a>
              </div>
              <pre className="mono mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all text-[10px] text-neutral-400">
                {JSON.stringify(h.spec, null, 2)}
              </pre>
            </li>
          ))}
        </ul>
      )}

      {error && <div className="text-xs text-red-300">{error}</div>}
    </div>
  );
}
