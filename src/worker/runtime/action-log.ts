// Append-only action-log helper. Persists, broadcasts, and mirrors an action
// envelope. Always go through `record()` — concept handlers must not insert
// directly into `action_log`.

import type { ActingEnvelope } from "../../shared/types";
import type { RunHooks, RunSink } from "./types";

export async function record(
  hooks: RunHooks,
  envelope: Omit<ActingEnvelope, "id" | "createdAt">,
  sink: RunSink
): Promise<{ id: string; createdAt: string }> {
  const createdAt = new Date().toISOString();
  const id = await hooks.logAction(envelope);
  sink.send({
    type: "event",
    event: {
      id,
      actorAgentId: envelope.by,
      action: envelope.action,
      args: envelope.args,
      runId: envelope.runId ?? null,
      behaviorVersionId: envelope.behaviorVersionId ?? null,
      causedByActionId: envelope.causedByActionId ?? null,
      causedByReactionId: envelope.causedByReactionId ?? null,
      createdAt,
    },
  });
  // Mirror to the actor's local action log. Best-effort: if the actor is the
  // workspace itself, or the agent has been deleted, just skip.
  void hooks
    .mirrorActionToChild(envelope.by, {
      ...envelope,
      id,
      createdAt,
    })
    .catch(() => {
      /* mirroring is best-effort */
    });
  return { id, createdAt };
}
