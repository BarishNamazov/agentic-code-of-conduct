// Normalize raw behavioral input into BCIR.
//
// Pipeline:
//   1. If JSON parses and looks like BCIR, return it.
//   2. Try the lightweight markdown / DSL parser.
//   3. If `env.AI` is available, ask an LLM to fill in the gaps.
//   4. Otherwise return whatever the parser produced with low-confidence warnings.
//
// We deliberately do not require the LLM. The deterministic parser must always
// be able to produce a runnable (if minimal) BCIR.

import type {
  BCIR,
  BehaviorFormat,
  CompileBehaviorInput,
  CompilerWarning,
  ConceptIR,
  ReactionIR,
  ThenActionIR,
  ToolSpecIR,
} from "../../shared/types";
import { listAvailableTools } from "../runtime/tools";
import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

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

// --- DSL / Markdown parser ---

const KNOWN_KERNEL_CONCEPTS = new Set([
  "Tooling",
  "Spawning",
  "Communicating",
  "Approving",
  "Revising",
  "Running",
  "Requesting",
  "Creating",
  "Building",
  "UserInput",
]);

const VERB_TO_CONCEPT: Record<string, string> = {
  read: "Reading",
  reading: "Reading",
  extract: "Claiming",
  claim: "Claiming",
  search: "Searching",
  searched: "Searching",
  summarize: "Summarizing",
  summarise: "Summarizing",
  summary: "Summarizing",
  review: "Reviewing",
  reviewing: "Reviewing",
  spawn: "Spawning",
  call: "Tooling",
  send: "Communicating",
  message: "Communicating",
  email: "Communicating",
  ask: "Communicating",
  discuss: "Communicating",
  converse: "Communicating",
  talk: "Communicating",
  consult: "Communicating",
  write: "Writing",
  generate: "Generating",
  fetch: "Fetching",
  analyze: "Analyzing",
  classify: "Classifying",
  notify: "Notifying",
  approve: "Approving",
  reply: "Communicating",
  respond: "Communicating",
};

