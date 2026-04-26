// Spawning concept: create a child agent and run it to completion.
//
// Lifecycle actions:
//   request: Spawning.spawn
//   attest:  Spawning.spawned, Spawning.completed
//
// The child's tokens are forwarded to the parent's sink so the user sees the
// child's contribution; the final captured text is bound to
// `binding.lastChildOutput` for subsequent reaction steps to reference.

import type { BCIR } from "../../../shared/types";
import { record } from "../action-log";
import { asString, summarize } from "../binding";
import { listAvailableTools } from "../tools";
import type {
  RunBinding,
  RunContext,
  RunHooks,
  RunSink,
} from "../types";

export async function executeSpawning(
  args: Record<string, unknown>,
  requestActionId: string,
  ctx: RunContext,
  hooks: RunHooks,
  sink: RunSink,
  binding: RunBinding
): Promise<void> {
  const childName = String(args.name ?? args.role ?? "Helper");
  const childPurpose = String(
    args.purpose ?? args.task ?? args.behavior ?? args.object ?? ""
  );
  const childBehaviorText = String(
    args.behavior ?? args.behaviorText ?? args.purpose ?? args.task ?? ""
  );

  const childBCIR =
    childBehaviorText.length > 16
      ? await hooks.normalizeChildBehavior({
          name: childName,
          rawText: `Agent: ${childName}\nPurpose: ${childPurpose}\n${childBehaviorText}`,
        })
      : defaultChildBCIR(childName, childPurpose);

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

  // Build the child's task input. The parent's `?input` (the original user
  // message) is the data the child must work on; `purpose` is the instruction.
  const parentInput = asString(binding.input);
  const explicitInput =
    asString(args.input) || asString(args.task);
  const taskInput = (() => {
    if (childPurpose && (explicitInput || parentInput)) {
      return `${childPurpose}\n\n--- Input ---\n${explicitInput || parentInput}`;
    }
    return explicitInput || parentInput || childPurpose || `Help with ${ctx.runId}`;
  })();

  const captured = await runAndCapture(hooks, {
    childAgentId,
    userInput: taskInput,
    runId: ctx.runId,
    parentSink: sink,
    causedByActionId: requestActionId,
    forwardToParent: true,
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

// Run an agent (child or sibling) to completion, capturing its textual output.
// `forwardToParent` controls whether tokens / events are streamed to the user
// (true for spawning) or kept silent (false for inter-agent communication).
export async function runAndCapture(
  hooks: RunHooks,
  input: {
    childAgentId: string;
    userInput: string;
    runId: string;
    parentSink: RunSink;
    causedByActionId?: string | null;
    forwardToParent: boolean;
  }
): Promise<string> {
  let captured = "";
  const sink: RunSink = {
    send(chunk) {
      if (chunk.type === "token" && typeof chunk.text === "string") {
        captured += chunk.text;
      } else if (chunk.type === "tool_result" && chunk.status === "completed") {
        const out = chunk.output;
        if (typeof out === "string" && out.length > captured.length) {
          captured = out;
        }
      }
      if (input.forwardToParent) {
        input.parentSink.send(chunk);
      }
    },
  };

  await hooks.runChild({
    childAgentId: input.childAgentId,
    userInput: input.userInput,
    runId: input.runId,
    sink,
    causedByActionId: input.causedByActionId ?? null,
  });

  return captured;
}

// Single-LLM-reaction child used when the parent provided too little behavior
// text to normalize. The child still has access to the full agentic loop via
// `Building.act`.
export function defaultChildBCIR(name: string, purpose: string): BCIR {
  const purposeLine = purpose
    ? `Purpose: ${purpose}`
    : `Purpose: act on the user's request.`;
  return {
    schemaVersion: "bcir.v0",
    agent: { name, purpose: purpose || undefined },
    raw: {
      format: "behavioral-dsl",
      text: `Agent: ${name}\n${purposeLine}\nWhen the user gives input, think and use tools as needed to fulfill the request.`,
    },
    concepts: [],
    reactions: [
      {
        id: "r_child_1",
        name: "R1",
        prose:
          "When the user gives input, think and use tools as needed to fulfill the request.",
        formal: "when UserInput.received do request Building.act(goal: ?input)",
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
      { capability: "communicate", scope: "self" },
    ],
  };
}
