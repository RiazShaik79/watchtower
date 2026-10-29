// `npm run db:setup` logic against real MySQL (CI's container, where root plays Aiven's avnadmin):
// it creates an isolated database and user, proves the user can't read the "app" database,
// creates the tables, and refuses to silently reuse an existing user.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mysql from "mysql2/promise";
import { describeUrl } from "@/lib/db-config";
import { setupWatchtowerDatabase, UserExistsError } from "@/lib/db";

const url = process.env.WT_DATABASE_URL;
const DB = "wt_setup_test";
const USER = "wt_setup_test";
const APP_DB = "fake_app_db";

describe("database setup (db:setup)", { skip: !url && "WT_DATABASE_URL not set" }, () => {
  let adminUrl = "";
  let root: mysql.Connection;

  before(async () => {
    const p = describeUrl(url!);
    root = await mysql.createConnection({ uri: url! });
    await root.query(`DROP USER IF EXISTS '${USER}'@'%'`);
    await root.query(`DROP DATABASE IF EXISTS \`${DB}\``);
    await root.query(`CREATE DATABASE IF NOT EXISTS \`${APP_DB}\``);
    await root.query(`CREATE TABLE IF NOT EXISTS \`${APP_DB}\`.users (id INT PRIMARY KEY, email VARCHAR(100))`);
    const parsed = new URL(url!);
    parsed.pathname = `/${APP_DB}`;
    adminUrl = parsed.toString();
    assert.equal(p.host, "127.0.0.1");
  });

  after(async () => {
    await root.query(`DROP USER IF EXISTS '${USER}'@'%'`);
    await root.query(`DROP DATABASE IF EXISTS \`${DB}\``);
    await root.query(`DROP DATABASE IF EXISTS \`${APP_DB}\``);
    await root.end();
  });

  test("creates an isolated user, passes every check and creates the tables", async () => {
    const r = await setupWatchtowerDatabase({ adminUrl, database: DB, user: USER });
    assert.ok(r.ok, JSON.stringify(r.checks, null, 1));
    assert.equal(r.userCreated, true);
    assert.deepEqual(r.migrationsApplied, ["001_init.sql"]);
    assert.ok(r.databaseUrl?.startsWith(`mysql://${USER}:`));

    const conn = await mysql.createConnection({ uri: r.databaseUrl! });
    try {
      const [tables] = await conn.query(`SHOW TABLES FROM \`${DB}\``);
      assert.ok((tables as unknown[]).length >= 9, "Watchtower tables exist");
      await assert.rejects(conn.query(`SELECT * FROM \`${APP_DB}\`.users`), /denied/i, "the app's data is unreachable");
    } finally {
      await conn.end();
    }
  });

  test("an existing user is never silently reused", async () => {
    await assert.rejects(setupWatchtowerDatabase({ adminUrl, database: DB, user: USER }), UserExistsError);
  });

  test("rotating gives a new working password and keeps the tables", async () => {
    const r = await setupWatchtowerDatabase({ adminUrl, database: DB, user: USER, rotatePassword: true });
    assert.ok(r.ok);
    assert.deepEqual(r.migrationsApplied, [], "already up to date");
    const conn = await mysql.createConnection({ uri: r.databaseUrl! });
    await conn.query("SELECT 1");
    await conn.end();
  });

  test("refuses an admin URL that points at Watchtower's own database", async () => {
    const parsed = new URL(adminUrl);
    parsed.pathname = `/${DB}`;
    await assert.rejects(setupWatchtowerDatabase({ adminUrl: parsed.toString(), database: DB, user: USER }), /app's database/);
  });
});
