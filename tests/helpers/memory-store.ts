// In-memory Store with the same semantics as lib/db.ts (dedupe on source+externalId, one open
// incident per fingerprint), so pipeline tests need no database.
import type { ApiUsageRow, DiagnosisStore, NewDiagnosis, NewIncident, Store, StoredEvent } from "@/lib/store";
import { SEVERITY_RANK, TERMINAL_STATUSES, type AuditEntry, type Incident, type ScrubbedSignal } from "@/lib/types";

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

export interface MemoryDiagnosisStore extends DiagnosisStore {
  base: MemoryStore;
  diagnoses: (NewDiagnosis & { id: number })[];
  usage: (ApiUsageRow & { at: Date })[];
  requests: { approvalId: number; incidentId: number; model: string | null; notes: string | null; handledAt: Date | null; diagnosisId: number | null }[];
}

/** The diagnosis side of lib/db.ts in memory, on top of a pipeline memory store. */
export function memoryDiagnosisStore(base: MemoryStore = memoryStore(), now: () => Date = () => new Date()): MemoryDiagnosisStore {
  const diagnoses: MemoryDiagnosisStore["diagnoses"] = [];
  const usage: MemoryDiagnosisStore["usage"] = [];
  const requests: MemoryDiagnosisStore["requests"] = [];
  const toStored = (e: MemoryStore["events"][number]): StoredEvent => ({
    id: e.id,
    source: e.source,
    occurredAt: e.occurredAt,
    level: e.level,
    title: e.title,
    message: e.message,
    stack: e.stack ?? null,
    route: e.route ?? null,
    eventCount: e.count ?? 1,
  });
  return {
    base,
    diagnoses,
    usage,
    requests,
    getSetting: base.getSetting,
    audit: base.audit,
    async getIncident(id) {
      const i = base.incidents.find((x) => x.id === id);
      return i ? { ...i } : null;
    },
    async incidentEvents(incidentId, limit) {
      return base.events.filter((e) => e.incidentId === incidentId).slice(-limit).map(toStored);
    },
    async recentDeploys(limit) {
      return base.events.filter((e) => e.source === "deploy").slice(-limit).reverse().map(toStored);
    },
    async findDiagnosis(incidentId, inputHash, model) {
      return diagnoses.findLast((d) => d.incidentId === incidentId && d.inputHash === inputHash && d.model === model && d.status === "ok")?.id ?? null;
    },
    async usageSince(from) {
      const rows = usage.filter((u) => u.at >= from);
      return { calls: rows.length, costUsd: rows.reduce((s, u) => s + u.costUsd, 0) };
    },
    async saveDiagnosis(d) {
      const id = diagnoses.length + 1;
      diagnoses.push({ ...d, id });
      return id;
    },
    async recordUsage(u) {
      usage.push({ ...u, at: now() });
    },
    async setIncidentStatus(id, from, to) {
      const i = base.incidents.find((x) => x.id === id);
      if (!i || i.status !== from) return false;
      i.status = to;
      return true;
    },
    async pendingDiagnosisRequests(limit) {
      return requests.filter((r) => r.handledAt === null).slice(0, limit);
    },
    async markRequestHandled(approvalId, diagnosisId) {
      const r = requests.find((x) => x.approvalId === approvalId);
      if (r) {
        r.handledAt = now();
        r.diagnosisId = diagnosisId ?? r.diagnosisId;
      }
    },
    async diagnosisCandidates(limit) {
      return base.incidents
        .filter((i) => i.status === "new" && !i.seeded && SEVERITY_RANK[i.severity] >= SEVERITY_RANK.medium && !diagnoses.some((d) => d.incidentId === i.id))
        .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.lastSeen.getTime() - a.lastSeen.getTime())
        .slice(0, limit)
        .map((i) => ({ ...i }));
    },
  };
}
