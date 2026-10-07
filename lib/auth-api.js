// ============================================================
// Public auth API for the marketing site (steerosai.com).
//
// A deliberate plain-JS port of dashboard/lib/auth.ts: the two
// apps live in different packages/languages (CommonJS JS vs TS),
// so ~120 lines are duplicated rather than shared. Both write the
// SAME users/sessions tables via the shared SQLite handle, using
// the same token format (32-byte base64url, sha256 stored), which
// is what makes single sign-on work: a session created here is
// valid in the dashboard and vice versa.
//
// The steeros_session cookie carries Domain=.steerosai.com when
// AUTH_COOKIE_DOMAIN is set (VPS .env) — that attribute is the
// SSO linchpin. Unset (local dev) => host-only cookie.
//
// Open signup by design (status 'pending', plan 'none'); login is
// throttled in-process like the dashboard. Mounted OUTSIDE the
// /config,/metrics actor gate in index.js.
// ============================================================

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("./db");

const SESSION_COOKIE = "steeros_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Mirrors dashboard/app/api/auth/signup/route.ts exactly — keep in
// sync so both surfaces behave identically.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 80;

const sha256hex = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hashPassword = (password) => bcrypt.hashSync(password, 12);
const verifyPassword = (password, hash) => bcrypt.compareSync(password, hash);

/** Cookie attrs for the shared session. Domain only when configured. */
function sessionCookieOptions() {
  const opts = {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production", // HTTPS behind Caddy on the VPS
    path: "/",
    // Express res.cookie takes maxAge in MILLISECONDS (it converts
    // to expires + seconds internally) — unlike Next's cookies API.
    maxAge: SESSION_TTL_MS,
  };
  if (process.env.AUTH_COOKIE_DOMAIN) opts.domain = process.env.AUTH_COOKIE_DOMAIN;
  return opts;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  // Lazy cleanup: drop expired sessions whenever a new one is made.
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).run(sha256hex(token), userId, now, now + SESSION_TTL_MS);
  return token;
}

function getSessionUser(token) {
  if (!token) return null;
  // 'pending' = signed up but not subscribed yet: they need a
  // session to reach /billing and subscribe, so they're let in
  // here; only 'suspended' is locked out.
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.status IN ('active', 'pending')`
    )
    .get(sha256hex(token), Date.now());
  return row ?? null;
}

function deleteSession(token) {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256hex(token));
}

/**
 * Resolve the session user behind an incoming request (Cookie
 * header). Used by the /config,/metrics actor middleware in
 * index.js to scope dashboard users to their own data. Returns
 * null when there is no live session.
 */
function getSessionUserFromRequest(req) {
  const header = req.headers?.cookie;
  const token =
    typeof header === "string" ? parseCookies(header)[SESSION_COOKIE] : undefined;
  return getSessionUser(token);
}

/** Minimal cookie-header parser — Express has no cookie parser here. */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// In-memory login throttle: 5 failures per email+IP -> 60s lockout.
// The proxy runs as a single Node process, so a Map is enough.
const fails = new Map();

// Compared against when the email is unknown, so login timing doesn't
// reveal whether an account exists.
const DUMMY_HASH = hashPassword("not-the-password");

function signup(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const name = typeof body.name === "string" ? body.name.trim().slice(0, MAX_NAME_LENGTH) : "";

    if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: "Enter a valid email address." });
    }
    if (password.length < 8) {
      return res.status(400).json({ ok: false, error: "Password must be at least 8 characters." });
    }

    // Friendly pre-check; the UNIQUE constraint below is the real
    // guard against the race between two simultaneous signups.
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (existing) {
      return res
        .status(409)
        .json({ ok: false, error: "An account with this email already exists." });
    }

    const id = crypto.randomUUID();
    try {
      db.prepare(
        `INSERT INTO users (id, email, password_hash, name, created_at, status, plan)
         VALUES (?, ?, ?, ?, ?, 'pending', 'none')`
      ).run(id, email, hashPassword(password), name || null, Date.now());
    } catch (err) {
      if (String(err.message).includes("UNIQUE")) {
        return res
          .status(409)
          .json({ ok: false, error: "An account with this email already exists." });
      }
      throw err;
    }

    const token = createSession(id);
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
    return res.json({ ok: true, user: { id, email, name: name || null } });
  } catch (err) {
    console.error("[auth] signup failed:", err.message);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}

function login(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";

    const ip =
      String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      "local";
    const lockKey = `${ip}\x00${email}`;
    const lock = fails.get(lockKey);
    const now = Date.now();
    if (lock && lock.until > now) {
      return res
        .status(429)
        .json({ ok: false, error: "Too many attempts. Try again in a minute." });
    }

    // 'pending' users can log in — they need a session to reach
    // /billing and subscribe. Only 'suspended' is denied.
    const user = db
      .prepare("SELECT * FROM users WHERE email = ? AND status IN ('active', 'pending')")
      .get(email);
    const passwordOk = verifyPassword(password || "", user?.password_hash ?? DUMMY_HASH);

    if (!user || !passwordOk) {
      const entry = fails.get(lockKey) ?? { count: 0, until: 0 };
      entry.count += 1;
      if (entry.count >= 5) {
        entry.until = now + 60_000;
        entry.count = 0;
      }
      fails.set(lockKey, entry);
      return res.status(401).json({ ok: false, error: "Invalid email or password." });
    }
    fails.delete(lockKey);

    const token = createSession(user.id);
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
    return res.json({
      ok: true,
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (err) {
    console.error("[auth] login failed:", err.message);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}

function logout(req, res) {
  try {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    deleteSession(token);
    // Domain + path MUST match the set, or the browser keeps the
    // .steerosai.com cookie alive and SSO "logs back in".
    res.clearCookie(SESSION_COOKIE, {
      path: "/",
      ...(process.env.AUTH_COOKIE_DOMAIN ? { domain: process.env.AUTH_COOKIE_DOMAIN } : {}),
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[auth] logout failed:", err.message);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}

function me(req, res) {
  try {
    const user = getSessionUser(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    res.setHeader("Cache-Control", "no-store");
    if (!user) return res.status(401).json({ ok: false });
    return res.json({ ok: true, user });
  } catch (err) {
    console.error("[auth] me failed:", err.message);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}

module.exports = {
  signup,
  login,
  logout,
  me,
  getSessionUserFromRequest,
  SESSION_COOKIE,
  sessionCookieOptions,
  createSession,
  hashPassword,
};
