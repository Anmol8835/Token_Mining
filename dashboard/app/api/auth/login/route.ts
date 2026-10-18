import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import {
  createSession,
  hashPassword,
  verifyPassword,
  sessionCookieOptions,
  SESSION_COOKIE,
} from "@/lib/auth";

// In-memory login throttle: 5 failures per email+IP -> 60s lockout.
// The dashboard runs as a single Node process, so a Map is enough.
const fails = new Map<string, { count: number; until: number }>();

// Compared against when the email is unknown, so login timing doesn't
// reveal whether an account exists.
const DUMMY_HASH = hashPassword("not-the-password");

export async function POST(req: NextRequest) {
  let body: { email?: unknown; password?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* invalid JSON -> generic 401 below */
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const lockKey = `${ip}\x00${email}`;
  const lock = fails.get(lockKey);
  const now = Date.now();
  if (lock && lock.until > now) {
    return NextResponse.json(
      { ok: false, error: "Too many attempts. Try again in a minute." },
      { status: 429 }
    );
  }

  // 'pending' users can log in — they need a session to reach
  // /billing and subscribe. Only 'suspended' is denied.
  const user = getDb()
    .prepare("SELECT * FROM users WHERE email = ? AND status IN ('active', 'pending')")
    .get(email) as { id: string; email: string; name: string | null; password_hash: string } | undefined;
  const passwordOk = verifyPassword(password || "", user?.password_hash ?? DUMMY_HASH);

  if (!user || !passwordOk) {
    const entry = fails.get(lockKey) ?? { count: 0, until: 0 };
    entry.count += 1;
    if (entry.count >= 5) {
      entry.until = now + 60_000;
      entry.count = 0;
    }
    fails.set(lockKey, entry);
    return NextResponse.json({ ok: false, error: "Invalid email or password." }, { status: 401 });
  }
  fails.delete(lockKey);

  const token = createSession(user.id);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, sessionCookieOptions());

  return NextResponse.json({
    ok: true,
    user: { id: user.id, email: user.email, name: user.name },
  });
}
