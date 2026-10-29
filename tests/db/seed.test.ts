// Against a real MySQL (CI's service container, or a local database via WT_DATABASE_URL):
// migrations apply, the seed produces the expected incidents, reseeding stores nothing twice,
// and the schema enforces the approval guardrail. Skipped when WT_DATABASE_URL isn't set.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mysql from "mysql2/promise";
import { EXPECTED, MUST_NOT_APPEAR, seedInto } from "@/fixtures";
import { closeDb, dbStore, deleteSeededData, listIncidents, runMigrations } from "@/lib/db";

const url = process.env.WT_DATABASE_URL;

describe("database: migrations and seed", { skip: !url && "WT_DATABASE_URL not set" }, () => {
  before(async () => {
    await runMigrations();
    await deleteSeededData();
  });
  after(async () => {
    await deleteSeededData();
    await closeDb();
  });

  test("seeded incidents are grouped with the right severity", async () => {
    await seedInto(dbStore({ seeded: true }));
    const seeded = (await listIncidents("all")).filter((i) => i.seeded);
    for (const e of EXPECTED) {
      const match = seeded.find((i) => i.title.includes(e.titleIncludes));
      assert.ok(match, `missing "${e.titleIncludes}"`);
      assert.deepEqual({ kind: match.kind, severity: match.severity, events: match.eventCount }, { kind: e.kind, severity: e.severity, events: e.events }, e.titleIncludes);
    }
    assert.equal(seeded.length, EXPECTED.length);
  });

  test("seeding again stores nothing new (dedupe on source + external id)", async () => {
    const again = await seedInto(dbStore({ seeded: true }));
    assert.equal(again.stored, 0);
    assert.equal(again.incidents, 0);
  });

  test("no fixture secret is stored anywhere", async () => {
    const conn = await mysql.createConnection({ uri: url! });
    try {
      const [rows] = await conn.query(
        "SELECT CONCAT_WS(' ', title, message_scrubbed, IFNULL(stack_scrubbed,'')) AS t FROM raw_events UNION ALL SELECT title FROM incidents UNION ALL SELECT CAST(detail_json AS CHAR) FROM audit_log",
      );
      const dump = (rows as { t: string | null }[]).map((r) => r.t ?? "").join("\n");
      for (const s of MUST_NOT_APPEAR) assert.ok(!dump.includes(s), `"${s}" stored`);
    } finally {
      await conn.end();
    }
  });

  test("the schema refuses a dispatch_fix action without an approval (guardrail 8)", async () => {
    const conn = await mysql.createConnection({ uri: url! });
    try {
      await assert.rejects(conn.query("INSERT INTO actions (type, status) VALUES ('dispatch_fix', 'requested')"), /ck_actions_dispatch_needs_approval|3819/);
    } finally {
      await conn.end();
    }
  });

  test("only one open incident per fingerprint", async () => {
    const conn = await mysql.createConnection({ uri: url! });
    try {
      const fp = "f".repeat(64);
      await conn.query("DELETE FROM incidents WHERE fingerprint = ?", [fp]);
      const insert = "INSERT INTO incidents (fingerprint, title, kind, severity, first_seen, last_seen, seeded) VALUES (?, 't', 'error', 'low', NOW(3), NOW(3), 1)";
      await conn.query(insert, [fp]);
      await assert.rejects(conn.query(insert, [fp]), /Duplicate entry/);
      await conn.query("UPDATE incidents SET status = 'dismissed' WHERE fingerprint = ?", [fp]);
      await conn.query(insert, [fp]); // allowed once the first is closed
      await conn.query("DELETE FROM incidents WHERE fingerprint = ?", [fp]);
    } finally {
      await conn.end();
    }
  });
});
