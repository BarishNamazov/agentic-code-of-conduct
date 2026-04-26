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

type DocMeta = {
  id: string;
  title: string;
  mimeType: string;
  tags: string[];
  size: number;
  createdAt: string;
  updatedAt: string;
};

const KNOWLEDGE_TEXT_LIMIT = 1_000_000; // 1 MB cap per upload

export function KnowledgePanel({
  agentId,
  agent,
}: {
  agentId: string;
  agent: WorkspaceAgentClient;
}) {
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState<{
    id: string;
    title: string;
    content: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const list = await agent.stub.listAgentDocuments(agentId);
      setDocs(list);
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

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        if (file.size > KNOWLEDGE_TEXT_LIMIT) {
          throw new Error(
            `${file.name}: too large (${file.size}B > ${KNOWLEDGE_TEXT_LIMIT}B). Split or compress first.`
          );
        }
        // Read everything as text. Binary uploads aren't useful to the
        // text-search corpus the agent searches over.
        const content = await file.text();
        await agent.stub.addAgentDocument({
          agentId,
          title: file.name,
          content,
          mimeType: file.type || guessMime(file.name),
        });
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm(`Delete document ${id}?`)) return;
    setBusy(true);
    try {
      await agent.stub.deleteAgentDocument(agentId, id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onView = async (id: string) => {
    setBusy(true);
    try {
      const doc = await agent.stub.getAgentDocument(agentId, id);
      if (doc) {
        setPreviewing({ id: doc.id, title: doc.title, content: doc.content });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Knowledge</h3>
        <button className="btn" onClick={() => void refresh()} disabled={busy}>
          Refresh
        </button>
      </div>

      <div className="text-[11px] leading-snug text-neutral-500">
        Upload reference documents this agent should ground its answers in.
        Agents read them via the{" "}
        <span className="mono">knowledge.search</span> /{" "}
        <span className="mono">knowledge.read</span> tools during a run.
        Plain-text formats work best (Markdown, .txt, JSON, CSV).
      </div>

      <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-neutral-700 bg-neutral-950 px-3 py-4 text-xs text-neutral-300 hover:border-emerald-500/40 hover:text-emerald-300">
        <input
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            void onFiles(e.target.files);
            e.target.value = "";
          }}
          disabled={busy}
        />
        {busy ? "Working…" : "Click to upload one or more files"}
      </label>

      {docs.length === 0 ? (
        <div className="text-xs text-neutral-500">No documents yet.</div>
      ) : (
        <ul className="space-y-1 text-xs">
          {docs.map((d) => (
            <li
              key={d.id}
              className="flex min-w-0 items-center gap-2 rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5"
            >
              <button
                className="mono min-w-0 flex-1 truncate text-left hover:text-emerald-300"
                onClick={() => void onView(d.id)}
                title={d.title}
              >
                {d.title}
              </button>
              <span className="shrink-0 text-[10px] text-neutral-500">
                {d.size}B · {d.mimeType.split(";")[0]}
              </span>
              <button
                className="shrink-0 text-[10px] text-neutral-500 hover:text-red-300"
                onClick={() => void onDelete(d.id)}
                title="Delete"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <div className="text-xs text-red-300">{error}</div>}

      {previewing && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setPreviewing(null)}
        >
          <div
            className="card max-h-[80vh] w-full max-w-3xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 pb-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">
                  {previewing.title}
                </div>
                <div className="mono text-[10px] text-neutral-500">
                  {previewing.id}
                </div>
              </div>
              <button className="btn" onClick={() => setPreviewing(null)}>
                Close
              </button>
            </div>
            <pre className="mono max-h-[68vh] overflow-auto whitespace-pre-wrap break-words rounded border border-neutral-800 bg-neutral-950 p-2 text-[11px] text-neutral-300">
              {previewing.content}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function guessMime(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  return "text/plain";
}