function gerund(verb: string): string {
  const v = verb.toLowerCase();
  if (v.endsWith("e")) return cap(v.slice(0, -1) + "ing");
  if (/[^aeiou][aeiou][^aeiouwy]$/.test(v)) {
    return cap(v + v.slice(-1) + "ing");
  }
  return cap(v + "ing");
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function extractAgentName(text: string): string | null {
  const m =
    text.match(/^\s*Agent[:\s]+([^\n]+)/im) ||
    text.match(/^\s*#\s+Agent[:\s]+([^\n]+)/im) ||
    text.match(/^\s*name[:\s]+["']?([^"'\n]+)/im);
  return m && m[1] ? m[1].trim() : null;
}

function extractPurpose(text: string): string | undefined {
  const m =
    text.match(/^\s*Purpose[:\s]+([^\n]+)/im) ||
    text.match(/^\s*Description[:\s]+([^\n]+)/im);
  return m && m[1] ? m[1].trim() : undefined;
}

// Heuristically split prose into reaction-shaped sentences.
// Recognises "When X, do Y", "After X, Y", "If X, Y", "For each X, Y".
function extractReactionSentences(text: string): string[] {
  const lines = text
    .split(/\n+/)
    .map((l) => l.replace(/^[-*\d.\s>]+/, "").trim())
    .filter(Boolean);
  const sentences: string[] = [];
  for (const line of lines) {
    // also split on ". " sentence boundaries
    for (const part of line.split(/(?<=[.!?])\s+(?=[A-Z])/)) {
      const t = part.trim();
      if (!t) continue;
      if (/^(when|after|if|on|whenever|once|for each)\b/i.test(t)) {
        sentences.push(t);
      }
    }
  }
  return sentences;
}

const ACTION_VERBS = Object.keys(VERB_TO_CONCEPT);
const VERB_RE = new RegExp(
  `\\b(${ACTION_VERBS.join("|")})\\b([\\s\\S]*?)(?=$|,|\\.|;)`,
  "gi"
);

// Pronouns and meta-references that point back at the triggering input
// rather than to a literal value. When a behavior says
// `When the user submits a paper draft, read it.` the "it" must resolve
// to the actual draft, not to the literal string "it".
const INPUT_PRONOUN_RE =
  /^(it|this|that|them|those|these|the (?:input|message|document|draft|text|content|prompt|request|paper|file|submission)|user (?:input|message))(\s+.*)?$/i;

function actionFromVerb(verb: string, rest: string): {
  posture: "request" | "attest";
  action: string;
  args: Record<string, string>;
} {
  const v = verb.toLowerCase();
  const concept = VERB_TO_CONCEPT[v] ?? cap(v);
  // All verbs map to request posture today; attest comes from explicit
  // past-tense action phrasing handled elsewhere.
  const posture: "request" | "attest" = "request";
  // Try to extract an object/argument string
  let arg = rest
    .replace(/^[\s,:;-]+/, "")
    .replace(/^(the|a|an|some)\s+/i, "")
    .trim();

  // If the object is a pronoun referring back to the user's input,
  // bind to ?input so the run loop substitutes the real value.
  let argRef: string | null = null;
  if (arg && INPUT_PRONOUN_RE.test(arg)) {
    argRef = "?input";
    arg = "";
  }

  const action = `${concept}.${normalisedAction(v)}`;
  const args: Record<string, string> = {};
  if (argRef) {
    args.object = argRef;
  } else if (arg) {
    args.object = arg;
  } else {
    args.object = "?input";
  }
  return { posture, action, args };
}

function normalisedAction(verb: string): string {
  // Map verb to past-tense action name used in the spec.
  const map: Record<string, string> = {
    read: "read",
    extract: "extract",
    claim: "extracted",
    search: "called",
    summarize: "compose",
    summarise: "compose",
    review: "completed",
    spawn: "spawn",
    call: "called",
    send: "send",
    message: "send",
    email: "send",
    write: "write",
    generate: "generate",
    fetch: "fetch",
    analyze: "analyze",
    classify: "classify",
    notify: "notify",
    approve: "requested",
    reply: "send",
    respond: "send",
  };
  return map[verb.toLowerCase()] ?? verb.toLowerCase();
}

function parseDSLOrMarkdown(text: string): {
  reactions: ReactionIR[];
  concepts: ConceptIR[];
  warnings: CompilerWarning[];
} {
  const warnings: CompilerWarning[] = [];
  const sentences = extractReactionSentences(text);
  const reactions: ReactionIR[] = [];
  const conceptMap = new Map<string, ConceptIR>();

  function ensureConcept(name: string) {
    if (KNOWN_KERNEL_CONCEPTS.has(name)) return;
    if (!conceptMap.has(name)) {
      conceptMap.set(name, {
        name,
        purpose: `Auto-derived concept ${name}.`,
        actions: [],
      });
    }
  }

  // Heuristic: the very first reaction always starts on UserInput.received
  // unless the prose explicitly mentions a different trigger.
  let entryAssigned = false;

  for (const sentence of sentences) {
    const reactionId = uid("r");
    const trigger = parseTrigger(sentence, !entryAssigned);
    if (trigger.action.startsWith("UserInput")) entryAssigned = true;

    const then: ThenActionIR[] = [];
    let m: RegExpExecArray | null;
    VERB_RE.lastIndex = 0;
    while ((m = VERB_RE.exec(sentence))) {
      const [, verb, rest] = m as unknown as [string, string, string];
      // Skip the verb if it is the trigger verb (after "when X").
      if (
        new RegExp(`^when\\s+\\S+\\s+\\S*\\s*${verb}`, "i").test(sentence) &&
        then.length === 0
      ) continue;
      const a = actionFromVerb(verb, rest);
      then.push(a);
      ensureConcept(a.action.split(".")[0] ?? "");
    }

    if (then.length === 0) {
      // Fallback: ask the LLM/runtime to figure it out by emitting a generic
      // generate request.
      then.push({
        posture: "request",
        action: "Tooling.called",
        args: { tool: "llm.generate", prompt: sentence },
      });
    }

    reactions.push({
      id: reactionId,
      name: `R${reactions.length + 1}`,
      prose: sentence,
      formal: synthesizeFormal(trigger, then),
      when: [trigger],
      where: [],
      then,
    });
    ensureConcept(trigger.action.split(".")[0] ?? "");
  }

  if (reactions.length === 0) {
    // Whole behavior is just prose: create one catch-all reaction that
    // delegates to the agentic loop. Building.act lets the runtime use the
    // LLM, multiple tools, sub-agents, and self-modification to fulfil the
    // request rather than emitting a single naive llm.generate call.
    reactions.push({
      id: uid("r"),
      name: "R1",
      prose: text.trim().slice(0, 500),
      formal: "when UserInput.received do Building.act(goal: ?input)",
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
    });
    ensureConcept("Building");
    warnings.push({
      level: "info",
      message:
        "No structured reactions detected. Defaulted to the agentic loop (Building.act).",
    });
  }

  return {
    reactions,
    concepts: Array.from(conceptMap.values()),
    warnings,
  };
}

function parseTrigger(
  sentence: string,
  defaultToUserInput: boolean
): { bind?: string; action: string; args: Record<string, string> } {
  // "When the paper draft is submitted, ..." -> Drafting.submitted
  const m = sentence.match(
    /^(?:when|after|if|on|whenever|once|for each)\s+([^,]+?)\s+(is|are|was|gets|has|completes|completed|finishes|finished)\s+([a-z]+)/i
  );
  if (m) {
    const subject = (m[1] ?? "").trim();
    const verb = (m[3] ?? "").trim().toLowerCase();
    const conceptGuess = guessConceptFromSubject(subject);
    return {
      bind: "?event",
      action: `${conceptGuess}.${normalisedAction(verb)}`,
      args: { subject },
    };
  }
  // "When user says ..." or "When asked ..."
  if (/^(when|after|if|on)\s+(user|the user)\b/i.test(sentence)) {
    return {
      bind: "?input",
      action: "UserInput.received",
      args: { input: "?input" },
    };
  }
  if (defaultToUserInput) {
    return {
      bind: "?input",
      action: "UserInput.received",
      args: { input: "?input" },
    };
  }
  // Fallback
  return {
    action: "Event.observed",
    args: { sentence },
  };
}

function guessConceptFromSubject(subject: string): string {
  const tokens = subject.toLowerCase().split(/\s+/);
  for (const token of tokens) {
    if (VERB_TO_CONCEPT[token]) return VERB_TO_CONCEPT[token];
  }
  // Pick the last noun-ish word and turn it into a gerund.
  const last = tokens[tokens.length - 1] ?? "event";
  return gerund(last);
}

function synthesizeFormal(
  trigger: { action: string; args: Record<string, string> },
  then: ThenActionIR[]
): string {
  const lhs = `${trigger.action}(${Object.entries(trigger.args)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ")})`;
  const rhs = then
    .map(
      (a) =>
        `${a.posture} ${a.action}(${Object.entries(a.args)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ")})`
    )
    .join("; ");
  return `when ${lhs} do ${rhs}`;
}

// --- LLM-powered normalization ---

const NORMALIZE_MODEL = "@cf/moonshotai/kimi-k2.6";

const NORMALIZE_SYSTEM_PROMPT = `You are a behavior compiler. You convert natural-language agent descriptions into structured BCIR (Behavioral Code Intermediate Representation).

Given the user's raw behavior text AND a draft BCIR produced by a deterministic parser, produce an improved BCIR JSON object.

## BCIR Schema

\`\`\`
{
  "agent": { "name": "<clear agent name>", "purpose": "<1-sentence purpose>" },
  "concepts": [
    { "name": "<PascalCase gerund, e.g. Summarizing>", "purpose": "<what this concept represents>", "actions": [{ "name": "<concept.action>", "params": ["param1"] }] }
  ],
  "reactions": [
    {
      "id": "<keep from draft or generate new>",
      "name": "<short descriptive name, e.g. SummarizeOnInput>",
      "prose": "<human-readable description of this reaction>",
      "formal": "when <Trigger.action>(args) do <posture> <Action>(args)",
      "when": [{ "bind": "?var", "action": "Concept.action", "args": { "key": "?var" } }],
      "where": [],
      "then": [
        { "posture": "request", "action": "Concept.action", "args": { "key": "value" } }
      ]
    }
  ]
}
\`\`\`

## Key concepts for "then" actions

- \`Building.act\` with \`{ "goal": "..." }\` — delegates to the agentic loop (multi-step LLM planning with tools). Use for complex tasks.
- \`Tooling.called\` with \`{ "tool": "toolName", ... }\` — calls a specific tool directly.
- \`Spawning.spawn\` with \`{ "name": "...", "purpose": "...", "behavior": "...", "task": "..." }\` — spawns a child agent.
- \`Communicating.converse\` with \`{ "with": "<agent id or name>", "topic": "...", "message": "..." }\` — start a multi-turn dialogue with another agent and loop until satisfied. Use when peer review or back-and-forth clarification is needed.
- \`Communicating.send\` with \`{ "message": "..." }\` — sends a response to the user.

Available tools: llm.generate, memory.search, http.fetch, agent.writeFile, agent.readFile, agent.listFiles, agent.deleteFile, agent.setHandler, agent.listHandlers, agent.list, agent.search, agent.getBehavior, agent.spawn, agent.communicate, agent.updateBehavior.

## Triggers (when)

- \`UserInput.received\` with \`{ "input": "?input" }\` — fires when the user sends a message. This is the most common trigger.
- \`<Concept>.<action>\` — fires when a specific concept action is observed.

## Rules

1. Use \`?input\` to reference the user's input text in args.
2. Every reaction must have at least one "when" trigger and one "then" action.
3. Concept names should be PascalCase gerunds (Summarizing, Reviewing, Fetching).
4. Reaction names should be descriptive PascalCase (SummarizeDocument, HandleUserQuery).
5. For open-ended or complex tasks, prefer \`Building.act\` over chaining many specific tool calls.
6. For simple direct tasks (just call one tool), use \`Tooling.called\` directly.
7. Preserve reaction IDs from the draft when the reaction maps to the same intent.
8. If the raw text describes a single-purpose agent (e.g. "summarize papers"), create focused reactions — don't over-decompose.
9. The "formal" field is a human-readable summary: \`when Trigger(args) do posture Action(args); ...\`

Respond with ONLY the JSON object (no markdown fences, no explanation). The JSON must have keys: agent, concepts, reactions.`;

function buildNormalizePrompt(rawText: string, draft: BCIR): string {
  const draftSummary = {
    agent: draft.agent,
    concepts: draft.concepts,
    reactions: draft.reactions.map((r) => ({
      id: r.id,
      name: r.name,
      prose: r.prose,
      formal: r.formal,
      when: r.when,
      then: r.then,
    })),
  };

  return `## Raw behavior text

${rawText}

## Deterministic parser draft

${JSON.stringify(draftSummary, null, 2)}

Produce an improved BCIR JSON. Fix generic names, add missing reactions, improve prose descriptions, and ensure correct action mappings. Keep the same structure if the draft is already good — only improve what needs improving.`;
}

function tryParseLLMResponse(text: string): {
  agent?: { name: string; purpose?: string };
  concepts?: ConceptIR[];
  reactions?: ReactionIR[];
} | null {
  // Extract JSON from the response (handle markdown fences)
  let json = text.trim();
  const fenced = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenced) json = fenced[1]!.trim();

  // Find the first { ... } block
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

function validateLLMReaction(r: unknown): r is ReactionIR {
  if (!r || typeof r !== "object") return false;
  const obj = r as Record<string, unknown>;
  return (
    typeof obj.name === "string" &&
    typeof obj.prose === "string" &&
    Array.isArray(obj.when) &&
    obj.when.length > 0 &&
    Array.isArray(obj.then) &&
    obj.then.length > 0
  );
}

function mergeLLMResult(
  draft: BCIR,
  llmResult: {
    agent?: { name: string; purpose?: string };
    concepts?: ConceptIR[];
    reactions?: ReactionIR[];
  }
): BCIR {
  const agent = {
    name: llmResult.agent?.name || draft.agent.name,
    purpose: llmResult.agent?.purpose || draft.agent.purpose,
  };

  let reactions = draft.reactions;
  if (llmResult.reactions && llmResult.reactions.length > 0) {
    const validated = llmResult.reactions.filter(validateLLMReaction);
    if (validated.length > 0) {
      reactions = validated.map((r, i) => ({
        id: r.id || uid("r"),
        name: r.name || `R${i + 1}`,
        prose: r.prose,
        formal:
          r.formal ||
          synthesizeFormal(
            r.when[0] ?? {
              action: "UserInput.received",
              args: { input: "?input" },
            },
            r.then
          ),
        when: r.when,
        where: r.where || [],
        then: r.then.map((t) => ({
          posture: t.posture || "request",
          action: t.action,
          args: t.args || {},
        })),
      }));
    }
  }

  let concepts = draft.concepts;
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
    ...draft,
    agent,
    concepts,
    reactions,
    tools: collectTools(reactions),
    permissions: collectPermissions(reactions),
  };
}

async function polishWithLLM(
  env: { AI?: Ai },
  draft: BCIR
): Promise<{ bcir: BCIR; warnings: CompilerWarning[] }> {
  if (!env.AI) {
    return {
      bcir: draft,
      warnings: [
        {
          level: "info",
          message:
            "No AI binding present; behavior was normalized by the deterministic parser only.",
        },
      ],
    };
  }

  try {
    const workersai = createWorkersAI({ binding: env.AI as never });
    const prompt = buildNormalizePrompt(draft.raw.text, draft);
    const { text } = await generateText({
      model: workersai(NORMALIZE_MODEL as never),
      system: NORMALIZE_SYSTEM_PROMPT,
      prompt,
    });

    const parsed = tryParseLLMResponse(text);
    if (!parsed) {
      return {
        bcir: draft,
        warnings: [
          {
            level: "warn",
            message:
              "LLM normalization returned unparseable output; falling back to deterministic parse.",
          },
        ],
      };
    }

    const merged = mergeLLMResult(draft, parsed);
    return {
      bcir: merged,
      warnings: [
        {
          level: "info",
          message: "Behavior was normalized with LLM assistance.",
        },
      ],
    };
  } catch (e) {
    return {
      bcir: draft,
      warnings: [
        {
          level: "warn",
          message: `LLM normalization failed (${e instanceof Error ? e.message : "unknown error"}); falling back to deterministic parse.`,
        },
      ],
    };
  }
}

// --- Public entry point ---

export async function normalizeBehavior(
  env: { AI?: Ai },
  input: CompileBehaviorInput
): Promise<{ bcir: BCIR; warnings: CompilerWarning[] }> {
  const text = input.rawText;
  const format = detectFormat(text, input.rawFormat);

  // 1. JSON BCIR
  const json = tryParseBCIR(text);
  if (json) {
    return { bcir: json, warnings: [] };
  }

  // 2. Deterministic parser
  const { reactions, concepts, warnings } = parseDSLOrMarkdown(text);
  const name = extractAgentName(text) ?? "Untitled Agent";
  const purpose = extractPurpose(text);

  const tools = collectTools(reactions);
  const draft = withDefaultCapabilities({
    schemaVersion: "bcir.v0",
    agent: { name, purpose },
    raw: { format, text },
    concepts,
    reactions,
    tools,
    permissions: collectPermissions(reactions),
  });

  // 3. Optional LLM polish
  const { bcir, warnings: polishWarnings } = await polishWithLLM(env, draft);

  if (format === "unknown") {
    warnings.push({
      level: "warn",
      message:
        "Format could not be detected confidently. Review the parsed reactions before activating.",
    });
  }

  return {
    bcir: withDefaultCapabilities(bcir),
    warnings: [...warnings, ...polishWarnings],
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
