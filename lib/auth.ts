// Single-admin authentication for the dashboard: ADMIN_USER + ADMIN_PASSWORD_HASH (scrypt), a
// database session (12 h) in an httpOnly, SameSite=Strict cookie, and a sign-in throttle.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { audit } from "./audit";
import { adminSessionValid, createAdminSession, deleteAdminSession, insertAudit } from "./db";
import { createThrottle, newSessionToken, safeEqual, sessionIdHash, verifyPassword } from "./password";

const COOKIE = "wt_session";
const SESSION_MS = 12 * 60 * 60_000;

// 5 attempts per 15 min per client, and 20 per 15 min overall (one admin; anything more is an attack).
const perClient = createThrottle(5, 15 * 60_000);
const overall = createThrottle(20, 15 * 60_000);

function secret(): string {
  const s = process.env.SESSION_SECRET ?? "";
  if (s.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters.");
  return s;
}

export type LoginResult = { ok: true } | { ok: false; error: string };

export async function login(username: string, password: string, clientKey: string): Promise<LoginResult> {
  const store = { audit: insertAudit };
  if (!perClient.attempt(clientKey) || !overall.attempt("all")) {
    await audit(store, { actor: "system", action: "login_throttled", outcome: "denied" });
    return { ok: false, error: "Too many attempts. Wait 15 minutes and try again." };
  }
  const expectedUser = process.env.ADMIN_USER ?? "";
  const hash = process.env.ADMIN_PASSWORD_HASH ?? "";
  // Always run scrypt, so a wrong username takes as long as a wrong password.
  const passwordOk = await verifyPassword(password, hash || "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA");
  const userOk = expectedUser.length > 0 && safeEqual(username, expectedUser);
  if (!userOk || !passwordOk || !hash) {
    await audit(store, { actor: "system", action: "login_failed", outcome: "denied" });
    return { ok: false, error: "Wrong username or password." };
  }
  perClient.reset(clientKey);
  const token = newSessionToken();
  await createAdminSession(sessionIdHash(token, secret()), new Date(Date.now() + SESSION_MS));
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MS / 1000,
  });
  await audit(store, { actor: "admin", action: "login", outcome: "ok" });
  return { ok: true };
}

export async function isSignedIn(): Promise<boolean> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return false;
  return adminSessionValid(sessionIdHash(token, secret()));
}

/** For pages and actions: redirect to /login unless signed in. */
export async function requireAdmin(): Promise<void> {
  if (!(await isSignedIn())) redirect("/login");
}

export async function logout(): Promise<void> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (token) await deleteAdminSession(sessionIdHash(token, secret()));
  store.delete(COOKIE);
  await audit({ audit: insertAudit }, { actor: "admin", action: "logout", outcome: "ok" });
}
