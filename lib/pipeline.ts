// Ingestion pipeline shared by the worker and the seed script:
// signal → scrub → fingerprint → store (dedupe) → group into an incident → severity → audit.
import { audit } from "./audit";
import { HEALTH_APP_DOWN_FP, HEALTH_DB_DOWN_FP, fingerprint, normalizeMessage, normalizeRoute, topInAppFrame } from "./fingerprint";
import { BASELINE_MS, INITIAL_HEALTH_STATE, WINDOW_MS, errorSeverity, evaluateHealth, maxSeverity, type HealthEvaluation, type HealthPoll, type HealthState } from "./severity";
import { accrueAwake, monthKey } from "./cadence";
import { scrubText } from "./scrub";
import type { Store } from "./store";
import type { ScrubbedSignal, Signal } from "./types";

export interface IngestResult {
  stored: number;
  duplicates: number;
  detected: number[];
  escalated: number[];
}

/** Scrub every text field, then fingerprint the scrubbed text. */
export function scrubSignal(signal: Signal): ScrubbedSignal {
  const { fixedFingerprint, ...rest } = signal;
  const title = scrubText(signal.title, 300);
  const message = scrubText(signal.message, 2000);
  const stack = signal.stack ? scrubText(signal.stack, 8000) : undefined;
  const route = signal.route ? normalizeRoute(scrubText(signal.route, 200)) : undefined;
  const location = route ?? (topInAppFrame(stack) || normalizeMessage(scrubText(signal.location ?? "", 300)).slice(0, 120));
  const fp = fixedFingerprint ?? (signal.kind ? fingerprint(signal.kind, signal.errorType ?? "unknown", location, message) : null);
  return { ...rest, title, message, stack, route, location, fingerprint: fp };
}

export async function ingestSignals(store: Store, signals: Signal[]): Promise<IngestResult> {
  const result: IngestResult = { stored: 0, duplicates: 0, detected: [], escalated: [] };
  const ordered = [...signals].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  for (const raw of ordered) {
    const signal = scrubSignal(raw);
    const eventId = await store.insertRawEvent(signal);
    if (eventId === null) {
      result.duplicates++;
      continue;
    }
    result.stored++;
    if (!signal.kind || !signal.fingerprint) continue;
    await groupEvent(store, signal, eventId, result);
  }
  return result;
}

async function groupEvent(store: Store, signal: ScrubbedSignal, eventId: number, result: IngestResult): Promise<void> {
  const fp = signal.fingerprint!;
  const kind = signal.kind!;
  const at = signal.occurredAt;
  const count = signal.count ?? 1;
  const open = await store.findOpenIncident(fp);

  let severity = signal.forcedSeverity;
  if (!severity) {
    const [countInWindow, countInBaseline, everSeen] = await Promise.all([
      store.countEvents(fp, new Date(at.getTime() - WINDOW_MS), at),
      store.countEvents(fp, new Date(at.getTime() - BASELINE_MS), at),
      open ? Promise.resolve(true) : store.fingerprintEverSeen(fp),
    ]);
    severity = errorSeverity({
      kind: kind === "health" ? "error" : kind,
      level: signal.level,
      isNewFingerprint: !everSeen,
      countInWindow,
      countInBaseline,
    });
  }

  if (open) {
    const previous = open.severity;
    const next = maxSeverity(previous, severity);
    await store.updateIncident(open.id, { lastSeen: at > open.lastSeen ? at : open.lastSeen, addEvents: count, severity: next });
    await store.linkRawEvent(eventId, open.id);
    if (next !== previous) {
      result.escalated.push(open.id);
      await audit(store, { actor: "worker", action: "incident_escalated", incidentId: open.id, outcome: "ok", detail: { from: previous, to: next, source: signal.source } });
    }
    return;
  }

  const regressionOf = await store.latestClosedIncidentId(fp);
  const latestDeploy = await store.getSetting("latest_deploy");
  const id = await store.createIncident({
    fingerprint: fp,
    title: signal.title,
    kind,
    severity,
    firstSeen: at,
    lastSeen: at,
    eventCount: count,
    route: signal.route ?? null,
    regressionOf,
    deployIdAtOpen: latestDeploy ? (JSON.parse(latestDeploy) as { id?: string }).id ?? null : null,
  });
  await store.linkRawEvent(eventId, id);
  result.detected.push(id);
  await audit(store, {
    actor: "worker",
    action: "incident_detected",
    incidentId: id,
    outcome: "ok",
    detail: { severity, kind, source: signal.source, title: signal.title, regression_of: regressionOf },
  });
}

