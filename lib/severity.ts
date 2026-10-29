// Severity rules (architecture §5), as pure functions. First match wins; an open incident's
// severity is never lowered automatically (maxSeverity).
import { SEVERITY_RANK, type Kind, type Level, type Severity } from "./types";

export const WINDOW_MS = 15 * 60_000;
export const BASELINE_MS = 24 * 60 * 60_000;
const WINDOWS_PER_BASELINE = BASELINE_MS / WINDOW_MS;

export interface ErrorStats {
  kind: Exclude<Kind, "health">;
  level: Level;
  /** No incident (open or closed) has ever had this fingerprint. */
  isNewFingerprint: boolean;
  /** Occurrences in the 15 min ending at this event, including it. */
  countInWindow: number;
  /** Occurrences in the 24 h ending at this event, including the window. */
  countInBaseline: number;
}

export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/** Average occurrences per 15-min window over the 24 h before the current window. */
export function baselinePerWindow(s: Pick<ErrorStats, "countInWindow" | "countInBaseline">): number {
  return Math.max(0, s.countInBaseline - s.countInWindow) / (WINDOWS_PER_BASELINE - 1);
}

export function errorSeverity(s: ErrorStats): Severity {
  if (s.level !== "error") {
    // Warnings: slow queries escalate on volume, everything else stays low.
    return s.kind === "slow_query" && s.countInWindow >= 5 ? "medium" : "low";
  }
  if (s.kind === "slow_query") return s.countInWindow >= 5 ? "medium" : "low";
  if (s.countInWindow >= 10) return "high";
  if (s.kind === "db") return "medium"; // a single DB connection error
  if (s.isNewFingerprint) return "high";
  const baseline = baselinePerWindow(s);
  if (baseline > 0 && s.countInWindow >= 5 && s.countInWindow >= 5 * baseline) return "high"; // spike
  return "medium"; // a known fingerprint recurring
}

// ---------------------------------------------------------------------------------------------
// Health polls
// ---------------------------------------------------------------------------------------------

export const COLD_START_MS = 20_000;
export const CRITICAL_AFTER_FAILURES = 3;
export const CRITICAL_AFTER_DB_DOWN = 2;

/** One health poll (a 120 s attempt plus 1 retry, done by lib/integrations/app.ts). */
export interface HealthPoll {
  at: Date;
  /** HTTP status, or null when no response arrived (timeout / network error). */
  httpStatus: number | null;
  /** Total time until the final answer, across the retry. */
  ms: number;
  /** `db` field from the response body, when there was one. */
  db: "up" | "down" | null;
  /** Short failure reason: "timeout", "network", "http_500"… */
  error?: string;
}

export interface HealthState {
  consecutiveFailures: number;
  dbDownStreak: number;
}

export type HealthOutcome = "ok" | "cold_start" | "failed" | "db_down";

export interface HealthEvaluation {
  state: HealthState;
  outcome: HealthOutcome;
  /** The incident this poll raises or feeds, if any. */
  incident: { kind: "health" | "db"; severity: Severity } | null;
}

export const INITIAL_HEALTH_STATE: HealthState = { consecutiveFailures: 0, dbDownStreak: 0 };

/**
 * A slow success is a cold start (Render Free sleeps), never a failure. One failure raises a low
 * "watch" incident; 3 consecutive failures, or `db: "down"` twice in a row, make it critical.
 */
export function evaluateHealth(prev: HealthState, poll: HealthPoll): HealthEvaluation {
  if (poll.httpStatus === 200 && poll.db !== "down") {
    return {
      state: { consecutiveFailures: 0, dbDownStreak: 0 },
      outcome: poll.ms > COLD_START_MS ? "cold_start" : "ok",
      incident: null,
    };
  }
  if (poll.db === "down") {
    const dbDownStreak = prev.dbDownStreak + 1;
    return {
      state: { consecutiveFailures: prev.consecutiveFailures + 1, dbDownStreak },
      outcome: "db_down",
      incident: { kind: "db", severity: dbDownStreak >= CRITICAL_AFTER_DB_DOWN ? "critical" : "low" },
    };
  }
  const consecutiveFailures = prev.consecutiveFailures + 1;
  return {
    state: { consecutiveFailures, dbDownStreak: 0 },
    outcome: "failed",
    incident: { kind: "health", severity: consecutiveFailures >= CRITICAL_AFTER_FAILURES ? "critical" : "low" },
  };
}
