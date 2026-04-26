// Run-loop orchestrator. Lives in the WorkspaceAgent and drives a
// BehaviorAgent's reactions for a single user-facing run. The workspace owns
// the canonical action log, graph projection and tool execution; concept
// handlers under `runtime/concepts/*` implement the per-concept semantics.
//
// Lifecycle:
//   Running.started → for each entry reaction:
//      Reacting.fired → for each `then` line:
//         attest  → record action verbatim
//         request → Requesting.requested → dispatch by concept
//   Running.completed → graph refresh.

import type { ReactionIR, ThenActionIR } from "../../shared/types";
import { selectEntryReactionsLLM } from "../behavior/validate";
import { record } from "./action-log";
import { composeWithUserInput, resolveArgs } from "./binding";
import { executeBuilding } from "./concepts/building";
import { executeCommunicating } from "./concepts/communicating";
import { executeSpawning } from "./concepts/spawning";
import { runTool } from "./concepts/tooling";
import type {
  RunBinding,
  RunContext,
  RunHooks,
  RunInput,
  RunSink,
  RuntimeEnv,
} from "./types";

// Re-export so existing call-sites (WorkspaceAgent) keep working.
export type { RunHooks, RunSink, RunInput } from "./types";

const STEP_BUDGET = 16;

export async function executeBehaviorRun(
  input: RunInput,
  hooks: RunHooks,
  sink: RunSink,
  env: RuntimeEnv
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
  const reactions = await selectEntryReactionsLLM(bcir, trigger, userInput, env);

  const binding: RunBinding = { input: userInput, runId };
  const ctx: RunContext = { agentId, bcir, behaviorVersionId, runId };

  let stepBudget = STEP_BUDGET;
  for (const reaction of reactions) {
    if (stepBudget <= 0) break;
    stepBudget = await executeReaction(
      reaction,
      binding,
      stepBudget,
      ctx,
      startEnvelope.id,
      hooks,
      sink,
      env
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
  binding: RunBinding,
  stepBudget: number,
  ctx: RunContext,
  causedByActionId: string,
  hooks: RunHooks,
  sink: RunSink,
  env: RuntimeEnv
): Promise<number> {
  const fired = await record(
    hooks,
    {
      by: ctx.agentId,
      action: "Reacting.fired",
      args: { reaction: reaction.id, name: reaction.name, prose: reaction.prose },
      behaviorVersionId: ctx.behaviorVersionId,
      runId: ctx.runId,
      causedByActionId,
      causedByReactionId: reaction.id,
    },
    sink
  );

  let budget = stepBudget;
  for (const line of reaction.then) {
    if (budget <= 0) break;
    budget--;
    await executeThenLine(line, binding, reaction, fired.id, ctx, hooks, sink, env);
  }
  return budget;
}

async function executeThenLine(
  line: ThenActionIR,
  binding: RunBinding,
  reaction: ReactionIR,
  causedByActionId: string,
  ctx: RunContext,
  hooks: RunHooks,
  sink: RunSink,
  env: RuntimeEnv
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

  // posture === "request" — every request is bracketed by Requesting.requested
  // so the action log captures intent before execution.
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

  // Dispatch by concept prefix. Each branch is a thin call into the concept
  // module — keeping this file an orchestrator, not a kitchen sink.
  if (line.action === "Tooling.called") {
    const toolName = String(args.tool ?? "llm.generate");
    const enriched = { ...args };
    if (toolName === "llm.generate") {
      const userInput = typeof binding.input === "string" ? binding.input : "";
      const existing = typeof enriched.prompt === "string" ? enriched.prompt : "";
      enriched.prompt = composeWithUserInput(existing || `Respond to the user.`, userInput);
    }
    await runTool(toolName, enriched, requestAction.id, ctx, hooks, sink, env, binding);
    return;
  }

  if (line.action.startsWith("Building.")) {
    await executeBuilding(args, requestAction.id, reaction, ctx, hooks, sink, env, binding);
    return;
  }

  if (line.action.startsWith("Spawning.")) {
    await executeSpawning(args, requestAction.id, ctx, hooks, sink, binding);
    return;
  }

  if (line.action.startsWith("Communicating.")) {
    await executeCommunicating(
      args,
      requestAction.id,
      reaction.id,
      ctx,
      hooks,
      sink,
      env,
      binding
    );
    return;
  }

  // Fallback: ask the LLM to satisfy the request via llm.generate. We surface
  // the resolved args plus the original user input so the model has antecedent
  // context (e.g. when the reaction wrote `object: ?input`, ?input has already
  // been substituted in `args.object` at this point).
  await runFallbackLLM(line, args, reaction, requestAction.id, ctx, hooks, sink, env, binding);
}

async function runFallbackLLM(
  line: ThenActionIR,
  args: Record<string, unknown>,
  reaction: ReactionIR,
  requestActionId: string,
  ctx: RunContext,
  hooks: RunHooks,
  sink: RunSink,
  env: RuntimeEnv,
  binding: RunBinding
): Promise<void> {
  const userInput = typeof binding.input === "string" ? binding.input : "";
  const lastChild = typeof binding.lastChildOutput === "string" ? binding.lastChildOutput : "";
  const lastTool = typeof binding.lastToolOutput === "string" ? binding.lastToolOutput : "";

  const explicitPrompt = typeof args.prompt === "string" ? args.prompt : null;
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
    requestActionId,
    ctx,
    hooks,
    sink,
    env,
    binding
  );
}
