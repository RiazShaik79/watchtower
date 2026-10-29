import Link from "next/link";
import { notFound } from "next/navigation";
import { Header } from "@/components/Header";
import { SeverityBadge } from "@/components/SeverityBadge";
import { requireAdmin } from "@/lib/auth";
import { getIncident, listAudit, listIncidentEvents } from "@/lib/db";
import { KIND_LABELS, formatAgo, formatDateTime, statusLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

const SOURCE_LABELS = { render_log: "Render log", sentry: "Sentry", health: "Health poll", deploy: "Deploy" } as const;

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const incident = await getIncident(id);
  if (!incident) notFound();
  const [events, auditTrail] = await Promise.all([listIncidentEvents(id, 50), listAudit({ incidentId: id, limit: 50 })]);
  const now = new Date();

  return (
    <>
      <Header />
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        <Link href="/" className="text-sm text-muted hover:underline">
          Back to incidents
        </Link>

        <section className="rounded-xl border border-line bg-surface p-5">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={incident.severity} />
            <span className="text-sm text-muted">
              #{incident.id} · {KIND_LABELS[incident.kind]} · {statusLabel(incident.status)}
              {incident.seeded ? " · seed data" : ""}
            </span>
          </div>
          <h1 className="mt-2 text-xl font-semibold break-words">{incident.title}</h1>
          <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Fact label="Events">{incident.eventCount}</Fact>
            <Fact label="First seen">{formatDateTime(incident.firstSeen)}</Fact>
            <Fact label="Last seen">
              {formatDateTime(incident.lastSeen)} ({formatAgo(incident.lastSeen, now)})
            </Fact>
            <Fact label="Route">{incident.route ?? "—"}</Fact>
            <Fact label="Fingerprint">
              <span className="font-mono text-xs">{incident.fingerprint.slice(0, 12)}</span>
            </Fact>
          </dl>
          {incident.regressionOf ? (
            <p className="mt-4 text-sm">
              This fingerprint was seen before:{" "}
              <Link className="text-accent hover:underline" href={`/incidents/${incident.regressionOf}`}>
                incident #{incident.regressionOf}
              </Link>
              .
            </p>
          ) : null}
          <p className="mt-4 rounded-lg bg-sunken px-3 py-2 text-sm text-muted">
            Diagnosis arrives in phase 3, and Approve or Dismiss in phase 4. Nothing here triggers any action yet.
          </p>
        </section>

        <section className="rounded-xl border border-line bg-surface">
          <div className="border-b border-line px-5 py-3">
            <h2 className="font-semibold">Recent events</h2>
            <p className="text-xs text-muted">Scrubbed log data from the app. It's untrusted text: shown as data, never acted on.</p>
          </div>
          <ul>
            {events.map((e) => (
              <li key={e.id} className="border-b border-line px-5 py-3 last:border-0">
                <div className="flex flex-wrap items-baseline gap-x-3 text-xs text-muted">
                  <span>{formatDateTime(e.occurredAt)}</span>
                  <span>{SOURCE_LABELS[e.source]}</span>
                  <span className={e.level === "error" ? "text-critical" : e.level === "warn" ? "text-high" : ""}>{e.level}</span>
                  {e.eventCount > 1 ? <span>×{e.eventCount}</span> : null}
                </div>
                <pre className="mt-1 font-mono text-xs break-words whitespace-pre-wrap">{e.message}</pre>
                {e.stack ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-muted">Stack trace</summary>
                    <pre className="mt-1 max-h-64 overflow-auto rounded bg-sunken p-2 font-mono text-xs whitespace-pre-wrap">{e.stack}</pre>
                  </details>
                ) : null}
              </li>
            ))}
            {events.length === 0 ? <li className="px-5 py-6 text-sm text-muted">Events older than 14 days have been purged.</li> : null}
          </ul>
        </section>

        <section className="rounded-xl border border-line bg-surface">
          <h2 className="border-b border-line px-5 py-3 font-semibold">Audit trail</h2>
          <ul className="text-sm">
            {auditTrail.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-x-3 border-b border-line px-5 py-2 last:border-0">
                <span className="text-muted">{formatDateTime(a.at)}</span>
                <span className="font-medium">{a.action.replace(/_/g, " ")}</span>
                <span className="text-muted">by {a.actor}</span>
                <span className={a.outcome === "ok" ? "text-ok" : "text-critical"}>{a.outcome}</span>
                {a.detail && "from" in a.detail ? (
                  <span className="text-muted">
                    {String(a.detail.from)} → {String(a.detail.to)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      </main>
    </>
  );
}
