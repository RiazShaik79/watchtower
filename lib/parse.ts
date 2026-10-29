// Source parsers: turn Render log lines and Sentry issues into Signals (still unscrubbed; the
// pipeline scrubs before storing). They understand the app's JSON log shapes from lib/log.ts:
// request_failed, db_query_failed, db_connect_failed, slow_query, health_db_down.
import { DB_CONNECTION_FP, HEALTH_DB_DOWN_FP } from "./fingerprint";
import type { Signal } from "./types";

export interface RenderLogLine {
  id: string;
  message: string;
  timestamp: string;
  labels?: { name: string; value: string }[];
}

// mysql2 / Node error codes that mean "can't reach the database", not "bad query".
const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "PROTOCOL_CONNECTION_LOST",
  "ER_CON_COUNT_ERROR",
  "ER_ACCESS_DENIED_ERROR",
  "HANDSHAKE_SSL_ERROR",
  "PING_TIMEOUT",
]);

// Non-JSON lines worth keeping: framework/runtime error prints. Everything else (including the
// app's console mailer, which prints emails and reset links) is dropped without being stored.
const PLAIN_ERROR_RE = /(?:^|\s)(?:⨯|Error:|TypeError|ReferenceError|RangeError|SyntaxError|Unhandled|uncaught|FATAL)\b/i;

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export function parseRenderLog(line: RenderLogLine): Signal | null {
  const occurredAt = new Date(line.timestamp);
  if (Number.isNaN(occurredAt.getTime())) return null;
  const base = { source: "render_log" as const, externalId: line.id, occurredAt };
  const text = line.message.trim();

  let data: Json | null = null;
  if (text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Json;
    } catch {
      data = null;
    }
  }

  if (!data) {
    if (!PLAIN_ERROR_RE.test(text)) return null;
    const first = text.split("\n")[0]!.slice(0, 300);
    const typeMatch = /\b([A-Z][A-Za-z]*Error)\b/.exec(first);
    return { ...base, level: "error", kind: "error", title: first, message: text, stack: text, errorType: typeMatch?.[1] ?? "plain_error" };
  }

  const msg = str(data.msg) ?? "log";
  const level = data.level === "error" ? "error" : data.level === "warn" ? "warn" : "info";
  const err = (data.err && typeof data.err === "object" ? data.err : {}) as Json;
  const code = str(data.code) ?? str(err.code);

  // Every "can't reach the database" error is one problem, whatever the code: one incident.
  const dbUnreachable = (title: string): Signal => ({
    ...base,
    level: "error",
    kind: "db",
    title,
    message: str(err.message) ?? msg,
    errorType: code ?? msg,
    fixedFingerprint: DB_CONNECTION_FP,
  });

  switch (msg) {
    case "request_failed": {
      const name = str(err.name) ?? "Error";
      const message = str(err.message) ?? "Request failed";
      return {
        ...base,
        level: "error",
        kind: "error",
        title: `${name}: ${message}`.slice(0, 300),
        message,
        stack: str(err.stack),
        route: str(data.route),
        errorType: name,
      };
    }
    case "db_connect_failed":
      return dbUnreachable(`Database connection failed (${code ?? "unknown"})`);
    case "health_db_down":
      // The app's own health route saw the database down: the same incident the health poll raises.
      return { ...dbUnreachable("Database down (reported by /api/health)"), fixedFingerprint: HEALTH_DB_DOWN_FP };
    case "db_query_failed": {
      if (code !== undefined && CONNECTION_CODES.has(code)) return dbUnreachable(`Database connection failed (${code})`);
      return {
        ...base,
        level: "error",
        kind: "error",
        title: `Database query failed (${code ?? "unknown"})`,
        message: str(err.message) ?? str(data.sql) ?? msg,
        stack: str(err.stack),
        errorType: code ?? "db_query_failed",
        location: str(data.sql),
      };
    }
    case "slow_query": {
      const sql = str(data.sql) ?? "";
      const ms = typeof data.ms === "number" ? data.ms : undefined;
      return {
        ...base,
        level: "warn",
        kind: "slow_query",
        title: `Slow query: ${sql.slice(0, 120)}`,
        message: `${ms ?? "?"} ms: ${sql}`,
        errorType: "slow_query",
        location: sql,
      };
    }
    default:
      if (level === "info") return null;
      return {
        ...base,
        level,
        kind: "error",
        title: (str(err.message) ? `${msg}: ${str(err.message)}` : msg).slice(0, 300),
        message: str(err.message) ?? msg,
        stack: str(err.stack),
        route: str(data.route),
        errorType: msg,
      };
  }
}

export interface SentryIssue {
  id: string;
  title: string;
  culprit?: string | null;
  level?: string;
  count: string | number;
  firstSeen: string;
  lastSeen: string;
  metadata?: { type?: string; value?: string; filename?: string; function?: string };
}

/**
 * A Sentry issue whose count grew since the last poll becomes one signal standing for the new
 * occurrences. Returns null when nothing changed.
 */
export function parseSentryIssue(issue: SentryIssue, previousCount: number): Signal | null {
  const count = Number(issue.count) || 0;
  const delta = count - previousCount;
  if (delta <= 0) return null;
  const occurredAt = new Date(issue.lastSeen);
  if (Number.isNaN(occurredAt.getTime())) return null;
  const route = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)/.exec(issue.culprit ?? "")?.[1];
  const level = issue.level === "warning" ? "warn" : issue.level === "info" ? "info" : "error";
  const errorType = issue.metadata?.type ?? issue.title.split(":")[0] ?? "Error";
  const message = issue.metadata?.value ?? issue.title;
  const frame = issue.metadata?.filename ? `${issue.metadata.filename.replace(/\.[cm]?[jt]sx?$/, "")}:${issue.metadata.function ?? "<anon>"}` : undefined;
  return {
    source: "sentry",
    externalId: `${issue.id}:${count}`,
    occurredAt,
    level,
    kind: "error",
    title: issue.title.slice(0, 300),
    message,
    route,
    errorType,
    location: frame,
    count: delta,
  };
}
