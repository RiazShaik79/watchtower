// In-memory Store with the same semantics as lib/db.ts (dedupe on source+externalId, one open
// incident per fingerprint), so pipeline tests need no database.
import type { NewIncident, Store } from "@/lib/store";
import { TERMINAL_STATUSES, type AuditEntry, type Incident, type ScrubbedSignal } from "@/lib/types";

export interface MemoryStore extends Store {
  events: (ScrubbedSignal & { id: number; incidentId: number | null })[];
  incidents: Incident[];
  auditLog: AuditEntry[];
  settings: Map<string, string>;
}

export function memoryStore(): MemoryStore {
  const events: MemoryStore["events"] = [];
  const incidents: Incident[] = [];
  const auditLog: AuditEntry[] = [];
  const settings = new Map<string, string>();
  const isOpen = (i: Incident) => !TERMINAL_STATUSES.includes(i.status);

  return {
    events,
    incidents,
    auditLog,
    settings,
    async insertRawEvent(e) {
      if (events.some((x) => x.source === e.source && x.externalId === e.externalId)) return null;
      const id = events.length + 1;
      events.push({ ...e, id, incidentId: null });
      return id;
    },
    async linkRawEvent(eventId, incidentId) {
      const e = events.find((x) => x.id === eventId);
      if (e) e.incidentId = incidentId;
    },
    async countEvents(fp, from, to) {
      return events
        .filter((e) => e.fingerprint === fp && e.occurredAt >= from && e.occurredAt <= to)
        .reduce((sum, e) => sum + (e.count ?? 1), 0);
    },
    async findOpenIncident(fp) {
      const found = incidents.find((i) => i.fingerprint === fp && isOpen(i));
      return found ? { ...found } : null; // a copy, like a database row
    },
    async latestClosedIncidentId(fp) {
      const closed = incidents.filter((i) => i.fingerprint === fp && !isOpen(i)).sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime());
      return closed[0]?.id ?? null;
    },
    async fingerprintEverSeen(fp) {
      return incidents.some((i) => i.fingerprint === fp);
    },
    async createIncident(n: NewIncident) {
      if (incidents.some((i) => i.fingerprint === n.fingerprint && isOpen(i))) throw Object.assign(new Error("duplicate open fingerprint"), { code: "ER_DUP_ENTRY" });
      const id = incidents.length + 1;
      incidents.push({
        id,
        fingerprint: n.fingerprint,
        title: n.title,
        kind: n.kind,
        severity: n.severity,
        status: "new",
        firstSeen: n.firstSeen,
        lastSeen: n.lastSeen,
        eventCount: n.eventCount,
        route: n.route,
        regressionOf: n.regressionOf,
        seeded: false,
      });
      return id;
    },
    async updateIncident(id, u) {
      const i = incidents.find((x) => x.id === id);
      if (!i) return;
      i.lastSeen = u.lastSeen;
      i.eventCount += u.addEvents;
      i.severity = u.severity;
    },
    async audit(entry) {
      auditLog.push(entry);
    },
    async getSetting(name) {
      return settings.get(name) ?? null;
    },
    async setSetting(name, value) {
      settings.set(name, value);
    },
  };
}
