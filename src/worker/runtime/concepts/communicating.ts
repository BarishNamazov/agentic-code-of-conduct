// Communicating concept: multi-turn dialogue between two agents.
//
// Lifecycle actions (gerund concept, past-tense actions per repo convention):
//   request:   Communicating.start | Communicating.ask | Communicating.converse
//   attest:    Communicating.started, Communicating.asked, Communicating.answered,
//              Communicating.concluded, Communicating.sent
//
// Flow:
//   1. Resolve recipient (id → exact name → fuzzy fallback). Reject self-talk.
//   2. Seed the first message (args.message | question | topic | goal | LLM-derived).
//   3. Loop up to MAX_TURNS:
//        a. Log Communicating.asked and run the recipient with the question
//           (capture-only sink — recipient tokens do NOT leak to the user).
//        b. Log Communicating.answered.
//        c. Ask the initiator's planner LLM whether they're satisfied. The
//           response is JSON: {satisfied: bool, summary?: string, next?: string}.
//        d. If satisfied, log Communicating.concluded(satisfied=true) and break.
//   4. On budget exhaustion: Communicating.concluded(satisfied=false, reason="max_turns").
//   5. Stream a single user-facing summary; bind transcript for downstream steps.
//
// All recipient runs share the parent `runId` and use `Communicating.asked`
// as their `causedByActionId` for traceable provenance.

import { record } from "../action-log";
import { asString, summarize, truncate } from "../binding";
import { generatePlannerText } from "../tools";
import type {
  RunBinding,
  RunContext,
  RunHooks,
  RunSink,
  RuntimeEnv,
} from "../types";
import { runAndCapture } from "./spawning";

export const MAX_COMMUNICATION_TURNS = 6;

export type CommunicationOutcome = {
  conversationId: string;
  recipient: { id: string; name: string } | null;
  satisfied: boolean;
  reason: ConclusionReason;
  summary: string;
  turnCount: number;
  transcript: TurnEntry[];
};

export type TurnEntry = {
  turn: number;
  question: string;
  reply: string;
};

export type ConclusionReason =
  | "satisfied"
  | "max_turns"
  | "recipient_not_found"
  | "self_communication"
  | "child_error"
  | "planner_error"
  | "missing_message";

