// Tooling concept: tool execution lifecycle.
//
// Every tool call is bracketed by `Tooling.called` (request, recorded by the
// caller of runTool) and `Tooling.completed`/`Tooling.failed` attestations
// (recorded here). The tool_calls table tracks status / output / errors.

import { record } from "../action-log";
import { summarize } from "../binding";
import { resolveToolName, TOOL_REGISTRY, type ToolResult } from "../tools";
import type {
  RunBinding,
  RunContext,
  RunHooks,
  RunSink,
  RuntimeEnv,
} from "../types";

export async function runTool(
  toolName: string,
  args: Record<string, unknown>,
  requestActionId: string,
  ctx: RunContext,
  hooks: RunHooks,
  sink: RunSink,
  env: RuntimeEnv,
  binding: RunBinding
): Promise<ToolResult> {
  const canonicalToolName = resolveToolName(toolName);
  const tool = TOOL_REGISTRY[canonicalToolName];
  const toolCallId = `tc_${crypto.randomUUID().slice(0, 8)}`;

  hooks.insertToolCall({
    id: toolCallId,
    runId: ctx.runId,
    actorAgentId: ctx.agentId,
    toolName: canonicalToolName,
    requestActionId,
    inputJson: JSON.stringify(args),
  });

  sink.send({
    type: "tool",
    toolCallId,
    tool: canonicalToolName,
    input: args,
    actorAgentId: ctx.agentId,
  });

  hooks.updateToolCall({
    id: toolCallId,
    status: "running",
    startedAt: new Date().toISOString(),
  });

  if (!tool) {
    const err = `Unknown tool "${canonicalToolName}".`;
    return await failTool(toolCallId, err, canonicalToolName, requestActionId, ctx, hooks, sink);
  }

  try {
    const result = await tool.run(env, args, {
      stream: {
        token(text) {
          sink.send({ type: "token", text, toolCallId });
        },
      },
      sink,
      host: hooks.toolHost,
      actorAgentId: ctx.agentId,
      runId: ctx.runId,
      causedByActionId: requestActionId,
    });

    if (result.error) {
      return await failTool(
        toolCallId,
        result.error,
        canonicalToolName,
        requestActionId,
        ctx,
        hooks,
        sink,
        result
      );
    }

    hooks.updateToolCall({
      id: toolCallId,
      status: "completed",
      outputJson: JSON.stringify(result.output ?? null),
      completedAt: new Date().toISOString(),
    });
    sink.send({
      type: "tool_result",
      toolCallId,
      status: "completed",
      output: result.output,
    });

    binding.lastToolOutput = result.output;

    await record(
      hooks,
      {
        by: ctx.agentId,
        action: "Tooling.completed",
        args: {
          tool: canonicalToolName,
          request: requestActionId,
          summary: summarize(result.output),
        },
        behaviorVersionId: ctx.behaviorVersionId,
        runId: ctx.runId,
        causedByActionId: requestActionId,
      },
      sink
    );
    return result;
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return await failTool(toolCallId, err, canonicalToolName, requestActionId, ctx, hooks, sink);
  }
}

async function failTool(
  toolCallId: string,
  errorMessage: string,
  toolName: string,
  requestActionId: string,
  ctx: RunContext,
  hooks: RunHooks,
  sink: RunSink,
  partial?: ToolResult
): Promise<ToolResult> {
  hooks.updateToolCall({
    id: toolCallId,
    status: "failed",
    errorText: errorMessage,
    completedAt: new Date().toISOString(),
  });
  sink.send({
    type: "tool_result",
    toolCallId,
    status: "failed",
    error: errorMessage,
  });
  await record(
    hooks,
    {
      by: ctx.agentId,
      action: "Tooling.failed",
      args: { tool: toolName, reason: errorMessage, request: requestActionId },
      behaviorVersionId: ctx.behaviorVersionId,
      runId: ctx.runId,
      causedByActionId: requestActionId,
    },
    sink
  );
  return partial ?? { error: errorMessage };
}
