import Link from "next/link";
import { Header } from "@/components/Header";
import { SeverityBadge } from "@/components/SeverityBadge";
import { StatusPanel, type StatusData } from "@/components/StatusPanel";
import { requireAdmin } from "@/lib/auth";
import { monthKey } from "@/lib/cadence";
import { apiCostThisMonth, diagnosisStatsThisMonth, getSettings, listIncidents, listRecentHealthPolls } from "@/lib/db";
import { diagnosisConfigFromEnv } from "@/lib/diagnose";
import { KIND_LABELS, formatAgo, formatDateTime, statusLabel } from "@/lib/format";
import { killSwitchFromEnv } from "@/lib/kill-switch";

export const dynamic = "force-dynamic";

function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export default async function IncidentsPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  await requireAdmin();
  const { show } = await searchParams;
  const filter = show === "all" ? "all" : "open";
  const now = new Date();
  const awakeKey = `awake_minutes:${monthKey(now)}`;

  const [incidents, settings, healthPolls, apiCostUsd, diagnosisStats] = await Promise.all([
    listIncidents(filter),
    getSettings(["last_tick_at", "last_tick_status", "last_tick_errors", "latest_deploy", "kill_switch", "app_chaos", awakeKey]),
    listRecentHealthPolls(12),
    apiCostThisMonth(now),
    diagnosisStatsThisMonth(now),
  ]);

  const envKill = killSwitchFromEnv();
  const status: StatusData = {
    lastTickAt: settings.last_tick_at ? new Date(settings.last_tick_at) : null,
    lastTickStatus: settings.last_tick_status ?? null,
    lastTickErrors: parseJson(settings.last_tick_errors, []),
    latestDeploy: parseJson(settings.latest_deploy, null),
    awakeMinutes: Number(settings[awakeKey] ?? 0),
    killSwitch: { on: envKill || settings.kill_switch === "on", source: envKill ? "env" : settings.kill_switch === "on" ? "dashboard" : null },
    apiCostUsd,
    monthlyBudgetUsd: diagnosisConfigFromEnv().monthlyBudgetUsd,
    diagnoses: diagnosisStats,
    chaosOn: settings.app_chaos === "on",
    healthPolls,
    now,
  };

  return (
    <>
      <Header />
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        <StatusPanel data={status} />

        <section className="rounded-xl border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h1 className="text-lg font-semibold">{filter === "open" ? "Open incidents" : "All incidents"}</h1>
            <nav className="flex gap-1 text-sm" aria-label="Filter incidents">
              <Link href="/" className={`rounded-full px-3 py-1 ${filter === "open" ? "bg-sunken font-medium" : "text-muted hover:bg-sunken"}`}>
                Open
              </Link>
              <Link href="/?show=all" className={`rounded-full px-3 py-1 ${filter === "all" ? "bg-sunken font-medium" : "text-muted hover:bg-sunken"}`}>
                All
              </Link>
            </nav>
          </div>
          {incidents.length === 0 ? (
            <p className="px-4 py-10 text-center text-muted">No {filter === "open" ? "open " : ""}incidents. All quiet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-muted">
                  <tr className="border-b border-line">
                    <th className="px-4 py-2 font-medium">Severity</th>
                    <th className="px-4 py-2 font-medium">Incident</th>
                    <th className="px-4 py-2 font-medium">Kind</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium">Events</th>
                    <th className="px-4 py-2 font-medium">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {incidents.map((i) => (
                    <tr key={i.id} className="border-b border-line last:border-0 hover:bg-sunken">
                      <td className="px-4 py-3">
                        <SeverityBadge severity={i.severity} />
                      </td>
                      <td className="max-w-md px-4 py-3">
                        <Link href={`/incidents/${i.id}`} className="font-medium hover:underline">
                          <span className="line-clamp-2 break-words">{i.title}</span>
                        </Link>
                        <span className="text-xs text-muted">
                          #{i.id}
                          {i.route ? ` · ${i.route}` : ""}
                          {i.regressionOf ? ` · reopened (was #${i.regressionOf})` : ""}
                          {i.seeded ? " · seed data" : ""}
                        </span>
                      </td>
                      <td className="px-4 py-3">{KIND_LABELS[i.kind]}</td>
                      <td className="px-4 py-3">{statusLabel(i.status)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{i.eventCount}</td>
                      <td className="px-4 py-3 whitespace-nowrap" title={formatDateTime(i.lastSeen)}>
                        {formatAgo(i.lastSeen, now)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
