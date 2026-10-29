// Versioned schema migrations: every db/migrations/NNN_name.sql runs once, in order, and is
// recorded in `schema_migrations` (same runner as the app's lib/db-migrate.ts).
import fs from "node:fs";
import path from "node:path";
import type { Pool } from "mysql2/promise";

const DIR = path.join(process.cwd(), "db", "migrations");

/** Split a .sql file into statements (no stored procedures here, so `;` at line end is enough). */
function statements(sql: string): string[] {
  return sql
    .replace(/^\s*--.*$/gm, "")
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Apply pending migrations. Returns the names applied (empty when up to date). */
export async function migrate(pool: Pool): Promise<string[]> {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(255) NOT NULL PRIMARY KEY, applied_at VARCHAR(30) NOT NULL)",
  );
  const [rows] = await pool.query("SELECT name FROM schema_migrations");
  const done = new Set((rows as { name: string }[]).map((r) => r.name));
  const files = fs.readdirSync(DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];

  for (const file of files) {
    if (done.has(file)) continue;
    // MySQL commits DDL implicitly, so a failed migration can leave part of it applied: fail loudly
    // with the statement, fix the file or the database, and run again.
    const conn = await pool.getConnection();
    try {
      for (const stmt of statements(fs.readFileSync(path.join(DIR, file), "utf8"))) {
        try {
          await conn.query(stmt);
        } catch (err) {
          throw new Error(`Migration ${file} failed on:\n${stmt.slice(0, 300)}\n${(err as Error).message}`);
        }
      }
      await conn.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", [file, new Date().toISOString()]);
      applied.push(file);
    } finally {
      conn.release();
    }
  }
  return applied;
}
