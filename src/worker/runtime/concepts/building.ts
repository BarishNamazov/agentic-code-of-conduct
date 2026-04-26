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
import AGENTIC_PLANNER_PROMPT from "../../prompts/agentic-planner.prompt";
import { renderTemplate } from "../../prompts/template";
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
  "knowledge.list",
  "knowledge.search",
  "knowledge.read",
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

  // Extract any <concept_call concept="X" action="Y">{json}</concept_call>
  // tags the model emitted in its final answer. Each one becomes a recorded
  // workspace action; the tags are stripped from what the user sees.
  const { cleanedText, conceptCalls } = extractConceptCalls(finalRespond);
  for (const call of conceptCalls) {
    await record(
      hooks,
      {
        by: ctx.agentId,
        action: `${call.concept}.${call.action}`,
        args: call.args,
        behaviorVersionId: ctx.behaviorVersionId,
        runId: ctx.runId,
        causedByActionId: lastCausedBy,
        causedByReactionId: reaction.id,
      },
      sink
    );
  }
  finalRespond = cleanedText;

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
  return previewAgenticContext(bcir, userInput, goal, history).rendered;
}

export type AgenticContextParts = {
  agentName: string;
  agentPurpose: string;
  reactions: string;
  toolCatalog: string;
  userInput: string;
  goal: string;
  history: string;
  promptTemplate: string;
  rendered: string;
};

// Returns the exact system prompt string sent to the LLM planner on the first
// (and subsequent) agentic step, plus the structured pieces it was assembled
// from. Used by the UI's Context Viewer so a developer can inspect what the
// agent actually sees.
export function previewAgenticContext(
  bcir: BCIR,
  userInput: string,
  goal: string,
  history: PlannerStep[] = []
): AgenticContextParts {
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

  const vars = {
    AGENT_NAME: agent?.name ?? "Agent",
    AGENT_PURPOSE: agent?.purpose ? `Your purpose: ${agent.purpose}` : "",
    REACTIONS: reactions ? `Your behavioral reactions:\n${reactions}` : "",
    TOOL_CATALOG: tools,
    USER_INPUT: truncate(userInput, 4000),
    GOAL: goal && goal !== userInput ? `\nGoal for this step: ${truncate(goal, 1000)}` : "",
    HISTORY: historyText,
  };

  return {
    agentName: vars.AGENT_NAME,
    agentPurpose: vars.AGENT_PURPOSE,
    reactions: vars.REACTIONS,
    toolCatalog: vars.TOOL_CATALOG,
    userInput: vars.USER_INPUT,
    goal: vars.GOAL,
    history: vars.HISTORY,
    promptTemplate: AGENTIC_PLANNER_PROMPT,
    rendered: renderTemplate(AGENTIC_PLANNER_PROMPT, vars),
  };
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

// Pull out <concept_call concept="X" action="Y">{json}</concept_call> blocks
// the model embedded in its final answer and return both the parsed calls
// (so the run loop can record() them) and the assistant text with the tags
// stripped (so the user does not see them).
type ParsedConceptCall = {
  concept: string;
  action: string;
  args: Record<string, unknown>;
};

export function extractConceptCalls(text: string): {
  cleanedText: string;
  conceptCalls: ParsedConceptCall[];
} {
  if (!text) return { cleanedText: text, conceptCalls: [] };
  // Be permissive about attribute order and whitespace; case-insensitive.
  const re =
    /<concept_call\b([^>]*)>([\s\S]*?)<\/concept_call>/gi;
  const calls: ParsedConceptCall[] = [];
  const cleaned = text.replace(re, (_match, attrs: string, inner: string) => {
    const concept = attrValue(attrs, "concept");
    const action = attrValue(attrs, "action");
    if (!concept || !action) return ""; // malformed → drop quietly
    const trimmed = inner.trim();
    let args: Record<string, unknown> = {};
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        } else {
          args = { value: parsed };
        }
      } catch {
        args = { raw: trimmed };
      }
    }
    calls.push({ concept, action, args });
    return "";
  });
  // Collapse whitespace runs the stripped tags may have left behind.
  const cleanedText = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return { cleanedText, conceptCalls: calls };
}

function attrValue(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const m = re.exec(attrs);
  if (!m) return null;
  return (m[2] ?? m[3] ?? "").trim() || null;
}
