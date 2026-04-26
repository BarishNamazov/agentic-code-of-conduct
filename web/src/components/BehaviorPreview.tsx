import type {
  BCIR,
  CompileBehaviorResult,
  ObservationPatternIR,
  StatePredicateIR,
  ThenActionIR,
} from "@shared/types";

export function BehaviorPreview({ result }: { result: CompileBehaviorResult }) {
  const { normalized: bcir, validation } = result;
  return (
    <div className="space-y-4">
      <BCIRView bcir={bcir} />
    </div>
  );
}

function ValidationSummary({
  ok,
  warnings,
  errors,
}: {
  ok: boolean;
  warnings: { level: string; message: string }[];
  errors: { level: string; message: string }[];
}) {
  if (errors.length === 0 && warnings.length === 0) {
    return (
      <div className="card border-emerald-500/30 bg-emerald-500/5 text-sm text-emerald-300">
        Behavior validated cleanly.
      </div>
    );
  }
  return (
    <div className="card space-y-2 text-sm">
      <div className="font-semibold">
        {ok ? "Compiled with warnings" : "Validation errors"}
      </div>
      <ul className="space-y-1">
        {errors.map((e, i) => (
          <li key={`e-${i}`} className="flex gap-2">
            <span className="badge badge-fail">error</span>
            <span className="text-neutral-200">{e.message}</span>
          </li>
        ))}
        {warnings.map((w, i) => (
          <li key={`w-${i}`} className="flex gap-2">
            <span className={`badge ${w.level === "warn" ? "badge-warn" : ""}`}>
              {w.level}
            </span>
            <span className="text-neutral-300">{w.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BCIRView({ bcir }: { bcir: BCIR }) {
  return (
    <div className="card space-y-4">
      <header>
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-300/80">
          Normalized behavior
        </div>
        <div className="font-display mt-1 text-base font-semibold tracking-tight">
          {bcir.agent.name}
        </div>
        {bcir.agent.purpose && (
          <div className="text-xs text-neutral-400">{bcir.agent.purpose}</div>
        )}
      </header>

      <section>
        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-400">
          Reactions ({bcir.reactions.length})
        </h4>
        <ul className="space-y-2">
          {bcir.reactions.map((r) => (
            <li
              key={r.id}
              className="rounded-lg border border-neutral-800/80 bg-neutral-950/60 p-3 text-xs transition hover:border-neutral-700"
            >
              <div className="flex items-center gap-2">
                <span className="badge">{r.name}</span>
                <span className="mono text-[10px] text-neutral-500">{r.id}</span>
              </div>
              <div className="mt-2 leading-relaxed text-neutral-300">
                {r.prose}
              </div>
              <div className="mono mt-2 space-y-1 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2 py-2 text-[11px] text-emerald-300">
                <ReactionSyntax when={r.when} where={r.where} then={r.then} />
              </div>
            </li>
          ))}
        </ul>
      </section>

      {bcir.tools.length > 0 && (
        <section>
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-400">
            Declared tools
          </h4>
          <ul className="flex flex-wrap gap-2">
            {bcir.tools.map((t) => (
              <li
                key={t.name}
                className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs"
                title={t.usage ? `${t.description}\n\n${t.usage}` : t.description}
              >
                <span className="mono text-emerald-300">{t.name}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {bcir.permissions.length > 0 && (
        <section>
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-400">
            Permissions
          </h4>
          <ul className="flex flex-wrap gap-2">
            {bcir.permissions.map((p, i) => (
              <li
                key={i}
                className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs"
              >
                <span className="mono text-emerald-300">{p.capability}</span>
                <span className="ml-1 text-neutral-500">· {p.scope}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ReactionSyntax({
  when,
  where,
  then,
}: {
  when: ObservationPatternIR[];
  where: StatePredicateIR[];
  then: ThenActionIR[];
}) {
  return (
    <>
      <SyntaxLine label="when" lines={when.map(formatWhen)} />
      {where.length > 0 && <SyntaxLine label="where" lines={where.map(formatWhere)} />}
      <SyntaxLine label="then" lines={then.map(formatThen)} />
    </>
  );
}

function SyntaxLine({ label, lines }: { label: string; lines: string[] }) {
  return (
    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2">
      <span className="select-none text-neutral-500">{label}</span>
      <div className="min-w-0 space-y-1">
        {lines.map((line, i) => (
          <div key={`${label}-${i}`} className="break-words">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatWhen(w: ObservationPatternIR) {
  const args = formatArgs(w.args);
  const bind = w.bind ? `${w.bind} = ` : "";
  return `${bind}${w.action}${args}`;
}

function formatWhere(w: StatePredicateIR) {
  const vars = w.variables.length > 0 ? ` [${w.variables.join(", ")}]` : "";
  return `${w.concept}: ${w.text}${vars}`;
}

function formatThen(t: ThenActionIR) {
  return `${t.posture} ${t.action}${formatArgs(t.args)}`;
}

function formatArgs(args: Record<string, string>) {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  return `(${entries.map(([key, value]) => `${key}: ${value}`).join(", ")})`;
}
