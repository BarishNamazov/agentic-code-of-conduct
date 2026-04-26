import { Agent, callable, type StreamingResponse } from "agents";
import type { BehaviorAgent } from "./BehaviorAgent";
import type {
  ActingEnvelope,
  AgentContextPreview,
  AgentDetail,
  AgentGraph,
  AgentSummary,
  BCIR,
  ChatAssistantRecord,
  ChatSessionRecord,
  ChatToolRecord,
  ChatTurnRecord,
  CompileBehaviorInput,
  CompileBehaviorResult,
  CreateAgentInput,
  CreateAgentResult,
  ReviseBehaviorInput,
  RunChunk,
  RunSummary,
  TimelineEvent,
  ToolStatus,
  WorkspaceState,
} from "../../shared/types";
import { normalizeBehavior } from "../behavior/normalize";
import { validateBehavior } from "../behavior/validate";
import {
  executeBehaviorRun,
  type RunHooks,
  type RunSink,
} from "../runtime/run-loop";
import { previewAgenticContext } from "../runtime/concepts/building";
import { executeCommunicating } from "../runtime/concepts/communicating";
import { listAvailableTools } from "../runtime/tools";

const RECENT_EVENT_LIMIT = 50;
const RECENT_RUN_LIMIT = 20;

export class WorkspaceAgent extends Agent<Env, WorkspaceState> {
  initialState: WorkspaceState = {
    agents: [],
    activeRuns: [],
    graph: { nodes: [], edges: [] },
    recentEvents: [],
  };

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      parent_agent_id TEXT,
      current_behavior_version_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS behavior_versions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      raw_format TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      normalized_json TEXT NOT NULL,
      compiler_warnings_json TEXT NOT NULL,
      supersedes_version_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS action_log (
      id TEXT PRIMARY KEY,
      actor_agent_id TEXT NOT NULL,
      behavior_version_id TEXT,
      action_name TEXT NOT NULL,
      args_json TEXT NOT NULL,
      caused_by_action_id TEXT,
      caused_by_reaction_id TEXT,
      run_id TEXT,
      created_at TEXT NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_action_log_actor_created
      ON action_log(actor_agent_id, created_at)`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_action_log_run_created
      ON action_log(run_id, created_at)`;
    this.sql`CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      actor_agent_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      request_action_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT NOT NULL,
      output_json TEXT,
      error_text TEXT,
      started_at TEXT,
      completed_at TEXT
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS spawn_edges (
      id TEXT PRIMARY KEY,
      parent_agent_id TEXT NOT NULL,
      child_agent_id TEXT NOT NULL,
      spawn_action_id TEXT NOT NULL,
      run_id TEXT,
      created_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS run_sessions (
      id TEXT PRIMARY KEY,
      root_agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_text TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS chat_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      turn_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_chat_sessions_agent_updated
      ON chat_sessions(agent_id, updated_at)`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_chat_turns_session_created
      ON chat_turns(session_id, created_at)`;

    await this.refreshWorkspaceState();
  }

  // ---------- Callable methods (UI-facing) ----------

  @callable()
  async listTools() {
    return listAvailableTools();
  }

  @callable()
  async compileBehavior(input: CompileBehaviorInput): Promise<CompileBehaviorResult> {
    const { bcir, warnings } = await normalizeBehavior(this.env, input);
    const validation = validateBehavior(bcir);
    return {
      normalized: bcir,
      validation: {
        ...validation,
        warnings: [...warnings, ...validation.warnings],
      },
    };
  }

  @callable()
  async createAgent(input: CreateAgentInput): Promise<CreateAgentResult> {
    const validation = validateBehavior(input.normalized);
    if (!validation.ok) {
      throw new Error(
        "Cannot create agent with invalid behavior: " +
          validation.errors.map((e) => e.message).join("; ")
      );
    }
    const agentId = `agent_${crypto.randomUUID().slice(0, 8)}`;
    const behaviorVersionId = `bv_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    this.sql`
      INSERT INTO behavior_versions
      (id, agent_id, version_number, raw_format, raw_text, normalized_json,
       compiler_warnings_json, supersedes_version_id, created_by, created_at)
      VALUES
      (${behaviorVersionId}, ${agentId}, 1, ${input.normalized.raw.format},
       ${input.normalized.raw.text}, ${JSON.stringify(input.normalized)},
       ${JSON.stringify(validation.warnings)}, ${null}, ${"user"}, ${now})
    `;

    this.sql`
      INSERT INTO agents (id, name, kind, parent_agent_id,
        current_behavior_version_id, status, created_at, updated_at)
      VALUES (${agentId}, ${input.name}, 'top_level', ${null},
        ${behaviorVersionId}, 'active', ${now}, ${now})
    `;

    const child = await this.ensureBehaviorAgentInstalled(agentId);
    await child.installBehavior({
      agentId,
      agentName: input.name,
      behaviorVersionId,
      normalized: input.normalized,
    });

    await this.logAction({
      by: "workspace",
      action: "Creating.created",
      args: { agent: agentId, behavior: behaviorVersionId, name: input.name },
      runId: null,
      behaviorVersionId,
      causedByActionId: null,
      causedByReactionId: null,
    });

    await this.refreshWorkspaceState();
    return { agentId, behaviorVersionId };
  }

