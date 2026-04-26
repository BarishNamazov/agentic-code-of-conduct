// Binding helpers: variable resolution, summarization, prompt composition.

import type { RunBinding } from "./types";

// Replace `?key` placeholders in an arg map with values from the run's binding.
// If the key is absent in the binding, we leave the literal placeholder so the
// caller (or LLM) can still see what was requested.
export function resolveArgs(
  args: Record<string, string>,
  binding: RunBinding
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

// Trim a value into a short string suitable for action-log args / tool summaries.
export function summarize(value: unknown, max = 240): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    return value.length > max ? value.slice(0, max) + "…" : value;
  }
  try {
    const json = JSON.stringify(value);
    return json.length > max ? json.slice(0, max) + "…" : json;
  } catch {
    return String(value);
  }
}

// If the reaction author wrote an explicit `prompt` arg, respect it but still
// surface the user's message so the LLM sees the full conversation context.
export function composeWithUserInput(prompt: string, userInput: string): string {
  if (!userInput) return prompt;
  if (prompt.includes(userInput)) return prompt;
  return `User message:\n${userInput}\n\n${prompt}`;
}

export function truncate(s: string | undefined | null, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
