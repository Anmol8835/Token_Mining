import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "node:crypto";
import { getDb } from "@/lib/db";
import {
  createSession,
  hashPassword,
  sessionCookieOptions,
  SESSION_COOKIE,
} from "@/lib/auth";

// Open signup. New accounts land as status='pending', plan='none':
// they can sign in and reach /billing, but the API stays blocked
// until a Dodo subscription webhook activates the plan.
//
// Mirrors the validation in db/create-user.js (email with @,
// password >= 8) plus a basic email shape check the CLI never needed
// (it's operator-typed).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 80;

export async function POST(req: NextRequest) {
  let body: { email?: unknown; password?: unknown; name?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* invalid JSON -> 400 below */
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const name = typeof body.name === "string" ? body.name.trim().slice(0, MAX_NAME_LENGTH) : "";

  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    return NextResponse.json(
      { ok: false, error: "Enter a valid email address." },
      { status: 400 }
    );
  }
  if (password.length < 8) {
    return NextResponse.json(
      { ok: false, error: "Password must be at least 8 characters." },
      { status: 400 }
    );
  }

  const db = getDb();
  // Friendly pre-check; the UNIQUE constraint below is the real guard
  // against the race between two simultaneous signups.
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) {
    return NextResponse.json(
      { ok: false, error: "An account with this email already exists." },
      { status: 409 }
    );
  }

  const id = crypto.randomUUID();
  try {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, name, created_at, status, plan)
       VALUES (?, ?, ?, ?, ?, 'pending', 'none')`
    ).run(id, email, hashPassword(password), name || null, Date.now());
  } catch (err) {
    if (String((err as Error).message).includes("UNIQUE")) {
      return NextResponse.json(
        { ok: false, error: "An account with this email already exists." },
        { status: 409 }
      );
    }
    throw err;
  }

  const token = createSession(id);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, sessionCookieOptions());

  return NextResponse.json({
    ok: true,
    user: { id, email, name: name || null },
  });
}
