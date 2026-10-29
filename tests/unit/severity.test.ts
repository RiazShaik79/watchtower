import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { INITIAL_HEALTH_STATE, errorSeverity, evaluateHealth, maxSeverity, type HealthPoll, type HealthState } from "@/lib/severity";

const base = { kind: "error" as const, level: "error" as const, isNewFingerprint: false, countInWindow: 1, countInBaseline: 1 };

describe("errorSeverity", () => {
  test("a new error fingerprint is high", () => assert.equal(errorSeverity({ ...base, isNewFingerprint: true }), "high"));
  test("a known fingerprint recurring is medium", () => assert.equal(errorSeverity(base), "medium"));
  test("10 or more in 15 min is high", () => assert.equal(errorSeverity({ ...base, countInWindow: 10, countInBaseline: 10 }), "high"));
  test("a spike of 5x the 24 h baseline is high", () => {
    // 96 events spread over the previous 24 h = ~1 per window; 6 now is a spike.
    assert.equal(errorSeverity({ ...base, countInWindow: 6, countInBaseline: 6 + 95 }), "high");
  });
  test("no spike when the baseline is already that busy", () => {
    assert.equal(errorSeverity({ ...base, countInWindow: 6, countInBaseline: 6 + 95 * 3 }), "medium");
  });
  test("a single DB connection error is medium", () => assert.equal(errorSeverity({ ...base, kind: "db", isNewFingerprint: true }), "medium"));
  test("slow queries: low, then medium at 5 in 15 min", () => {
    assert.equal(errorSeverity({ ...base, kind: "slow_query", level: "warn", countInWindow: 4 }), "low");
    assert.equal(errorSeverity({ ...base, kind: "slow_query", level: "warn", countInWindow: 5 }), "medium");
  });
  test("warnings are low", () => assert.equal(errorSeverity({ ...base, level: "warn", isNewFingerprint: true }), "low"));
  test("maxSeverity never lowers", () => {
    assert.equal(maxSeverity("critical", "low"), "critical");
    assert.equal(maxSeverity("low", "high"), "high");
  });
});

const poll = (p: Partial<HealthPoll>): HealthPoll => ({ at: new Date(), httpStatus: 200, ms: 500, db: "up", ...p });

function run(polls: Partial<HealthPoll>[]) {
  let state: HealthState = INITIAL_HEALTH_STATE;
  return polls.map((p) => {
    const e = evaluateHealth(state, poll(p));
    state = e.state;
    return e;
  });
}

describe("evaluateHealth", () => {
  test("a fast 200 is ok with no incident", () => {
    const [e] = run([{ ms: 400 }]);
    assert.equal(e?.outcome, "ok");
    assert.equal(e?.incident, null);
  });

  test("a cold start (slow but successful) is NOT a failure and raises nothing", () => {
    const results = run([{ ms: 34_000 }, { ms: 58_000 }, { ms: 41_000 }, { ms: 90_000 }]);
    for (const e of results) {
      assert.equal(e.outcome, "cold_start");
      assert.equal(e.incident, null);
    }
  });

  test("one failure is a low watch event", () => {
    const [e] = run([{ httpStatus: null, error: "timeout", db: null }]);
    assert.deepEqual(e?.incident, { kind: "health", severity: "low" });
  });

  test("3 consecutive failures are critical", () => {
    const fail = { httpStatus: null, error: "timeout", db: null } as const;
    const results = run([fail, { httpStatus: 502, db: null }, fail]);
    assert.deepEqual(results.map((r) => r.incident?.severity), ["low", "low", "critical"]);
  });

  test("a success in between resets the count", () => {
    const fail = { httpStatus: null, db: null } as const;
    const results = run([fail, fail, { ms: 30_000 }, fail, fail]);
    assert.deepEqual(results.map((r) => r.incident?.severity ?? null), ["low", "low", null, "low", "low"]);
  });

  test("db down twice in a row is critical (kind db)", () => {
    const down = { httpStatus: 503, db: "down" } as const;
    const results = run([down, down]);
    assert.deepEqual(results.map((r) => r.incident), [{ kind: "db", severity: "low" }, { kind: "db", severity: "critical" }]);
  });
});
