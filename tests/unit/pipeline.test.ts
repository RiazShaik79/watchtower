import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ingestSignals, recordHealth } from "@/lib/pipeline";
import type { Signal } from "@/lib/types";
import { memoryStore } from "../helpers/memory-store";

const t0 = new Date("2026-10-29T10:00:00Z");
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

const err = (id: string, minutes: number, message = "Cannot read properties of undefined (reading 'x')", route = "/api/log/[id]"): Signal => ({
  source: "render_log",
  externalId: id,
  occurredAt: at(minutes),
  level: "error",
  kind: "error",
  title: `TypeError: ${message}`,
  message,
  route,
  errorType: "TypeError",
});

describe("grouping and dedupe", () => {
  test("repeats of one error group into a single incident", async () => {
    const store = memoryStore();
    const r = await ingestSignals(store, [err("a", 0), err("b", 1), err("c", 2)]);
    assert.equal(store.incidents.length, 1);
    assert.equal(store.incidents[0]?.eventCount, 3);
    assert.equal(r.detected.length, 1);
    assert.ok(store.events.every((e) => e.incidentId === 1));
  });

  test("ids in the message or route don't split the group", async () => {
    const store = memoryStore();
    await ingestSignals(store, [err("a", 0, "Entry 101 missing", "/api/log/101"), err("b", 1, "Entry 9932 missing", "/api/log/9932")]);
    assert.equal(store.incidents.length, 1);
  });

  test("different errors open different incidents", async () => {
    const store = memoryStore();
    await ingestSignals(store, [err("a", 0, "x is undefined"), err("b", 1, "y is not a function"), err("c", 2, "x is undefined", "/api/water")]);
    assert.equal(store.incidents.length, 3);
  });

  test("the same external id is stored once (overlapping log windows)", async () => {
    const store = memoryStore();
    const first = await ingestSignals(store, [err("same", 0)]);
    const second = await ingestSignals(store, [err("same", 0), err("same", 0)]);
    assert.equal(first.stored, 1);
    assert.equal(second.stored, 0);
    assert.equal(second.duplicates, 2);
    assert.equal(store.incidents[0]?.eventCount, 1);
  });

  test("severity escalates with volume and never drops", async () => {
    const store = memoryStore();
    await ingestSignals(store, [err("seed", -60 * 24 * 2)]); // seen long ago, so not "new" later
    store.incidents[0]!.status = "dismissed";
    store.incidents[0]!.severity = "low";
    const burst = Array.from({ length: 10 }, (_, i) => err(`b${i}`, i));
    const r = await ingestSignals(store, burst);
    const open = store.incidents.find((i) => i.status === "new")!;
    assert.equal(open.regressionOf, 1, "a reopened fingerprint links to the closed incident");
    assert.equal(open.severity, "high");
    assert.ok(r.escalated.includes(open.id));
    await ingestSignals(store, [err("late", 60 * 5)]);
    assert.equal(open.severity, "high", "a later quiet event doesn't lower it");
  });

  test("detection and escalation are audited with scrubbed details", async () => {
    const store = memoryStore();
    await ingestSignals(store, [err("a", 0, "failed for jane@example.com")]);
    const entry = store.auditLog.find((e) => e.action === "incident_detected");
    assert.ok(entry);
    assert.ok(!JSON.stringify(entry).includes("jane@example.com"));
  });

  test("nothing unscrubbed is stored", async () => {
    const store = memoryStore();
    await ingestSignals(store, [{ ...err("a", 0, "connect mysql://avnadmin:hunter2@h:1/db for bob@example.com"), stack: "Error\n at x (Bearer abcdefghijklmnop123)" }]);
    const dump = JSON.stringify([store.events, store.incidents, store.auditLog]);
    for (const secret of ["hunter2", "avnadmin", "bob@example.com", "abcdefghijklmnop123"]) assert.ok(!dump.includes(secret), secret);
  });
});

describe("health polls through the pipeline", () => {
  test("cold starts store polls but open no incident", async () => {
    const store = memoryStore();
    for (const [i, ms] of [34_000, 50_000, 700].entries()) await recordHealth(store, { at: at(i * 15), httpStatus: 200, ms, db: "up" });
    assert.equal(store.incidents.length, 0);
    assert.equal(store.events.length, 3);
  });

  test("an outage becomes one incident that escalates to critical", async () => {
    const store = memoryStore();
    for (const i of [0, 1, 2]) await recordHealth(store, { at: at(i * 15), httpStatus: null, ms: 240_000, db: null, error: "timeout" });
    assert.equal(store.incidents.length, 1);
    assert.equal(store.incidents[0]?.severity, "critical");
    assert.equal(store.incidents[0]?.eventCount, 3);
    await recordHealth(store, { at: at(45), httpStatus: 200, ms: 800, db: "up" });
    assert.ok(store.auditLog.some((e) => e.action === "health_recovered"));
  });

  test("polls accrue awake minutes for the free-hours estimate", async () => {
    const store = memoryStore();
    await recordHealth(store, { at: at(0), httpStatus: 200, ms: 30_000, db: "up" });
    await recordHealth(store, { at: at(15), httpStatus: 200, ms: 500, db: "up" });
    assert.equal(store.settings.get("awake_minutes:2026-10"), String(16 + 15));
  });
});
