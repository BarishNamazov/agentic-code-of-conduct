import type { BCIR, CompileBehaviorResult } from "@shared/types";

export function BehaviorPreview({ result }: { result: CompileBehaviorResult }) {
  const { normalized: bcir, validation } = result;
  return (
    <div className="space-y-4">
      <ValidationSummary
        ok={validation.ok}
        warnings={validation.warnings}
        errors={validation.errors}
      />
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
        <div className="text-xs uppercase tracking-wider text-neutral-500">
          Normalized behavior
        </div>
        <div className="mt-1 text-base font-semibold tracking-tight">
          {bcir.agent.name}
        </div>
        {bcir.agent.purpose && (
          <div className="text-xs text-neutral-400">{bcir.agent.purpose}</div>
        )}
      </header>

      <section>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
          Reactions ({bcir.reactions.length})
        </h4>
        <ul className="space-y-2">
          {bcir.reactions.map((r) => (
            <li
              key={r.id}
              className="rounded-md border border-neutral-800 bg-neutral-950 p-3 text-xs"
            >
              <div className="flex items-center gap-2">
                <span className="badge">{r.name}</span>
                <span className="text-[10px] text-neutral-500">{r.id}</span>
              </div>
              <div className="mt-2 text-neutral-300">{r.prose}</div>
              <div className="mono mt-2 text-[11px] text-emerald-300">
                {r.formal}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {bcir.tools.length > 0 && (
        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
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
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
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