export async function executeCommunicating(
  args: Record<string, unknown>,
  requestActionId: string,
  reactionId: string | null,
  ctx: RunContext,
  hooks: RunHooks,
  sink: RunSink,
  env: RuntimeEnv,
  binding: RunBinding,
  options: { streamSummaryToSink?: boolean } = {}
): Promise<CommunicationOutcome> {
  const streamSummary = options.streamSummaryToSink !== false;
  const conversationId = `conv_${crypto.randomUUID().slice(0, 8)}`;

  const recipientQuery =
    asString(args.with) ||
    asString(args.to) ||
    asString(args.recipient) ||
    asString(args.agent) ||
    asString(args.agentId);

  const topic =
    asString(args.topic) ||
    asString(args.goal) ||
    asString(args.subject) ||
    "";

  const recipient = await resolveRecipient(recipientQuery, ctx.agentId, hooks);

  if (!recipient) {
    return await concludeWith(
      conversationId,
      ctx,
      hooks,
      sink,
      requestActionId,
      reactionId,
      {
        satisfied: false,
        reason: recipientQuery
          ? "recipient_not_found"
          : "recipient_not_found",
        summary: recipientQuery
          ? `No agent matched "${recipientQuery}".`
          : "No recipient was specified.",
        turnCount: 0,
        transcript: [],
        recipient: null,
      },
      binding,
      streamSummary
    );
  }

  if (recipient.id === ctx.agentId) {
    return await concludeWith(
      conversationId,
      ctx,
      hooks,
      sink,
      requestActionId,
      reactionId,
      {
        satisfied: false,
        reason: "self_communication",
        summary: "An agent cannot start a conversation with itself.",
        turnCount: 0,
        transcript: [],
        recipient,
      },
      binding,
      streamSummary
    );
  }

  // Seed message — explicit > LLM-derived from topic + run input.
  let message =
    asString(args.message) ||
    asString(args.question) ||
    asString(args.object);

  if (!message) {
    message = await formulateOpeningMessage(
      env,
      topic,
      asString(binding.input),
      ctx,
      recipient
    );
  }

  if (!message) {
    return await concludeWith(
      conversationId,
      ctx,
      hooks,
      sink,
      requestActionId,
      reactionId,
      {
        satisfied: false,
        reason: "missing_message",
        summary: "Could not formulate an opening message.",
        turnCount: 0,
        transcript: [],
        recipient,
      },
      binding,
      streamSummary
    );
  }

  const startedAction = await record(
    hooks,
    {
      by: ctx.agentId,
      action: "Communicating.started",
      args: {
        conversation: conversationId,
        initiator: ctx.agentId,
        recipient: recipient.id,
        recipientName: recipient.name,
        topic,
      },
      behaviorVersionId: ctx.behaviorVersionId,
      runId: ctx.runId,
      causedByActionId: requestActionId,
      causedByReactionId: reactionId,
    },
    sink
  );

  const transcript: TurnEntry[] = [];
  let lastCause = startedAction.id;
  let satisfied = false;
  let reason: ConclusionReason = "max_turns";
  let summaryText = "";

  for (let turn = 1; turn <= MAX_COMMUNICATION_TURNS; turn++) {
    const askedAction = await record(
      hooks,
      {
        by: ctx.agentId,
        action: "Communicating.asked",
        args: {
          conversation: conversationId,
          turn,
          from: ctx.agentId,
          to: recipient.id,
          message: summarize(message, 800),
        },
        behaviorVersionId: ctx.behaviorVersionId,
        runId: ctx.runId,
        causedByActionId: lastCause,
        causedByReactionId: reactionId,
      },
      sink
    );

    let reply = "";
    try {
      reply = await runAndCapture(hooks, {
        childAgentId: recipient.id,
        userInput: wrapInterAgentMessage({
          fromName: nameForActor(ctx),
          conversationId,
          turn,
          topic,
          message,
        }),
        runId: ctx.runId,
        parentSink: sink,
        causedByActionId: askedAction.id,
        // Capture-only: recipient tokens are NOT forwarded to the user.
        // The full conversation is observable through the action log; only
        // the final summary is shown live.
        forwardToParent: false,
      });
    } catch (e) {
      reason = "child_error";
      summaryText = `Recipient failed: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }

    const answeredAction = await record(
      hooks,
      {
        by: recipient.id,
        action: "Communicating.answered",
        args: {
          conversation: conversationId,
          turn,
          from: recipient.id,
          to: ctx.agentId,
          inReplyToActionId: askedAction.id,
          message: summarize(reply, 800),
        },
        behaviorVersionId: ctx.behaviorVersionId,
        runId: ctx.runId,
        causedByActionId: askedAction.id,
        causedByReactionId: reactionId,
      },
      sink
    );

    transcript.push({ turn, question: message, reply });
    lastCause = answeredAction.id;

    const evaluation = await evaluateSatisfaction(env, {
      topic,
      goal: asString(binding.input),
      transcript,
      maxTurns: MAX_COMMUNICATION_TURNS,
      remainingTurns: MAX_COMMUNICATION_TURNS - turn,
    });

    if (evaluation.error) {
      reason = "planner_error";
      summaryText = evaluation.error;
      break;
    }
    if (evaluation.satisfied) {
      satisfied = true;
      reason = "satisfied";
      summaryText = evaluation.summary || compactTranscript(transcript);
      break;
    }
    if (turn === MAX_COMMUNICATION_TURNS) {
      satisfied = false;
      reason = "max_turns";
      summaryText = evaluation.summary || compactTranscript(transcript);
      break;
    }

    // Continue dialogue.
    message =
      evaluation.next?.trim() ||
      `Could you elaborate further on the previous point?`;
  }

  return await concludeWith(
    conversationId,
    ctx,
    hooks,
    sink,
    requestActionId,
    reactionId,
    {
      satisfied,
      reason,
      summary: summaryText || compactTranscript(transcript),
      turnCount: transcript.length,
      transcript,
      recipient,
    },
    binding,
    streamSummary
  );
}

// -------- Recipient resolution --------

async function resolveRecipient(
  query: string,
  selfAgentId: string,
  hooks: RunHooks
): Promise<{ id: string; name: string } | null> {
  if (!query.trim()) return null;
  const q = query.trim();

  // Best deterministic option first: exact agent id.
  const list = (await hooks.toolHost.listAgents?.()) ?? [];
  const byId = list.find((a) => a.id === q);
  if (byId) return { id: byId.id, name: byId.name };

  // Exact (case-insensitive) name match. Prefer a non-self match.
  const lowered = q.toLowerCase();
  const exactName = list.filter((a) => a.name.toLowerCase() === lowered);
  const nonSelfExact = exactName.filter((a) => a.id !== selfAgentId);
  if (nonSelfExact.length === 1) {
    return { id: nonSelfExact[0]!.id, name: nonSelfExact[0]!.name };
  }
  if (nonSelfExact.length > 1) {
    // Ambiguous exact name: fall through to fuzzy, but bias toward most recent.
    const pick = nonSelfExact[0]!;
    return { id: pick.id, name: pick.name };
  }

  // Fuzzy fallback via search.
  const matches = (await hooks.toolHost.searchAgents?.(q)) ?? [];
  const filtered = matches.filter((m) => m.id !== selfAgentId);
  if (filtered.length === 0) return null;
  return { id: filtered[0]!.id, name: filtered[0]!.name };
}

function nameForActor(ctx: RunContext): string {
  return ctx.bcir.agent?.name || ctx.agentId;
}

function wrapInterAgentMessage(input: {
  fromName: string;
  conversationId: string;
  turn: number;
  topic: string;
  message: string;
}): string {
  const header =
    `[Inter-agent message — conversation ${input.conversationId}, turn ${input.turn}, ` +
    `from "${input.fromName}"${input.topic ? `, topic: ${input.topic}` : ""}]`;
  return `${header}\n\n${input.message}\n\nReply directly to the question above.`;
}

// -------- Opening message + satisfaction evaluator --------

async function formulateOpeningMessage(
  env: RuntimeEnv,
  topic: string,
  userInput: string,
  ctx: RunContext,
  recipient: { name: string }
): Promise<string> {
  const seedTopic = topic || userInput;
  if (!seedTopic) return "";
  const prompt = [
    `You are agent "${nameForActor(ctx)}". You are about to start a conversation with another agent named "${recipient.name}".`,
    topic ? `Topic / goal of the conversation: ${topic}` : "",
    userInput ? `Underlying user request driving this conversation:\n${truncate(userInput, 1200)}` : "",
    `Write a single concise opening message (2-4 sentences) that asks them what you need to know. Output the message text only — no preamble, no quotes.`,
  ]
    .filter(Boolean)
    .join("\n");
  const { text, error } = await generatePlannerText(env, prompt);
  if (error) return seedTopic;
  return text.trim() || seedTopic;
}

async function evaluateSatisfaction(
  env: RuntimeEnv,
  input: {
    topic: string;
    goal: string;
    transcript: TurnEntry[];
    maxTurns: number;
    remainingTurns: number;
  }
): Promise<{ satisfied: boolean; summary?: string; next?: string; error?: string }> {
  const transcriptText = input.transcript
    .map(
      (t) => `Turn ${t.turn} — you asked: ${t.question}\nThey replied: ${t.reply}`
    )
    .join("\n\n");
  const prompt = [
    `You are evaluating whether a conversation with another agent has met your needs.`,
    input.topic ? `Topic / goal: ${input.topic}` : "",
    input.goal ? `Underlying user request: ${truncate(input.goal, 800)}` : "",
    `\nConversation so far:\n${truncate(transcriptText, 4000)}`,
    `\nDecide if you have enough information to act. Output ONLY a single JSON object — no markdown.`,
    `If satisfied: {"satisfied": true, "summary": "<concise summary of what you learned>"}`,
    `If not satisfied and you want to ask another question: {"satisfied": false, "next": "<your next question, 1-3 sentences>"}`,
    `Remaining turns available: ${input.remainingTurns}. Be decisive — only continue if a follow-up is genuinely needed.`,
  ]
    .filter(Boolean)
    .join("\n");
  const { text, error } = await generatePlannerText(env, prompt);
  if (error) return { satisfied: false, error };
  const parsed = parseSatisfactionJSON(text);
  if (!parsed) {
    // Fall back: if no remaining turns, treat the raw text as the summary.
    return {
      satisfied: input.remainingTurns === 0,
      summary: text.trim().slice(0, 800) || undefined,
    };
  }
  return parsed;
}

function parseSatisfactionJSON(
  raw: string
): { satisfied: boolean; summary?: string; next?: string } | null {
  if (!raw) return null;
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof obj.satisfied !== "boolean") return null;
    return {
      satisfied: obj.satisfied,
      summary: typeof obj.summary === "string" ? obj.summary : undefined,
      next: typeof obj.next === "string" ? obj.next : undefined,
    };
  } catch {
    return null;
  }
}

// -------- Conclusion --------

async function concludeWith(
  conversationId: string,
  ctx: RunContext,
  hooks: RunHooks,
  sink: RunSink,
  requestActionId: string,
  reactionId: string | null,
  outcome: Omit<CommunicationOutcome, "conversationId">,
  binding: RunBinding,
  streamSummary: boolean
): Promise<CommunicationOutcome> {
  await record(
    hooks,
    {
      by: ctx.agentId,
      action: "Communicating.concluded",
      args: {
        conversation: conversationId,
        satisfied: outcome.satisfied,
        reason: outcome.reason,
        turnCount: outcome.turnCount,
        recipient: outcome.recipient?.id ?? null,
        recipientName: outcome.recipient?.name ?? null,
        summary: summarize(outcome.summary, 600),
      },
      behaviorVersionId: ctx.behaviorVersionId,
      runId: ctx.runId,
      causedByActionId: requestActionId,
      causedByReactionId: reactionId,
    },
    sink
  );

  binding.lastConversation = outcome.transcript;
  binding.lastConversationSummary = outcome.summary;

  if (streamSummary && outcome.summary) {
    sink.send({ type: "token", text: outcome.summary });
  }

  return { conversationId, ...outcome };
}

function compactTranscript(transcript: TurnEntry[]): string {
  if (transcript.length === 0) return "";
  const last = transcript[transcript.length - 1]!;
  return truncate(last.reply, 600);
}
