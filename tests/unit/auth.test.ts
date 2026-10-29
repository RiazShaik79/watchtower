import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createThrottle, hashPassword, newSessionToken, safeEqual, sessionIdHash, verifyPassword } from "@/lib/password";

describe("admin password hashing", () => {
  test("hash verifies with the right password only", async () => {
    const hash = await hashPassword("correct horse battery");
    assert.match(hash, /^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
    assert.equal(await verifyPassword("correct horse battery", hash), true);
    assert.equal(await verifyPassword("correct horse batterY", hash), false);
  });

  test("two hashes of one password differ (random salt)", async () => {
    assert.notEqual(await hashPassword("same password!"), await hashPassword("same password!"));
  });

  test("malformed or empty hashes never verify", async () => {
    for (const bad of ["", "plain", "bcrypt$x$y", "scrypt$16384$8$1$$", "scrypt$1$1$1$AAAA$AAAA"]) {
      assert.equal(await verifyPassword("anything", bad), false, bad);
    }
  });

  test("unicode is normalised (NFKC)", async () => {
    const hash = await hashPassword("ﬁsh-password");
    assert.equal(await verifyPassword("fish-password", hash), true);
  });
});

describe("sessions", () => {
  test("tokens are random and only an HMAC is stored", () => {
    const a = newSessionToken();
    assert.notEqual(a, newSessionToken());
    assert.ok(a.length >= 43);
    const stored = sessionIdHash(a, "x".repeat(32));
    assert.match(stored, /^[0-9a-f]{64}$/);
    assert.ok(!stored.includes(a));
    assert.notEqual(stored, sessionIdHash(a, "y".repeat(32)), "depends on SESSION_SECRET");
  });

  test("safeEqual", () => {
    assert.ok(safeEqual("admin", "admin"));
    assert.ok(!safeEqual("admin", "admin2"));
    assert.ok(!safeEqual("admin", "Admin"));
  });
});

describe("sign-in throttle", () => {
  test("allows the limit, blocks after, resets after the window", () => {
    let now = 0;
    const throttle = createThrottle(5, 60_000, () => now);
    for (let i = 0; i < 5; i++) assert.ok(throttle.attempt("ip"));
    assert.ok(!throttle.attempt("ip"));
    assert.ok(throttle.attempt("other-ip"), "keys are separate");
    now = 60_001;
    assert.ok(throttle.attempt("ip"));
  });
});