  @callable()
  async reviseBehavior(input: ReviseBehaviorInput): Promise<{ behaviorVersionId: string }> {
    const validation = validateBehavior(input.normalized);
    if (!validation.ok) {
      throw new Error(
        "Cannot revise behavior: " + validation.errors.map((e) => e.message).join("; ")
      );
    }
    const agentRows = this.sql<{
      current_behavior_version_id: string | null;
      name: string;
    }>`SELECT current_behavior_version_id, name FROM agents WHERE id = ${input.agentId}`;
    const agentRow = agentRows[0];
    if (!agentRow) throw new Error(`Unknown agent ${input.agentId}`);
    const supersedes = agentRow.current_behavior_version_id;

    const lastVersion = this.sql<{ n: number }>`
      SELECT COALESCE(MAX(version_number), 0) as n
      FROM behavior_versions WHERE agent_id = ${input.agentId}
    `[0]?.n ?? 0;

    const behaviorVersionId = `bv_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    this.sql`
      INSERT INTO behavior_versions
      (id, agent_id, version_number, raw_format, raw_text, normalized_json,
       compiler_warnings_json, supersedes_version_id, created_by, created_at)
      VALUES
      (${behaviorVersionId}, ${input.agentId}, ${lastVersion + 1},
       ${input.normalized.raw.format}, ${input.normalized.raw.text},
       ${JSON.stringify(input.normalized)},
       ${JSON.stringify(validation.warnings)}, ${supersedes}, ${"user"}, ${now})
    `;
    this.sql`
      UPDATE agents SET current_behavior_version_id = ${behaviorVersionId},
        updated_at = ${now}
      WHERE id = ${input.agentId}
    `;
    const child = await this.ensureBehaviorAgentInstalled(input.agentId);
    await child.installBehavior({
      agentId: input.agentId,
      agentName: agentRow.name,
      behaviorVersionId,
      normalized: input.normalized,
    });

    await this.logAction({
      by: "workspace",
      action: "Revising.superseded",
      args: { agent: input.agentId, old: supersedes, new: behaviorVersionId },
      runId: null,
      behaviorVersionId,
      causedByActionId: null,
      causedByReactionId: null,
    });
    await this.refreshWorkspaceState();
    return { behaviorVersionId };
  }

  @callable()
  async getAgentDetail(agentId: string): Promise<AgentDetail> {
    const agent = this.findAgent(agentId);
    if (!agent) throw new Error(`Unknown agent ${agentId}`);

    const child = await this.ensureBehaviorAgentInstalled(agentId);
    const installed = await child.getBehavior();
    if (!installed) throw new Error(`Agent ${agentId} has no installed behavior`);

    const versions = this.sql<{
      id: string;
      version_number: number;
      created_at: string;
    }>`SELECT id, version_number, created_at
       FROM behavior_versions
       WHERE agent_id = ${agentId}
       ORDER BY version_number DESC`;

    const childRows = this.sql<{ id: string }>`
      SELECT child_agent_id as id FROM spawn_edges WHERE parent_agent_id = ${agentId}
    `;
    const children: AgentSummary[] = childRows
      .map((r) => this.findAgent(r.id))
      .filter((a): a is AgentSummary => !!a);

    const recentRuns = this.listRuns(agentId, RECENT_RUN_LIMIT);

    return {
      agent,
      behavior: installed.normalized,
      versions: versions.map((v) => ({
        id: v.id,
        versionNumber: v.version_number,
        createdAt: v.created_at,
      })),
      children,
      recentRuns,
    };
  }

  @callable()
  async getBehaviorVersion(versionId: string): Promise<BCIR | null> {
    const rows = this.sql<{
      normalized_json: string;
    }>`SELECT normalized_json FROM behavior_versions WHERE id = ${versionId}`;
    const row = rows[0];
    return row ? (JSON.parse(row.normalized_json) as BCIR) : null;
  }

  @callable()
  async previewAgentContext(
    agentId: string,
    userInput: string
  ): Promise<AgentContextPreview> {
    const agent = this.findAgent(agentId);
    if (!agent) throw new Error(`Unknown agent ${agentId}`);
    const child = await this.ensureBehaviorAgentInstalled(agentId);
    const installed = await child.getBehavior();
    if (!installed) throw new Error(`Agent ${agentId} has no installed behavior`);
    const parts = previewAgenticContext(installed.normalized, userInput, userInput, []);
    return { agentId, ...parts };
  }

  @callable()
  async getRunActions(runId: string): Promise<TimelineEvent[]> {
    const rows = this.sql<ActionLogRow>`
      SELECT * FROM action_log WHERE run_id = ${runId} ORDER BY created_at ASC
    `;
    return rows.map(rowToTimeline);
  }

  @callable()
  async getRecentActions(limit = 100): Promise<TimelineEvent[]> {
    const rows = this.sql<ActionLogRow>`
      SELECT * FROM action_log ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map(rowToTimeline);
  }

