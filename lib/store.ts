// The persistence the pipeline needs, as an interface: lib/db.ts implements it against MySQL and
// tests/helpers/memory-store.ts in memory, so grouping and severity are tested without a database.
import type { AuditEntry, Incident, Kind, ScrubbedSignal, Severity } from "./types";

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
