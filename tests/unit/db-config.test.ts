import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertIdentifier, buildDatabaseUrl, connectionOptions, describeUrl, grantProblems, unexpectedDatabases } from "@/lib/db-config";

const AIVEN = "mysql://avnadmin:p%40ss@pp-mysql.aivencloud.com:12345/defaultdb?ssl-mode=REQUIRED";

describe("connectionOptions", () => {
  test("ssl-mode=REQUIRED becomes verified TLS and leaves the URL", () => {
    const o = connectionOptions(AIVEN, "-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----");
    assert.ok(!o.uri.includes("ssl-mode"));
    assert.equal(o.ssl?.rejectUnauthorized, true);
    assert.ok(o.ssl?.ca.includes("\nabc\n"), "escaped newlines are restored");
  });
  test("TLS without a CA is an error, never an unverified connection", () => {
    assert.throws(() => connectionOptions(AIVEN, undefined), /CA certificate/);
  });
  test("a local URL has no TLS", () => {
    assert.deepEqual(connectionOptions("mysql://root:ci@127.0.0.1:3306/watchtower", undefined), { uri: "mysql://root:ci@127.0.0.1:3306/watchtower" });
  });
});

describe("describeUrl and buildDatabaseUrl", () => {
  test("reads the parts of an Aiven Service URI", () => {
    assert.deepEqual(describeUrl(AIVEN), { user: "avnadmin", host: "pp-mysql.aivencloud.com", port: "12345", database: "defaultdb", sslMode: "REQUIRED" });
  });
  test("rejects non-MySQL URLs", () => {
    assert.throws(() => describeUrl("postgres://u:p@h/db"), /mysql:\/\//);
  });
  test("builds the new user's URL with the password encoded and ssl-mode kept", () => {
    const url = buildDatabaseUrl({ user: "watchtower", password: "a/b@c:d#e%f", host: "h.example", port: "12345", database: "watchtower", sslMode: "REQUIRED" });
    assert.equal(url, "mysql://watchtower:a%2Fb%40c%3Ad%23e%25f@h.example:12345/watchtower?ssl-mode=REQUIRED");
    const back = new URL(url);
    assert.equal(decodeURIComponent(back.password), "a/b@c:d#e%f");
  });
});

describe("assertIdentifier", () => {
  test("allows plain names only", () => {
    assert.doesNotThrow(() => assertIdentifier("watchtower", "db"));
    for (const bad of ["Watchtower", "wt-db", "wt`; DROP", "", "1abc", "a".repeat(40)]) assert.throws(() => assertIdentifier(bad, "db"), /Invalid db/, bad);
  });
});

describe("isolation checks", () => {
  test("own database plus USAGE is isolated", () => {
    assert.deepEqual(grantProblems(["GRANT USAGE ON *.* TO `watchtower`@`%`", "GRANT ALL PRIVILEGES ON `watchtower`.* TO `watchtower`@`%`"], "watchtower"), []);
  });
  test("any global privilege, other database or grant option is a problem", () => {
    const problems = grantProblems(
      [
        "GRANT SELECT, INSERT ON *.* TO `watchtower`@`%`",
        "GRANT ALL PRIVILEGES ON `defaultdb`.* TO `watchtower`@`%`",
        "GRANT ALL PRIVILEGES ON `watchtower`.* TO `watchtower`@`%` WITH GRANT OPTION",
        "GRANT `admin_role`@`%` TO `watchtower`@`%`",
      ],
      "watchtower",
    );
    assert.equal(problems.length, 4);
  });
  test("ANSI_QUOTES (Aiven) grants: own database is isolated, the same problems are still caught", () => {
    assert.deepEqual(grantProblems(['GRANT USAGE ON *.* TO "watchtower"@"%"', 'GRANT ALL PRIVILEGES ON "watchtower".* TO "watchtower"@"%"'], "watchtower"), []);
    const problems = grantProblems(
      [
        'GRANT SELECT ON *.* TO "watchtower"@"%"',
        'GRANT ALL PRIVILEGES ON "defaultdb".* TO "watchtower"@"%"',
        'GRANT ALL PRIVILEGES ON "watchtower".* TO "watchtower"@"%" WITH GRANT OPTION',
        'GRANT "admin_role"@"%" TO "watchtower"@"%"',
        'GRANT ALL PRIVILEGES ON "watchtower`.* TO "watchtower"@"%"',
      ],
      "watchtower",
    );
    assert.equal(problems.length, 5);
  });
  test("visible databases: only its own and the built-in schemas", () => {
    assert.deepEqual(unexpectedDatabases(["information_schema", "performance_schema", "watchtower"], "watchtower"), []);
    assert.deepEqual(unexpectedDatabases(["information_schema", "watchtower", "defaultdb", "mysql"], "watchtower"), ["defaultdb", "mysql"]);
  });
});
