// Building concept: the agentic planner loop.
//
// Triggered by `Building.act`. Drives a JSON tool-calling loop using the LLM.
// The loop sees the agent's behavior, the user input, and a catalog of tools;
// it can call tools (including agent.spawn / agent.search / agent.communicate
// / agent.updateBehavior / agent.writeFile / agent.setHandler / etc.) and
// finally emits a `respond` decision streamed to the user as a token chunk.

import type { BCIR, ReactionIR } from "../../../shared/types";
import { record } from "../action-log";
import { asString, summarize, truncate } from "../binding";
import { generatePlannerText, TOOL_REGISTRY } from "../tools";
import type {
  RunBinding,
  RunContext,
  RunHooks,
  RunSink,
  RuntimeEnv,
} from "../types";
import { runTool } from "./tooling";

const AGENTIC_TOOLS = [
  "llm.generate",
  "memory.search",
  "http.fetch",
  "agent.list",
  "agent.search",
  "agent.getBehavior",
  "agent.spawn",
  "agent.communicate",
  "agent.updateBehavior",
  "agent.writeFile",
  "agent.readFile",
  "agent.listFiles",
  "agent.deleteFile",
  "agent.setHandler",
  "agent.listHandlers",
];

const MAX_AGENTIC_STEPS = 8;

type PlannerStep = {
  tool?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  thought?: string;
};

type PlannerDecision = {
  thought?: string;
  tool?: string;
  input?: Record<string, unknown>;
  respond?: string;
};

export async function executeBuilding(
  args: Record<string, unknown>,
  requestActionId: string,
  reaction: ReactionIR,
  ctx: RunContext,
  hooks: RunHooks,
  sink: RunSink,
  env: RuntimeEnv,
  binding: RunBinding
): Promise<void> {
  const userInput = asString(binding.input);
  const goal =
    asString(args.goal) || asString(args.task) || userInput;

  const history: PlannerStep[] = [];
  let lastCausedBy = requestActionId;
  let finalRespond: string | null = null;

  for (let step = 0; step < MAX_AGENTIC_STEPS; step++) {
    const prompt = buildAgenticSystemPrompt(ctx.bcir, userInput, goal, history);
    const { text, error } = await generatePlannerText(env, prompt);
    if (error) {
      history.push({ thought: `planner error: ${error}` });
      finalRespond = `I hit an LLM error while planning: ${error}`;
      break;
    }
    const decision = parsePlannerResponse(text);
    if (!decision) {
      const trimmed = text.trim();
      finalRespond = trimmed.length > 0 ? trimmed : "I couldn't produce a structured plan.";
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
      env,
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
    finalRespond = "I ran out of agentic steps without producing a complete answer.";
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
  history: PlannerStep[]
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
              : truncate(JSON.stringify(h.output ?? null), 1200);
          return `Step ${i + 1}: ${h.thought ? `(${h.thought}) ` : ""}called ${h.tool} with ${truncate(inp, 400)} → ${out}`;
        })
        .join("\n")
    : "(no steps yet)";

  return [
    `You are an agent named "${agent?.name ?? "Agent"}".`,
    agent?.purpose ? `Your purpose: ${agent.purpose}` : "",
    reactions ? `Your behavioral reactions:\n${reactions}` : "",
    `\nAvailable tools you can call:\n${tools}`,
    `\nThe user input for this run:\n${truncate(userInput, 4000)}`,
    goal && goal !== userInput ? `\nGoal for this step: ${truncate(goal, 1000)}` : "",
    `\nWork history so far:\n${historyText}`,
    `\nDecide the next step. You MUST reply with a single JSON object — nothing else, no markdown fences.`,
    `Either:`,
    `  {"thought": "<short reasoning>", "tool": "<tool.name>", "input": { ... }}  — to call a tool`,
    `or:`,
    `  {"thought": "<short reasoning>", "respond": "<final answer for the user>"}  — when you are done.`,
    `Rules:`,
    `- Use agent.search / agent.list to discover existing agents you can delegate to via agent.spawn(fromAgentId) or talk to via agent.communicate.`,
    `- Use agent.spawn to delegate sub-tasks; pass userInput so the child has data to work on.`,
    `- Use agent.communicate when you need a back-and-forth dialogue with another agent until you are satisfied; pass goal/topic and an initial message.`,
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

function parsePlannerResponse(raw: string): PlannerDecision | null {
  if (!raw) return null;
  let text = raw.trim();
  // Strip code fences if the model added them despite instructions.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
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
