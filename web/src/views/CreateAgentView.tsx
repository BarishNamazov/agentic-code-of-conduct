import { useState } from "react";
import type { CompileBehaviorResult } from "@shared/types";
import type { WorkspaceAgentClient } from "../lib/agent-client";
import type { Route } from "../App";
import { BehaviorPreview } from "../components/BehaviorPreview";

const DEFAULT_TEMPLATE = `Agent: Paper Draft Reviewer
Purpose: Review research paper drafts and produce a focused critique.

When the user submits a paper draft, read it.
After reading the draft, extract the main claims.
For each claim, search the workspace memory for prior context.
After checking the claims, summarize the result.
If the review needs help, spawn a research helper.
`;

export function CreateAgentView({
  agent,
  navigate,
}: {
  agent: WorkspaceAgentClient;
  navigate: (r: Route) => void;
}) {
  const [rawText, setRawText] = useState(DEFAULT_TEMPLATE);
  const [name, setName] = useState("Paper Draft Reviewer");
  const [compiling, setCompiling] = useState(false);
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<CompileBehaviorResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onCompile = async () => {
    setError(null);
    setCompiling(true);
    setPreview(null);
    try {
      const result = await agent.stub.compileBehavior({ rawText });
      setPreview(result);
      if (result.normalized.agent.name) {
        setName(result.normalized.agent.name);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCompiling(false);
    }
  };

  const onCreate = async () => {
    if (!preview) return;
    setError(null);
    setCreating(true);
    try {
      const normalized = {
        ...preview.normalized,
        agent: { ...preview.normalized.agent, name },
      };
      const { agentId } = await agent.stub.createAgent({ name, normalized });
      navigate({ name: "agent", agentId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Create an agent</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Paste a behavioral description (free-form prose, the behavioral DSL, or
          BCIR JSON). The compiler will normalize it and show the structured
          behavior before you commit.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="card flex flex-col">
          <label className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Behavior source
          </label>
          <textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            spellCheck={false}
            className="mono input min-h-[420px] resize-y bg-neutral-950 text-[13px] leading-relaxed"
          />
          <div className="mt-3 flex items-center justify-between">
            <div className="text-xs text-neutral-500">
              Tip: free-form lines starting with “When …”, “After …”, or “If …”
              produce reactions.
            </div>
            <button
              onClick={onCompile}
              disabled={compiling || !rawText.trim()}
              className="btn btn-primary"
            >
              {compiling ? "Compiling…" : "Compile preview"}
            </button>
          </div>
        </section>

        <section className="space-y-4">
          {error && (
            <div className="card border-red-500/40 bg-red-500/5 text-sm text-red-300">
              {error}
            </div>
          )}
          {preview ? (
            <>
              <div className="card space-y-3">
                <label className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
                  Agent name
                </label>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <div className="flex justify-end">
                  <button
                    onClick={onCreate}
                    disabled={creating || !preview.validation.ok || !name.trim()}
                    className="btn btn-primary"
                  >
                    {creating ? "Creating…" : "Create agent"}
                  </button>
                </div>
                {!preview.validation.ok && (
                  <div className="text-xs text-red-300">
                    Fix the validation errors below before creating.
                  </div>
                )}
              </div>
              <BehaviorPreview result={preview} />
            </>
          ) : (
            <div className="card text-sm text-neutral-500">
              Compile to see the normalized behavior, validation results, and the
              tool plan that the runtime will execute.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
