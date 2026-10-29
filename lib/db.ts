// The only database access in Watchtower: the mysql2 pool and every query (CLAUDE.md).
// Connects with WT_DATABASE_URL (database `watchtower`, user `watchtower`: never the app's
// credentials). Times are UTC DATETIME(3), read back as Date.
import { createHash } from "node:crypto";
import mysql, { type Pool, type PoolConnection, type ResultSetHeader } from "mysql2/promise";
import { migrate } from "./db-migrate";
import { log } from "./log";
import type { NewIncident, Store } from "./store";
import type { Actor, AuditEntry, Incident, IncidentStatus, Kind, Level, Outcome, ScrubbedSignal, Severity, Source } from "./types";

// ---------------------------------------------------------------------------------------------
// Connection, migrations, helpers
// ---------------------------------------------------------------------------------------------

const TLS_SSL_MODES = new Set(["REQUIRED", "VERIFY_CA", "VERIFY_IDENTITY"]);

function createPool(): Pool {
  const url = process.env.WT_DATABASE_URL?.trim();
  if (!url) throw new Error("WT_DATABASE_URL is not set. See .env.example.");
  // Aiven adds `?ssl-mode=REQUIRED`, which mysql2 doesn't understand: turn it into a verified TLS
  // connection with the provider's CA. A local URL without it connects without TLS.
  const parsed = new URL(url);
  const sslMode = parsed.searchParams.get("ssl-mode")?.toUpperCase();
  parsed.searchParams.delete("ssl-mode");
  let ssl: { ca: string; rejectUnauthorized: true } | undefined;
  if (sslMode && TLS_SSL_MODES.has(sslMode)) {
    const ca = process.env.WT_DATABASE_CA_CERT?.trim().replace(/\\n/g, "\n");
    if (!ca) throw new Error(`WT_DATABASE_URL asks for TLS (ssl-mode=${sslMode}) but WT_DATABASE_CA_CERT is not set.`);
    ssl = { ca, rejectUnauthorized: true };
  }
  return mysql.createPool({
    uri: parsed.toString(),
    connectionLimit: 3, // shares the Aiven service with the app (ADR 0003)
    waitForConnections: true,
    decimalNumbers: true,
    timezone: "Z",
    ...(ssl ? { ssl } : {}),
  });
}

const globalForDb = globalThis as unknown as { wtPool?: Pool; wtReady?: Promise<Pool> };

function ready(): Promise<Pool> {
  globalForDb.wtReady ??= (async () => {
    const pool = (globalForDb.wtPool ??= createPool());
    const applied = await migrate(pool);
    if (applied.length) log.info("db_migrations_applied", { names: applied });
    return pool;
  })().catch((err) => {
    globalForDb.wtReady = undefined;
    log.error("db_connect_failed", { code: (err as { code?: string })?.code, err });
    throw err;
  });
  return globalForDb.wtReady;
}

/** Close the pool so a worker process can exit. */
export async function closeDb(): Promise<void> {
  const pool = globalForDb.wtPool;
  globalForDb.wtPool = undefined;
  globalForDb.wtReady = undefined;
  await pool?.end();
}

/** Run pending migrations now (npm run db:migrate). */
export async function runMigrations(): Promise<void> {
  await ready();
}

type Executor = Pool | PoolConnection;
type Param = string | number | Date | null;

async function query<T>(sql: string, params: Param[] = [], ex?: Executor): Promise<T[]> {
  const [rows] = await (ex ?? (await ready())).query(sql, params);
  return rows as T[];
}

async function one<T>(sql: string, params: Param[] = [], ex?: Executor): Promise<T | null> {
  return (await query<T>(sql, params, ex))[0] ?? null;
}

async function exec(sql: string, params: Param[] = [], ex?: Executor): Promise<ResultSetHeader> {
  const [result] = await (ex ?? (await ready())).query(sql, params);
  return result as ResultSetHeader;
}

