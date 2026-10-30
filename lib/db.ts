// The only database access in Watchtower: the mysql2 pool and every query (CLAUDE.md).
// Connects with WT_DATABASE_URL (database `watchtower`, user `watchtower`: never the app's
// credentials). Times are UTC DATETIME(3), read back as Date.
import { createHash, randomBytes } from "node:crypto";
import mysql, { type Connection, type Pool, type PoolConnection, type ResultSetHeader } from "mysql2/promise";
import { assertIdentifier, buildDatabaseUrl, connectionOptions, describeUrl, grantProblems, hasOwnGrant, unexpectedDatabases } from "./db-config";
import { migrate } from "./db-migrate";
import { log } from "./log";
import type { ApiUsageRow, DiagnosisRequest, DiagnosisStore, NewDiagnosis, NewIncident, Store, StoredEvent } from "./store";
import type { Actor, AuditEntry, Incident, IncidentStatus, Kind, Level, Outcome, ScrubbedSignal, Severity, Source } from "./types";

// ---------------------------------------------------------------------------------------------
// Connection, migrations, helpers
// ---------------------------------------------------------------------------------------------

function createPool(): Pool {
  const url = process.env.WT_DATABASE_URL?.trim();
  if (!url) throw new Error("WT_DATABASE_URL is not set. See .env.example.");
  return mysql.createPool({
    ...connectionOptions(url, process.env.WT_DATABASE_CA_CERT),
    connectionLimit: 3, // shares the Aiven service with the app (ADR 0003)
    waitForConnections: true,
    decimalNumbers: true,
    timezone: "Z",
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

// ---------------------------------------------------------------------------------------------
// Diagnosis store (lib/diagnose.ts, lib/state-machine.ts)
// ---------------------------------------------------------------------------------------------

interface EventRow {
  id: number;
  source: Source;
  occurred_at: Date;
  level: Level;
  title: string;
  message_scrubbed: string;
  stack_scrubbed: string | null;
  route: string | null;
  event_count: number;
}

const EVENT_COLUMNS = "id, source, occurred_at, level, title, message_scrubbed, stack_scrubbed, route, event_count";

const toStoredEvent = (r: EventRow): StoredEvent => ({
  id: r.id,
  source: r.source,
  occurredAt: r.occurred_at,
  level: r.level,
  title: r.title,
  message: r.message_scrubbed,
  stack: r.stack_scrubbed,
  route: r.route,
  eventCount: r.event_count,
});

export function dbDiagnosisStore(): DiagnosisStore {
  return {
    getIncident,
    async incidentEvents(incidentId, limit) {
      const rows = await query<EventRow>(`SELECT ${EVENT_COLUMNS} FROM raw_events WHERE incident_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?`, [incidentId, limit]);
      return rows.map(toStoredEvent).reverse(); // oldest first, as a timeline
    },
    async recentDeploys(limit) {
      const rows = await query<EventRow>(`SELECT ${EVENT_COLUMNS} FROM raw_events WHERE source = 'deploy' AND seeded = 0 ORDER BY occurred_at DESC, id DESC LIMIT ?`, [limit]);
      return rows.map(toStoredEvent);
    },
    async findDiagnosis(incidentId, inputHash, model) {
      const row = await one<{ id: number }>(
        "SELECT id FROM diagnoses WHERE incident_id = ? AND input_hash = ? AND model = ? AND status = 'ok' ORDER BY id DESC LIMIT 1",
        [incidentId, inputHash, model],
      );
      return row?.id ?? null;
    },
    async usageSince(from) {
      const row = await one<{ calls: number; cost: number | null }>("SELECT COUNT(*) AS calls, SUM(cost_usd) AS cost FROM api_usage WHERE at >= ?", [from]);
      return { calls: Number(row?.calls ?? 0), costUsd: Number(row?.cost ?? 0) };
    },
    async saveDiagnosis(d: NewDiagnosis) {
      const r = await exec(
        `INSERT INTO diagnoses (incident_id, model, input_hash, status, result_json, confidence, cost_usd, owner_notes, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.incidentId, d.model, d.inputHash, d.status, d.result ? JSON.stringify(d.result) : null, d.confidence, d.costUsd, d.notes, d.error],
      );
      return r.insertId;
    },
    async recordUsage(u: ApiUsageRow) {
      await exec(
        `INSERT INTO api_usage (incident_id, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [u.incidentId, u.model, u.inputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.outputTokens, u.costUsd],
      );
    },
    async setIncidentStatus(id, from, to) {
      return (await exec("UPDATE incidents SET status = ? WHERE id = ? AND status = ?", [to, id, from])).affectedRows === 1;
    },
    async pendingDiagnosisRequests(limit) {
      const rows = await query<{ id: number; incident_id: number; model: string | null; reason: string | null }>(
        "SELECT id, incident_id, model, reason FROM approvals WHERE action = 'rediagnose' AND handled_at IS NULL ORDER BY id LIMIT ?",
        [limit],
      );
      return rows.map((r): DiagnosisRequest => ({ approvalId: r.id, incidentId: r.incident_id, model: r.model, notes: r.reason }));
    },
    async markRequestHandled(approvalId, diagnosisId) {
      await exec("UPDATE approvals SET handled_at = ?, diagnosis_id = COALESCE(?, diagnosis_id) WHERE id = ?", [new Date(), diagnosisId, approvalId]);
    },
    async diagnosisCandidates(limit) {
      // A failed automatic diagnosis isn't retried on its own (that would spend on every run);
      // the owner can ask again with Re-diagnose.
      const rows = await query<IncidentRow>(
        `SELECT ${INCIDENT_COLUMNS} FROM incidents i
         WHERE status = 'new' AND seeded = 0 AND severity IN ('critical','high','medium')
           AND NOT EXISTS (SELECT 1 FROM diagnoses d WHERE d.incident_id = i.id)
         ORDER BY ${SEVERITY_ORDER}, last_seen DESC LIMIT ?`,
        [limit],
      );
      return rows.map(toIncident);
    },
    audit: insertAudit,
    getSetting,
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

export interface DiagnosisView {
  id: number;
  model: string;
  status: "ok" | "failed";
  result: Record<string, unknown> | null;
  confidence: number | null;
  costUsd: number;
  notes: string | null;
  error: string | null;
  createdAt: Date;
}

export async function listDiagnoses(incidentId: number, limit = 10): Promise<DiagnosisView[]> {
  const rows = await query<{
    id: number;
    model: string;
    status: "ok" | "failed";
    result_json: unknown;
    confidence: number | null;
    cost_usd: number;
    owner_notes: string | null;
    error: string | null;
    created_at: Date;
  }>(
    `SELECT id, model, status, result_json, confidence, cost_usd, owner_notes, error, created_at
     FROM diagnoses WHERE incident_id = ? ORDER BY id DESC LIMIT ?`,
    [incidentId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    model: r.model,
    status: r.status,
    result: (typeof r.result_json === "string" ? JSON.parse(r.result_json) : r.result_json) as Record<string, unknown> | null,
    confidence: r.confidence === null ? null : Number(r.confidence),
    costUsd: Number(r.cost_usd),
    notes: r.owner_notes,
    error: r.error,
    createdAt: r.created_at,
  }));
}

/** The owner's unhandled Re-diagnose request for an incident, if any. */
export async function pendingDiagnosisRequest(incidentId: number): Promise<{ id: number; deep: boolean; at: Date } | null> {
  const row = await one<{ id: number; model: string | null; created_at: Date }>(
    "SELECT id, model, created_at FROM approvals WHERE incident_id = ? AND action = 'rediagnose' AND handled_at IS NULL ORDER BY id DESC LIMIT 1",
    [incidentId],
  );
  return row ? { id: row.id, deep: row.model !== null, at: row.created_at } : null;
}

/** Queue a Re-diagnose for the worker (the dashboard never calls Claude itself). Notes must be scrubbed. */
export async function requestDiagnosis(incidentId: number, options: { deep: boolean; notes: string | null }): Promise<number> {
  const r = await exec("INSERT INTO approvals (incident_id, action, actor, reason, model) VALUES (?, 'rediagnose', 'admin', ?, ?)", [
    incidentId,
    options.notes,
    options.deep ? "deep" : null,
  ]);
  await insertAudit({
    actor: "admin",
    action: "rediagnose_requested",
    incidentId,
    outcome: "ok",
    detail: { approval_id: r.insertId, deep: options.deep, with_notes: Boolean(options.notes) },
  });
  return r.insertId;
}

export async function diagnosisStatsThisMonth(now: Date = new Date()): Promise<{ count: number; failed: number }> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const row = await one<{ n: number; failed: number | null }>("SELECT COUNT(*) AS n, SUM(status = 'failed') AS failed FROM diagnoses WHERE created_at >= ?", [start]);
  return { count: Number(row?.n ?? 0), failed: Number(row?.failed ?? 0) };
}

/** The dashboard kill-switch toggle (guardrail 5). KILL_SWITCH=true in the env still wins. */
export async function setKillSwitch(on: boolean): Promise<void> {
  await setSetting("kill_switch", on ? "on" : "off");
  await insertAudit({ actor: "admin", action: on ? "kill_switch_on" : "kill_switch_off", outcome: "ok" });
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
  // Re-diagnose requests on seeded incidents go with them (diagnoses cascade on their own).
  await exec("DELETE FROM approvals WHERE incident_id IN (SELECT id FROM (SELECT id FROM incidents WHERE seeded = 1) s)");
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

// ---------------------------------------------------------------------------------------------
// One-time setup (`npm run db:setup`, ADR 0003): with the Aiven admin URL, create Watchtower's own
// database and a user limited to it, prove the isolation, then create the tables as that user.
// The admin URL is used only inside this function and is never stored or logged.
// ---------------------------------------------------------------------------------------------

export class UserExistsError extends Error {
  constructor(user: string) {
    super(`User "${user}" already exists.`);
    this.name = "UserExistsError";
  }
}

export interface SetupCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface SetupResult {
  checks: SetupCheck[];
  ok: boolean;
  /** The new user's connection URL. Only set when every check passed. */
  databaseUrl: string | null;
  migrationsApplied: string[];
  userCreated: boolean;
}

export async function setupWatchtowerDatabase(options: {
  adminUrl: string;
  caCert?: string;
  database?: string;
  user?: string;
  /** Required when the user already exists: replaces its password. */
  rotatePassword?: boolean;
  /** Progress messages for the terminal, so a slow step never looks frozen. */
  onStep?: (message: string) => void;
}): Promise<SetupResult> {
  const step = options.onStep ?? (() => {});
  // Every setup query fails after 30 s instead of waiting forever.
  const run = (conn: Connection, sql: string, values?: unknown[]) => conn.query({ sql, values, timeout: 30_000 });
  const database = options.database ?? "watchtower";
  const user = options.user ?? "watchtower";
  assertIdentifier(database, "database name");
  assertIdentifier(user, "user name");
  const admin = describeUrl(options.adminUrl);
  const forbidden = admin.database || "defaultdb";
  if (forbidden.toLowerCase() === database) throw new Error("The admin URL must point at the app's database, not Watchtower's.");
  const password = randomBytes(24).toString("base64url");

  step(`Connecting to ${admin.host} as ${admin.user}...`);
  const adminConn = await mysql.createConnection(connectionOptions(options.adminUrl, options.caCert, "The admin URL"));
  let userCreated = false;
  try {
    step(`Creating database "${database}" and user "${user}"...`);
    await run(adminConn, `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    try {
      await run(adminConn, "CREATE USER ?@'%' IDENTIFIED BY ?", [user, password]);
      userCreated = true;
    } catch (err) {
      if ((err as { code?: string })?.code !== "ER_CANNOT_USER") throw err;
      if (!options.rotatePassword) throw new UserExistsError(user);
      step(`User "${user}" already exists: giving it a new password...`);
      await run(adminConn, "ALTER USER ?@'%' IDENTIFIED BY ?", [user, password]);
    }
    await run(adminConn, `GRANT ALL PRIVILEGES ON \`${database}\`.* TO ?@'%'`, [user]);
  } finally {
    await adminConn.end();
  }

  const databaseUrl = buildDatabaseUrl({ user, password, host: admin.host, port: admin.port, database, sslMode: admin.sslMode });
  const checks: SetupCheck[] = [];
  step(`Checking isolation, connected as "${user}"...`);
  const userConn = await mysql.createConnection(connectionOptions(databaseUrl, options.caCert));
  try {
    const [grantRows] = await run(userConn, "SHOW GRANTS");
    const grants = (grantRows as Record<string, string>[]).map((r) => Object.values(r)[0] ?? "");
    const badGrants = grantProblems(grants, database);
    checks.push({
      name: `"${user}" has rights on "${database}" only`,
      pass: badGrants.length === 0 && hasOwnGrant(grants, database),
      detail: badGrants.length ? `unexpected: ${badGrants.join(" | ")}` : hasOwnGrant(grants, database) ? `${grants.length} grant line(s)` : `no grant on "${database}"`,
    });

    const [dbRows] = await run(userConn, "SHOW DATABASES");
    const visible = (dbRows as Record<string, string>[]).map((r) => Object.values(r)[0] ?? "");
    const extra = unexpectedDatabases(visible, database);
    checks.push({ name: "it can't see any other database", pass: extra.length === 0, detail: extra.length ? `also sees: ${extra.join(", ")}` : visible.join(", ") });

    let denied = false;
    let detail = "";
    try {
      await run(userConn, `SHOW TABLES FROM \`${forbidden.replace(/`/g, "")}\``);
      detail = `it CAN read "${forbidden}"`;
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "";
      denied = code === "ER_DBACCESS_DENIED_ERROR" || code === "ER_BAD_DB_ERROR";
      detail = denied ? `access denied (${code})` : `unexpected error ${code}`;
    }
    checks.push({ name: `it can't read the app's database "${forbidden}"`, pass: denied, detail });
  } finally {
    await userConn.end();
  }

  const ok = checks.every((c) => c.pass);
  let migrationsApplied: string[] = [];
  if (ok) {
    step("Creating tables...");
    const pool = mysql.createPool({ ...connectionOptions(databaseUrl, options.caCert), connectionLimit: 1 });
    try {
      migrationsApplied = await migrate(pool);
    } finally {
      await pool.end();
    }
  }
  return { checks, ok, databaseUrl: ok ? databaseUrl : null, migrationsApplied, userCreated };
}
