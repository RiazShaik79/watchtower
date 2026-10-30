import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InvalidTransitionError, TRANSITIONS, canTransition, transition } from "@/lib/state-machine";
import { INCIDENT_STATUSES, TERMINAL_STATUSES } from "@/lib/types";
import { memoryDiagnosisStore, memoryStore } from "../helpers/memory-store";

function storeWithIncident() {
  const base = memoryStore();
  base.incidents.push({
    id: 1,
    fingerprint: "fp",
    title: "TypeError",
    kind: "error",
    severity: "high",
    status: "new",
    firstSeen: new Date(),
    lastSeen: new Date(),
    eventCount: 1,
    route: null,
    regressionOf: null,
    seeded: false,
  });
  return memoryDiagnosisStore(base);
}

describe("state machine", () => {
  test("every status has an entry and terminal statuses go nowhere", () => {
    for (const s of INCIDENT_STATUSES) assert.ok(Array.isArray(TRANSITIONS[s]), s);
    for (const s of TERMINAL_STATUSES) assert.deepEqual(TRANSITIONS[s], [], s);
  });

  test("the architecture's moves into diagnosed are allowed", () => {
    for (const from of ["new", "diagnosed", "failed", "regression"] as const) assert.ok(canTransition(from, "diagnosed"), from);
    assert.equal(canTransition("verified", "diagnosed"), false);
    assert.equal(canTransition("new", "pr_open"), false);
  });

  test("a valid move changes the status and is audited", async () => {
    const store = storeWithIncident();
    assert.equal(await transition(store, { id: 1, status: "new" }, "diagnosed", "worker", { diagnosis_id: 7 }), true);
    assert.equal(store.base.incidents[0]?.status, "diagnosed");
    const row = store.base.auditLog.at(-1);
    assert.equal(row?.action, "status_changed");
    assert.deepEqual(row?.detail, { from: "new", to: "diagnosed", diagnosis_id: 7 });
  });

  test("a move the table doesn't allow throws and is audited as denied", async () => {
    const store = storeWithIncident();
    await assert.rejects(transition(store, { id: 1, status: "new" }, "merged", "worker"), InvalidTransitionError);
    assert.equal(store.base.incidents[0]?.status, "new");
    assert.equal(store.base.auditLog.at(-1)?.action, "invalid_transition");
    assert.equal(store.base.auditLog.at(-1)?.outcome, "denied");
  });

  test("fix_approved can't be reached through transition(): it needs an approval (guardrail 8)", async () => {
    const store = storeWithIncident();
    await assert.rejects(transition(store, { id: 1, status: "diagnosed" }, "fix_approved", "admin"), /needs an approval/);
  });

  test("if the status changed meanwhile, nothing changes", async () => {
    const store = storeWithIncident();
    store.base.incidents[0]!.status = "dismissed";
    assert.equal(await transition(store, { id: 1, status: "new" }, "diagnosed", "worker"), false);
    assert.equal(store.base.incidents[0]?.status, "dismissed");
    assert.equal(store.base.auditLog.at(-1)?.outcome, "skipped");
  });
});