const isDuplicate = (err: unknown) => (err as { code?: string })?.code === "ER_DUP_ENTRY";

// ---------------------------------------------------------------------------------------------
// Rows → objects
// ---------------------------------------------------------------------------------------------

interface IncidentRow {
  id: number;
  fingerprint: string;
  title: string;
  kind: Kind;
  severity: Severity;
  status: IncidentStatus;
  first_seen: Date;
  last_seen: Date;
  event_count: number;
  route: string | null;
  regression_of: number | null;
  seeded: number;
}

const toIncident = (r: IncidentRow): Incident => ({
  id: r.id,
  fingerprint: r.fingerprint,
  title: r.title,
  kind: r.kind,
  severity: r.severity,
  status: r.status,
  firstSeen: r.first_seen,
  lastSeen: r.last_seen,
  eventCount: r.event_count,
  route: r.route,
  regressionOf: r.regression_of,
  seeded: r.seeded === 1,
});

const INCIDENT_COLUMNS = "id, fingerprint, title, kind, severity, status, first_seen, last_seen, event_count, route, regression_of, seeded";
const OPEN_CONDITION = "status NOT IN ('verified','dismissed','rolled_back')";
const SEVERITY_ORDER = "FIELD(severity,'critical','high','medium','low')";

// ---------------------------------------------------------------------------------------------
// Pipeline store
// ---------------------------------------------------------------------------------------------

/**
 * The pipeline's Store backed by MySQL. `seeded` marks rows written by `npm run seed` and keeps
 * its settings (health streaks, awake minutes, cursors) under a `seed:` prefix, so seeding never
 * disturbs the real monitoring state.
 */
