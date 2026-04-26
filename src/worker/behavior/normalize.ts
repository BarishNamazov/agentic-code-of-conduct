// Normalize raw behavioral input into BCIR.
//
// Pipeline:
//   1. If JSON parses and looks like BCIR, return it.
//   2. Ask an LLM to parse casual behavior text into BCIR.
//   3. If the LLM is unavailable or returns invalid JSON, return a generic
//      runnable BCIR that delegates to the agentic loop.

import type {
  BCIR,
  BehaviorFormat,
  CompileBehaviorInput,
  CompilerWarning,
  ConceptIR,
  ReactionIR,
  ToolSpecIR,
} from "../../shared/types";
import { listAvailableTools } from "../runtime/tools";
import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import NORMALIZE_SYSTEM_PROMPT from "../prompts/normalize-behavior.prompt";
import NORMALIZE_USER_PROMPT from "../prompts/normalize-behavior-user.prompt";
import { renderTemplate } from "../prompts/template";

const NORMALIZE_MODEL = "@cf/moonshotai/kimi-k2.6";

function uid(prefix = "id"): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function detectFormat(text: string, hint?: BehaviorFormat): BehaviorFormat {
  if (hint && hint !== "unknown") return hint;
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      /* fallthrough */
    }
  }
  if (/^(when|where|then)\b/im.test(trimmed)) return "behavioral-dsl";
  if (/^#\s|\n#\s|\*\s|^-\s/m.test(trimmed)) return "markdown";
  return "unknown";
}

function tryParseBCIR(text: string): BCIR | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.schemaVersion === "bcir.v0" && parsed.agent?.name) {
      return withDefaultCapabilities(parsed as BCIR);
    }
  } catch {
    /* not JSON */
  }
  return null;
}

function createFallbackBCIR(text: string, format: BehaviorFormat): BCIR {
  const reactions: ReactionIR[] = [
    {
      id: uid("r"),
      name: "HandleUserInput",
      prose: "Handle the user's input according to the provided behavior.",
      formal: "when UserInput.received(input: ?input) then request Building.act(goal: ?input)",
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
  ];

  return withDefaultCapabilities({
    schemaVersion: "bcir.v0",
    agent: {
      name: "Untitled Agent",
      purpose: "Act on user requests according to the provided behavior.",
    },
    raw: { format, text },
    concepts: [],
    reactions,
    tools: collectTools(reactions),
    permissions: collectPermissions(reactions),
  });
}

function buildNormalizePrompt(rawText: string, fallback: BCIR): string {
  const fallbackSummary = {
    agent: fallback.agent,
    concepts: fallback.concepts,
    reactions: fallback.reactions.map((r) => ({
      id: r.id,
      name: r.name,
      prose: r.prose,
      formal: r.formal,
      when: r.when,
      then: r.then,
    })),
  };

  return renderTemplate(NORMALIZE_USER_PROMPT, {
    RAW_BEHAVIOR_TEXT: rawText,
    FALLBACK_BCIR: JSON.stringify(fallbackSummary, null, 2),
  });
}

function tryParseLLMResponse(text: string): {
  agent?: { name: string; purpose?: string };
  concepts?: ConceptIR[];
  reactions?: ReactionIR[];
} | null {
  let json = text.trim();
  const fenced = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenced) json = fenced[1]!.trim();

  const start = json.indexOf("{");
  const end = json.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  json = json.slice(start, end + 1);

  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeArgs(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key.length > 0)
      .map(([key, arg]) => [key, String(arg)])
  );
}

function hasValidTrigger(value: unknown): boolean {
  return isRecord(value) && typeof value.action === "string";
}

function hasValidThenAction(value: unknown): boolean {
  return isRecord(value) && typeof value.action === "string";
}

function validateLLMReaction(r: unknown): r is ReactionIR {
  if (!isRecord(r)) return false;
  return (
    typeof r.name === "string" &&
    typeof r.prose === "string" &&
    Array.isArray(r.when) &&
    r.when.length > 0 &&
    r.when.every(hasValidTrigger) &&
    Array.isArray(r.then) &&
    r.then.length > 0 &&
    r.then.every(hasValidThenAction)
  );
}

function synthesizeFormal(r: ReactionIR): string {
  const trigger = r.when[0] ?? {
    action: "UserInput.received",
    args: { input: "?input" },
  };
  const lhs = `${trigger.action}(${Object.entries(normalizeArgs(trigger.args))
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ")})`;
  const rhs = r.then
    .map(
      (a) =>
        `${a.posture ?? "request"} ${a.action}(${Object.entries(a.args ?? {})
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ")})`
    )
    .join("; ");
  return `when ${lhs} then ${rhs}`;
}

