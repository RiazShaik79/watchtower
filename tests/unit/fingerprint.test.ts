import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fingerprint, normalizeMessage, normalizeRoute, topInAppFrame } from "@/lib/fingerprint";
import { scrubSignal } from "@/lib/pipeline";
import { parseRenderLog, parseSentryIssue } from "@/lib/parse";

describe("normalizeMessage", () => {
  test("replaces variable parts with placeholders", () => {
    assert.equal(
      normalizeMessage("User 42 not found at 2026-10-29T13:44:00.123Z (id 3f2b1c9e-1a2b-4c3d-9e8f-0123456789ab, mail a@b.co, hash deadbeefcafe)"),
      "User <n> not found at <ts> (id <uuid>, mail <email>, hash <hex>)",
    );
  });
  test("quoted strings become <str>", () => {
    assert.equal(normalizeMessage(`Unknown column 'foo' in "bar"`), "Unknown column <str> in <str>");
  });
  test("two occurrences of one error with different ids normalise the same", () => {
    assert.equal(normalizeMessage("Entry 101 missing for user 7"), normalizeMessage("Entry 9932 missing for user 15"));
  });
});

describe("normalizeRoute", () => {
  test("dynamic segments and ids become :id", () => {
    assert.equal(normalizeRoute("/api/log/[id]"), "/api/log/:id");
    assert.equal(normalizeRoute("/api/log/42"), "/api/log/:id");
    assert.equal(normalizeRoute("/api/weight/3f2b1c9e-1a2b-4c3d-9e8f-0123456789ab?x=1"), "/api/weight/:id");
    assert.equal(normalizeRoute("/api/health/"), "/api/health");
  });
});

describe("topInAppFrame", () => {
  test("skips framework frames and strips the deploy path, extension and line numbers", () => {
    const stack = [
      "TypeError: boom",
      "    at async /opt/render/project/src/node_modules/next/dist/server/x.js:1:2",
      "    at PATCH (/opt/render/project/src/.next/server/app/api/log/[id]/route.js:1:2345)",
    ].join("\n");
    assert.equal(topInAppFrame(stack), "app/api/log/[id]/route:PATCH");
  });
  test("empty when no in-app frame", () => {
    assert.equal(topInAppFrame("Error\n    at node:internal/process/task_queues:95:5"), "");
    assert.equal(topInAppFrame(undefined), "");
  });
});

describe("fingerprint", () => {
  test("stable and sensitive to kind, type and location", () => {
    const a = fingerprint("error", "TypeError", "/api/log/:id", "x is undefined");
    assert.equal(a, fingerprint("error", "TypeError", "/api/log/:id", "x is undefined"));
    assert.notEqual(a, fingerprint("error", "RangeError", "/api/log/:id", "x is undefined"));
    assert.notEqual(a, fingerprint("error", "TypeError", "/api/water", "x is undefined"));
    assert.notEqual(a, fingerprint("db", "TypeError", "/api/log/:id", "x is undefined"));
  });

  test("the same error from the Render logs and from Sentry gets one fingerprint", () => {
    const fromLog = parseRenderLog({
      id: "1",
      timestamp: "2026-10-29T10:00:00Z",
      message: JSON.stringify({
        level: "error",
        msg: "request_failed",
        route: "/api/debug/error",
        err: { name: "Error", message: "Watchtower phase-1 test error", stack: "Error: x\n    at GET (/opt/render/project/src/.next/server/app/api/debug/error/route.js:1:9)" },
      }),
    });
    const fromSentry = parseSentryIssue(
      {
        id: "77",
        title: "Error: Watchtower phase-1 test error",
        culprit: "GET /api/debug/error",
        count: "1",
        firstSeen: "2026-10-29T10:00:00Z",
        lastSeen: "2026-10-29T10:00:00Z",
        metadata: { type: "Error", value: "Watchtower phase-1 test error", filename: "app/api/debug/error/route.ts", function: "GET" },
      },
      0,
    );
    assert.ok(fromLog && fromSentry);
    assert.equal(scrubSignal(fromLog).fingerprint, scrubSignal(fromSentry).fingerprint);
  });
});