export function dbStore(options: { seeded?: boolean } = {}): Store {
  const seeded = options.seeded ? 1 : 0;
  const settingName = (name: string) => (seeded ? `seed:${name}` : name);
  // Seeded fingerprints live in their own namespace, so seeded and real incidents never merge.
  const fp = (fingerprint: string) => (seeded ? createHash("sha256").update(`seed:${fingerprint}`).digest("hex") : fingerprint);
  return {
    async insertRawEvent(e: ScrubbedSignal) {
      try {
        const r = await exec(
          `INSERT INTO raw_events (source, external_id, occurred_at, level, kind, title, message_scrubbed, stack_scrubbed, route, event_count, fingerprint, seeded)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            e.source,
            (seeded ? `seed:${e.externalId}` : e.externalId).slice(0, 191),
            e.occurredAt,
            e.level,
            e.kind,
            e.title,
            e.message,
            e.stack ?? null,
            e.route ?? null,
            e.count ?? 1,
            e.fingerprint ? fp(e.fingerprint) : null,
            seeded,
          ],
        );
        return r.insertId;
      } catch (err) {
        if (isDuplicate(err)) return null;
        throw err;
      }
    },
    async linkRawEvent(eventId, incidentId) {
      await exec("UPDATE raw_events SET incident_id = ? WHERE id = ?", [incidentId, eventId]);
    },
    async countEvents(fingerprint, from, to) {
      const row = await one<{ n: number | null }>(
        "SELECT SUM(event_count) AS n FROM raw_events WHERE fingerprint = ? AND occurred_at BETWEEN ? AND ?",
        [fp(fingerprint), from, to],
      );
      return Number(row?.n ?? 0);
    },
    async findOpenIncident(fingerprint) {
      const row = await one<IncidentRow>(`SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE open_fingerprint = ?`, [fp(fingerprint)]);
      return row ? toIncident(row) : null;
    },
    async latestClosedIncidentId(fingerprint) {
      const row = await one<{ id: number }>(
        `SELECT id FROM incidents WHERE fingerprint = ? AND NOT (${OPEN_CONDITION}) ORDER BY last_seen DESC LIMIT 1`,
        [fp(fingerprint)],
      );
      return row?.id ?? null;
    },
    async fingerprintEverSeen(fingerprint) {
      return (await one<{ id: number }>("SELECT id FROM incidents WHERE fingerprint = ? LIMIT 1", [fp(fingerprint)])) !== null;
    },
    async createIncident(i: NewIncident) {
      const r = await exec(
        `INSERT INTO incidents (fingerprint, title, kind, severity, first_seen, last_seen, event_count, route, regression_of, deploy_id_at_open, seeded)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [fp(i.fingerprint), i.title, i.kind, i.severity, i.firstSeen, i.lastSeen, i.eventCount, i.route, i.regressionOf, i.deployIdAtOpen, seeded],
      );
      return r.insertId;
    },
    async updateIncident(id, u) {
      await exec("UPDATE incidents SET last_seen = ?, event_count = event_count + ?, severity = ? WHERE id = ?", [u.lastSeen, u.addEvents, u.severity, id]);
    },
    async audit(entry: AuditEntry) {
      await insertAudit(seeded ? { ...entry, detail: { ...entry.detail, seeded: true } } : entry);
    },
    getSetting: (name) => getSetting(settingName(name)),
    setSetting: (name, value) => setSetting(settingName(name), value),
  };
}

export async function insertAudit(entry: AuditEntry): Promise<void> {
  await exec("INSERT INTO audit_log (actor, action, incident_id, detail_json, outcome) VALUES (?, ?, ?, ?, ?)", [
    entry.actor,
    entry.action,
    entry.incidentId ?? null,
    entry.detail ? JSON.stringify(entry.detail) : null,
    entry.outcome,
  ]);
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export async function getSetting(name: string): Promise<string | null> {
  return (await one<{ value: string }>("SELECT value FROM settings WHERE name = ?", [name]))?.value ?? null;
}

export async function setSetting(name: string, value: string): Promise<void> {
  await exec("INSERT INTO settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [name, value]);
}

export async function getSettings(names: string[]): Promise<Record<string, string>> {
  if (!names.length) return {};
  const rows = await query<{ name: string; value: string }>(`SELECT name, value FROM settings WHERE name IN (${names.map(() => "?").join(",")})`, names);
  return Object.fromEntries(rows.map((r) => [r.name, r.value]));
}

// ---------------------------------------------------------------------------------------------
// Dashboard reads
// ---------------------------------------------------------------------------------------------

export async function listIncidents(filter: "open" | "all" = "open", limit = 200): Promise<Incident[]> {
  const where = filter === "open" ? `WHERE ${OPEN_CONDITION}` : "";
  const rows = await query<IncidentRow>(`SELECT ${INCIDENT_COLUMNS} FROM incidents ${where} ORDER BY ${SEVERITY_ORDER}, last_seen DESC LIMIT ?`, [limit]);
  return rows.map(toIncident);
}

export async function getIncident(id: number): Promise<Incident | null> {
  const row = await one<IncidentRow>(`SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE id = ?`, [id]);
  return row ? toIncident(row) : null;
}

export interface RawEventView {
  id: number;
  source: Source;
  occurredAt: Date;
  level: Level;
  title: string;
  message: string;
  stack: string | null;
  route: string | null;
  eventCount: number;
  seeded: boolean;
}

export async function listIncidentEvents(incidentId: number, limit = 50): Promise<RawEventView[]> {
  const rows = await query<{
    id: number;
    source: Source;
    occurred_at: Date;
    level: Level;
    title: string;
    message_scrubbed: string;
    stack_scrubbed: string | null;
    route: string | null;
    event_count: number;
    seeded: number;
  }>(
    `SELECT id, source, occurred_at, level, title, message_scrubbed, stack_scrubbed, route, event_count, seeded
     FROM raw_events WHERE incident_id = ? ORDER BY occurred_at DESC LIMIT ?`,
    [incidentId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    occurredAt: r.occurred_at,
    level: r.level,
    title: r.title,
    message: r.message_scrubbed,
    stack: r.stack_scrubbed,
    route: r.route,
    eventCount: r.event_count,
    seeded: r.seeded === 1,
  }));
}

export interface AuditView {
  id: number;
  at: Date;
  actor: Actor;
  action: string;
  incidentId: number | null;
  detail: Record<string, unknown> | null;
  outcome: Outcome;
}

export async function listAudit(options: { incidentId?: number; limit?: number } = {}): Promise<AuditView[]> {
  const rows = await query<{
    id: number;
    at: Date;
    actor: Actor;
    action: string;
    incident_id: number | null;
    detail_json: unknown;
    outcome: Outcome;
  }>(
    `SELECT id, at, actor, action, incident_id, detail_json, outcome FROM audit_log
     ${options.incidentId ? "WHERE incident_id = ?" : ""} ORDER BY id DESC LIMIT ?`,
    options.incidentId ? [options.incidentId, options.limit ?? 50] : [options.limit ?? 50],
  );
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    actor: r.actor,
    action: r.action,
    incidentId: r.incident_id,
    detail: (typeof r.detail_json === "string" ? JSON.parse(r.detail_json) : r.detail_json) as Record<string, unknown> | null,
    outcome: r.outcome,
  }));
}

