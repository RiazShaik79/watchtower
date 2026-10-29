// One worker cycle (`npm run worker:tick`), run by .github/workflows/worker.yml every 15 min:
// health (if due) → Render logs → Sentry → deploys → purge. Each step fails safe on its own:
// an error is recorded and surfaced on the dashboard, never retried into an action (guardrail 7).
import { pathToFileURL } from "node:url";
import { audit } from "@/lib/audit";
import { shouldPollHealth } from "@/lib/cadence";
import { closeDb, dbStore, purgeAdminSessions, purgeRawEvents, runMigrations } from "@/lib/db";
import { pollHealth } from "@/lib/integrations/app";
import { fetchDeploys, fetchLogs, renderConfigured } from "@/lib/integrations/render";
import { fetchRecentIssues, sentryConfigured } from "@/lib/integrations/sentry";
import { isKillSwitchOn } from "@/lib/kill-switch";
import { log } from "@/lib/log";
import { parseRenderLog, parseSentryIssue } from "@/lib/parse";
import { ingestSignals, recordDeploys, recordHealth } from "@/lib/pipeline";
import { scrubText } from "@/lib/scrub";
import type { Store } from "@/lib/store";
import type { Signal } from "@/lib/types";

const LOG_OVERLAP_MS = 2 * 60_000;
const FIRST_RUN_LOOKBACK_MS = 60 * 60_000;
const MAX_LOOKBACK_MS = 6 * 24 * 60 * 60_000; // Render keeps 7 days of logs on Hobby

type StepResult = Record<string, unknown>;

async function stepHealth(store: Store, now: Date): Promise<StepResult> {
  if (!process.env.APP_HEALTH_URL) return { skipped: "APP_HEALTH_URL not set" };
  const last = await store.getSetting("last_health_poll_at");
  if (!shouldPollHealth(now, process.env.POLL_TIMEZONE || "Asia/Kolkata", process.env.POLL_ACTIVE_HOURS, last ? new Date(last) : null)) {
    return { skipped: "overnight cadence" };
  }
  const poll = await pollHealth();
  const evaluation = await recordHealth(store, poll);
  return { outcome: evaluation.outcome, ms: poll.ms, status: poll.httpStatus };
}

async function stepLogs(store: Store, now: Date): Promise<StepResult> {
  if (!renderConfigured()) return { skipped: "Render API not configured" };
  const cursorRaw = await store.getSetting("render_logs_cursor");
  const cursor = cursorRaw ? new Date(cursorRaw) : new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS);
  const start = new Date(Math.max(cursor.getTime() - LOG_OVERLAP_MS, now.getTime() - MAX_LOOKBACK_MS));
  const { logs, truncated } = await fetchLogs(start, now);
  const signals = logs.map(parseRenderLog).filter((s): s is Signal => s !== null);
  const result = await ingestSignals(store, signals);
  // When truncated, resume from the last line fetched; the overlap and dedupe make that safe.
  const last = logs.at(-1);
  const nextCursor = truncated && last ? new Date(last.timestamp) : now;
  await store.setSetting("render_logs_cursor", nextCursor.toISOString());
  if (truncated) await audit(store, { actor: "worker", action: "logs_truncated", outcome: "skipped", detail: { fetched: logs.length } });
  return { lines: logs.length, signals: signals.length, ...result, truncated };
}

async function stepSentry(store: Store): Promise<StepResult> {
  if (!sentryConfigured()) return { skipped: "Sentry API not configured" };
  const issues = await fetchRecentIssues();
  const counts = JSON.parse((await store.getSetting("sentry_counts")) ?? "{}") as Record<string, number>;
  const signals = issues.map((issue) => parseSentryIssue(issue, counts[issue.id] ?? 0)).filter((s): s is Signal => s !== null);
  const result = await ingestSignals(store, signals);
  for (const issue of issues) counts[issue.id] = Number(issue.count) || 0;
  const trimmed = Object.fromEntries(Object.entries(counts).slice(-500));
  await store.setSetting("sentry_counts", JSON.stringify(trimmed));
  return { issues: issues.length, signals: signals.length, ...result };
}

async function stepDeploys(store: Store): Promise<StepResult> {
  if (!renderConfigured()) return { skipped: "Render API not configured" };
  const deploys = await fetchDeploys(10);
  return { deploys: deploys.length, new: await recordDeploys(store, deploys) };
}

async function stepPurge(): Promise<StepResult> {
  return { raw_events: await purgeRawEvents(14), sessions: await purgeAdminSessions() };
}

function describe(err: unknown): string {
  const e = err as { name?: string; message?: string; code?: string };
  return scrubText(`${e?.name ?? "Error"}: ${e?.message ?? String(err)}${e?.code ? ` (${e.code})` : ""}`, 300);
}

export async function runTick(now: Date = new Date()): Promise<{ ok: boolean; summary: Record<string, StepResult>; errors: { step: string; error: string }[] }> {
  await runMigrations();
  const store = dbStore();
  const summary: Record<string, StepResult> = {};
  const errors: { step: string; error: string }[] = [];

  const steps: [string, () => Promise<StepResult>][] = [
    ["health", () => stepHealth(store, now)],
    ["logs", () => stepLogs(store, now)],
    ["sentry", () => stepSentry(store)],
    ["deploys", () => stepDeploys(store)],
    ["purge", () => stepPurge()],
  ];
  for (const [name, run] of steps) {
    try {
      summary[name] = await run();
    } catch (err) {
      const error = describe(err);
      errors.push({ step: name, error });
      summary[name] = { error };
      log.error("worker_step_failed", { step: name, error });
      await audit(store, { actor: "worker", action: `${name}_failed`, outcome: "error", detail: { error } }).catch(() => undefined);
    }
  }

  const killSwitch = await isKillSwitchOn(store);
  await store.setSetting("last_tick_at", new Date().toISOString());
  await store.setSetting("last_tick_status", errors.length ? "error" : "ok");
  await store.setSetting("last_tick_errors", JSON.stringify(errors));
  await store.setSetting("last_tick_summary", JSON.stringify(summary));
  await audit(store, { actor: "worker", action: "worker_tick", outcome: errors.length ? "error" : "ok", detail: { ...summary, kill_switch: killSwitch } });
  return { ok: errors.length === 0, summary, errors };
}

// Run when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTick()
    .then(async ({ ok, summary, errors }) => {
      log.info("worker_tick_done", { ok, summary, errors });
      await closeDb();
      process.exitCode = ok ? 0 : 1;
    })
    .catch(async (err) => {
      log.error("worker_tick_crashed", { error: describe(err) });
      await closeDb().catch(() => undefined);
      process.exitCode = 1;
    });
}
