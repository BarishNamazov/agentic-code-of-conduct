import type {
  BCIR,
  CompilerWarning,
  CompiledBehavior,
  ReactionIR,
  ValidationResult,
} from "../../shared/types";
import { generatePlannerText, type ToolEnv } from "../runtime/tools";
import ROUTE_REACTIONS_PROMPT from "../prompts/route-reactions.prompt";
import { renderTemplate } from "../prompts/template";

export function validateBehavior(bcir: BCIR): ValidationResult {
  const errors: CompilerWarning[] = [];
  const warnings: CompilerWarning[] = [];

  if (!bcir.agent?.name || bcir.agent.name.trim() === "") {
    errors.push({ level: "error", message: "Agent has no name." });
  }

  if (!bcir.reactions || bcir.reactions.length === 0) {
    errors.push({ level: "error", message: "Behavior has no reactions." });
  }

  const declaredTools = new Set(bcir.tools.map((t) => t.name));
  for (const r of bcir.reactions) {
    if (!r.prose || r.prose.trim() === "") {
      warnings.push({
        level: "warn",
        message: `Reaction ${r.name} has no prose. Add a human-readable description.`,
        ref: r.id,
      });
    }
    if (!r.formal || r.formal.trim() === "") {
      warnings.push({
        level: "warn",
        message: `Reaction ${r.name} has no formal text.`,
        ref: r.id,
      });
    }
    for (const t of r.then) {
      if (t.posture !== "request" && t.posture !== "attest") {
        errors.push({
          level: "error",
          message: `Reaction ${r.name} contains unknown posture "${(t as { posture: string }).posture}".`,
          ref: r.id,
        });
      }
      if (!/^[A-Z][A-Za-z0-9]+\.[a-z][A-Za-z0-9_]*$/.test(t.action)) {
        warnings.push({
          level: "warn",
          message: `Action "${t.action}" in reaction ${r.name} is not in Concept.action form.`,
          ref: r.id,
        });
      }
      if (t.action === "Tooling.called") {
        const tool = String(t.args.tool ?? "");
        if (tool && !declaredTools.has(tool)) {
          warnings.push({
            level: "warn",
            message: `Tool "${tool}" used in reaction ${r.name} is not declared in the tool list.`,
            ref: r.id,
          });
        }
      }
    }
  }

  for (const concept of bcir.concepts) {
    if (!/^[A-Z][a-z]+ing$/.test(concept.name)) {
      warnings.push({
        level: "info",
        message: `Concept "${concept.name}" is not a gerund.`,
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

export function compileBehavior(bcir: BCIR): CompiledBehavior {
  const entrypoints: { reactionId: string; trigger: string }[] = [];
  const tools = new Set<string>(bcir.tools.map((t) => t.name));
  let allowSpawn = bcir.permissions.some((p) => p.capability === "spawn");

  for (const r of bcir.reactions) {
    const firstTrigger = r.when[0]?.action ?? "Event.observed";
    entrypoints.push({ reactionId: r.id, trigger: firstTrigger });
    for (const t of r.then) {
      if (t.action.startsWith("Spawning.")) allowSpawn = true;
    }
  }

  return {
    entrypoints,
    runtime: {
      mode: "llm-assisted",
      maxSteps: 12,
      allowSpawn,
      allowTools: Array.from(tools).filter(Boolean),
    },
  };
}

// Pick reactions that should fire when the run starts with a user input.
export function selectEntryReactions(
  bcir: BCIR,
  trigger: { action: string }
): ReactionIR[] {
  const matched = bcir.reactions.filter((r) =>
    r.when.some((w) => w.action === trigger.action)
  );
  if (matched.length > 0) return matched;
  // If nothing matches, fire the first reaction (heuristic for free-form behavior).
  const first = bcir.reactions[0];
  return first ? [first] : [];
}

// Synthetic catch-all reaction that delegates to the agentic loop. Used when
// the LLM dispatcher decides none of the declared reactions are a good fit
// for the current user input — the agent then behaves ad-hoc.
const ADHOC_REACTION_ID = "r_adhoc_building_act";
function adhocBuildingActReaction(): ReactionIR {
  return {
    id: ADHOC_REACTION_ID,
    name: "Adhoc",
    prose:
      "No declared reaction matched the user's input. Fall back to the agentic loop and act dynamically.",
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
  };
}

// LLM-assisted version of `selectEntryReactions`. For UserInput-style triggers
// we ask the model which (if any) of the declared reactions are relevant to
// the actual user input. Reactions clearly unrelated to the input are dropped;
// if nothing is relevant we synthesise a single Building.act fallback so the
// agent can still respond ad-hoc.
//
// This is the runtime equivalent of:
//   when UserInput.received(?input)
//   do request Reactions.reactWithRelevantReaction(?input)
export async function selectEntryReactionsLLM(
  bcir: BCIR,
  trigger: { action: string },
  userInput: string,
  env: ToolEnv
): Promise<ReactionIR[]> {
  const candidates = selectEntryReactions(bcir, trigger);
  if (candidates.length === 0) return [adhocBuildingActReaction()];

  const input = (userInput ?? "").trim();
  // Without a real user message there's nothing to match against; preserve
  // the legacy behavior of firing every candidate.
  if (!input) return candidates;

  const picked = await pickRelevantReactionIds(candidates, input, env);
  if (picked === null) {
    // LLM unavailable or unparseable — fail safe to legacy behavior.
    return candidates;
  }

  if (picked.length === 0) return [adhocBuildingActReaction()];

  const byId = new Map(candidates.map((r) => [r.id, r]));
  const selected: ReactionIR[] = [];
  for (const id of picked) {
    const r = byId.get(id);
    if (r && !selected.includes(r)) selected.push(r);
  }
  return selected.length > 0 ? selected : [adhocBuildingActReaction()];
}

async function pickRelevantReactionIds(
  candidates: ReactionIR[],
  userInput: string,
  env: ToolEnv
): Promise<string[] | null> {
  if (!env.AI) return null;

  const summary = candidates
    .map((r, i) => {
      const prose = (r.prose || "").trim().replace(/\s+/g, " ").slice(0, 240);
      const formal = (r.formal || "").trim().replace(/\s+/g, " ").slice(0, 240);
      return `${i + 1}. id=${r.id} | name=${r.name}\n   prose: ${prose}\n   formal: ${formal}`;
    })
    .join("\n");

  const prompt = renderTemplate(ROUTE_REACTIONS_PROMPT, {
    USER_MESSAGE: userInput.slice(0, 2000),
    REACTIONS: summary,
  });

  const { text, error } = await generatePlannerText(env, prompt);
  if (error) return null;
  return parseReactionIds(text, candidates);
}

function parseReactionIds(
  text: string,
  candidates: ReactionIR[]
): string[] | null {
  if (!text) return null;
  const validIds = new Set(candidates.map((r) => r.id));
  // Strip code fences if the model added them despite instructions.
  const stripped = text
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  // Try strict JSON object first, then any embedded JSON object/array.
  const candidatesJson: string[] = [];
  candidatesJson.push(stripped);
  const objMatch = stripped.match(/\{[\s\S]*\}/);
  if (objMatch) candidatesJson.push(objMatch[0]);
  const arrMatch = stripped.match(/\[[\s\S]*\]/);
  if (arrMatch) candidatesJson.push(arrMatch[0]);

  for (const raw of candidatesJson) {
    try {
      const parsed = JSON.parse(raw);
      const ids: unknown = Array.isArray(parsed)
        ? parsed
        : (parsed as { ids?: unknown })?.ids;
      if (!Array.isArray(ids)) continue;
      const filtered = ids.filter(
        (x): x is string => typeof x === "string" && validIds.has(x)
      );
      // Empty array is a meaningful signal ("nothing relevant") — return it.
      return filtered;
    } catch {
      // try next candidate
    }
  }
  return null;
}
