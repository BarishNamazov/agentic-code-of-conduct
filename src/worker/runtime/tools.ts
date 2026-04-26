// Tool adapter layer.
//
// Tools are invoked exclusively through `runTool`. Every invocation is wrapped in
// a `Tooling.called` request action and a `Tooling.completed` (or `Tooling.failed`)
// attestation, both of which are recorded in the workspace action log.

import { generateText, streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

export type ToolEnv = {
  AI?: { run: (m: string, i: unknown, o?: unknown) => Promise<unknown> };
};

export type ToolStreamWriter = {
  token(text: string): void;
};

export type ToolResult = {
  output?: unknown;
  error?: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  run: (
    env: ToolEnv,
    input: Record<string, unknown>,
    ctx: { stream?: ToolStreamWriter; host: ToolHostQueries }
  ) => Promise<ToolResult>;
};

// Lookups that tools may need from the surrounding workspace.
export type ToolHostQueries = {
  searchMemory(query: string): unknown[];
};

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct";

const llmGenerate: ToolDefinition = {
  name: "llm.generate",
  description:
    "Free-form text generation via the configured Workers AI binding (or echo fallback when AI is missing).",
  async run(env, input, ctx) {
    const prompt = String(input.prompt ?? input.input ?? "");
    if (!prompt) return { error: "Missing 'prompt'." };
    if (!env.AI) {
      const echoed = `[no AI binding] ${prompt.slice(0, 800)}`;
      ctx.stream?.token(echoed);
      return { output: echoed };
    }
    try {
      const workersai = createWorkersAI({ binding: env.AI as never });
      const result = streamText({
        model: workersai(DEFAULT_MODEL as never),
        prompt,
      });
      let acc = "";
      for await (const chunk of result.textStream) {
        acc += chunk;
        ctx.stream?.token(chunk);
      }
      return { output: acc };
    } catch (e) {
      // Some Workers AI models don't support streaming; fall back to non-streaming.
      try {
        const workersai = createWorkersAI({ binding: env.AI as never });
        const { text } = await generateText({
          model: workersai(DEFAULT_MODEL as never),
          prompt,
        });
        ctx.stream?.token(text);
        return { output: text };
      } catch (err) {
        return { error: errorMessage(err) || errorMessage(e) };
      }
    }
  },
};

const memorySearch: ToolDefinition = {
  name: "memory.search",
  description:
    "Search the workspace's action log for prior actions whose serialized arguments contain the query string.",
  async run(_env, input, ctx) {
    const q = String(input.query ?? "").trim();
    if (!q) return { output: [] };
    return { output: ctx.host.searchMemory(q) };
  },
};

const httpFetch: ToolDefinition = {
  name: "http.fetch",
  description:
    "Fetch a URL with GET. Limited to https:// for safety. Returns truncated body.",
  async run(_env, input) {
    const url = String(input.url ?? "");
    if (!url.startsWith("https://")) {
      return { error: "Only https:// URLs are allowed." };
    }
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { "user-agent": "behaving-agents/0.1" },
      });
      const body = await res.text();
      return {
        output: {
          status: res.status,
          contentType: res.headers.get("content-type"),
          body: body.slice(0, 4000),
        },
      };
    } catch (e) {
      return { error: errorMessage(e) };
    }
  },
};

export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  [llmGenerate.name]: llmGenerate,
  [memorySearch.name]: memorySearch,
  [httpFetch.name]: httpFetch,
};

export function listAvailableTools() {
  return Object.values(TOOL_REGISTRY).map((t) => ({
    name: t.name,
    description: t.description,
  }));
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
