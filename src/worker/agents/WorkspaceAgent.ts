import { Agent, callable, type StreamingResponse } from "agents";
import { BehaviorAgent } from "./BehaviorAgent";
import type {
  ActingEnvelope,
  AgentDetail,
  AgentGraph,
  AgentSummary,
  BCIR,
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

    const child = await this.subAgent(BehaviorAgent, agentId);
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
    const child = await this.subAgent(BehaviorAgent, input.agentId);
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

    const child = await this.subAgent(BehaviorAgent, agentId);
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
  async deleteAgent(agentId: string): Promise<void> {
    const agent = this.findAgent(agentId);
    if (!agent) return;
    // Wipe child storage (transitively wipes its descendants).
    try {
      this.deleteSubAgent(BehaviorAgent, agentId);
    } catch {
      /* ignore — sub-agent might not exist yet */
    }
    this.sql`DELETE FROM action_log WHERE actor_agent_id = ${agentId}`;
    this.sql`DELETE FROM tool_calls WHERE actor_agent_id = ${agentId}`;
    this.sql`DELETE FROM spawn_edges WHERE parent_agent_id = ${agentId} OR child_agent_id = ${agentId}`;
    this.sql`DELETE FROM behavior_versions WHERE agent_id = ${agentId}`;
    this.sql`DELETE FROM run_sessions WHERE root_agent_id = ${agentId}`;
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
    const child = await this.subAgent(BehaviorAgent, input.agentId);

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

  private async requireBehaviorAgent(agentId: string) {
    if (!this.findAgent(agentId)) {
      throw new Error(`Unknown agent ${agentId}`);
    }
    return this.subAgent(BehaviorAgent, agentId);
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

  // ---------- Internal orchestration ----------

  private async runBehavior(opts: {
    runId: string;
    agentId: string;
    userInput: string;
    sink: RunSink;
    causedByActionId: string | null;
  }): Promise<void> {
    const child = await this.subAgent(BehaviorAgent, opts.agentId);
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
          const child = await ws.subAgent(BehaviorAgent, childAgentId);
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
          const childAgent = await ws.subAgent(BehaviorAgent, childAgentId);
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
        const child = await ws.subAgent(BehaviorAgent, childAgentId);
        await child.installBehavior({
          agentId: childAgentId,
          agentName: name,
          behaviorVersionId: childBehaviorVersionId,
          normalized: behavior,
        });
        return { childAgentId };
      },
      runChild: async ({ childAgentId, userInput, runId, sink }) => {
        await ws.runBehavior({
          runId,
          agentId: childAgentId,
          userInput,
          sink,
          causedByActionId: null,
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