  @callable()
  async getToolCalls(runId: string) {
    const rows = this.sql<{
      id: string;
      run_id: string;
      actor_agent_id: string;
      tool_name: string;
      request_action_id: string;
      status: string;
      input_json: string;
      output_json: string | null;
      error_text: string | null;
      started_at: string | null;
      completed_at: string | null;
    }>`SELECT * FROM tool_calls WHERE run_id = ${runId} ORDER BY started_at ASC`;
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      actorAgentId: r.actor_agent_id,
      tool: r.tool_name,
      requestActionId: r.request_action_id,
      status: r.status as ToolStatus,
      input: safeJSON(r.input_json),
      output: r.output_json ? safeJSON(r.output_json) : null,
      error: r.error_text,
      startedAt: r.started_at,
      completedAt: r.completed_at,
    }));
  }

  @callable()
  async listChats(agentId: string): Promise<ChatSessionRecord[]> {
    if (!this.findAgent(agentId)) return [];
    const sessions = this.sql<{
      id: string;
      agent_id: string;
      title: string;
      created_at: string;
      updated_at: string;
    }>`SELECT id, agent_id, title, created_at, updated_at
       FROM chat_sessions
       WHERE agent_id = ${agentId}
       ORDER BY updated_at DESC`;

    if (sessions.length === 0) {
      const runBacked = this.listRunBackedChats(agentId);
      for (const session of runBacked) {
        await this.saveChatSession(session);
      }
      return runBacked;
    }

    return sessions.map((s) => {
      const turns = this.sql<{
        turn_json: string;
      }>`SELECT turn_json FROM chat_turns
         WHERE session_id = ${s.id}
         ORDER BY created_at ASC`;
      return {
        id: s.id,
        agentId: s.agent_id,
        title: s.title,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        turns: turns
          .map((t) => safeUnknown(t.turn_json))
          .filter(isChatTurnRecord),
      };
    });
  }

  @callable()
  async saveChatSession(session: ChatSessionRecord): Promise<void> {
    if (!this.findAgent(session.agentId)) {
      throw new Error(`Unknown agent ${session.agentId}`);
    }
    const now = new Date().toISOString();
    this.sql`
      INSERT INTO chat_sessions (id, agent_id, title, created_at, updated_at)
      VALUES (${session.id}, ${session.agentId}, ${session.title},
              ${session.createdAt || now}, ${session.updatedAt || now})
      ON CONFLICT(id) DO UPDATE SET
        agent_id = excluded.agent_id,
        title = excluded.title,
        updated_at = excluded.updated_at
    `;
    this.sql`DELETE FROM chat_turns WHERE session_id = ${session.id}`;
    for (const turn of session.turns) {
      this.sql`
        INSERT INTO chat_turns
          (id, session_id, agent_id, turn_json, created_at, updated_at)
        VALUES (${turn.id}, ${session.id}, ${session.agentId},
                ${JSON.stringify(turn)}, ${turn.user.createdAt || now},
                ${session.updatedAt || now})
      `;
    }
  }

  @callable()
  async deleteChatSession(agentId: string, sessionId: string): Promise<{ ok: boolean }> {
    this.sql`DELETE FROM chat_turns WHERE agent_id = ${agentId} AND session_id = ${sessionId}`;
    this.sql`DELETE FROM chat_sessions WHERE agent_id = ${agentId} AND id = ${sessionId}`;
    return { ok: true };
  }

  @callable()
  async deleteAgent(agentId: string): Promise<void> {
    const agent = this.findAgent(agentId);
    if (!agent) return;
    const agentIds = [
      agentId,
      ...this.sql<{ id: string }>`
        SELECT id FROM agents WHERE parent_agent_id = ${agentId}
      `.map((r) => r.id),
    ];
    for (const id of agentIds) {
      try {
        const child = this.getBehaviorAgent(id);
        await child.resetStorage();
      } catch {
        /* ignore — child storage is best-effort cleanup */
      }
    }
    this.sql`DELETE FROM action_log WHERE actor_agent_id = ${agentId}`;
    this.sql`DELETE FROM tool_calls WHERE actor_agent_id = ${agentId}`;
    this.sql`DELETE FROM spawn_edges WHERE parent_agent_id = ${agentId} OR child_agent_id = ${agentId}`;
    this.sql`DELETE FROM behavior_versions WHERE agent_id = ${agentId}`;
    this.sql`DELETE FROM run_sessions WHERE root_agent_id = ${agentId}`;
    this.sql`DELETE FROM chat_turns WHERE agent_id = ${agentId}`;
    this.sql`DELETE FROM chat_sessions WHERE agent_id = ${agentId}`;
    this.sql`DELETE FROM agents WHERE id = ${agentId} OR parent_agent_id = ${agentId}`;
    await this.refreshWorkspaceState();
  }

  // ---------- Files & handlers (UI façade over BehaviorAgent) ----------

  @callable()
  async listAgentFiles(agentId: string) {
    const child = await this.requireBehaviorAgent(agentId);
    return child.listFiles();
  }

  @callable()
  async readAgentFile(agentId: string, path: string) {
    const child = await this.requireBehaviorAgent(agentId);
    return child.readFile(path);
  }

  @callable()
  async writeAgentFile(input: {
    agentId: string;
    path: string;
    content: string;
    contentType?: string;
  }) {
    const child = await this.requireBehaviorAgent(input.agentId);
    return child.writeFile({
      path: input.path,
      content: input.content,
      contentType: input.contentType,
    });
  }

  @callable()
  async deleteAgentFile(agentId: string, path: string) {
    const child = await this.requireBehaviorAgent(agentId);
    return child.deleteFile(path);
  }

  @callable()
  async listAgentHandlers(agentId: string) {
    const child = await this.requireBehaviorAgent(agentId);
    return child.listHandlers();
  }

  @callable()
  async setAgentHandler(input: {
    agentId: string;
    method: string;
    path: string;
    spec: unknown;
  }) {
    const child = await this.requireBehaviorAgent(input.agentId);
    return child.setHandler({
      method: input.method,
      path: input.path,
      spec: input.spec as never,
    });
  }

  @callable()
  async deleteAgentHandler(agentId: string, id: string) {
    const child = await this.requireBehaviorAgent(agentId);
    return child.deleteHandler(id);
  }

  // ---------- Documents (uploaded knowledge) ----------

  @callable()
  async listAgentDocuments(agentId: string) {
    const child = await this.requireBehaviorAgent(agentId);
    return child.listDocuments();
  }

  @callable()
  async addAgentDocument(input: {
    agentId: string;
    id?: string;
    title: string;
    content: string;
    mimeType?: string;
    tags?: string[];
  }) {
    const child = await this.requireBehaviorAgent(input.agentId);
    return child.addDocument({
      id: input.id,
      title: input.title,
      content: input.content,
      mimeType: input.mimeType,
      tags: input.tags,
    });
  }

  @callable()
  async deleteAgentDocument(agentId: string, id: string) {
    const child = await this.requireBehaviorAgent(agentId);
    return child.deleteDocument(id);
  }

  @callable()
  async getAgentDocument(agentId: string, id: string) {
    const child = await this.requireBehaviorAgent(agentId);
    return child.getDocument(id);
  }

  @callable()
  async searchAgentDocuments(input: {
    agentId: string;
    query: string;
    limit?: number;
  }) {
    const child = await this.requireBehaviorAgent(input.agentId);
    return child.searchDocuments({ query: input.query, limit: input.limit });
  }

  // Internal: serve an HTTP request targeted at a specific agent. Called
  // from the worker fetch handler, not from the UI.
  async serveAgentRequest(input: {
    agentId: string;
    kind: "files" | "web" | "handle";
    path: string;
    method: string;
    body?: string;
    contentType?: string;
  }): Promise<{ status: number; contentType: string; body: string }> {
    const agent = this.findAgent(input.agentId);
    if (!agent) {
      return jsonResp(404, { error: `Unknown agent ${input.agentId}` });
    }
    const child = await this.ensureBehaviorAgentInstalled(input.agentId);

    if (input.kind === "files") {
      if (input.method === "GET") {
        if (!input.path || input.path === "/") {
          return jsonResp(200, await child.listFiles());
        }
        const file = await child.readFile(input.path);
        if (!file) return jsonResp(404, { error: "Not found" });
        return {
          status: 200,
          contentType: file.contentType,
          body: file.content,
        };
      }
      if (input.method === "PUT" || input.method === "POST") {
        const body = input.body ?? "";
        let path = input.path;
        let content = body;
        let contentType = input.contentType;
        if (
          (input.method === "POST" && (!path || path === "/")) ||
          (input.contentType ?? "").includes("application/json")
        ) {
          try {
            const parsed = JSON.parse(body);
            if (parsed && typeof parsed === "object") {
              path = String((parsed as { path?: string }).path ?? path);
              content = String((parsed as { content?: string }).content ?? "");
              contentType =
                (parsed as { contentType?: string }).contentType ?? contentType;
            }
          } catch {
            /* fall back to raw body */
          }
        }
        const meta = await child.writeFile({ path, content, contentType });
        return jsonResp(200, meta);
      }
      if (input.method === "DELETE") {
        await child.deleteFile(input.path);
        return jsonResp(200, { ok: true });
      }
      return jsonResp(405, { error: "Method not allowed" });
    }

    if (input.kind === "web") {
      let path = input.path;
      if (!path || path === "/" || path === "") path = "index.html";
      let file = await child.readFile(path);
      if (!file && !path.includes(".")) {
        // SPA-ish fallback to index.html when present.
        file = await child.readFile("index.html");
      }
      if (!file) {
        return {
          status: 404,
          contentType: "text/plain; charset=utf-8",
          body: `Not found: ${path}`,
        };
      }
      return {
        status: 200,
        contentType: file.contentType,
        body: file.content,
      };
    }

    // kind === "handle"
    const handler = await child.findHandler(
      input.method,
      "/" + input.path.replace(/^\/+/, "")
    );
    if (!handler) {
      return jsonResp(404, {
        error: `No handler for ${input.method} ${input.path}`,
      });
    }
    return this.executeHandlerSpec(handler.spec, {
      child,
      requestBody: input.body ?? "",
      requestPath: "/" + input.path.replace(/^\/+/, ""),
      method: input.method,
    });
  }

  private async executeHandlerSpec(
    spec: unknown,
    ctx: {
      child: { readFile: (p: string) => Promise<{
        path: string;
        content: string;
        contentType: string;
        size: number;
        updatedAt: string;
      } | null> };
      requestBody: string;
      requestPath: string;
      method: string;
    }
  ): Promise<{ status: number; contentType: string; body: string }> {
    if (!spec || typeof spec !== "object") {
      return jsonResp(500, { error: "Handler spec is not an object." });
    }
    const s = spec as { kind?: string };
    switch (s.kind) {
      case "text": {
        const t = spec as { body: string; contentType?: string; status?: number };
        return {
          status: t.status ?? 200,
          contentType: t.contentType ?? "text/plain; charset=utf-8",
          body: String(t.body ?? ""),
        };
      }
      case "json": {
        const j = spec as { body: unknown; status?: number };
        return jsonResp(j.status ?? 200, j.body);
      }
      case "redirect": {
        const r = spec as { location: string; status?: number };
        return {
          status: r.status ?? 302,
          contentType: "text/plain; charset=utf-8",
          body: r.location,
        };
      }
      case "file": {
        const f = spec as { path: string; status?: number };
        const file = await ctx.child.readFile(f.path);
        if (!file) return jsonResp(404, { error: `File not found: ${f.path}` });
        return {
          status: f.status ?? 200,
          contentType: file.contentType,
          body: file.content,
        };
      }
      case "llm": {
        const l = spec as {
          prompt: string;
          contentType?: string;
          status?: number;
        };
        const userPart = ctx.requestBody
          ? `\n\nRequest body:\n${ctx.requestBody}`
          : "";
        const text = await this.runLLMOnce(`${l.prompt}${userPart}`);
        return {
          status: l.status ?? 200,
          contentType: l.contentType ?? "text/plain; charset=utf-8",
          body: text,
        };
      }
      default:
        return jsonResp(500, {
          error: `Unknown handler kind: ${String(s.kind)}`,
        });
    }
  }

  private async runLLMOnce(prompt: string): Promise<string> {
    const { TOOL_REGISTRY } = await import("../runtime/tools");
    const tool = TOOL_REGISTRY["llm.generate"];
    if (!tool) return "";
    const result = await tool.run(this.env, { prompt }, {
      host: { searchMemory: () => [] },
    });
    if (typeof result.output === "string") return result.output;
    if (result.error) return `Error: ${result.error}`;
    return JSON.stringify(result.output ?? "");
  }

  private getBehaviorAgent(agentId: string) {
    const id = this.env.BehaviorAgent.idFromName(agentId);
    return this.env.BehaviorAgent.get(id) as unknown as BehaviorAgent;
  }

  private async ensureBehaviorAgentInstalled(agentId: string) {
    const child = this.getBehaviorAgent(agentId);
    const installed = await child.getBehavior();
    const row = this.sql<{
      name: string;
      behavior_version_id: string;
      normalized_json: string;
    }>`
      SELECT a.name, bv.id AS behavior_version_id, bv.normalized_json
      FROM agents a
      JOIN behavior_versions bv ON bv.id = a.current_behavior_version_id
      WHERE a.id = ${agentId}
      LIMIT 1
    `[0];
    if (!row) throw new Error(`Unknown agent ${agentId}`);
    if (installed?.behaviorVersionId !== row.behavior_version_id) {
      await child.installBehavior({
        agentId,
        agentName: row.name,
        behaviorVersionId: row.behavior_version_id,
        normalized: JSON.parse(row.normalized_json) as BCIR,
      });
    }
    return child;
  }

  private async requireBehaviorAgent(agentId: string) {
    if (!this.findAgent(agentId)) {
      throw new Error(`Unknown agent ${agentId}`);
    }
    return this.ensureBehaviorAgentInstalled(agentId);
  }

  // Streaming run.
  @callable({ streaming: true })
  async runAgent(
    stream: StreamingResponse,
    input: { agentId: string; userInput: string }
  ) {
    const sink: RunSink = {
      send(chunk: RunChunk) {
        try {
          stream.send(chunk);
        } catch {
          /* connection closed */
        }
      },
    };

    const runId = `run_${crypto.randomUUID().slice(0, 8)}`;
    const agent = this.findAgent(input.agentId);
    if (!agent) {
      sink.send({ type: "error", message: `Unknown agent ${input.agentId}` });
      stream.end({ type: "done", runId });
      return;
    }

    const startedAt = new Date().toISOString();
    this.sql`
      INSERT INTO run_sessions (id, root_agent_id, status, input_text, started_at)
      VALUES (${runId}, ${input.agentId}, 'running', ${input.userInput}, ${startedAt})
    `;

    try {
      await this.runBehavior({
        runId,
        agentId: input.agentId,
        userInput: input.userInput,
        sink,
        causedByActionId: null,
      });

      this.sql`
        UPDATE run_sessions SET status = 'completed', completed_at = ${new Date().toISOString()}
        WHERE id = ${runId}
      `;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      sink.send({ type: "error", message });
      this.sql`
        UPDATE run_sessions SET status = 'failed', completed_at = ${new Date().toISOString()}
        WHERE id = ${runId}
      `;
    }

    await this.refreshWorkspaceState();
    stream.end({ type: "done", runId });
  }

  // External SSE chat. Returns a ReadableStream of SSE-encoded bytes that the
  // worker fetch handler can pipe straight back as the response body. Maps
  // RunChunk -> the AgentEvent shape expected by `docs/external_platform.md`.
  async runExternalChat(input: {
    agentId: string;
    userInput: string;
  }): Promise<ReadableStream<Uint8Array>> {
    const encoder = new TextEncoder();
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    const sendEvent = (type: string, data: unknown) => {
      const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      writer.write(encoder.encode(payload)).catch(() => {
        /* downstream closed */
      });
    };

    const runId = `run_${crypto.randomUUID().slice(0, 8)}`;
    const turnId = runId;
    const agent = this.findAgent(input.agentId);

    const toolStartedAt = new Map<string, number>();

    const sink: RunSink = {
      send(chunk: RunChunk) {
        switch (chunk.type) {
          case "token":
            if (chunk.toolCallId) {
              // Streaming tool token (e.g. llm.generate). Surface as
              // input_json_delta so the consumer can render tool progress.
              sendEvent("input_json_delta", {
                toolUseId: chunk.toolCallId,
                partialJson: chunk.text,
              });
            } else {
              sendEvent("text_delta", { delta: chunk.text });
            }
            break;
          case "tool":
            toolStartedAt.set(chunk.toolCallId, Date.now());
            sendEvent("tool_use_start", {
              toolUseId: chunk.toolCallId,
              name: chunk.tool,
            });
            sendEvent("input_json_delta", {
              toolUseId: chunk.toolCallId,
              partialJson: JSON.stringify(chunk.input ?? null),
            });
            break;
          case "tool_result": {
            const startedAt = toolStartedAt.get(chunk.toolCallId);
            const durationMs =
              startedAt != null ? Math.max(0, Date.now() - startedAt) : 0;
            sendEvent("tool_result", {
              toolUseId: chunk.toolCallId,
              status: chunk.status === "completed" ? "ok" : "error",
              result: chunk.output ?? chunk.error ?? null,
              durationMs,
            });
            break;
          }
          case "error":
            sendEvent("error", { message: chunk.message });
            break;
          // event / spawn / graph / done are workspace-internal — skip.
          default:
            break;
        }
      },
    };

    const startedAt = new Date().toISOString();
    if (!agent) {
      sendEvent("turn_start", { turnId });
      sendEvent("error", { message: `Unknown agent ${input.agentId}` });
      sendEvent("turn_end", { turnId });
      sendEvent("done", {});
      writer.close().catch(() => {});
      return readable;
    }

    this.sql`
      INSERT INTO run_sessions (id, root_agent_id, status, input_text, started_at)
      VALUES (${runId}, ${input.agentId}, 'running', ${input.userInput}, ${startedAt})
    `;
    sendEvent("turn_start", { turnId });
    sendEvent("conversation_state", {
      conversationId: runId,
      agentId: input.agentId,
    });

    const work = (async () => {
      try {
        await this.runBehavior({
          runId,
          agentId: input.agentId,
          userInput: input.userInput,
          sink,
          causedByActionId: null,
        });
        this.sql`
          UPDATE run_sessions SET status = 'completed',
            completed_at = ${new Date().toISOString()} WHERE id = ${runId}
        `;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendEvent("error", { message });
        this.sql`
          UPDATE run_sessions SET status = 'failed',
            completed_at = ${new Date().toISOString()} WHERE id = ${runId}
        `;
      } finally {
        sendEvent("turn_end", { turnId });
        sendEvent("done", {});
        await this.refreshWorkspaceState().catch(() => {});
        try {
          await writer.close();
        } catch {
          /* downstream closed */
        }
      }
    })();
    // Keep DO alive until the run finishes even if the caller stops awaiting.
    this.ctx.waitUntil(work);
    return readable;
  }

  // External listing — mirrors `AgentSummary` from the integration doc.
  async describeAgentsForExternal(query?: string): Promise<ExternalAgentSummary[]> {
    const like = query ? `%${query.replace(/[%_]/g, "")}%` : null;
    const rows = like
      ? this.sql<AgentDescribeRow>`
          SELECT a.id, a.name, a.kind, a.status, a.updated_at,
            json_extract(bv.normalized_json, '$.agent.purpose') AS purpose,
            bv.raw_text
          FROM agents a
          LEFT JOIN behavior_versions bv ON bv.id = a.current_behavior_version_id
          WHERE a.kind = 'top_level'
            AND (a.name LIKE ${like}
                 OR COALESCE(json_extract(bv.normalized_json, '$.agent.purpose'), '') LIKE ${like}
                 OR COALESCE(bv.raw_text, '') LIKE ${like})
          ORDER BY a.updated_at DESC
        `
      : this.sql<AgentDescribeRow>`
          SELECT a.id, a.name, a.kind, a.status, a.updated_at,
            json_extract(bv.normalized_json, '$.agent.purpose') AS purpose,
            bv.raw_text
          FROM agents a
          LEFT JOIN behavior_versions bv ON bv.id = a.current_behavior_version_id
          WHERE a.kind = 'top_level'
          ORDER BY a.updated_at DESC
        `;
    return rows.map((r) => toExternalAgentSummary(r));
  }

  async describeAgentForExternal(
    agentId: string
  ): Promise<ExternalAgentDetail | null> {
    const rows = this.sql<AgentDescribeRow>`
      SELECT a.id, a.name, a.kind, a.status, a.updated_at,
        json_extract(bv.normalized_json, '$.agent.purpose') AS purpose,
        bv.raw_text
      FROM agents a
      LEFT JOIN behavior_versions bv ON bv.id = a.current_behavior_version_id
      WHERE a.id = ${agentId}
      LIMIT 1
    `;
    const r = rows[0];
    if (!r) return null;
    const summary = toExternalAgentSummary(r);
    return {
      ...summary,
      purpose: r.purpose ?? null,
      behaviorSummary: (r.raw_text ?? "").slice(0, 1200),
    };
  }

  // ---------- Internal orchestration ----------

  private async runBehavior(opts: {
    runId: string;
    agentId: string;
    userInput: string;
    sink: RunSink;
    causedByActionId: string | null;
  }): Promise<void> {
    const child = await this.ensureBehaviorAgentInstalled(opts.agentId);
    await child.setRunning(true);
    try {
      const installed = await child.getBehavior();
      if (!installed) {
        throw new Error(`Agent ${opts.agentId} has no installed behavior.`);
      }
      const hooks = this.makeRunHooks();
      await executeBehaviorRun(
        {
          runId: opts.runId,
          agentId: opts.agentId,
          bcir: installed.normalized,
          behaviorVersionId: installed.behaviorVersionId,
          userInput: opts.userInput,
        },
        hooks,
        opts.sink,
        this.env
      );
    } finally {
      await child.setRunning(false);
    }
  }

  private makeRunHooks(): RunHooks {
    const ws = this;
    return {
      logAction: async (envelope) => ws.logAction(envelope),
      mirrorActionToChild: async (childAgentId, envelope) => {
        if (childAgentId === "workspace") return;
        if (!ws.findAgent(childAgentId)) return;
        try {
          const child = await ws.ensureBehaviorAgentInstalled(childAgentId);
          await child.recordAction(envelope);
        } catch {
          /* best-effort */
        }
      },
      toolHost: {
        searchMemory: (q: string) => {
          const like = `%${q.replace(/[%_]/g, "")}%`;
          return ws.sql<{
            id: string;
            actor_agent_id: string;
            action_name: string;
            args_json: string;
            created_at: string;
          }>`SELECT id, actor_agent_id, action_name, args_json, created_at
             FROM action_log
             WHERE args_json LIKE ${like}
             ORDER BY created_at DESC
             LIMIT 25`;
        },
        writeAgentFile: async ({ actorAgentId, path, content, contentType }) => {
          const child = await ws.requireBehaviorAgent(actorAgentId);
          return child.writeFile({ path, content, contentType });
        },
        readAgentFile: async ({ actorAgentId, path }) => {
          const child = await ws.requireBehaviorAgent(actorAgentId);
          return child.readFile(path);
        },
        listAgentFiles: async ({ actorAgentId }) => {
          const child = await ws.requireBehaviorAgent(actorAgentId);
          return child.listFiles();
        },
        deleteAgentFile: async ({ actorAgentId, path }) => {
          const child = await ws.requireBehaviorAgent(actorAgentId);
          return child.deleteFile(path);
        },
        setAgentHandler: async ({ actorAgentId, method, path, spec }) => {
          const child = await ws.requireBehaviorAgent(actorAgentId);
          return child.setHandler({
            method,
            path,
            spec: spec as never,
          });
        },
        listAgentHandlers: async ({ actorAgentId }) => {
          const child = await ws.requireBehaviorAgent(actorAgentId);
          return child.listHandlers();
        },
        searchAgentDocuments: async ({ actorAgentId, query, limit }) => {
          const child = await ws.requireBehaviorAgent(actorAgentId);
          return child.searchDocuments({ query, limit });
        },
        listAgentDocuments: async ({ actorAgentId }) => {
          const child = await ws.requireBehaviorAgent(actorAgentId);
          return child.listDocuments();
        },
        readAgentDocument: async ({ actorAgentId, id }) => {
          const child = await ws.requireBehaviorAgent(actorAgentId);
          return child.getDocument(id);
        },
        listAgents: async () => {
          return ws
            .sql<{
              id: string;
              name: string;
              kind: string;
              purpose: string | null;
              parent_agent_id: string | null;
            }>`
              SELECT a.id, a.name, a.kind, a.parent_agent_id,
                (SELECT json_extract(bv.normalized_json, '$.agent.purpose')
                 FROM behavior_versions bv
                 WHERE bv.id = a.current_behavior_version_id) AS purpose
              FROM agents a
              ORDER BY a.created_at DESC
            `
            .map((r) => ({
              id: r.id,
              name: r.name,
              kind: r.kind,
              purpose: r.purpose ?? null,
              parentAgentId: r.parent_agent_id ?? null,
            }));
        },
        searchAgents: async (query: string) => {
          const like = `%${query.replace(/[%_]/g, "")}%`;
          const rows = ws.sql<{
            id: string;
            name: string;
            kind: string;
            purpose: string | null;
            raw_text: string | null;
          }>`
            SELECT a.id, a.name, a.kind,
              json_extract(bv.normalized_json, '$.agent.purpose') AS purpose,
              bv.raw_text
            FROM agents a
            LEFT JOIN behavior_versions bv ON bv.id = a.current_behavior_version_id
            WHERE a.name LIKE ${like}
               OR COALESCE(bv.raw_text, '') LIKE ${like}
            ORDER BY a.created_at DESC
            LIMIT 25
          `;
          return rows.map((r) => ({
            id: r.id,
            name: r.name,
            kind: r.kind,
            purpose: r.purpose ?? null,
            behaviorSummary: (r.raw_text ?? "").slice(0, 400),
          }));
        },
        getAgentBehavior: async (agentId: string) => {
          const rows = ws.sql<{
            name: string;
            purpose: string | null;
            raw_text: string;
          }>`
            SELECT a.name,
              json_extract(bv.normalized_json, '$.agent.purpose') AS purpose,
              bv.raw_text
            FROM agents a
            JOIN behavior_versions bv ON bv.id = a.current_behavior_version_id
            WHERE a.id = ${agentId}
            LIMIT 1
          `;
          const r = rows[0];
          return r
            ? { name: r.name, purpose: r.purpose ?? null, rawText: r.raw_text }
            : null;
        },
        spawnAgent: async ({
          actorAgentId,
          name,
          purpose,
          behaviorText,
          fromAgentId,
          runId,
          causedByActionId,
          userInput,
        }) => {
          // If fromAgentId is given, clone that agent's behavior text.
          let raw = behaviorText ?? "";
          if (!raw && fromAgentId) {
            const rows = ws.sql<{ raw_text: string }>`
              SELECT bv.raw_text FROM agents a
              JOIN behavior_versions bv ON bv.id = a.current_behavior_version_id
              WHERE a.id = ${fromAgentId} LIMIT 1
            `;
            if (rows[0]) raw = rows[0].raw_text;
          }
          if (!raw) {
            raw = `Agent: ${name}\nPurpose: ${purpose ?? "act on the user's request."}`;
          }
          const { bcir } = await normalizeBehavior(ws.env, { rawText: raw });
          const behavior: BCIR = {
            ...bcir,
            agent: { ...bcir.agent, name, purpose: purpose ?? bcir.agent?.purpose },
          };
          const childAgentId = `agent_${crypto.randomUUID().slice(0, 8)}`;
          const childBehaviorVersionId = `bv_${crypto.randomUUID().slice(0, 8)}`;
          const now = new Date().toISOString();
          ws.sql`
            INSERT INTO behavior_versions
            (id, agent_id, version_number, raw_format, raw_text, normalized_json,
             compiler_warnings_json, supersedes_version_id, created_by, created_at)
            VALUES (${childBehaviorVersionId}, ${childAgentId}, 1, ${behavior.raw.format},
                    ${behavior.raw.text}, ${JSON.stringify(behavior)}, '[]', ${null},
                    ${actorAgentId}, ${now})
          `;
          ws.sql`
            INSERT INTO agents (id, name, kind, parent_agent_id,
              current_behavior_version_id, status, created_at, updated_at)
            VALUES (${childAgentId}, ${name}, 'spawned', ${actorAgentId},
              ${childBehaviorVersionId}, 'active', ${now}, ${now})
          `;
          ws.sql`
            INSERT INTO spawn_edges (id, parent_agent_id, child_agent_id, spawn_action_id, run_id, created_at)
            VALUES (${`se_${crypto.randomUUID().slice(0, 8)}`}, ${actorAgentId}, ${childAgentId},
                    ${causedByActionId}, ${runId}, ${now})
          `;
          const childAgent = await ws.getBehaviorAgent(childAgentId);
          await childAgent.installBehavior({
            agentId: childAgentId,
            agentName: name,
            behaviorVersionId: childBehaviorVersionId,
            normalized: behavior,
          });
          // Run the child to completion, capturing its output.
          let captured = "";
          const captureSink: RunSink = {
            send(chunk) {
              if (chunk.type === "token" && typeof chunk.text === "string") {
                captured += chunk.text;
              }
            },
          };
          const taskInput = (() => {
            if (purpose && userInput) return `${purpose}\n\n--- Input ---\n${userInput}`;
            return userInput || purpose || `Help with ${runId}`;
          })();
          await ws.runBehavior({
            runId,
            agentId: childAgentId,
            userInput: taskInput,
            sink: captureSink,
            causedByActionId,
          });
          return { childAgentId, output: captured };
        },
        updateAgentBehavior: async ({ actorAgentId, behaviorText }) => {
          const { bcir } = await normalizeBehavior(ws.env, { rawText: behaviorText });
          return ws.reviseBehavior({ agentId: actorAgentId, normalized: bcir });
        },
        communicateAgent: async ({
          actorAgentId,
          recipient,
          message,
          topic,
          runId,
          causedByActionId,
          sink,
        }) => {
          const actor = await ws.ensureBehaviorAgentInstalled(actorAgentId);
          const installed = await actor.getBehavior();
          if (!installed) {
            throw new Error(`Actor agent ${actorAgentId} has no installed behavior.`);
          }
          // Forward live timeline events but suppress the final user-facing
          // summary token — the agentic loop will decide what to say once the
          // tool result returns.
          const fallbackSink: RunSink = { send: () => {} };
          const upstream = (sink ?? fallbackSink) as RunSink;
          const forward: RunSink = {
            send(chunk) {
              if (chunk.type === "token") return;
              upstream.send(chunk);
            },
          };
          const outcome = await executeCommunicating(
            { recipient, message, topic },
            causedByActionId,
            null,
            {
              agentId: actorAgentId,
              bcir: installed.normalized,
              behaviorVersionId: installed.behaviorVersionId,
              runId,
            },
            ws.makeRunHooks(),
            forward,
            ws.env,
            { input: "", runId },
            { streamSummaryToSink: false }
          );
          return {
            conversationId: outcome.conversationId,
            satisfied: outcome.satisfied,
            reason: outcome.reason,
            summary: outcome.summary,
            turnCount: outcome.turnCount,
          };
        },
      },
      insertToolCall: ({ id, runId, actorAgentId, toolName, requestActionId, inputJson }) => {
        ws.sql`
          INSERT INTO tool_calls
          (id, run_id, actor_agent_id, tool_name, request_action_id, status, input_json)
          VALUES (${id}, ${runId}, ${actorAgentId}, ${toolName}, ${requestActionId}, 'requested', ${inputJson})
        `;
      },
      updateToolCall: ({ id, status, outputJson, errorText, startedAt, completedAt }) => {
        ws.sql`
          UPDATE tool_calls SET
            status = ${status},
            output_json = COALESCE(${outputJson ?? null}, output_json),
            error_text = COALESCE(${errorText ?? null}, error_text),
            started_at = COALESCE(${startedAt ?? null}, started_at),
            completed_at = COALESCE(${completedAt ?? null}, completed_at)
          WHERE id = ${id}
        `;
      },
      spawnChild: async ({ parentAgentId, name, behavior, runId, causedByActionId }) => {
        const childAgentId = `agent_${crypto.randomUUID().slice(0, 8)}`;
        const childBehaviorVersionId = `bv_${crypto.randomUUID().slice(0, 8)}`;
        const now = new Date().toISOString();
        ws.sql`
          INSERT INTO behavior_versions
          (id, agent_id, version_number, raw_format, raw_text, normalized_json,
           compiler_warnings_json, supersedes_version_id, created_by, created_at)
          VALUES (${childBehaviorVersionId}, ${childAgentId}, 1, ${behavior.raw.format},
                  ${behavior.raw.text}, ${JSON.stringify(behavior)}, '[]', ${null},
                  ${parentAgentId}, ${now})
        `;
        ws.sql`
          INSERT INTO agents (id, name, kind, parent_agent_id,
            current_behavior_version_id, status, created_at, updated_at)
          VALUES (${childAgentId}, ${name}, 'spawned', ${parentAgentId},
            ${childBehaviorVersionId}, 'active', ${now}, ${now})
        `;
        ws.sql`
          INSERT INTO spawn_edges (id, parent_agent_id, child_agent_id, spawn_action_id, run_id, created_at)
          VALUES (${`se_${crypto.randomUUID().slice(0, 8)}`}, ${parentAgentId}, ${childAgentId},
                  ${causedByActionId}, ${runId}, ${now})
        `;
        const child = await ws.getBehaviorAgent(childAgentId);
        await child.installBehavior({
          agentId: childAgentId,
          agentName: name,
          behaviorVersionId: childBehaviorVersionId,
          normalized: behavior,
        });
        return { childAgentId };
      },
      runChild: async ({ childAgentId, userInput, runId, sink, causedByActionId }) => {
        await ws.runBehavior({
          runId,
          agentId: childAgentId,
          userInput,
          sink,
          causedByActionId: causedByActionId ?? null,
        });
      },
      normalizeChildBehavior: async ({ name, rawText }) => {
        const { bcir } = await normalizeBehavior(ws.env, { rawText });
        // Force the agent name to the spawn-requested name so the BCIR
        // matches the row stored in the agents table.
        return { ...bcir, agent: { ...bcir.agent, name } };
      },
      refreshGraph: async () => {
        const graph = ws.buildGraph();
        return graph;
      },
    };
  }

  private async logAction(
    env: Omit<ActingEnvelope, "id" | "createdAt">
  ): Promise<string> {
    const id = `act_${crypto.randomUUID().slice(0, 8)}`;
    const createdAt = new Date().toISOString();
    this.sql`
      INSERT INTO action_log
      (id, actor_agent_id, behavior_version_id, action_name, args_json,
       caused_by_action_id, caused_by_reaction_id, run_id, created_at)
      VALUES
      (${id}, ${env.by}, ${env.behaviorVersionId ?? null}, ${env.action},
       ${JSON.stringify(env.args)}, ${env.causedByActionId ?? null},
       ${env.causedByReactionId ?? null}, ${env.runId ?? null}, ${createdAt})
    `;
    this.broadcast(
      JSON.stringify({
        type: "action",
        action: { id, createdAt, ...env },
      })
    );
    return id;
  }

  // ---------- State projection ----------

  private async refreshWorkspaceState(): Promise<void> {
    const agents = this.listAgents();
    const activeRuns = this.sql<{
      id: string;
      root_agent_id: string;
      status: string;
      input_text: string | null;
      started_at: string;
      completed_at: string | null;
    }>`SELECT id, root_agent_id, status, input_text, started_at, completed_at
       FROM run_sessions
       ORDER BY started_at DESC
       LIMIT ${RECENT_RUN_LIMIT}`.map(
      (r): RunSummary => ({
        id: r.id,
        rootAgentId: r.root_agent_id,
        status: r.status as RunSummary["status"],
        inputText: r.input_text,
        startedAt: r.started_at,
        completedAt: r.completed_at,
      })
    );
    const recentEvents = this.sql<ActionLogRow>`
      SELECT * FROM action_log ORDER BY created_at DESC LIMIT ${RECENT_EVENT_LIMIT}
    `.map(rowToTimeline);
    const graph = this.buildGraph();
    this.setState({ agents, activeRuns, graph, recentEvents });
  }

  private listAgents(): AgentSummary[] {
    const rows = this.sql<{
      id: string;
      name: string;
      kind: string;
      parent_agent_id: string | null;
      current_behavior_version_id: string | null;
      status: string;
      created_at: string;
      updated_at: string;
    }>`SELECT * FROM agents ORDER BY created_at ASC`;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind as AgentSummary["kind"],
      parentAgentId: r.parent_agent_id,
      currentBehaviorVersionId: r.current_behavior_version_id,
      status: r.status as AgentSummary["status"],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  private listRuns(agentId: string, limit: number): RunSummary[] {
    const rows = this.sql<{
      id: string;
      root_agent_id: string;
      status: string;
      input_text: string | null;
      started_at: string;
      completed_at: string | null;
    }>`SELECT * FROM run_sessions WHERE root_agent_id = ${agentId}
       ORDER BY started_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({
      id: r.id,
      rootAgentId: r.root_agent_id,
      status: r.status as RunSummary["status"],
      inputText: r.input_text,
      startedAt: r.started_at,
      completedAt: r.completed_at,
    }));
  }

  private listRunBackedChats(agentId: string): ChatSessionRecord[] {
    const runs = this.sql<{
      id: string;
      root_agent_id: string;
      status: string;
      input_text: string | null;
      started_at: string;
      completed_at: string | null;
    }>`SELECT * FROM run_sessions WHERE root_agent_id = ${agentId}
       ORDER BY started_at ASC LIMIT 100`;
    if (runs.length === 0) return [];

    const turns = runs.map((r): ChatTurnRecord => {
      const events = this.sql<ActionLogRow>`
        SELECT * FROM action_log WHERE run_id = ${r.id} ORDER BY created_at ASC
      `.map(rowToTimeline);
      const tools = this.sql<{
        id: string;
        actor_agent_id: string;
        tool_name: string;
        status: string;
        input_json: string;
        output_json: string | null;
        error_text: string | null;
        started_at: string | null;
        completed_at: string | null;
      }>`SELECT id, actor_agent_id, tool_name, status, input_json, output_json,
                error_text, started_at, completed_at
         FROM tool_calls WHERE run_id = ${r.id}
         ORDER BY COALESCE(started_at, completed_at) ASC`;
      const spawned = this.sql<{
        child_agent_id: string;
        child_name: string | null;
        parent_agent_id: string;
      }>`SELECT se.child_agent_id, a.name AS child_name, se.parent_agent_id
         FROM spawn_edges se
         LEFT JOIN agents a ON a.id = se.child_agent_id
         WHERE se.run_id = ${r.id}
         ORDER BY se.created_at ASC`.map((s) => ({
        childAgentId: s.child_agent_id,
        childName: s.child_name ?? s.child_agent_id,
        parentAgentId: s.parent_agent_id,
      }));
      const chatTools: ChatToolRecord[] = tools.map((t) => {
        const output = t.output_json ? safeUnknown(t.output_json) : undefined;
        return {
          id: t.id,
          tool: t.tool_name,
          input: safeUnknown(t.input_json),
          output,
          error: t.error_text ?? undefined,
          status: t.status as ChatToolRecord["status"],
          actorAgentId: t.actor_agent_id,
          tokens: typeof output === "string" ? output : "",
          startedAt: t.started_at ?? t.completed_at ?? r.started_at,
        };
      });
      const assistant = buildAssistantFromRun(
        r.id,
        r.status,
        agentId,
        events,
        chatTools,
        spawned
      );
      return {
        id: `turn_${r.id}`,
        user: {
          text: extractCurrentMessage(r.input_text ?? ""),
          createdAt: r.started_at,
        },
        assistant,
      };
    });

    return [
      {
        id: `runs_${agentId}`,
        agentId,
        title: "Run history",
        createdAt: turns[0]?.user.createdAt ?? new Date().toISOString(),
        updatedAt:
          runs[runs.length - 1]?.completed_at ??
          runs[runs.length - 1]?.started_at ??
          new Date().toISOString(),
        turns,
      },
    ];
  }

  private findAgent(agentId: string): AgentSummary | null {
    const rows = this.sql<{
      id: string;
      name: string;
      kind: string;
      parent_agent_id: string | null;
      current_behavior_version_id: string | null;
      status: string;
      created_at: string;
      updated_at: string;
    }>`SELECT * FROM agents WHERE id = ${agentId}`;
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      kind: r.kind as AgentSummary["kind"],
      parentAgentId: r.parent_agent_id,
      currentBehaviorVersionId: r.current_behavior_version_id,
      status: r.status as AgentSummary["status"],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private buildGraph(): AgentGraph {
    const agents = this.listAgents();
    const nodes: AgentGraph["nodes"] = agents.map((a) => ({
      id: a.id,
      type: "agent",
      label: a.name,
      status: a.status,
    }));

    const edges: AgentGraph["edges"] = [];
    const spawnEdges = this.sql<{
      id: string;
      parent_agent_id: string;
      child_agent_id: string;
      spawn_action_id: string;
    }>`SELECT id, parent_agent_id, child_agent_id, spawn_action_id FROM spawn_edges`;
    for (const e of spawnEdges) {
      edges.push({
        id: `e_${e.id}`,
        source: e.parent_agent_id,
        target: e.child_agent_id,
        type: "spawned",
        actionId: e.spawn_action_id,
      });
    }

    // Add tool calls as transient nodes/edges so the graph reads as a true topology.
    const toolCalls = this.sql<{
      id: string;
      actor_agent_id: string;
      tool_name: string;
      status: string;
    }>`SELECT id, actor_agent_id, tool_name, status FROM tool_calls
       ORDER BY started_at DESC LIMIT 50`;
    const seenTools = new Set<string>();
    for (const tc of toolCalls) {
      const toolNodeId = `tool:${tc.tool_name}`;
      if (!seenTools.has(toolNodeId)) {
        nodes.push({
          id: toolNodeId,
          type: "tool",
          label: tc.tool_name,
        });
        seenTools.add(toolNodeId);
      }
      edges.push({
        id: `e_${tc.id}`,
        source: tc.actor_agent_id,
        target: toolNodeId,
        type: "called",
        actionId: tc.id,
      });
    }
    return { nodes, edges };
  }
}

type ActionLogRow = {
  id: string;
  actor_agent_id: string;
  behavior_version_id: string | null;
  action_name: string;
  args_json: string;
  caused_by_action_id: string | null;
  caused_by_reaction_id: string | null;
  run_id: string | null;
  created_at: string;
};

type AgentDescribeRow = {
  id: string;
  name: string;
  kind: string;
  status: string;
  updated_at: string;
  purpose: string | null;
  raw_text: string | null;
};

export type ExternalAgentSummary = {
  id: string;
  displayName: string;
  description?: string;
  status: "available" | "busy" | "offline";
  updatedAt: string;
};

export type ExternalAgentDetail = ExternalAgentSummary & {
  purpose: string | null;
  behaviorSummary: string;
};

function toExternalAgentSummary(r: AgentDescribeRow): ExternalAgentSummary {
  const status: ExternalAgentSummary["status"] =
    r.status === "active"
      ? "available"
      : r.status === "paused"
        ? "offline"
        : r.status === "archived"
          ? "offline"
          : "available";
  const description = r.purpose?.trim() || r.raw_text?.slice(0, 240) || undefined;
  return {
    id: r.id,
    displayName: r.name,
    description,
    status,
    updatedAt: r.updated_at,
  };
}

function rowToTimeline(r: ActionLogRow): TimelineEvent {
  return {
    id: r.id,
    actorAgentId: r.actor_agent_id,
    action: r.action_name,
    args: safeJSON(r.args_json),
    runId: r.run_id,
    behaviorVersionId: r.behavior_version_id,
    causedByActionId: r.caused_by_action_id,
    causedByReactionId: r.caused_by_reaction_id,
    createdAt: r.created_at,
  };
}

function safeJSON(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text);
    return typeof v === "object" && v !== null
      ? (v as Record<string, unknown>)
      : { value: v };
  } catch {
    return { raw: text };
  }
}

function safeUnknown(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isChatTurnRecord(value: unknown): value is ChatTurnRecord {
  if (!value || typeof value !== "object") return false;
  const turn = value as { id?: unknown; user?: unknown; assistant?: unknown };
  return (
    typeof turn.id === "string" &&
    typeof turn.user === "object" &&
    turn.user !== null &&
    typeof turn.assistant === "object" &&
    turn.assistant !== null
  );
}

function extractCurrentMessage(inputText: string): string {
  const marker = "\n[Current message]\n";
  const idx = inputText.lastIndexOf(marker);
  if (idx >= 0) return inputText.slice(idx + marker.length).trim();
  return inputText.trim();
}

function buildAssistantFromRun(
  runId: string,
  runStatus: string,
  rootAgentId: string,
  events: TimelineEvent[],
  tools: ChatToolRecord[],
  spawned: ChatAssistantRecord["spawned"]
): ChatAssistantRecord {
  // Prefer the cleaned Communicating.sent event text (concept_call tags
  // stripped) over the raw llm.generate output (which contains the full
  // planner JSON envelope and any concept_call tags).
  const rootText =
    communicatingSentText(events, rootAgentId) ??
    firstStringOutput(
      tools.filter(
        (t) => t.actorAgentId === rootAgentId && t.tool === "llm.generate"
      )
    ) ??
    "";
  const subThreadMap = new Map<string, ChatAssistantRecord["subThreads"][number]>();
  for (const tool of tools) {
    if (tool.actorAgentId === rootAgentId || tool.tool !== "llm.generate") continue;
    const text = typeof tool.output === "string" ? tool.output : tool.tokens;
    if (!text) continue;
    const existing = subThreadMap.get(tool.actorAgentId);
    const spawnedName =
      spawned.find((s) => s.childAgentId === tool.actorAgentId)?.childName ??
      tool.actorAgentId;
    subThreadMap.set(tool.actorAgentId, {
      agentId: tool.actorAgentId,
      agentName: existing?.agentName ?? spawnedName,
      text: (existing?.text ?? "") + text,
    });
  }

  return {
    runId,
    status:
      runStatus === "running"
        ? "running"
        : runStatus === "failed"
          ? "failed"
          : "completed",
    text: rootText,
    subThreads: Array.from(subThreadMap.values()),
    events,
    tools,
    spawned,
    errors: tools.flatMap((t) => (t.error ? [t.error] : [])),
    toolActor: tools.map((t) => [t.id, t.actorAgentId]),
  };
}

function firstStringOutput(tools: ChatToolRecord[]): string | null {
  for (const tool of tools) {
    if (typeof tool.output === "string" && tool.output.trim()) return tool.output;
    if (tool.tokens.trim()) return tool.tokens;
  }
  return null;
}

function communicatingSentText(
  events: TimelineEvent[],
  rootAgentId: string
): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (
      event.actorAgentId === rootAgentId &&
      event.action === "Communicating.sent" &&
      typeof event.args.object === "string"
    ) {
      return event.args.object;
    }
  }
  return null;
}

function jsonResp(
  status: number,
  body: unknown
): { status: number; contentType: string; body: string } {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body),
  };
}

