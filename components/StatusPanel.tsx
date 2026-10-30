// Worker freshness, app health, latest deploy, free-hours estimate, kill switch and API cost.
import { toggleKillSwitch } from "@/app/actions";
import { projectMonth } from "@/lib/cadence";
import { formatAgo, formatDateTime, isStale } from "@/lib/format";
import type { HealthPollView } from "@/lib/db";

export interface StatusData {
  lastTickAt: Date | null;
  lastTickStatus: string | null;
  lastTickErrors: { step: string; error: string }[];
  latestDeploy: { id: string; status: string; commit: string | null; at: string } | null;
  awakeMinutes: number;
  killSwitch: { on: boolean; source: "env" | "dashboard" | null };
  apiCostUsd: number;
  monthlyBudgetUsd: number;
  diagnoses: { count: number; failed: number };
  /** The app's /api/health reported chaos mode on (ADR 0007). */
  chaosOn: boolean;
  healthPolls: HealthPollView[];
  now: Date;
}

const FREE_HOURS = 750;

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <h2 className="text-sm font-medium text-muted">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

export function StatusPanel({ data }: { data: StatusData }) {
  const stale = isStale(data.lastTickAt, data.now);
  const usedHours = data.awakeMinutes / 60;
  const projected = projectMonth(usedHours, data.now);
  const lastPoll = data.healthPolls[0];

  const overBudget = data.apiCostUsd >= data.monthlyBudgetUsd;

  return (
    <div className="space-y-4">
      {data.chaosOn ? (
        <div role="alert" className="rounded-xl border border-critical bg-critical-soft px-4 py-3 text-sm text-critical">
          <strong>CHAOS MODE IS ON in the app.</strong> Deliberate test errors can be triggered in production. When the test is done, remove{" "}
          <code>CHAOS_MODE</code> from the Place-and-Plate service&apos;s Environment on Render.
        </div>
      ) : null}
      {overBudget ? (
        <div role="alert" className="rounded-xl border border-critical bg-critical-soft px-4 py-3 text-sm text-critical">
          <strong>The monthly API budget is used up</strong> (${data.apiCostUsd.toFixed(2)} of ${data.monthlyBudgetUsd.toFixed(2)}). Diagnosis is paused until next month or
          until <code>MONTHLY_API_BUDGET_USD</code> is raised.
        </div>
      ) : null}
      {stale ? (
        <div role="alert" className="rounded-xl border border-critical bg-critical-soft px-4 py-3 text-sm text-critical">
          <strong>The worker looks stale.</strong>{" "}
          {data.lastTickAt ? `Its last run was ${formatAgo(data.lastTickAt, data.now)}.` : "It hasn't run yet."} Nothing new is being
          detected. Check the worker workflow in the Watchtower repo's Actions tab.
        </div>
      ) : null}
      {data.lastTickErrors.length ? (
        <div role="alert" className="rounded-xl border border-high bg-high-soft px-4 py-3 text-sm text-high">
          <strong>The last worker run had problems.</strong> Nothing was done automatically.
          <ul className="mt-1 list-disc pl-5">
            {data.lastTickErrors.map((e) => (
              <li key={e.step}>
                <span className="font-medium">{e.step}</span>: {e.error}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="Worker">
          <p className="font-semibold">{data.lastTickAt ? formatAgo(data.lastTickAt, data.now) : "Never run"}</p>
          <p className="text-sm text-muted">
            {data.lastTickAt ? `${formatDateTime(data.lastTickAt)}, ${data.lastTickStatus === "ok" ? "no errors" : "with errors"}` : "Runs every 15 min"}
          </p>
        </Card>
        <Card title="App health">
          {lastPoll ? (
            <>
              <p className={`font-semibold ${lastPoll.level === "error" ? "text-critical" : "text-ok"}`}>{lastPoll.level === "error" ? "Failing" : "Up"}</p>
              <p className="text-sm text-muted">
                {lastPoll.title}, {formatAgo(lastPoll.occurredAt, data.now)}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted">No health polls yet</p>
          )}
        </Card>
        <Card title="Latest deploy">
          {data.latestDeploy ? (
            <>
              <p className="font-semibold">
                {data.latestDeploy.status} <span className="font-mono text-sm font-normal">{data.latestDeploy.commit ?? ""}</span>
              </p>
              <p className="text-sm text-muted">{formatAgo(new Date(data.latestDeploy.at), data.now)}</p>
            </>
          ) : (
            <p className="text-sm text-muted">None seen yet</p>
          )}
        </Card>
        <Card title="Render free hours (app, from polls)">
          <p className="font-semibold">
            {usedHours.toFixed(0)} h <span className="font-normal text-muted">of {FREE_HOURS} this month</span>
          </p>
          <p className={`text-sm ${projected > FREE_HOURS * 0.9 ? "text-critical" : "text-muted"}`}>
            On track for about {projected.toFixed(0)} h. Excludes real visits; Render&apos;s billing page has the exact figure.
          </p>
        </Card>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
        <form action={toggleKillSwitch} className="flex items-center gap-2">
          <span>
            Kill switch:{" "}
            <strong className={data.killSwitch.on ? "text-critical" : "text-ink"}>
              {data.killSwitch.on ? `on (${data.killSwitch.source === "env" ? "KILL_SWITCH env" : "dashboard"})` : "off"}
            </strong>
          </span>
          {data.killSwitch.source === "env" ? null : (
            <button
              type="submit"
              name="on"
              value={data.killSwitch.on ? "0" : "1"}
              className="rounded-full border border-line px-2.5 py-0.5 text-xs hover:bg-sunken"
              title={data.killSwitch.on ? "Allow diagnosis again" : "Stop all Claude calls and workflow triggers"}
            >
              {data.killSwitch.on ? "Turn off" : "Turn on"}
            </button>
          )}
        </form>
        <span>
          API cost this month: <strong className="text-ink">${data.apiCostUsd.toFixed(2)}</strong> of ${data.monthlyBudgetUsd.toFixed(0)}
        </span>
        <span>
          Diagnoses this month: <strong className="text-ink">{data.diagnoses.count}</strong>
          {data.diagnoses.failed ? ` (${data.diagnoses.failed} failed)` : ""}
        </span>
      </div>
    </div>
  );
}
