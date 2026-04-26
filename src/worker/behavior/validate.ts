import type {
  BCIR,
  CompilerWarning,
  CompiledBehavior,
  ReactionIR,
  ValidationResult,
} from "../../shared/types";

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
