// Pure crypto for the single-admin login (unit-tested): scrypt password hashes in the app's format
// "scrypt$N$r$p$salt$hash", session tokens stored only as an HMAC, and an in-memory throttle.
import { createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

const N = 16384;
const r = 8;
const p = 1;
const KEY_LENGTH = 64;

function scryptAsync(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, keyLength, { ...options, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize("NFKC"), salt, KEY_LENGTH, { N, r, p });
  return ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, rr, pp, saltB64, keyB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64url");
  if (!expected.length) return false;
  try {
    const key = await scryptAsync(password.normalize("NFKC"), Buffer.from(saltB64, "base64url"), expected.length, {
      N: Number(n),
      r: Number(rr),
      p: Number(pp),
    });
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** Constant-time string comparison (for the username). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What's stored in admin_sessions: HMAC-SHA256(token, SESSION_SECRET). A DB leak can't be replayed. */
export function sessionIdHash(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}

/** Fixed-window throttle: `limit` attempts per key per `windowMs`. */
export function createThrottle(limit: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    /** Records an attempt; false when the key is over the limit. */
    attempt(key: string): boolean {
      const t = now();
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= t) {
        hits.set(key, { count: 1, resetAt: t + windowMs });
        return true;
      }
      entry.count++;
      return entry.count <= limit;
    },
    reset(key: string) {
      hits.delete(key);
    },
  };
}