// ---------------------------------------------------------------------------------------------
// Health polls
// ---------------------------------------------------------------------------------------------

const HEALTH_TITLES = {
  ok: (ms: number) => `Health OK (${ms} ms)`,
  cold_start: (ms: number) => `Cold start: health OK after ${Math.round(ms / 1000)} s`,
  failed: (reason: string) => `App health check failing (${reason})`,
  db_down: () => "Database down (reported by /api/health)",
};

export async function recordHealth(store: Store, poll: HealthPoll): Promise<HealthEvaluation> {
  const saved = await store.getSetting("health_state");
  const prev: HealthState = saved ? { ...INITIAL_HEALTH_STATE, ...(JSON.parse(saved) as Partial<HealthState>) } : INITIAL_HEALTH_STATE;
  const evaluation = evaluateHealth(prev, poll);

  const title =
    evaluation.outcome === "ok"
      ? HEALTH_TITLES.ok(poll.ms)
      : evaluation.outcome === "cold_start"
        ? HEALTH_TITLES.cold_start(poll.ms)
        : evaluation.outcome === "db_down"
          ? HEALTH_TITLES.db_down()
          : HEALTH_TITLES.failed(poll.error ?? (poll.httpStatus ? `HTTP ${poll.httpStatus}` : "no response"));

  await ingestSignals(store, [
    {
      source: "health",
      externalId: `health:${poll.at.toISOString()}`,
      occurredAt: poll.at,
      level: evaluation.incident ? "error" : "info",
      kind: evaluation.incident?.kind ?? null,
      title,
      message: `${evaluation.outcome}; status=${poll.httpStatus ?? "none"}; ms=${poll.ms}; db=${poll.db ?? "unknown"}`,
      route: "/api/health",
      fixedFingerprint: evaluation.incident ? (evaluation.incident.kind === "db" ? HEALTH_DB_DOWN_FP : HEALTH_APP_DOWN_FP) : undefined,
      forcedSeverity: evaluation.incident?.severity,
    },
  ]);

  if (!evaluation.incident && prev.consecutiveFailures > 0) {
    await audit(store, { actor: "worker", action: "health_recovered", outcome: "ok", detail: { after_failures: prev.consecutiveFailures } });
  }

  // Free-hours estimate: each poll keeps the app awake for 15 min.
  const awakeUntilRaw = await store.getSetting("app_awake_until");
  const { addedMinutes, awakeUntil } = accrueAwake(awakeUntilRaw ? new Date(awakeUntilRaw) : null, poll.at);
  const monthSetting = `awake_minutes:${monthKey(poll.at)}`;
  const used = Number((await store.getSetting(monthSetting)) ?? 0);
  await store.setSetting(monthSetting, String(used + addedMinutes));
  await store.setSetting("app_awake_until", awakeUntil.toISOString());
  await store.setSetting("health_state", JSON.stringify(evaluation.state));
  await store.setSetting("last_health_poll_at", poll.at.toISOString());
  return evaluation;
}

// ---------------------------------------------------------------------------------------------
// Deploys
// ---------------------------------------------------------------------------------------------

export interface DeployInfo {
  id: string;
  status: string;
  commitId: string | null;
  commitMessage: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export async function recordDeploys(store: Store, deploys: DeployInfo[]): Promise<number> {
  let added = 0;
  for (const d of [...deploys].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const summary = `${d.commitId?.slice(0, 7) ?? "no-commit"} ${(d.commitMessage ?? "").split("\n")[0]}`.trim();
    const failed = /fail|cancel/i.test(d.status);
    const stored = await ingestSignals(store, [
      {
        source: "deploy",
        externalId: `${d.id}:${d.status}`,
        occurredAt: d.finishedAt ?? d.createdAt,
        level: failed ? "error" : "info",
        kind: null,
        title: `Deploy ${d.status}: ${summary}`.slice(0, 300),
        message: summary,
      },
    ]);
    if (stored.stored && (d.status === "live" || failed)) {
      added++;
      await audit(store, { actor: "worker", action: "deploy_seen", outcome: failed ? "error" : "ok", detail: { deploy_id: d.id, status: d.status, commit: d.commitId?.slice(0, 12) ?? null } });
    }
  }
  const newest = [...deploys].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (newest) {
    await store.setSetting(
      "latest_deploy",
      JSON.stringify({ id: newest.id, status: newest.status, commit: newest.commitId?.slice(0, 7) ?? null, at: (newest.finishedAt ?? newest.createdAt).toISOString() }),
    );
  }
  return added;
}
