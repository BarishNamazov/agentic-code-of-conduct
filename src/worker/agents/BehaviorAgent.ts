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

  async onStart() {
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
  }

  // Install (or replace) the behavior this agent runs.
  async installBehavior(input: {
    agentId: string;
    agentName: string;
    behaviorVersionId: string;
    normalized: BCIR;
  }) {
    this.sql`
      INSERT INTO local_behavior (id, behavior_version_id, normalized_json, installed_at)
      VALUES (${crypto.randomUUID()}, ${input.behaviorVersionId},
              ${JSON.stringify(input.normalized)}, ${new Date().toISOString()})
    `;
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
    this.setState({ ...this.state, status: running ? "running" : "ready" });
  }
}

function safeJSON(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { raw: text };
  }
}
