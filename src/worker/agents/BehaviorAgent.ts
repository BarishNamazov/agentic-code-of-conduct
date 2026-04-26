import { Agent } from "agents";
import type {
  ActingEnvelope,
  BCIR,
  TimelineEvent,
} from "../../shared/types";

export type BehaviorAgentState = {
  agentId: string | null;
  behaviorVersionId: string | null;
  status: "empty" | "ready" | "running";
  agentName: string | null;
};

// A BehaviorAgent is a real Cloudflare Agents SDK sub-agent. Each instance is
// a Durable Object facet of the parent WorkspaceAgent with its own isolated
// SQLite database. Its job is to durably store the current behavior version
// and a mirror of every action it produced so that provenance is preserved
// even if the workspace projection is rebuilt.

export class BehaviorAgent extends Agent<Env, BehaviorAgentState> {
  initialState: BehaviorAgentState = {
    agentId: null,
    behaviorVersionId: null,
    status: "empty",
    agentName: null,
  };

  #nameSet = false;

  private ensureName(agentId?: string | null) {
    if (this.#nameSet) return;
    const id = agentId ?? this.state.agentId ?? this.ctx.id.toString();
    // Workaround: partyserver throws if .name is read before setName() when
    // the DO is accessed via RPC rather than routePartyKitRequest().
    // https://github.com/cloudflare/workerd/issues/2240
    void this.setName(id);
    this.#nameSet = true;
  }

  async onStart() {
    this.ensureName();
    this.ensureSchema();
  }

  private ensureSchema() {
    this.sql`CREATE TABLE IF NOT EXISTS local_behavior (
      id TEXT PRIMARY KEY,
      behavior_version_id TEXT NOT NULL,
      normalized_json TEXT NOT NULL,
      installed_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS local_actions (
      id TEXT PRIMARY KEY,
      action_name TEXT NOT NULL,
      args_json TEXT NOT NULL,
      run_id TEXT,
      behavior_version_id TEXT,
      caused_by_action_id TEXT,
      caused_by_reaction_id TEXT,
      created_at TEXT NOT NULL
    )`;
    // Files: durable per-agent file system. Used both for "artifacts" the
    // agent produces during a run and for static frontend assets it serves
    // at /api/agents/<id>/web/*. Path is the canonical key (no leading "/").
    this.sql`CREATE TABLE IF NOT EXISTS local_files (
      path TEXT PRIMARY KEY,
      content_text TEXT,
      content_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    // Request handlers: declarative specs that map (method, path) to a
    // response. Specs are JSON, executed by `invokeHandler` — no eval.
    this.sql`CREATE TABLE IF NOT EXISTS local_handlers (
      id TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_local_handlers_method_path
      ON local_handlers(method, path)`;
    // Documents: unnormalized blobs uploaded by the user that the agent can
    // search over via the `knowledge.*` tools. Independent of `local_files`,
    // which are addressable artifacts the agent itself produces.
    this.sql`CREATE TABLE IF NOT EXISTS local_documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      content_text TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_local_documents_created
      ON local_documents(created_at)`;
  }

  // Install (or replace) the behavior this agent runs.
  async installBehavior(input: {
    agentId: string;
    agentName: string;
    behaviorVersionId: string;
    normalized: BCIR;
  }) {
    this.ensureSchema();
    this.sql`
      INSERT INTO local_behavior (id, behavior_version_id, normalized_json, installed_at)
      VALUES (${crypto.randomUUID()}, ${input.behaviorVersionId},
              ${JSON.stringify(input.normalized)}, ${new Date().toISOString()})
    `;
    this.ensureName(input.agentId);
    this.setState({
      agentId: input.agentId,
      agentName: input.agentName,
      behaviorVersionId: input.behaviorVersionId,
      status: "ready",
    });
    return { ok: true };
  }

  // Returns the most recently installed behavior.
  async getBehavior(): Promise<{
    behaviorVersionId: string;
    normalized: BCIR;
  } | null> {
    this.ensureSchema();
    const rows = this.sql<{
      behavior_version_id: string;
      normalized_json: string;
    }>`SELECT behavior_version_id, normalized_json
       FROM local_behavior
       ORDER BY installed_at DESC
       LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    return {
      behaviorVersionId: row.behavior_version_id,
      normalized: JSON.parse(row.normalized_json) as BCIR,
    };
  }

  // Mirror an action produced by this agent during a workspace-orchestrated run.
  async recordAction(env: ActingEnvelope) {
    this.ensureSchema();
    this.sql`
      INSERT INTO local_actions
      (id, action_name, args_json, run_id, behavior_version_id,
       caused_by_action_id, caused_by_reaction_id, created_at)
      VALUES (${env.id}, ${env.action}, ${JSON.stringify(env.args)},
              ${env.runId ?? null}, ${env.behaviorVersionId ?? null},
              ${env.causedByActionId ?? null}, ${env.causedByReactionId ?? null},
              ${env.createdAt})
    `;
  }

  // Inspection helper for the UI.
  async listLocalActions(limit = 100): Promise<TimelineEvent[]> {
    this.ensureSchema();
    const rows = this.sql<{
      id: string;
      action_name: string;
      args_json: string;
      run_id: string | null;
      behavior_version_id: string | null;
      caused_by_action_id: string | null;
      caused_by_reaction_id: string | null;
      created_at: string;
    }>`SELECT id, action_name, args_json, run_id, behavior_version_id,
              caused_by_action_id, caused_by_reaction_id, created_at
       FROM local_actions
       ORDER BY created_at DESC
       LIMIT ${limit}`;
    return rows.map((r) => ({
      id: r.id,
      actorAgentId: this.state.agentId ?? "",
      action: r.action_name,
      args: safeJSON(r.args_json),
      runId: r.run_id,
      behaviorVersionId: r.behavior_version_id,
      causedByActionId: r.caused_by_action_id,
      causedByReactionId: r.caused_by_reaction_id,
      createdAt: r.created_at,
    }));
  }

  async setRunning(running: boolean) {
    this.ensureSchema();
    this.ensureName();
    this.setState({ ...this.state, status: running ? "running" : "ready" });
  }

  async resetStorage(): Promise<{ ok: boolean }> {
    this.ensureSchema();
    this.sql`DELETE FROM local_handlers`;
    this.sql`DELETE FROM local_files`;
    this.sql`DELETE FROM local_documents`;
    this.sql`DELETE FROM local_actions`;
    this.sql`DELETE FROM local_behavior`;
    this.ensureName();
    this.setState({
      agentId: null,
      agentName: null,
      behaviorVersionId: null,
      status: "empty",
    });
    return { ok: true };
  }

  // ---------- Files ----------

  async writeFile(input: {
    path: string;
    content: string;
    contentType?: string;
  }): Promise<LocalFileMeta> {
    this.ensureSchema();
    const path = normalizePath(input.path);
    const contentType = input.contentType?.trim() || guessContentType(path);
    const now = new Date().toISOString();
    const size = byteLength(input.content);
    const existing = this.sql<{
      created_at: string;
    }>`SELECT created_at FROM local_files WHERE path = ${path}`[0];
    if (existing) {
      this.sql`
        UPDATE local_files
        SET content_text = ${input.content},
            content_type = ${contentType},
            size = ${size},
            updated_at = ${now}
        WHERE path = ${path}
      `;
    } else {
      this.sql`
        INSERT INTO local_files
          (path, content_text, content_type, size, created_at, updated_at)
        VALUES (${path}, ${input.content}, ${contentType}, ${size}, ${now}, ${now})
      `;
    }
    return {
      path,
      contentType,
      size,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
    };
  }

  async readFile(path: string): Promise<{
    path: string;
    content: string;
    contentType: string;
    size: number;
    updatedAt: string;
  } | null> {
    this.ensureSchema();
    const p = normalizePath(path);
    const rows = this.sql<{
      path: string;
      content_text: string | null;
      content_type: string;
      size: number;
      updated_at: string;
    }>`SELECT path, content_text, content_type, size, updated_at
       FROM local_files WHERE path = ${p}`;
    const row = rows[0];
    if (!row) return null;
    return {
      path: row.path,
      content: row.content_text ?? "",
      contentType: row.content_type,
      size: row.size,
      updatedAt: row.updated_at,
    };
  }

  async listFiles(): Promise<LocalFileMeta[]> {
    this.ensureSchema();
    const rows = this.sql<{
      path: string;
      content_type: string;
      size: number;
      created_at: string;
      updated_at: string;
    }>`SELECT path, content_type, size, created_at, updated_at
       FROM local_files ORDER BY path ASC`;
    return rows.map((r) => ({
      path: r.path,
      contentType: r.content_type,
      size: r.size,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async deleteFile(path: string): Promise<{ ok: boolean }> {
    this.ensureSchema();
    const p = normalizePath(path);
    this.sql`DELETE FROM local_files WHERE path = ${p}`;
    return { ok: true };
  }

  // ---------- Handlers ----------

  async setHandler(input: {
    id?: string;
    method: string;
    path: string;
    spec: HandlerSpec;
  }): Promise<LocalHandler> {
    this.ensureSchema();
    const method = (input.method || "GET").toUpperCase();
    const path = normalizeHandlerPath(input.path);
    const now = new Date().toISOString();
    const id =
      input.id ?? `h_${method}_${path.replace(/[^A-Za-z0-9]+/g, "_")}`;
    const specJson = JSON.stringify(input.spec);
    const existing = this.sql<{
      created_at: string;
    }>`SELECT created_at FROM local_handlers WHERE id = ${id}`[0];
    if (existing) {
      this.sql`
        UPDATE local_handlers
        SET method = ${method}, path = ${path}, spec_json = ${specJson},
            updated_at = ${now}
        WHERE id = ${id}
      `;
    } else {
      this.sql`
        INSERT INTO local_handlers (id, method, path, spec_json, created_at, updated_at)
        VALUES (${id}, ${method}, ${path}, ${specJson}, ${now}, ${now})
      `;
    }
    return {
      id,
      method,
      path,
      spec: input.spec,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
    };
  }

  async listHandlers(): Promise<LocalHandler[]> {
    this.ensureSchema();
    const rows = this.sql<{
      id: string;
      method: string;
      path: string;
      spec_json: string;
      created_at: string;
      updated_at: string;
    }>`SELECT id, method, path, spec_json, created_at, updated_at
       FROM local_handlers ORDER BY path ASC, method ASC`;
    return rows.map((r) => ({
      id: r.id,
      method: r.method,
      path: r.path,
      spec: safeJSON(r.spec_json) as unknown as HandlerSpec,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async deleteHandler(id: string): Promise<{ ok: boolean }> {
    this.ensureSchema();
    this.sql`DELETE FROM local_handlers WHERE id = ${id}`;
    return { ok: true };
  }

  // Find a matching handler for (method, path). Path matching is exact or
  // prefix (handler.path ends with "/*"). Returns the most specific match.
  // ---------- Documents (uploaded knowledge) ----------

  async addDocument(input: {
    id?: string;
    title: string;
    content: string;
    mimeType?: string;
    tags?: string[];
  }): Promise<LocalDocumentMeta> {
    this.ensureSchema();
    const id = input.id?.trim() || `doc_${crypto.randomUUID().slice(0, 8)}`;
    const title = input.title.trim() || id;
    const mime = (input.mimeType || "text/plain").trim();
    const tags = Array.isArray(input.tags) ? input.tags.map(String) : [];
    const size = byteLength(input.content);
    const now = new Date().toISOString();
    const existing = this.sql<{
      created_at: string;
    }>`SELECT created_at FROM local_documents WHERE id = ${id}`[0];
    if (existing) {
      this.sql`
        UPDATE local_documents
        SET title = ${title}, mime_type = ${mime},
            tags_json = ${JSON.stringify(tags)},
            content_text = ${input.content}, size = ${size},
            updated_at = ${now}
        WHERE id = ${id}
      `;
    } else {
      this.sql`
        INSERT INTO local_documents
          (id, title, mime_type, tags_json, content_text, size, created_at, updated_at)
        VALUES (${id}, ${title}, ${mime}, ${JSON.stringify(tags)},
                ${input.content}, ${size}, ${now}, ${now})
      `;
    }
    return {
      id,
      title,
      mimeType: mime,
      tags,
      size,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
    };
  }

  async listDocuments(): Promise<LocalDocumentMeta[]> {
    this.ensureSchema();
    const rows = this.sql<{
      id: string;
      title: string;
      mime_type: string;
      tags_json: string;
      size: number;
      created_at: string;
      updated_at: string;
    }>`SELECT id, title, mime_type, tags_json, size, created_at, updated_at
       FROM local_documents ORDER BY updated_at DESC`;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      mimeType: r.mime_type,
      tags: safeStringArray(r.tags_json),
      size: r.size,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async getDocument(id: string): Promise<{
    id: string;
    title: string;
    mimeType: string;
    tags: string[];
    content: string;
    size: number;
    createdAt: string;
    updatedAt: string;
  } | null> {
    this.ensureSchema();
    const rows = this.sql<{
      id: string;
      title: string;
      mime_type: string;
      tags_json: string;
      content_text: string;
      size: number;
      created_at: string;
      updated_at: string;
    }>`SELECT id, title, mime_type, tags_json, content_text, size,
              created_at, updated_at
       FROM local_documents WHERE id = ${id}`;
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      title: r.title,
      mimeType: r.mime_type,
      tags: safeStringArray(r.tags_json),
      content: r.content_text,
      size: r.size,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async deleteDocument(id: string): Promise<{ ok: boolean }> {
    this.ensureSchema();
    this.sql`DELETE FROM local_documents WHERE id = ${id}`;
    return { ok: true };
  }

  // Naive ranking: count how many query terms appear in title / tags / content.
  // Returns matching documents with a content snippet around the first hit.
  async searchDocuments(input: {
    query: string;
    limit?: number;
  }): Promise<DocumentSearchHit[]> {
    this.ensureSchema();
    const query = input.query.trim();
    if (!query) return [];
    const limit = Math.max(1, Math.min(50, input.limit ?? 8));
    const terms = Array.from(
      new Set(
        query
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => t.length > 1)
      )
    );
    if (terms.length === 0) terms.push(query.toLowerCase());

    // Pull recent docs and rank in memory. The MVP keeps this O(n); upgrade to
    // FTS5 / vector search when corpora grow.
    const rows = this.sql<{
      id: string;
      title: string;
      mime_type: string;
      tags_json: string;
      content_text: string;
      size: number;
      updated_at: string;
    }>`SELECT id, title, mime_type, tags_json, content_text, size, updated_at
       FROM local_documents
       ORDER BY updated_at DESC
       LIMIT 500`;
    const scored = rows
      .map((r) => {
        const hayTitle = r.title.toLowerCase();
        const hayBody = `${r.tags_json}\n${r.content_text}`.toLowerCase();
        let score = 0;
        for (const t of terms) {
          if (hayTitle.includes(t)) score += 2;
          if (hayBody.includes(t)) score += 1;
        }
        return { row: r, score };
      })
      .filter((s) => s.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ row: r }) => ({
      id: r.id,
      title: r.title,
      mimeType: r.mime_type,
      tags: safeStringArray(r.tags_json),
      size: r.size,
      updatedAt: r.updated_at,
      snippet: makeSnippet(r.content_text, terms),
    }));
  }

  async findHandler(
    method: string,
    path: string
  ): Promise<LocalHandler | null> {
    this.ensureSchema();
    const m = method.toUpperCase();
    const candidates = this.sql<{
      id: string;
      method: string;
      path: string;
      spec_json: string;
      created_at: string;
      updated_at: string;
    }>`SELECT id, method, path, spec_json, created_at, updated_at
       FROM local_handlers
       WHERE method = ${m} OR method = '*'`;
    let best: LocalHandler | null = null;
    let bestScore = -1;
    for (const r of candidates) {
      const score = matchHandlerPath(r.path, path);
      if (score > bestScore) {
        bestScore = score;
        best = {
          id: r.id,
          method: r.method,
          path: r.path,
          spec: safeJSON(r.spec_json) as unknown as HandlerSpec,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        };
      }
    }
    return best;
  }
}

// ---------- Types & helpers ----------

export type LocalFileMeta = {
  path: string;
  contentType: string;
  size: number;
  createdAt: string;
  updatedAt: string;
};

export type LocalDocumentMeta = {
  id: string;
  title: string;
  mimeType: string;
  tags: string[];
  size: number;
  createdAt: string;
  updatedAt: string;
};

export type DocumentSearchHit = {
  id: string;
  title: string;
  mimeType: string;
  tags: string[];
  size: number;
  updatedAt: string;
  snippet: string;
};

export type LocalHandler = {
  id: string;
  method: string;
  path: string;
  spec: HandlerSpec;
  createdAt: string;
  updatedAt: string;
};

// Declarative handler spec — interpreted, not eval'd. New variants can be
// added without breaking stored handlers.
export type HandlerSpec =
  | { kind: "text"; body: string; contentType?: string; status?: number }
  | { kind: "json"; body: unknown; status?: number }
  | { kind: "file"; path: string; status?: number }
  | { kind: "redirect"; location: string; status?: number }
  | {
      kind: "llm";
      prompt: string;
      contentType?: string;
      status?: number;
    };

function normalizePath(path: string): string {
  let p = path.trim();
  while (p.startsWith("/")) p = p.slice(1);
  if (!p) throw new Error("File path cannot be empty.");
  if (p.includes("..")) throw new Error("File path cannot contain '..'.");
  return p;
}

function normalizeHandlerPath(path: string): string {
  let p = path.trim();
  if (!p.startsWith("/")) p = "/" + p;
  return p.replace(/\/+/g, "/");
}

// Returns a non-negative score on match, -1 otherwise. Exact match wins;
// longer prefix wins among wildcard matches.
function matchHandlerPath(pattern: string, path: string): number {
  if (pattern === path) return 1_000_000;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2);
    if (path === prefix || path.startsWith(prefix + "/")) {
      return prefix.length;
    }
  }
  if (pattern === "/*") return 0;
  return -1;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function guessContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".js") || lower.endsWith(".mjs"))
    return "application/javascript; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".md") || lower.endsWith(".txt"))
    return "text/plain; charset=utf-8";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "text/plain; charset=utf-8";
}

function safeStringArray(text: string): string[] {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function makeSnippet(content: string, terms: string[]): string {
  const lower = content.toLowerCase();
  let firstHit = -1;
  for (const t of terms) {
    const idx = lower.indexOf(t);
    if (idx >= 0 && (firstHit < 0 || idx < firstHit)) firstHit = idx;
  }
  const start = Math.max(0, (firstHit < 0 ? 0 : firstHit) - 80);
  const end = Math.min(content.length, start + 320);
  const slice = content.slice(start, end).replace(/\s+/g, " ");
  return (start > 0 ? "…" : "") + slice + (end < content.length ? "…" : "");
}

function safeJSON(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { raw: text };
  }
}
