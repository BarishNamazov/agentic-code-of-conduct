const CEREBRAS_API_URL = "https://api.cerebras.ai/v1/chat/completions";
const CEREBRAS_MODEL = "zai-glm-4.7";

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

export async function cerebrasGenerate(
  apiKey: string,
  prompt: string,
  caller: string
): Promise<{ text: string; error?: string }> {
  const id = `llm_${crypto.randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  const record: LlmCallRecord = {
    id,
    model: CEREBRAS_MODEL,
    caller,
    prompt,
    startedAt,
  };

  listener?.onStart({ ...record });

  try {
    const res = await fetch(CEREBRAS_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: CEREBRAS_MODEL,
        stream: false,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: -1,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      const error = `Cerebras ${res.status}: ${body.slice(0, 400)}`;
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

  const record: LlmCallRecord = {
    id,
    model: CEREBRAS_MODEL,
    caller,
    prompt: `[system] ${system}\n\n[user] ${prompt}`,
    startedAt,
  };

  listener?.onStart({ ...record });

  try {
    const res = await fetch(CEREBRAS_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: CEREBRAS_MODEL,
        stream: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        max_tokens: -1,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      const error = `Cerebras ${res.status}: ${body.slice(0, 400)}`;
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
