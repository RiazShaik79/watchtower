// The incident's diagnoses (newest first) and the Re-diagnose controls. A diagnosis is advice for a
// human: nothing on this panel triggers a fix. Re-diagnose only queues a request for the worker.
import { requestRediagnose } from "@/app/incidents/[id]/actions";
import type { Diagnosis } from "@/lib/diagnosis-schema";
import type { DiagnosisView } from "@/lib/db";
import { formatAgo, formatDateTime } from "@/lib/format";

const str = (v: unknown) => (typeof v === "string" ? v : "");

function asDiagnosis(result: Record<string, unknown> | null): Diagnosis | null {
  if (!result) return null;
  return {
    summary: str(result.summary),
    root_cause: str(result.root_cause),
    evidence: Array.isArray(result.evidence) ? (result.evidence as { ref?: unknown; why?: unknown }[]).map((e) => ({ ref: str(e?.ref), why: str(e?.why) })) : [],
    confidence: typeof result.confidence === "number" ? result.confidence : 0,
    blast_radius: str(result.blast_radius),
    immediate_mitigation: str(result.immediate_mitigation),
    fix_approach: str(result.fix_approach),
    needs_human_only: result.needs_human_only === true,
    missing_info: Array.isArray(result.missing_info) ? result.missing_info.map(str).filter(Boolean) : [],
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-medium text-muted">{label}</h3>
      <div className="mt-0.5 text-sm break-words whitespace-pre-wrap">{children}</div>
    </div>
  );
}

function EvidenceRef({ value }: { value: string }) {
  const event = /^event:(\d+)$/.exec(value);
  if (event) {
    return (
      <a href={`#event-${event[1]}`} className="font-mono text-xs text-accent hover:underline">
        {value}
      </a>
    );
  }
  return <span className="font-mono text-xs">{value}</span>;
}

function Meta({ d, now }: { d: DiagnosisView; now: Date }) {
  return (
    <p className="text-xs text-muted" title={formatDateTime(d.createdAt)}>
      {formatAgo(d.createdAt, now)} · {d.model} · ${d.costUsd.toFixed(3)}
      {d.notes ? " · with your notes" : ""}
    </p>
  );
}

function DiagnosisBody({ d, now }: { d: DiagnosisView; now: Date }) {
  const diagnosis = asDiagnosis(d.result);
  if (d.status === "failed" || !diagnosis) {
    return (
      <div className="space-y-1">
        <p className="text-sm text-critical">
          <strong>This diagnosis failed.</strong> Nothing was done automatically.
        </p>
        {d.error ? <p className="font-mono text-xs break-words text-muted">{d.error}</p> : null}
        <Meta d={d} now={now} />
      </div>
    );
  }
  const pct = Math.round(diagnosis.confidence * 100);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${pct >= 75 ? "bg-ok-soft text-ok" : pct >= 40 ? "bg-medium-soft text-medium" : "bg-high-soft text-high"}`}>
          Confidence {pct}%
        </span>
        {diagnosis.needs_human_only ? (
          <span className="rounded-full bg-critical-soft px-2 py-0.5 text-xs font-medium text-critical">Needs a human: the fix touches protected files</span>
        ) : null}
      </div>
      <p className="font-medium">{diagnosis.summary}</p>
      <Field label="Root cause">{diagnosis.root_cause}</Field>
      <Field label="Evidence">
        <ul className="space-y-1 whitespace-normal">
          {diagnosis.evidence.map((e, i) => (
            <li key={i}>
              <EvidenceRef value={e.ref} /> <span className="text-muted">{e.why}</span>
            </li>
          ))}
        </ul>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Who is affected">{diagnosis.blast_radius || "—"}</Field>
        <Field label="What you can do now">{diagnosis.immediate_mitigation || "—"}</Field>
      </div>
      <Field label="How to fix it">{diagnosis.fix_approach || "—"}</Field>
      {diagnosis.missing_info.length ? (
        <Field label="What would make it more certain">
          <ul className="list-disc pl-5 whitespace-normal">
            {diagnosis.missing_info.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </Field>
      ) : null}
      <Meta d={d} now={now} />
    </div>
  );
}

export function DiagnosisPanel({
  incidentId,
  closed,
  diagnoses,
  pending,
  now,
}: {
  incidentId: number;
  closed: boolean;
  diagnoses: DiagnosisView[];
  pending: { deep: boolean; at: Date } | null;
  now: Date;
}) {
  const [latest, ...older] = diagnoses;
  return (
    <section className="rounded-xl border border-line bg-surface">
      <div className="border-b border-line px-5 py-3">
        <h2 className="font-semibold">Diagnosis</h2>
        <p className="text-xs text-muted">Claude&apos;s reading of the events and the app&apos;s code. Advice only: nothing here changes the app.</p>
      </div>
      <div className="space-y-4 px-5 py-4">
        {latest ? (
          <DiagnosisBody d={latest} now={now} />
        ) : (
          <p className="text-sm text-muted">
            No diagnosis yet. New incidents of medium severity or worse are diagnosed on the next worker run; others only when you ask below.
          </p>
        )}

        {older.length ? (
          <details className="rounded-lg border border-line px-3 py-2">
            <summary className="cursor-pointer text-sm text-muted">Earlier diagnoses ({older.length})</summary>
            <div className="mt-3 space-y-6">
              {older.map((d) => (
                <DiagnosisBody key={d.id} d={d} now={now} />
              ))}
            </div>
          </details>
        ) : null}

        {closed ? null : pending ? (
          <p className="rounded-lg bg-sunken px-3 py-2 text-sm">
            A {pending.deep ? "deep " : ""}re-diagnose is queued ({formatAgo(pending.at, now)}). It runs on the next worker run, within 15 minutes, or start it now
            in the Watchtower repo: Actions → worker → Run workflow.
          </p>
        ) : (
          <form action={requestRediagnose} className="space-y-2 rounded-lg bg-sunken px-3 py-3">
            <input type="hidden" name="incidentId" value={incidentId} />
            <label className="block">
              <span className="text-sm font-medium">Ask again</span>
              <textarea
                name="notes"
                maxLength={1000}
                rows={2}
                placeholder="Optional notes for Claude, e.g. what you already checked"
                className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="submit" name="deep" value="0" className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-white hover:opacity-90">
                Re-diagnose
              </button>
              <button type="submit" name="deep" value="1" className="rounded-full border border-line bg-surface px-4 py-1.5 text-sm hover:bg-paper">
                Deep re-diagnose (Opus, about 2× the cost)
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
