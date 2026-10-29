// Shared types for the worker, the pipeline and the dashboard.

export type Level = "info" | "warn" | "error";
export type Kind = "error" | "health" | "db" | "slow_query";
export type Severity = "critical" | "high" | "medium" | "low";
export type Source = "render_log" | "health" | "sentry" | "deploy";
export type Actor = "worker" | "admin" | "system";
export type Outcome = "ok" | "error" | "skipped" | "denied";

export const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Incident statuses (architecture §4). Terminal ones free the fingerprint for a new incident. */
export const INCIDENT_STATUSES = [
  "new",
  "diagnosed",
  "fix_approved",
  "pr_open",
  "ci_passed",
  "merged",
  "deployed",
  "verified",
  "regression",
  "rolled_back",
  "failed",
  "dismissed",
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const TERMINAL_STATUSES: readonly IncidentStatus[] = ["verified", "dismissed", "rolled_back"];

/**
 * One parsed signal from a source, BEFORE scrubbing. `kind: null` means "store it, don't group it"
 * (health OK polls, deploys). Parsers return null for lines that shouldn't be stored at all.
 */
export interface Signal {
  source: Source;
  externalId: string;
  occurredAt: Date;
  level: Level;
  kind: Kind | null;
  /** Short human title, e.g. "TypeError: Cannot read properties of undefined". */
  title: string;
  message: string;
  stack?: string;
  /** App route, e.g. "/api/log/[id]", when known. Preferred grouping location. */
  route?: string;
  /** Error class or code: "TypeError", "ECONNREFUSED". */
  errorType?: string;
  /** Grouping location when there's no route: top in-app frame or a normalised SQL snippet. */
  location?: string;
  /** How many occurrences this signal stands for (Sentry reports counts). Default 1. */
  count?: number;
  /** A fixed fingerprint for synthetic signals (health incidents). */
  fixedFingerprint?: string;
  /** A severity decided by the source evaluator (health), used instead of the error rules. */
  forcedSeverity?: Severity;
}

/** A signal after scrubbing and fingerprinting: the only form that's stored. */
export interface ScrubbedSignal extends Omit<Signal, "fixedFingerprint"> {
  fingerprint: string | null;
}

export interface Incident {
  id: number;
  fingerprint: string;
  title: string;
  kind: Kind;
  severity: Severity;
  status: IncidentStatus;
  firstSeen: Date;
  lastSeen: Date;
  eventCount: number;
  route: string | null;
  regressionOf: number | null;
  seeded: boolean;
}

export interface AuditEntry {
  actor: Actor;
  action: string;
  incidentId?: number | null;
  detail?: Record<string, unknown>;
  outcome: Outcome;
}
