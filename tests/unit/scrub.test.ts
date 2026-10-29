import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { scrubDeep, scrubText } from "@/lib/scrub";

describe("scrubText", () => {
  const cases: [string, string, string][] = [
    ["email", "user jane.doe+test@example.co.uk failed", "jane.doe"],
    ["mysql URL", "connect mysql://avnadmin:s3cr3t@host.aivencloud.com:12345/db?ssl-mode=REQUIRED now", "s3cr3t"],
    ["postgres URL", "postgres://u:p4ss@db/x", "p4ss"],
    ["bearer token", "Authorization: Bearer abc.def.ghi-123456789", "abc.def.ghi"],
    ["basic auth header", "authorization=Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ["cookie header", "cookie: ct_session=abcdef123456; ct_device_user=jane", "abcdef123456"],
    ["set-cookie", "Set-Cookie: wt_session=zzz999; HttpOnly", "zzz999"],
    ["password field", '{"password":"hunter2","user":"x"}', "hunter2"],
    ["password=", "login password=hunter2 ok", "hunter2"],
    ["api key field", "api_key: AKZ-998877", "AKZ-998877"],
    ["anthropic key", "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "sk-ant-api03"],
    ["github token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_abcdef"],
    ["github fine-grained", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "github_pat_11"],
    ["sentry token", "sntrys_eyJpYXQiOjE3MzAwMDAwMDB9_abcdefghijklmnopqrstuvwxyz", "sntrys_eyJ"],
    ["render key", "rnd_ABCDEFGHIJKLMNOPQRSTUV", "rnd_ABCDEF"],
    ["google key", "AIzaSyA-abcdefghijklmnopqrstuvwxyz12345", "AIzaSyA"],
    ["JWT", `token ${["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"].join(".")}`, "dozjgNryP4J3"], // the public jwt.io example, split so secret scanners don't flag it
    ["reset link token", "https://app/reset-password?token=8f2c9d1e4b7a&x=1", "8f2c9d1e4b7a"],
    ["oauth code", "/callback?code=4/0AbCdEf&state=xyz", "0AbCdEf"],
    ["PEM block", "-----BEGIN CERTIFICATE-----\nMIIBIjANBgkqh\n-----END CERTIFICATE-----", "MIIBIjANBgkqh"],
    ["private key", "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN\n-----END PRIVATE KEY-----", "MIIEvQIBADAN"],
    ["card number spaced", "card 4111 1111 1111 1111 declined", "4111 1111"],
    ["card number plain", "card 4111111111111111 declined", "4111111111111111"],
    ["IPv4", "from 203.0.113.45 port", "203.0.113.45"],
    ["x-debug-token header", "x-debug-token: fake-debug-value", "fake-debug-value"],
    ["URL credentials", "https://user:pa55@example.com/path", "pa55"],
  ];
  for (const [name, input, secret] of cases) {
    test(`removes ${name}`, () => {
      const out = scrubText(input);
      assert.ok(!out.includes(secret), `"${secret}" survived: ${out}`);
    });
  }

  test("keeps useful debugging text", () => {
    const input = "TypeError: Cannot read properties of undefined (reading 'servings') at /api/log/42 code=ER_DUP_ENTRY 1840 ms";
    const out = scrubText(input);
    assert.ok(out.includes("TypeError: Cannot read properties of undefined"));
    assert.ok(out.includes("/api/log/42"));
    assert.ok(out.includes("ER_DUP_ENTRY"));
    assert.ok(out.includes("1840 ms"));
  });

  test("keeps epoch timestamps and short numbers (not cards)", () => {
    assert.equal(scrubText("at 1730212345678 took 42"), "at 1730212345678 took 42");
  });

  test("keeps commit SHAs and sha256 fingerprints (pure hex)", () => {
    const sha = "55bb45cb745e1d2c3b4a5f6e7d8c9b0a1f2e3d4c";
    assert.ok(scrubText(`deploy ${sha}`).includes(sha));
  });

  test("is idempotent", () => {
    const once = scrubText("mail jane@example.com with Bearer abcdefghijklmnop1234 and mysql://a:b@c/d");
    assert.equal(scrubText(once), once);
  });

  test("truncates oversized input", () => {
    const out = scrubText("x".repeat(20_000), 100);
    assert.ok(out.length < 130);
    assert.ok(out.endsWith("[truncated]"));
  });

  test("handles empty input", () => {
    assert.equal(scrubText(undefined), "");
    assert.equal(scrubText(""), "");
  });
});

describe("scrubDeep", () => {
  test("replaces secret-named keys and scrubs nested strings", () => {
    const out = scrubDeep({
      authorization: "Bearer zzz",
      headers: { cookie: "a=b" },
      nested: { note: "contact bob@example.com", list: ["mysql://u:p@h/d"] },
      count: 3,
    }) as Record<string, unknown>;
    assert.equal(out.authorization, "[REDACTED]");
    assert.equal(out.headers, "[REDACTED]");
    assert.deepEqual(out.nested, { note: "contact [EMAIL]", list: ["[DB_URL]"] });
    assert.equal(out.count, 3);
  });
});
