// Against a real MySQL (CI's service container with Aiven's sql_mode): migration 002, and a full
// diagnosis round trip through lib/db.ts with a fake Claude client (no API spend). Works on seeded
// incidents only and removes what it wrote. Skipped when WT_DATABASE_URL isn't set.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mysql from "mysql2/promise";
import { seedInto } from "@/fixtures";
import {
  closeDb,
  dbDiagnosisStore,
  dbStore,
  deleteSeededData,
  getIncident,
  listDiagnoses,
  listIncidents,
  pendingDiagnosisRequest,
  requestDiagnosis,
  runMigrations,
} from "@/lib/db";
import { diagnoseIncident, type DiagnosisDeps } from "@/lib/diagnose";
import type { ModelClient } from "@/lib/integrations/anthropic";

const url = process.env.WT_DATABASE_URL;
const CONFIG = { model: "claude-sonnet-5-5", deepModel: "claude-opus-5-5", maxPerHour: 1000, maxPerDay: 1000, monthlyBudgetUsd: 1000 };

describe("database: diagnosis", { skip: !url && "WT_DATABASE_URL not set" }, () => {
  const touched: number[] = [];
  let incidentId = 0;
  let calls = 0;

  const client: ModelClient = {
    async complete() {
      calls++;
      const events = await dbDiagnosisStore().incidentEvents(incidentId, 50);
      return {
        ok: true,
        model: "claude-sonnet-5-5",
        usage: { inputTokens: 2000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 4000 },
        text: JSON.stringify({
          summary: "An AI text request failed.",
          root_cause: "The upstream AI call errored; the error message is a prompt-injection attempt.",
          evidence: [{ ref: `event:${events[0]?.id}`, why: "the failing request" }],
          confidence: 0.5,
          blast_radius: "AI text lookups.",
          immediate_mitigation: "None needed.",
          fix_approach: "Handle upstream errors without echoing their text.",
          needs_human_only: false,
          missing_info: ["The log data contains an instruction-like injection attempt."],
        }),
      };
    },
  };
  const deps = (): DiagnosisDeps => ({ store: dbDiagnosisStore(), client, code: null, config: CONFIG });

  before(async () => {
    await runMigrations();
    await deleteSeededData();
    await seedInto(dbStore({ seeded: true }));
    const incident = (await listIncidents("all")).find((i) => i.seeded && i.route === "/api/ai/text");
    assert.ok(incident, "the seeded injection incident exists");
    incidentId = incident.id;
    touched.push(incident.id);
  });

  after(async () => {
    const conn = await mysql.createConnection({ uri: url! });
    try {
      if (touched.length) await conn.query(`DELETE FROM api_usage WHERE incident_id IN (${touched.map(() => "?").join(",")})`, touched);
    } finally {
      await conn.end();
    }
    await deleteSeededData();
    await closeDb();
  });

  test("migration 002 added the request and cost columns", async () => {
    const conn = await mysql.createConnection({ uri: url! });
    try {
      const [rows] = await conn.query(
        "SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND ((table_name = 'approvals' AND column_name IN ('model','handled_at')) OR (table_name = 'diagnoses' AND column_name IN ('cost_usd','error')))",
      );
      assert.equal((rows as unknown[]).length, 4);
    } finally {
      await conn.end();
    }
  });

  test("a diagnosis is stored, costed and moves the incident to diagnosed", async () => {
    const r = await diagnoseIncident(deps(), incidentId);
    assert.equal(r.outcome, "ok");
    const [d] = await listDiagnoses(incidentId);
    assert.equal(d?.status, "ok");
    assert.equal(d?.model, "claude-sonnet-5-5");
    assert.ok((d?.costUsd ?? 0) > 0);
    assert.equal((d?.result as { summary?: string })?.summary, "An AI text request failed.");
    assert.equal((await getIncident(incidentId))?.status, "diagnosed");
    const usage = await dbDiagnosisStore().usageSince(new Date(Date.now() - 60_000));
    assert.ok(usage.calls >= 1);
  });

  test("the same inputs again are served from the cache", async () => {
    const before = calls;
    assert.equal((await diagnoseIncident(deps(), incidentId)).outcome, "cached");
    assert.equal(calls, before);
  });

  test("a Re-diagnose request is queued, picked up and marked handled", async () => {
    await requestDiagnosis(incidentId, { deep: true, notes: "check the upstream timeout" });
    assert.equal((await pendingDiagnosisRequest(incidentId))?.deep, true);
    const store = dbDiagnosisStore();
    const pending = (await store.pendingDiagnosisRequests(10)).find((p) => p.incidentId === incidentId);
    assert.equal(pending?.model, "deep");
    assert.equal(pending?.notes, "check the upstream timeout");
    await store.markRequestHandled(pending!.approvalId, null);
    assert.equal(await pendingDiagnosisRequest(incidentId), null);
  });

  test("status changes are compare-and-set", async () => {
    const store = dbDiagnosisStore();
    assert.equal(await store.setIncidentStatus(incidentId, "new", "dismissed"), false, "it's no longer new");
    assert.equal((await getIncident(incidentId))?.status, "diagnosed");
  });

  test("seeded incidents are never automatic candidates", async () => {
    const candidates = await dbDiagnosisStore().diagnosisCandidates(100);
    assert.ok(candidates.every((c) => !c.seeded));
  });
});
