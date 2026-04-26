// Run loop. Lives in the WorkspaceAgent and orchestrates a BehaviorAgent's
// reactions for a single run. The workspace owns the canonical action log,
// graph projection and tool execution; the BehaviorAgent owns the durable
// behavior copy and a mirror of every action it produced (for provenance).

import type {
  ActingEnvelope,
  AgentGraph,
  BCIR,
  ReactionIR,
  RunChunk,
  ThenActionIR,
  ToolStatus,
} from "../../shared/types";
import { selectEntryReactions } from "../behavior/validate";
import { TOOL_REGISTRY, type ToolHostQueries } from "./tools";

export type RunSink = {
  send(chunk: RunChunk): void;
};

// Hooks the workspace gives to the run loop. Decoupled so the loop is testable.
export type RunHooks = {
  // Persist an action and broadcast it. Returns the inserted action id.
  logAction: (env: Omit<ActingEnvelope, "id" | "createdAt">) => Promise<string>;
  // Mirror action to the child's local_actions table via RPC.
  mirrorActionToChild: (
    childAgentId: string,
    envelope: ActingEnvelope
  ) => Promise<void>;
  // Workspace-scoped lookups for tools that need them (e.g. memory.search).
  toolHost: ToolHostQueries;
  // Insert a tool_calls row.
  insertToolCall: (input: {
    id: string;
    runId: string;
    actorAgentId: string;
    toolName: string;
    requestActionId: string;
    inputJson: string;
  }) => void;
  // Update tool call status / output.
  updateToolCall: (input: {
    id: string;
    status: ToolStatus;
    outputJson?: string | null;
    errorText?: string | null;
    completedAt?: string | null;
    startedAt?: string | null;
  }) => void;
  // Spawn a child behavior agent and install behavior. Returns child agent id.
  spawnChild: (input: {
    parentAgentId: string;
    name: string;
    behavior: BCIR;
    runId: string;
    causedByActionId: string;
  }) => Promise<{ childAgentId: string }>;
  // Run a child behavior agent (recursively) to completion. Streams chunks back.
  runChild: (input: {
    childAgentId: string;
    userInput: string;
    runId: string;
    sink: RunSink;
  }) => Promise<void>;
  // Update the workspace state projection + broadcast a graph chunk.
  refreshGraph: () => Promise<AgentGraph>;
};

export type RunInput = {
  runId: string;
  agentId: string;
  bcir: BCIR;
  behaviorVersionId: string;
  userInput: string;
};

export async function executeBehaviorRun(
  input: RunInput,
  hooks: RunHooks,
  sink: RunSink,
  envForTools: { AI?: { run: (m: string, i: unknown, o?: unknown) => Promise<unknown> } }
): Promise<void> {
  const { runId, agentId, bcir, behaviorVersionId, userInput } = input;

  const startEnvelope = await record(
    hooks,
    {
      by: agentId,
      action: "Running.started",
      args: { run: runId, input: userInput },
      behaviorVersionId,
      runId,
    },
    sink
  );

  const trigger = { action: "UserInput.received" };
  const reactions = selectEntryReactions(bcir, trigger);

  const binding: Record<string, unknown> = { input: userInput, runId };

  let stepBudget = 16;
  for (const reaction of reactions) {
    if (stepBudget <= 0) break;
    stepBudget = await executeReaction(
      reaction,
      binding,
      stepBudget,
      {
        agentId,
        bcir,
        behaviorVersionId,
        runId,
        causedByActionId: startEnvelope.id,
      },
      hooks,
      sink,
      envForTools
    );
  }

  await record(
    hooks,
    {
      by: agentId,
      action: "Running.completed",
      args: { run: runId },
      behaviorVersionId,
      runId,
    },
    sink
  );

  const graph = await hooks.refreshGraph();
  sink.send({ type: "graph", graph });
}

async function executeReaction(
  reaction: ReactionIR,
  binding: Record<string, unknown>,
  stepBudget: number,
  ctx: {
    agentId: string;
    bcir: BCIR;
    behaviorVersionId: string;
    runId: string;
    causedByActionId: string;
  },
  hooks: RunHooks,
  sink: RunSink,
  envForTools: { AI?: { run: (m: string, i: unknown, o?: unknown) => Promise<unknown> } }
): Promise<number> {
  const fired = await record(
    hooks,
    {
      by: ctx.agentId,
      action: "Reacting.fired",
      args: { reaction: reaction.id, name: reaction.name, prose: reaction.prose },
      behaviorVersionId: ctx.behaviorVersionId,
      runId: ctx.runId,
      causedByActionId: ctx.causedByActionId,
      causedByReactionId: reaction.id,
    },
    sink
  );

  let budget = stepBudget;
  for (const line of reaction.then) {
    if (budget <= 0) break;
    budget--;
    await executeThenLine(line, binding, reaction, fired.id, ctx, hooks, sink, envForTools);
  }
  return budget;
}

