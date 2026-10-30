import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DIAGNOSIS_SCHEMA, validateDiagnosis, type SuppliedRefs } from "@/lib/diagnosis-schema";

const supplied: SuppliedRefs = {
  events: new Set([11, 12]),
  commits: ["55bb45c0123456789abcdef0123456789abcdef0"],
  files: new Map([["lib/chaos-cases.ts", 40]]),
};

const good = () => ({
  summary: "The null-handling scenario reads a property of an undefined meal.",
  root_cause: "lib/chaos-cases.ts looks up a meal that isn't in the table and reads .calories on undefined.",
  evidence: [
    { ref: "event:11", why: "TypeError: Cannot read properties of undefined (reading 'calories')" },
    { ref: "file:lib/chaos-cases.ts:17", why: "the unchecked lookup" },
    { ref: "commit:55bb45c", why: "the deployed commit" },
  ],
  confidence: 0.92,
  blast_radius: "Only the chaos test route.",
  immediate_mitigation: "Turn chaos mode off.",
  fix_approach: "Check the lookup result before reading from it.",
  needs_human_only: false,
  missing_info: [],
});

describe("validateDiagnosis", () => {
  test("a well-formed answer citing supplied refs passes", () => {
    const r = validateDiagnosis(good(), supplied);
    assert.equal(r.ok, true);
  });

  test("citations must point at what was supplied", () => {
    for (const [ref, why] of [
      ["event:99", /wasn't supplied/],
      ["file:lib/auth.ts:3", /file that wasn't supplied/],
      ["file:lib/chaos-cases.ts:41", /past the end/],
      ["commit:deadbee", /wasn't supplied/],
      ["https://example.com", /isn't event/],
    ] as const) {
      const d = good();
      d.evidence = [{ ref, why: "x" }];
      const r = validateDiagnosis(d, supplied);
      assert.equal(r.ok, false, ref);
      if (!r.ok) assert.match(r.errors.join(" "), why, ref);
    }
  });

  test("a line range and a bare file path are accepted", () => {
    const d = good();
    d.evidence = [
      { ref: "file:lib/chaos-cases.ts:10-20", why: "x" },
      { ref: "file:lib/chaos-cases.ts", why: "y" },
    ];
    assert.equal(validateDiagnosis(d, supplied).ok, true);
  });

  test("an extra field, like an action a log line asked for, is rejected", () => {
    const r = validateDiagnosis({ ...good(), action: "open_pr", status: "resolved" }, supplied);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.errors.join(" "), /unexpected field "action"/);
      assert.match(r.errors.join(" "), /unexpected field "status"/);
    }
  });

  test("an extra field inside evidence is rejected", () => {
    const d = good() as Record<string, unknown>;
    d.evidence = [{ ref: "event:11", why: "x", run: "rm -rf" }];
    assert.equal(validateDiagnosis(d, supplied).ok, false);
  });

  test("wrong types, missing fields, empty evidence and bad confidence fail", () => {
    const cases: Record<string, unknown>[] = [
      { ...good(), confidence: 1.5 },
      { ...good(), confidence: "high" },
      { ...good(), needs_human_only: "no" },
      { ...good(), evidence: [] },
      { ...good(), summary: "" },
      { ...good(), missing_info: "none" },
      (() => {
        const d: Record<string, unknown> = good();
        delete d.root_cause;
        return d;
      })(),
    ];
    for (const c of cases) assert.equal(validateDiagnosis(c, supplied).ok, false, JSON.stringify(c).slice(0, 80));
    assert.equal(validateDiagnosis("not an object", supplied).ok, false);
    assert.equal(validateDiagnosis([good()], supplied).ok, false);
  });

  test("over-long text is rejected", () => {
    assert.equal(validateDiagnosis({ ...good(), summary: "x".repeat(601) }, supplied).ok, false);
  });

  test("the API schema is closed: no additional properties anywhere", () => {
    assert.equal(DIAGNOSIS_SCHEMA.additionalProperties, false);
    assert.equal(DIAGNOSIS_SCHEMA.properties.evidence.items.additionalProperties, false);
    assert.deepEqual([...DIAGNOSIS_SCHEMA.required].sort(), Object.keys(DIAGNOSIS_SCHEMA.properties).sort());
  });
});
