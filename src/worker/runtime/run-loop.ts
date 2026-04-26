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
import {
  generatePlannerText,
  listAvailableTools,
  TOOL_REGISTRY,
  type ToolHostQueries,
  type ToolResult,
} from "./tools";

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
  // Normalize a free-form child behavior text into a BCIR. Lets parent
  // agents spawn children with rich, parser-derived reactions instead of
  // a single hard-coded LLM call.
  normalizeChildBehavior: (input: {
    name: string;
    rawText: string;
  }) => Promise<BCIR>;
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
    const toolName = String(args.tool ?? "llm.generate");
    const enriched = { ...args };
    if (toolName === "llm.generate") {
      const userInput = typeof binding.input === "string" ? binding.input : "";
      const existing = typeof enriched.prompt === "string" ? enriched.prompt : "";
      enriched.prompt = composeWithUserInput(existing || `Respond to the user.`, userInput);
    }
    await runTool(
      toolName,
      enriched,
      requestAction.id,
      ctx,
      hooks,
      sink,
      envForTools,
      binding
    );
    return;
  }

  if (line.action.startsWith("Building.")) {
    await executeAgenticLoop(
      args,
      requestAction.id,
      reaction,
      ctx,
      hooks,
      sink,
      envForTools,
      binding
    );
    return;
  }

  if (line.action.startsWith("Spawning.")) {
    await runSpawn(args, requestAction.id, ctx, hooks, sink, binding);
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

  // Fallback: ask the LLM to satisfy the request. We deliberately surface
  // both the original user message and the resolved arguments — the args
  // alone (e.g. "object: ?input" pre-resolution, or "object: it") lack
  // antecedent. After `resolveArgs` ?input has already been replaced with
  // `binding.input`, so `args.object` should now be the real document.
  const userInput = typeof binding.input === "string" ? binding.input : "";
  const lastChild =
    typeof binding.lastChildOutput === "string" ? binding.lastChildOutput : "";
  const lastTool =
    typeof binding.lastToolOutput === "string" ? binding.lastToolOutput : "";

  const explicitPrompt =
    typeof args.prompt === "string" ? args.prompt : null;

  const verbPart = line.action.replace(/^[A-Z][A-Za-z]+\./, "");
  const conceptPart = line.action.split(".")[0] ?? "";

  const prompt =
    explicitPrompt !== null
      ? composeWithUserInput(explicitPrompt, userInput)
      : [
          userInput ? `User message / input:\n${userInput}\n` : "",
          lastChild ? `Previous sub-agent output:\n${lastChild}\n` : "",
          lastTool && lastTool !== userInput
            ? `Previous tool output:\n${lastTool}\n`
            : "",
          `You are an agent fulfilling the reaction: "${reaction.prose.trim()}".`,
          `The reaction asks you to ${verbPart} (${conceptPart}). ` +
            (Object.keys(args).length > 0
              ? `Inputs: ${JSON.stringify(args)}.`
              : ""),
          `Perform that step now and respond directly to the user with the result. Do not narrate that you are an LLM — just produce the requested output.`,
        ]
          .filter(Boolean)
          .join("\n");
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

// If the reaction author wrote an explicit `prompt` arg, respect it but still
// surface the user's message so the LLM sees the full conversation context.
function composeWithUserInput(prompt: string, userInput: string): string {
  if (!userInput) return prompt;
  if (prompt.includes(userInput)) return prompt;
  return `User message:\n${userInput}\n\n${prompt}`;
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
): Promise<ToolResult> {
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
    return { error: err };
  }

  try {
    const result = await tool.run(envForTools, args, {
      stream: {
        token(text) {
          sink.send({ type: "token", text, toolCallId });
        },
      },
      host: hooks.toolHost,
      actorAgentId: ctx.agentId,
      runId: ctx.runId,
      causedByActionId: requestActionId,
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
      return result;
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
    return result;
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
    return { error: err };
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
  sink: RunSink,
  binding: Record<string, unknown>
): Promise<void> {
  const childName = String(args.name ?? args.role ?? "Helper");
  // Accept a few shapes: explicit purpose, task, behavior text, or fall back
  // to args.object (which may itself be the resolved user input).
  const childPurpose = String(
    args.purpose ?? args.task ?? args.behavior ?? args.object ?? ""
  );
  const childBehaviorText = String(
    args.behavior ?? args.behaviorText ?? args.purpose ?? args.task ?? ""
  );

  // Build a child BCIR. If the parent provided a `behavior` arg, normalize it
  // through the parser so the child can have its own reactions (and even
  // spawn further). Otherwise fall back to a single LLM-backed reaction.
  let childBCIR: BCIR;
  if (childBehaviorText && childBehaviorText.length > 16) {
    childBCIR = await hooks.normalizeChildBehavior({
      name: childName,
      rawText: `Agent: ${childName}\nPurpose: ${childPurpose}\n${childBehaviorText}`,
    });
  } else {
    const purposeLine = childPurpose
      ? `Purpose: ${childPurpose}`
      : `Purpose: act on the user's request.`;
    childBCIR = {
      schemaVersion: "bcir.v0",
      agent: { name: childName, purpose: childPurpose || undefined },
      raw: {
        format: "behavioral-dsl",
        text: `Agent: ${childName}\n${purposeLine}\nWhen the user gives input, think and use tools as needed to fulfill the request.`,
      },
      concepts: [],
      reactions: [
        {
          id: "r_child_1",
          name: "R1",
          prose:
            "When the user gives input, think and use tools as needed to fulfill the request.",
          formal:
            "when UserInput.received do request Building.act(goal: ?input)",
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
              action: "Building.act",
              args: { goal: "?input" },
            },
          ],
        },
      ],
      tools: listAvailableTools(),
      permissions: [
        { capability: "tools", scope: "self" },
        { capability: "spawn", scope: "self" },
      ],
    };
  }

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

  // Run the child immediately so the parent can observe its output. We
  // intercept the child's stream so we can (a) forward chunks to the user
  // and (b) capture the final textual output and bind it to the parent's
  // `lastChildOutput` for subsequent reaction steps.
  // Build the child's task input. The parent's `?input` (the original user
  // message or upstream payload) is the actual data the child must work on.
  // The purpose, if any, is the *instruction* the parent attached. We pass
  // both so the child has content to act on, not just an instruction.
  const parentInput = typeof binding.input === "string" ? binding.input : "";
  const explicitInput =
    typeof args.input === "string"
      ? args.input
      : typeof args.task === "string"
        ? args.task
        : "";
  const taskInput = (() => {
    if (childPurpose && (explicitInput || parentInput)) {
      return `${childPurpose}\n\n--- Input ---\n${explicitInput || parentInput}`;
    }
    return explicitInput || parentInput || childPurpose || `Help with ${ctx.runId}`;
  })();

  let captured = "";
  const childSink: RunSink = {
    send(chunk) {
      if (chunk.type === "token" && typeof chunk.text === "string") {
        captured += chunk.text;
      } else if (chunk.type === "tool_result" && chunk.status === "completed") {
        const out = chunk.output;
        if (typeof out === "string" && out.length > captured.length) {
          captured = out;
        }
      }
      sink.send(chunk);
    },
  };

  await hooks.runChild({
    childAgentId,
    userInput: taskInput,
    runId: ctx.runId,
    sink: childSink,
  });

  binding.lastChildOutput = captured;
  binding[childName] = captured;

  await record(
    hooks,
    {
      by: ctx.agentId,
      action: "Spawning.completed",
      args: {
        child: childAgentId,
        name: childName,
        summary: summarize(captured),
      },
      behaviorVersionId: ctx.behaviorVersionId,
      runId: ctx.runId,
      causedByActionId: requestActionId,
    },
    sink
  );
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

// =============================================================================
// Agentic loop. Triggered by `Building.act`. Drives a JSON tool-calling loop
// using the LLM. The loop sees the agent's behavior, the user input, and a
// catalog of tools; it can call tools (including agent.spawn / agent.search /
// agent.updateBehavior / agent.writeFile / agent.setHandler / etc.) and finally
// emit a `respond` decision which is streamed to the user as a token chunk.
// =============================================================================

const AGENTIC_TOOLS = [
  "llm.generate",
  "memory.search",
  "http.fetch",
  "agent.list",
  "agent.search",
  "agent.getBehavior",
  "agent.spawn",
  "agent.updateBehavior",
  "agent.writeFile",
  "agent.readFile",
  "agent.listFiles",
  "agent.deleteFile",
  "agent.setHandler",
  "agent.listHandlers",
];

function buildToolCatalog(): string {
  return AGENTIC_TOOLS.map((name) => {
    const def = TOOL_REGISTRY[name];
    if (!def) return null;
    return `- ${def.name}: ${def.description}${
      def.usage ? `\n  ${def.usage.replace(/\n/g, "\n  ")}` : ""
    }`;
  })
    .filter(Boolean)
    .join("\n");
}

function buildAgenticSystemPrompt(
  bcir: BCIR,
  userInput: string,
  goal: string,
  history: { tool?: string; input?: unknown; output?: unknown; error?: string; thought?: string }[]
): string {
  const agent = bcir.agent;
  const reactions = (bcir.reactions ?? [])
    .map((r) => `  • ${r.prose || r.name}`)
    .join("\n");
  const tools = buildToolCatalog();
  const historyText = history.length
    ? history
        .map((h, i) => {
          if (h.thought && !h.tool) return `Step ${i + 1} thought: ${h.thought}`;
          const inp = JSON.stringify(h.input ?? null);
          const out =
            h.error != null
              ? `ERROR: ${h.error}`
              : truncateForPrompt(JSON.stringify(h.output ?? null), 1200);
          return `Step ${i + 1}: ${h.thought ? `(${h.thought}) ` : ""}called ${h.tool} with ${truncateForPrompt(inp, 400)} → ${out}`;
        })
        .join("\n")
    : "(no steps yet)";

  return [
    `You are an agent named "${agent?.name ?? "Agent"}".`,
    agent?.purpose ? `Your purpose: ${agent.purpose}` : "",
    reactions ? `Your behavioral reactions:\n${reactions}` : "",
    `\nAvailable tools you can call:\n${tools}`,
    `\nThe user input for this run:\n${truncateForPrompt(userInput, 4000)}`,
    goal && goal !== userInput ? `\nGoal for this step: ${truncateForPrompt(goal, 1000)}` : "",
    `\nWork history so far:\n${historyText}`,
    `\nDecide the next step. You MUST reply with a single JSON object — nothing else, no markdown fences.`,
    `Either:`,
    `  {"thought": "<short reasoning>", "tool": "<tool.name>", "input": { ... }}  — to call a tool`,
    `or:`,
    `  {"thought": "<short reasoning>", "respond": "<final answer for the user>"}  — when you are done.`,
    `Rules:`,
    `- Use agent.search / agent.list to discover existing agents you can delegate to via agent.spawn(fromAgentId).`,
    `- Use agent.spawn to delegate sub-tasks; pass userInput so the child has data to work on.`,
    `- Use agent.writeFile to save artifacts (HTML, code, JSON, …) the user will need.`,
    `- Use agent.setHandler to expose this agent at an HTTP path when the request asks for a website / endpoint / served content.`,
    `- Use agent.updateBehavior to permanently encode improved patterns once you have learned them.`,
    `- When you are confident the request is satisfied, use "respond" and put the user-facing answer in it. Keep responses concise unless the user asked for detail.`,
    `- If a tool errored, do NOT call it again with the same arguments. Adjust or pick another approach.`,
    `Respond with ONLY the JSON object.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function truncateForPrompt(s: string | undefined | null, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function parsePlannerResponse(
  raw: string
): { thought?: string; tool?: string; input?: Record<string, unknown>; respond?: string } | null {
  if (!raw) return null;
  let text = raw.trim();
  // Strip code fences if the model added them despite instructions.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  // Locate the first {...} block.
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  const slice = text.slice(start, end + 1);
  try {
    const obj = JSON.parse(slice) as Record<string, unknown>;
    return {
      thought: typeof obj.thought === "string" ? obj.thought : undefined,
      tool: typeof obj.tool === "string" ? obj.tool : undefined,
      input:
        obj.input && typeof obj.input === "object"
          ? (obj.input as Record<string, unknown>)
          : undefined,
      respond: typeof obj.respond === "string" ? obj.respond : undefined,
    };
  } catch {
    return null;
  }
}

async function executeAgenticLoop(
  args: Record<string, unknown>,
  requestActionId: string,
  reaction: ReactionIR,
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
  const userInput = typeof binding.input === "string" ? binding.input : "";
  const goal =
    typeof args.goal === "string"
      ? args.goal
      : typeof args.task === "string"
        ? args.task
        : userInput;

  const MAX_STEPS = 8;
  const history: {
    tool?: string;
    input?: unknown;
    output?: unknown;
    error?: string;
    thought?: string;
  }[] = [];

  let lastCausedBy = requestActionId;
  let finalRespond: string | null = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    const prompt = buildAgenticSystemPrompt(ctx.bcir, userInput, goal, history);
    const { text, error } = await generatePlannerText(envForTools, prompt);
    if (error) {
      history.push({ thought: `planner error: ${error}` });
      finalRespond = `I hit an LLM error while planning: ${error}`;
      break;
    }
    const decision = parsePlannerResponse(text);
    if (!decision) {
      // Treat the raw text as a final answer if it's non-trivial.
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        finalRespond = trimmed;
      } else {
        finalRespond = "I couldn't produce a structured plan.";
      }
      break;
    }
    if (decision.respond) {
      finalRespond = decision.respond;
      break;
    }
    if (!decision.tool) {
      history.push({
        thought: decision.thought,
        error: "planner returned neither tool nor respond",
      });
      continue;
    }
    if (!TOOL_REGISTRY[decision.tool]) {
      history.push({
        thought: decision.thought,
        tool: decision.tool,
        input: decision.input,
        error: `Unknown tool "${decision.tool}".`,
      });
      continue;
    }
    // Record the planner's decision as a Building.thought action for traceability.
    const thoughtAction = await record(
      hooks,
      {
        by: ctx.agentId,
        action: "Building.thought",
        args: {
          thought: decision.thought ?? "",
          tool: decision.tool,
          input: decision.input ?? {},
        },
        behaviorVersionId: ctx.behaviorVersionId,
        runId: ctx.runId,
        causedByActionId: lastCausedBy,
        causedByReactionId: reaction.id,
      },
      sink
    );
    const result = await runTool(
      decision.tool,
      decision.input ?? {},
      thoughtAction.id,
      ctx,
      hooks,
      sink,
      envForTools,
      binding
    );
    lastCausedBy = thoughtAction.id;
    history.push({
      thought: decision.thought,
      tool: decision.tool,
      input: decision.input,
      output: result.output,
      error: result.error,
    });
  }

  if (finalRespond == null) {
    finalRespond =
      "I ran out of agentic steps without producing a complete answer.";
  }

  // Stream the final response as a normal token (no toolCallId) so the chat
  // UI accumulates it into the turn text.
  sink.send({ type: "token", text: finalRespond });
  await record(
    hooks,
    {
      by: ctx.agentId,
      action: "Communicating.sent",
      args: { object: summarize(finalRespond) },
      behaviorVersionId: ctx.behaviorVersionId,
      runId: ctx.runId,
      causedByActionId: lastCausedBy,
      causedByReactionId: reaction.id,
    },
    sink
  );
  binding.lastBuildOutput = finalRespond;
}
