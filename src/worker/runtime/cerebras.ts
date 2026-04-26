import SHARED_SYSTEM_PROMPT from "../prompts/shared-system.prompt";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = "gpt-5.4-mini";

export type LlmCallRecord = {
  id: string;
  model: string;
  caller: string;
  prompt: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  output?: string;
  error?: string;
};

export type LlmCallListener = {
  onStart(record: LlmCallRecord): void;
  onEnd(record: LlmCallRecord): void;
};

let listener: LlmCallListener | null = null;

export function setLlmCallListener(l: LlmCallListener | null) {
  listener = l;
}

function sharedSystemPrompt(system?: string): string {
  const specific = system?.trim();
  return specific
    ? `${SHARED_SYSTEM_PROMPT.trim()}\n\n${specific}`
    : SHARED_SYSTEM_PROMPT.trim();
}

function recordPrompt(system: string, prompt: string): string {
  return `[system] ${system}\n\n[user] ${prompt}`;
}

export async function cerebrasGenerate(
  apiKey: string,
  prompt: string,
  caller: string
): Promise<{ text: string; error?: string }> {
  const id = `llm_${crypto.randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const system = sharedSystemPrompt();

  const record: LlmCallRecord = {
    id,
    model: OPENAI_MODEL,
    caller,
    prompt: recordPrompt(system, prompt),
    startedAt,
  };

  listener?.onStart({ ...record });

  try {
    const res = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        stream: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      const error = `OpenAI ${res.status}: ${body.slice(0, 400)}`;
      record.error = error;
      record.completedAt = new Date().toISOString();
      record.durationMs = Date.now() - startMs;
      listener?.onEnd({ ...record });
      return { text: "", error };
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = json.choices?.[0]?.message?.content ?? "";

    record.output = text;
    record.completedAt = new Date().toISOString();
    record.durationMs = Date.now() - startMs;
    listener?.onEnd({ ...record });

    return { text };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    record.error = error;
    record.completedAt = new Date().toISOString();
    record.durationMs = Date.now() - startMs;
    listener?.onEnd({ ...record });
    return { text: "", error };
  }
}

export async function cerebrasGenerateWithSystem(
  apiKey: string,
  system: string,
  prompt: string,
  caller: string
): Promise<{ text: string; error?: string }> {
  const id = `llm_${crypto.randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const composedSystem = sharedSystemPrompt(system);

  const record: LlmCallRecord = {
    id,
    model: OPENAI_MODEL,
    caller,
    prompt: recordPrompt(composedSystem, prompt),
    startedAt,
  };

  listener?.onStart({ ...record });

  try {
    const res = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        stream: false,
        messages: [
          { role: "system", content: composedSystem },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      const error = `OpenAI ${res.status}: ${body.slice(0, 400)}`;
      record.error = error;
      record.completedAt = new Date().toISOString();
      record.durationMs = Date.now() - startMs;
      listener?.onEnd({ ...record });
      return { text: "", error };
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = json.choices?.[0]?.message?.content ?? "";

    record.output = text;
    record.completedAt = new Date().toISOString();
    record.durationMs = Date.now() - startMs;
    listener?.onEnd({ ...record });

    return { text };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    record.error = error;
    record.completedAt = new Date().toISOString();
    record.durationMs = Date.now() - startMs;
    listener?.onEnd({ ...record });
    return { text: "", error };
  }
}