function mergeLLMResult(
  fallback: BCIR,
  llmResult: {
    agent?: { name: string; purpose?: string };
    concepts?: ConceptIR[];
    reactions?: ReactionIR[];
  }
): BCIR {
  const agent = {
    name: llmResult.agent?.name || fallback.agent.name,
    purpose: llmResult.agent?.purpose || fallback.agent.purpose,
  };

  let reactions = fallback.reactions;
  if (llmResult.reactions && llmResult.reactions.length > 0) {
    const validated = llmResult.reactions.filter(validateLLMReaction);
    if (validated.length > 0) {
      reactions = validated.map((r, i) => ({
        id: r.id || uid("r"),
        name: r.name || `Reaction${i + 1}`,
        prose: r.prose,
        formal: r.formal || synthesizeFormal(r),
        when: r.when.map((w) => ({
          bind: typeof w.bind === "string" ? w.bind : undefined,
          action: w.action,
          args: normalizeArgs(w.args),
        })),
        where: r.where || [],
        then: r.then.map((t) => ({
          posture: t.posture || "request",
          action: t.action,
          args: normalizeArgs(t.args),
        })),
      }));
    }
  }

  let concepts = fallback.concepts;
  if (llmResult.concepts && llmResult.concepts.length > 0) {
    concepts = llmResult.concepts
      .filter(
        (c): c is ConceptIR =>
          !!c && typeof c === "object" && typeof c.name === "string"
      )
      .map((c) => ({
        name: c.name,
        purpose: c.purpose || `Concept ${c.name}.`,
        principle: c.principle,
        state: c.state,
        actions: Array.isArray(c.actions) ? c.actions : [],
      }));
  }

  return {
    ...fallback,
    agent,
    concepts,
    reactions,
    tools: collectTools(reactions),
    permissions: collectPermissions(reactions),
  };
}

async function parseWithLLM(
  env: { AI?: Ai },
  fallback: BCIR
): Promise<{ bcir: BCIR; warnings: CompilerWarning[] }> {
  if (!env.AI) {
    return {
      bcir: fallback,
      warnings: [
        {
          level: "warn",
          message:
            "No AI binding present; using generic agentic-loop behavior.",
        },
      ],
    };
  }

  try {
    const workersai = createWorkersAI({ binding: env.AI as never });
    const prompt = buildNormalizePrompt(fallback.raw.text, fallback);
    const { text } = await generateText({
      model: workersai(NORMALIZE_MODEL as never),
      system: NORMALIZE_SYSTEM_PROMPT,
      prompt,
    });

    const parsed = tryParseLLMResponse(text);
    if (!parsed) {
      return {
        bcir: fallback,
        warnings: [
          {
            level: "warn",
            message:
              "LLM normalization returned unparseable output; using generic agentic-loop behavior.",
          },
        ],
      };
    }

    return {
      bcir: mergeLLMResult(fallback, parsed),
      warnings: [
        {
          level: "info",
          message: "Behavior was normalized by the LLM parser.",
        },
      ],
    };
  } catch (e) {
    return {
      bcir: fallback,
      warnings: [
        {
          level: "warn",
          message: `LLM normalization failed (${e instanceof Error ? e.message : "unknown error"}); using generic agentic-loop behavior.`,
        },
      ],
    };
  }
}

export async function normalizeBehavior(
  env: { AI?: Ai },
  input: CompileBehaviorInput
): Promise<{ bcir: BCIR; warnings: CompilerWarning[] }> {
  const text = input.rawText;
  const format = detectFormat(text, input.rawFormat);

  const json = tryParseBCIR(text);
  if (json) {
    return { bcir: json, warnings: [] };
  }

  const fallback = createFallbackBCIR(text, format);
  const { bcir, warnings } = await parseWithLLM(env, fallback);

  return {
    bcir: withDefaultCapabilities(bcir),
    warnings,
  };
}

function collectTools(reactions: ReactionIR[]): ToolSpecIR[] {
  const tools = new Map<string, ToolSpecIR>();
  for (const tool of listAvailableTools()) {
    tools.set(tool.name, tool);
  }
  for (const r of reactions) {
    for (const t of r.then) {
      if (t.action === "Tooling.called") {
        const name = String(t.args.tool ?? "llm.generate");
        if (!tools.has(name)) {
          tools.set(name, {
            name,
            description: `Auto-declared from reaction ${r.name}.`,
          });
        }
      }
    }
  }
  return Array.from(tools.values());
}

function collectPermissions(reactions: ReactionIR[]) {
  const perms = new Set<string>(["tools"]);
  for (const r of reactions) {
    for (const t of r.then) {
      if (t.action.startsWith("Spawning.")) perms.add("spawn");
      if (t.action.startsWith("Communicating.")) perms.add("communicate");
      if (t.action.startsWith("Tooling.")) perms.add("tools");
    }
  }
  return Array.from(perms).map((capability) => ({ capability, scope: "self" }));
}

function withDefaultCapabilities(bcir: BCIR): BCIR {
  const tools = new Map<string, ToolSpecIR>();
  for (const tool of listAvailableTools()) {
    tools.set(tool.name, tool);
  }
  for (const tool of bcir.tools ?? []) {
    tools.set(tool.name, tool);
  }

  const permissions = new Map<string, { capability: string; scope: string }>();
  for (const permission of bcir.permissions ?? []) {
    permissions.set(`${permission.capability}:${permission.scope}`, permission);
  }
  permissions.set("tools:self", { capability: "tools", scope: "self" });

  return {
    ...bcir,
    tools: Array.from(tools.values()),
    permissions: Array.from(permissions.values()),
  };
}

// Cloudflare Workers AI binding type alias (loose).
type Ai = {
  run: (model: string, input: unknown, options?: unknown) => Promise<unknown>;
};