export interface HealthPollView {
  occurredAt: Date;
  level: Level;
  title: string;
}

export async function listRecentHealthPolls(limit = 12): Promise<HealthPollView[]> {
  const rows = await query<{ occurred_at: Date; level: Level; title: string }>(
    "SELECT occurred_at, level, title FROM raw_events WHERE source = 'health' ORDER BY occurred_at DESC LIMIT ?",
    [limit],
  );
  return rows.map((r) => ({ occurredAt: r.occurred_at, level: r.level, title: r.title }));
}

export async function apiCostThisMonth(now: Date = new Date()): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const row = await one<{ total: number | null }>("SELECT SUM(cost_usd) AS total FROM api_usage WHERE at >= ?", [start]);
  return Number(row?.total ?? 0);
}

// ---------------------------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------------------------

/** Delete raw events older than `days` (default 14), in batches. Returns rows deleted. */
export async function purgeRawEvents(days = 14): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000);
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const r = await exec("DELETE FROM raw_events WHERE occurred_at < ? LIMIT 5000", [cutoff]);
    total += r.affectedRows;
    if (r.affectedRows < 5000) break;
  }
  return total;
}

/** Remove everything `npm run seed` wrote (the audit trail is append-only and is kept). */
export async function deleteSeededData(): Promise<{ events: number; incidents: number }> {
  const events = await exec("DELETE FROM raw_events WHERE seeded = 1");
  await exec("UPDATE incidents SET regression_of = NULL WHERE regression_of IN (SELECT id FROM (SELECT id FROM incidents WHERE seeded = 1) s)");
  const incidents = await exec("DELETE FROM incidents WHERE seeded = 1");
  await exec("DELETE FROM settings WHERE name LIKE 'seed:%'");
  return { events: events.affectedRows, incidents: incidents.affectedRows };
}

// ---------------------------------------------------------------------------------------------
// Admin sessions (lib/auth.ts)
// ---------------------------------------------------------------------------------------------

export async function createAdminSession(idHash: string, expiresAt: Date): Promise<void> {
  await exec("INSERT INTO admin_sessions (id_hash, expires_at) VALUES (?, ?)", [idHash, expiresAt]);
}

export async function adminSessionValid(idHash: string, now: Date = new Date()): Promise<boolean> {
  return (await one<{ id_hash: string }>("SELECT id_hash FROM admin_sessions WHERE id_hash = ? AND expires_at > ?", [idHash, now])) !== null;
}

export async function deleteAdminSession(idHash: string): Promise<void> {
  await exec("DELETE FROM admin_sessions WHERE id_hash = ?", [idHash]);
}

export async function purgeAdminSessions(now: Date = new Date()): Promise<number> {
  return (await exec("DELETE FROM admin_sessions WHERE expires_at <= ?", [now])).affectedRows;
}