async function executeThenLine(
  line: ThenActionIR,
  binding: Record<string, unknown>,
  reaction: ReactionIR,
  causedByActionId: string,
  ctx: {
    agentId: string;
    bcir: BCIR;
    behaviorVersionId: string;
    runId: string;
  },
  hooks: RunHooks,
  sink: RunSink,
  envForTools: { AI?: { run: (m: string, i: unknown, o?: unknown) => Promise<unknown> } }
): Promise<void> {
  const args = resolveArgs(line.args, binding);

  if (line.posture === "attest") {
    await record(
      hooks,
      {
        by: ctx.agentId,
        action: line.action,
        args,
        behaviorVersionId: ctx.behaviorVersionId,
        runId: ctx.runId,
        causedByActionId,
        causedByReactionId: reaction.id,
      },
      sink
    );
    return;
  }

  // posture === "request"
  const requestAction = await record(
    hooks,
    {
      by: ctx.agentId,
      action: "Requesting.requested",
      args: { action: line.action, args },
      behaviorVersionId: ctx.behaviorVersionId,
      runId: ctx.runId,
      causedByActionId,
      causedByReactionId: reaction.id,
    },
    sink
  );

  if (line.action === "Tooling.called") {
    await runTool(
      String(args.tool ?? "llm.generate"),
      args,
      requestAction.id,
      ctx,
      hooks,
      sink,
      envForTools,
      binding
    );
    return;
  }

  if (line.action.startsWith("Spawning.")) {
    await runSpawn(args, requestAction.id, ctx, hooks, sink);
    return;
  }

  if (line.action.startsWith("Communicating.")) {
    // For MVP we just attest the message as sent.
    await record(
      hooks,
      {
        by: ctx.agentId,
        action: "Communicating.sent",
        args,
        behaviorVersionId: ctx.behaviorVersionId,
        runId: ctx.runId,
        causedByActionId: requestAction.id,
        causedByReactionId: reaction.id,
      },
      sink
    );
    return;
  }

  // Fallback: ask the LLM to satisfy the request.
  const prompt =
    typeof args.prompt === "string"
      ? args.prompt
      : `Reaction "${reaction.prose}" requested ${line.action}. Inputs: ${JSON.stringify(args)}.`;
  await runTool(
    "llm.generate",
    { prompt, ...args },
    requestAction.id,
    ctx,
    hooks,
    sink,
    envForTools,
    binding
  );
}

async function runTool(
  toolName: string,
  args: Record<string, unknown>,
  requestActionId: string,
  ctx: {
    agentId: string;
    bcir: BCIR;
    behaviorVersionId: string;
    runId: string;
  },
  hooks: RunHooks,
  sink: RunSink,
  envForTools: { AI?: { run: (m: string, i: unknown, o?: unknown) => Promise<unknown> } },
  binding: Record<string, unknown>
): Promise<void> {
  const tool = TOOL_REGISTRY[toolName];
  const toolCallId = `tc_${crypto.randomUUID().slice(0, 8)}`;
  hooks.insertToolCall({
    id: toolCallId,
    runId: ctx.runId,
    actorAgentId: ctx.agentId,
    toolName,
    requestActionId,
    inputJson: JSON.stringify(args),
  });

  sink.send({
    type: "tool",
    toolCallId,
    tool: toolName,
    input: args,
    actorAgentId: ctx.agentId,
  });

  hooks.updateToolCall({
    id: toolCallId,
    status: "running",
    startedAt: new Date().toISOString(),
  });

  if (!tool) {
    const err = `Unknown tool "${toolName}".`;
    hooks.updateToolCall({
      id: toolCallId,
      status: "failed",
      errorText: err,
      completedAt: new Date().toISOString(),
    });
    sink.send({
      type: "tool_result",
      toolCallId,
      status: "failed",
      error: err,
    });
    await record(
      hooks,
      {
        by: ctx.agentId,
        action: "Tooling.failed",
        args: { tool: toolName, reason: err, request: requestActionId },
        behaviorVersionId: ctx.behaviorVersionId,
        runId: ctx.runId,
        causedByActionId: requestActionId,
      },
      sink
    );
    return;
  }

  try {
    const result = await tool.run(envForTools, args, {
      stream: {
        token(text) {
          sink.send({ type: "token", text, toolCallId });
        },
      },
      host: hooks.toolHost,
    });
    if (result.error) {
      hooks.updateToolCall({
        id: toolCallId,
        status: "failed",
        errorText: result.error,
        completedAt: new Date().toISOString(),
      });
      sink.send({
        type: "tool_result",
        toolCallId,
        status: "failed",
        error: result.error,
      });
      await record(
        hooks,
        {
          by: ctx.agentId,
          action: "Tooling.failed",
          args: { tool: toolName, reason: result.error, request: requestActionId },
          behaviorVersionId: ctx.behaviorVersionId,
          runId: ctx.runId,
          causedByActionId: requestActionId,
        },
        sink
      );
      return;
    }

    hooks.updateToolCall({
      id: toolCallId,
      status: "completed",
      outputJson: JSON.stringify(result.output ?? null),
      completedAt: new Date().toISOString(),
    });
    sink.send({
      type: "tool_result",
      toolCallId,
      status: "completed",
      output: result.output,
    });

    // Bind the tool result so subsequent steps can reference it.
    binding.lastToolOutput = result.output;

    await record(
      hooks,
      {
        by: ctx.agentId,
        action: "Tooling.completed",
        args: {
          tool: toolName,
          request: requestActionId,
          summary: summarize(result.output),
        },
        behaviorVersionId: ctx.behaviorVersionId,
        runId: ctx.runId,
        causedByActionId: requestActionId,
      },
      sink
    );
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    hooks.updateToolCall({
      id: toolCallId,
      status: "failed",
      errorText: err,
      completedAt: new Date().toISOString(),
    });
    sink.send({
      type: "tool_result",
      toolCallId,
      status: "failed",
      error: err,
    });
    await record(
      hooks,
      {
        by: ctx.agentId,
        action: "Tooling.failed",
        args: { tool: toolName, reason: err, request: requestActionId },
        behaviorVersionId: ctx.behaviorVersionId,
        runId: ctx.runId,
        causedByActionId: requestActionId,
      },
      sink
    );
  }
}

