// Pure helpers for MySQL connection settings, shared by lib/db.ts and `npm run db:setup`.
// No I/O here, so it's unit-tested.

const TLS_SSL_MODES = new Set(["REQUIRED", "VERIFY_CA", "VERIFY_IDENTITY"]);

export interface ConnectionOptions {
  uri: string;
  ssl?: { ca: string; rejectUnauthorized: true };
}

/**
 * Aiven URLs end with `?ssl-mode=REQUIRED`, which mysql2 doesn't understand: turn it into a
 * verified TLS connection with the provider's CA. A URL without it (local MySQL, CI) has no TLS.
 */
export function connectionOptions(url: string, caCert: string | undefined, label = "WT_DATABASE_URL"): ConnectionOptions {
  const parsed = new URL(url.trim());
  const sslMode = parsed.searchParams.get("ssl-mode")?.toUpperCase();
  parsed.searchParams.delete("ssl-mode");
  if (!sslMode || !TLS_SSL_MODES.has(sslMode)) return { uri: parsed.toString() };
  const ca = caCert?.trim().replace(/\\n/g, "\n");
  if (!ca) throw new Error(`${label} asks for TLS (ssl-mode=${sslMode}) but no CA certificate was given.`);
  return { uri: parsed.toString(), ssl: { ca, rejectUnauthorized: true } };
}

export interface UrlParts {
  user: string;
  host: string;
  port: string;
  database: string;
  sslMode: string | null;
}

export function describeUrl(url: string): UrlParts {
  const parsed = new URL(url.trim());
  if (!/^mysql:$/i.test(parsed.protocol)) throw new Error("Expected a mysql:// URL (Aiven → your service → Overview → Service URI).");
  return {
    user: decodeURIComponent(parsed.username),
    host: parsed.hostname,
    port: parsed.port || "3306",
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    sslMode: parsed.searchParams.get("ssl-mode"),
  };
}

/** A mysql:// URL with the password URL-encoded, keeping the admin URL's ssl-mode. */
export function buildDatabaseUrl(p: { user: string; password: string; host: string; port: string; database: string; sslMode: string | null }): string {
  const query = p.sslMode ? `?ssl-mode=${encodeURIComponent(p.sslMode)}` : "";
  return `mysql://${encodeURIComponent(p.user)}:${encodeURIComponent(p.password)}@${p.host}:${p.port}/${encodeURIComponent(p.database)}${query}`;
}

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]{0,31}$/;

/** Database and user names are put into SQL as identifiers, so only plain names are allowed. */
export function assertIdentifier(name: string, what: string): void {
  if (!IDENTIFIER_RE.test(name)) throw new Error(`Invalid ${what} "${name}": use lowercase letters, digits and _ only.`);
}

/**
 * The new user's `SHOW GRANTS` must contain only USAGE on *.* and privileges on its own database,
 * and nothing WITH GRANT OPTION. Returns the offending lines (empty = isolated).
 * Names are `backticked` by default but "double-quoted" under ANSI_QUOTES, which Aiven enables.
 */
export function grantProblems(grants: string[], database: string): string[] {
  const own = ownGrantPattern(database);
  return grants.filter((g) => {
    if (/WITH GRANT OPTION/i.test(g)) return true;
    if (/^GRANT USAGE ON \*\.\* TO /i.test(g)) return false;
    return !own.test(g);
  });
}

/** True when `SHOW GRANTS` includes a grant on the user's own database (so setup actually worked). */
export function hasOwnGrant(grants: string[], database: string): boolean {
  const own = ownGrantPattern(database);
  return grants.some((g) => own.test(g));
}

function ownGrantPattern(database: string): RegExp {
  return new RegExp("^GRANT .+ ON ([`\"])" + database.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\1\\.\\* TO ", "i");
}

/** Databases the new user may see: its own plus MySQL's built-in information schemas. */
export function unexpectedDatabases(visible: string[], database: string): string[] {
  const allowed = new Set([database.toLowerCase(), "information_schema", "performance_schema"]);
  return visible.filter((d) => !allowed.has(d.toLowerCase()));
}
