// Phase 2 "done when": the seeded incidents appear correctly grouped and with the right severity.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPECTED, MUST_NOT_APPEAR, seedInto } from "@/fixtures";
import { memoryStore } from "../helpers/memory-store";

test("fixtures produce exactly the expected incidents, kinds, severities and counts", async () => {
  const store = memoryStore();
  const result = await seedInto(store, new Date("2026-10-29T12:00:00Z"));
  const got = store.incidents.map((i) => ({ title: i.title, kind: i.kind, severity: i.severity, events: i.eventCount }));
  for (const e of EXPECTED) {
    const match = got.find((g) => g.title.includes(e.titleIncludes));
    assert.ok(match, `missing incident "${e.titleIncludes}". Got: ${JSON.stringify(got, null, 1)}`);
    assert.deepEqual({ kind: match.kind, severity: match.severity, events: match.events }, { kind: e.kind, severity: e.severity, events: e.events }, e.titleIncludes);
  }
  assert.equal(store.incidents.length, EXPECTED.length, `unexpected extra incidents: ${JSON.stringify(got, null, 1)}`);
  assert.equal(result.duplicates, 1, "the repeated log line is deduped");
});

test("the mailer line and info lines are never stored; cold starts are stored but raise nothing", async () => {
  const store = memoryStore();
  await seedInto(store, new Date("2026-10-29T12:00:00Z"));
  assert.ok(!store.events.some((e) => e.externalId === "seed-log-040"), "mailer line stored");
  assert.ok(!store.events.some((e) => e.externalId === "seed-log-041"), "info line stored");
  const coldStarts = store.events.filter((e) => e.title.startsWith("Cold start"));
  assert.equal(coldStarts.length, 2);
  assert.ok(coldStarts.every((e) => e.incidentId === null));
});

test("no secret or personal data from the fixtures reaches storage", async () => {
  const store = memoryStore();
  await seedInto(store, new Date("2026-10-29T12:00:00Z"));
  const dump = JSON.stringify([store.events, store.incidents, store.auditLog, [...store.settings]]);
  for (const s of MUST_NOT_APPEAR) assert.ok(!dump.includes(s), `"${s}" was stored`);
});

test("seeding twice stores nothing new", async () => {
  const store = memoryStore();
  const now = new Date("2026-10-29T12:00:00Z");
  await seedInto(store, now);
  const before = { events: store.events.length, incidents: store.incidents.length };
  const again = await seedInto(store, now);
  assert.equal(again.stored, 0);
  assert.deepEqual({ events: store.events.length, incidents: store.incidents.length }, before);
});