async function runSpawn(
  args: Record<string, unknown>,
  requestActionId: string,
  ctx: {
    agentId: string;
    bcir: BCIR;
    behaviorVersionId: string;
    runId: string;
  },
  hooks: RunHooks,
  sink: RunSink
): Promise<void> {
  const childName = String(args.name ?? args.role ?? "Helper");
  const childPurpose = String(args.purpose ?? args.task ?? args.object ?? "");
  // Derive a minimal child BCIR.
  const childBCIR: BCIR = {
    schemaVersion: "bcir.v0",
    agent: { name: childName, purpose: childPurpose || undefined },
    raw: {
      format: "behavioral-dsl",
      text: `Agent: ${childName}\nPurpose: ${childPurpose}\nWhen the user asks, generate a helpful answer.`,
    },
    concepts: [],
    reactions: [
      {
        id: "r_child_1",
        name: "R1",
        prose:
          "When the user asks, generate a helpful answer using the LLM.",
        formal:
          "when UserInput.received do request Tooling.called(tool: 'llm.generate', prompt: ?input)",
        when: [
          {
            bind: "?input",
            action: "UserInput.received",
            args: { input: "?input" },
          },
        ],
        where: [],
        then: [
          {
            posture: "request",
            action: "Tooling.called",
            args: { tool: "llm.generate", prompt: "?input" },
          },
        ],
      },
    ],
    tools: [
      {
        name: "llm.generate",
        description: "LLM generation",
      },
    ],
    permissions: [{ capability: "tools", scope: "self" }],
  };

  const { childAgentId } = await hooks.spawnChild({
    parentAgentId: ctx.agentId,
    name: childName,
    behavior: childBCIR,
    runId: ctx.runId,
    causedByActionId: requestActionId,
  });

  sink.send({
    type: "spawn",
    childAgentId,
    childName,
    parentAgentId: ctx.agentId,
  });

  await record(
    hooks,
    {
      by: ctx.agentId,
      action: "Spawning.spawned",
      args: { child: childAgentId, name: childName },
      behaviorVersionId: ctx.behaviorVersionId,
      runId: ctx.runId,
      causedByActionId: requestActionId,
    },
    sink
  );

  // Optionally execute the child immediately so the user sees output.
  const taskInput = childPurpose || `Help with: ${ctx.runId}`;
  await hooks.runChild({
    childAgentId,
    userInput: taskInput,
    runId: ctx.runId,
    sink,
  });
}

async function record(
  hooks: RunHooks,
  envelope: Omit<ActingEnvelope, "id" | "createdAt">,
  sink: RunSink
): Promise<{ id: string; createdAt: string }> {
  const createdAt = new Date().toISOString();
  const id = await hooks.logAction(envelope);
  sink.send({
    type: "event",
    event: {
      id,
      actorAgentId: envelope.by,
      action: envelope.action,
      args: envelope.args,
      runId: envelope.runId ?? null,
      behaviorVersionId: envelope.behaviorVersionId ?? null,
      causedByActionId: envelope.causedByActionId ?? null,
      causedByReactionId: envelope.causedByReactionId ?? null,
      createdAt,
    },
  });
  // Mirror to the child's local action log.
  void hooks
    .mirrorActionToChild(envelope.by, {
      ...envelope,
      id,
      createdAt,
    })
    .catch(() => {
      /* mirroring is best-effort */
    });
  return { id, createdAt };
}

function resolveArgs(
  args: Record<string, string>,
  binding: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && v.startsWith("?")) {
      const key = v.slice(1);
      out[k] = binding[key] ?? v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function summarize(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    return value.length > 240 ? value.slice(0, 240) + "…" : value;
  }
  try {
    const json = JSON.stringify(value);
    return json.length > 240 ? json.slice(0, 240) + "…" : json;
  } catch {
    return String(value);
  }
}
