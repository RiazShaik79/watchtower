// The persistence the pipeline needs, as an interface: lib/db.ts implements it against MySQL and
// tests/helpers/memory-store.ts in memory, so grouping and severity are tested without a database.
import type { AuditEntry, Incident, IncidentStatus, Kind, Level, ScrubbedSignal, Severity, Source } from "./types";

export interface NewIncident {
  fingerprint: string;
  title: string;
  kind: Kind;
  severity: Severity;
  firstSeen: Date;
  lastSeen: Date;
  eventCount: number;
  route: string | null;
  regressionOf: number | null;
  deployIdAtOpen: string | null;
}

export interface Store {
  /** Insert a scrubbed event. Returns its id, or null if (source, externalId) was already stored. */
  insertRawEvent(event: ScrubbedSignal): Promise<number | null>;
  linkRawEvent(eventId: number, incidentId: number): Promise<void>;
  /** Sum of occurrences of a fingerprint with occurred_at in [from, to]. */
  countEvents(fingerprint: string, from: Date, to: Date): Promise<number>;
  findOpenIncident(fingerprint: string): Promise<Incident | null>;
  latestClosedIncidentId(fingerprint: string): Promise<number | null>;
  fingerprintEverSeen(fingerprint: string): Promise<boolean>;
  createIncident(incident: NewIncident): Promise<number>;
  updateIncident(id: number, update: { lastSeen: Date; addEvents: number; severity: Severity }): Promise<void>;
  /** Append an audit row. `detail` must already be scrubbed (use lib/audit.ts). */
  audit(entry: AuditEntry): Promise<void>;
  getSetting(name: string): Promise<string | null>;
  setSetting(name: string, value: string): Promise<void>;
}

/** A stored, scrubbed event as diagnosis sees it. */
export interface StoredEvent {
  id: number;
  source: Source;
  occurredAt: Date;
  level: Level;
  title: string;
  message: string;
  stack: string | null;
  route: string | null;
  eventCount: number;
}

/** A pending dashboard "Re-diagnose" (an approvals row with action 'rediagnose'). */
export interface DiagnosisRequest {
  approvalId: number;
  incidentId: number;
  /** Set for a deep re-diagnose. */
  model: string | null;
  notes: string | null;
}

export interface NewDiagnosis {
  incidentId: number;
  model: string;
  inputHash: string;
  status: "ok" | "failed";
  /** Validated and scrubbed diagnosis JSON, or null when it failed. */
  result: Record<string, unknown> | null;
  confidence: number | null;
  costUsd: number;
  notes: string | null;
  error: string | null;
}

export interface ApiUsageRow {
  incidentId: number | null;
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** What lib/diagnose.ts and lib/state-machine.ts need: lib/db.ts and the test memory store implement it. */
export interface DiagnosisStore extends Pick<Store, "getSetting" | "audit"> {
  getIncident(id: number): Promise<Incident | null>;
  incidentEvents(incidentId: number, limit: number): Promise<StoredEvent[]>;
  recentDeploys(limit: number): Promise<StoredEvent[]>;
  /** An existing diagnosis id for the same incident, inputs and model (the cache), if any. */
  findDiagnosis(incidentId: number, inputHash: string, model: string): Promise<number | null>;
  /** Paid model calls and their cost since `from` (from api_usage). */
  usageSince(from: Date): Promise<{ calls: number; costUsd: number }>;
  saveDiagnosis(d: NewDiagnosis): Promise<number>;
  recordUsage(u: ApiUsageRow): Promise<void>;
  /** Compare-and-set: change the status only if it's still `from`. Returns whether it changed. */
  setIncidentStatus(id: number, from: IncidentStatus, to: IncidentStatus): Promise<boolean>;
  pendingDiagnosisRequests(limit: number): Promise<DiagnosisRequest[]>;
  markRequestHandled(approvalId: number, diagnosisId: number | null): Promise<void>;
  /** Open, non-seeded incidents still in `new`, medium severity or worse, most severe first. */
  diagnosisCandidates(limit: number): Promise<Incident[]>;
}
