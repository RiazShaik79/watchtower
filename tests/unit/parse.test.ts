import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DB_CONNECTION_FP } from "@/lib/fingerprint";
import { parseRenderLog, parseSentryIssue } from "@/lib/parse";

const line = (message: unknown, id = "x") => ({
  id,
  timestamp: "2026-10-29T10:00:00.000Z",
  message: typeof message === "string" ? message : JSON.stringify(message),
});

describe("parseRenderLog", () => {
  test("request_failed becomes an error signal with route and error type", () => {
    const s = parseRenderLog(line({ level: "error", msg: "request_failed", route: "/api/water", err: { name: "TypeError", message: "bad", stack: "TypeError: bad" } }));
    assert.equal(s?.kind, "error");
    assert.equal(s?.level, "error");
    assert.equal(s?.route, "/api/water");
    assert.equal(s?.errorType, "TypeError");
    assert.equal(s?.title, "TypeError: bad");
  });

  test("every database connection error code shares one fingerprint", () => {
    const a = parseRenderLog(line({ level: "error", msg: "db_connect_failed", code: "ECONNREFUSED" }));
    const b = parseRenderLog(line({ level: "error", msg: "db_query_failed", code: "PROTOCOL_CONNECTION_LOST", sql: "SELECT 1" }));
    assert.equal(a?.kind, "db");
    assert.equal(b?.kind, "db");
    assert.equal(a?.fixedFingerprint, DB_CONNECTION_FP);
    assert.equal(b?.fixedFingerprint, DB_CONNECTION_FP);
  });

  test("a non-connection query failure is an error grouped by its SQL", () => {
    const s = parseRenderLog(line({ level: "error", msg: "db_query_failed", code: "ER_PARSE_ERROR", sql: "SELECT * FROM x WHERE id = ?" }));
    assert.equal(s?.kind, "error");
    assert.equal(s?.location, "SELECT * FROM x WHERE id = ?");
    assert.equal(s?.fixedFingerprint, undefined);
  });

  test("slow_query is a warning", () => {
    const s = parseRenderLog(line({ level: "warn", msg: "slow_query", ms: 1500, sql: "SELECT 1" }));
    assert.equal(s?.kind, "slow_query");
    assert.equal(s?.level, "warn");
  });

  test("info lines and the console mailer are dropped", () => {
    assert.equal(parseRenderLog(line({ level: "info", msg: "db_migrations_applied" })), null);
    assert.equal(parseRenderLog(line("EMAIL to jane@example.com: Reset your password: https://x/reset?token=abc")), null);
    assert.equal(parseRenderLog(line("GET /api/health 200 in 12ms")), null);
  });

  test("plain-text framework errors are kept", () => {
    const s = parseRenderLog(line(" ⨯ TypeError: fetch failed\n    at x (/app/y.js:1:1)"));
    assert.equal(s?.kind, "error");
    assert.equal(s?.errorType, "TypeError");
  });

  test("invalid timestamps and broken JSON are handled", () => {
    assert.equal(parseRenderLog({ id: "1", timestamp: "nope", message: "{}" }), null);
    assert.equal(parseRenderLog(line("{not json")), null);
  });
});

describe("parseSentryIssue", () => {
  const issue = {
    id: "5",
    title: "RangeError: Invalid time value",
    culprit: "GET /dashboard",
    count: "3",
    firstSeen: "2026-10-29T09:00:00Z",
    lastSeen: "2026-10-29T10:00:00Z",
    metadata: { type: "RangeError", value: "Invalid time value" },
  };

  test("reports only new occurrences since the last poll", () => {
    assert.equal(parseSentryIssue(issue, 0)?.count, 3);
    assert.equal(parseSentryIssue(issue, 1)?.count, 2);
    assert.equal(parseSentryIssue(issue, 3), null);
  });

  test("the external id includes the count, so a grown issue is a new event", () => {
    assert.equal(parseSentryIssue(issue, 0)?.externalId, "5:3");
  });

  test("takes the route from the culprit", () => {
    assert.equal(parseSentryIssue(issue, 0)?.route, "/dashboard");
  });
});
