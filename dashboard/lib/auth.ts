import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { getDb } from "./db";

// ============================================================
// Dashboard session auth. Opaque tokens: the cookie holds the
// raw 32-byte token, sessions stores only its sha256 — a DB
// leak doesn't leak live sessions. Validated on every request
// by proxy.ts (Node runtime) and layout.tsx.
// ============================================================

export const SESSION_COOKIE = "steeros_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
};

const sha256hex = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");

export function hashPassword(password: string) {
  return bcrypt.hashSync(password, 12);
}

export function verifyPassword(password: string, hash: string) {
  return bcrypt.compareSync(password, hash);
}

export function createSession(userId: string) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const db = getDb();
  // Lazy cleanup: drop expired sessions whenever a new one is made.
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).run(sha256hex(token), userId, now, now + SESSION_TTL_MS);
  return token;
}

export function getSessionUser(token: string | undefined): SessionUser | null {
  if (!token) return null;
  // 'pending' = signed up but not subscribed yet: they need a
  // session to reach /billing and subscribe, so they're let in
  // here; only 'suspended' is locked out.
  const row = getDb()
    .prepare(
      `SELECT u.id, u.email, u.name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.status IN ('active', 'pending')`
    )
    .get(sha256hex(token), Date.now()) as SessionUser | undefined;
  return row ?? null;
}

export function deleteSession(token: string | undefined) {
  if (!token) return;
  getDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256hex(token));
}
