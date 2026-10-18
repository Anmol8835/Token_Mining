// ============================================================
// "Sign in with Google" OAuth for the Steeros proxy.
//
// The ENTIRE dance lives here on the Express app: /auth/google/start
// 302s to Google, /auth/google/callback exchanges the code, upserts
// the user, mints the SAME steeros_session cookie as email login
// (so the dashboard/site SSO needs no special-casing), and 302s
// into the dashboard. The marketing site's button is a plain link
// to app.steerosai.com/auth/google/start — the site never sees the
// client_secret. Caddy's `handle /auth*` already routes this
// publicly; no Caddyfile change.
//
// Security notes:
// - CSRF state: 32-byte base64url in an HttpOnly, host-only,
//   path-scoped, SameSite=Lax cookie; constant-time compare;
//   consumed once (cleared on every callback branch).
// - Google-created accounts get a bcrypt hash of 256 bits of random
//   (password_hash is NOT NULL in the schema) so password login can
//   never match one.
// - Only email_verified identities are accepted; suspended users
//   are bounced with no session.
// ============================================================

const crypto = require("crypto");
const {
  SESSION_COOKIE,
  sessionCookieOptions,
  createSession,
  hashPassword,
} = require("./auth-api");
const db = require("./db");

const OAUTH_STATE_COOKIE = "steeros_oauth_state";
const STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
// The legacy www.googleapis.com/oauth2/v3/userinfo endpoint is
// blocked for OAuth clients created after ~2023 — this is the one
// that works for new client IDs. Same response shape.
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

// Mirrors lib/auth-api.js — keep in sync so both surfaces agree.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 80;

/** Google OAuth settings, read per call. null when not configured. */
function oauthConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ||
    (process.env.DOMAIN
      ? `https://${process.env.DOMAIN}/auth/google/callback`
      : "http://localhost:8002/auth/google/callback");
  return { clientId, clientSecret, redirectUri };
}

if (!oauthConfig()) {
  console.warn(
    "[auth-google] GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not set — " +
      "/auth/google/* will return 503 until configured."
  );
}

/** Where the dashboard lives (where we send users after the dance). */
function dashboardOrigin() {
  return process.env.DOMAIN ? `https://${process.env.DOMAIN}` : "http://localhost:3000";
}

// Host-only + path-scoped: start and callback are both served by
// app.steerosai.com, so the cookie never needs Domain=. Path scoping
// also sidesteps the domain-cookie clearing gotcha entirely.
function stateCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/auth/google",
    maxAge: STATE_TTL_MS, // Express takes milliseconds
  };
}

const newState = () => crypto.randomBytes(32).toString("base64url");

/** Constant-time string compare (sha256-normalized so lengths never leak). */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
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

function clearStateCookie(res) {
  // Path MUST match the set, or the browser keeps the cookie.
  res.clearCookie(OAUTH_STATE_COOKIE, { path: "/auth/google" });
}

/**
 * Every failure lands in the dashboard's login page with a banner
 * (?error=google|suspended). Fixed path — never reflects user input,
 * so there is no open-redirect surface. State cookie dies no matter
 * which branch we got here from.
 */
function fail(res, reason) {
  clearStateCookie(res);
  res.setHeader("Cache-Control", "no-store");
  return res.redirect(`${dashboardOrigin()}/login?error=${reason}`);
}

/**
 * Look up the Google email; create a pending/none account on first
 * sight (exactly like email signup: the user then picks a plan).
 * Returns {user, created} — or {suspended:true}, which must NOT get
 * a session.
 */
function findOrCreateUser(email, name) {
  const select = db.prepare("SELECT id, email, name, status FROM users WHERE email = ?");
  const found = select.get(email);
  if (found) {
    if (found.status === "suspended") return { suspended: true };
    return { user: { id: found.id, email: found.email, name: found.name }, created: false };
  }

  const id = crypto.randomUUID();
  try {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, name, created_at, status, plan)
       VALUES (?, ?, ?, ?, ?, 'pending', 'none')`
    ).run(
      id,
      email,
      // password_hash is NOT NULL; 256 bits of entropy means a
      // password login can never match this account.
      hashPassword(crypto.randomBytes(32).toString("hex")),
      name || null,
      Date.now()
    );
  } catch (err) {
    // Two tabs raced; the other one won the INSERT. Fall through to
    // the lookup — if that also finds nothing, it was a real error.
    if (!String(err.message).includes("UNIQUE")) throw err;
    const raced = select.get(email);
    if (!raced) throw err;
    if (raced.status === "suspended") return { suspended: true };
    return { user: { id: raced.id, email: raced.email, name: raced.name }, created: false };
  }
  return { user: { id, email, name: name || null }, created: true };
}

function start(req, res) {
  try {
    const config = oauthConfig();
    if (!config) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(503).json({ ok: false, error: "google_oauth_not_configured" });
    }

    const state = newState();
    res.cookie(OAUTH_STATE_COOKIE, state, stateCookieOptions());
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account",
    });
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(`${GOOGLE_AUTH_URL}?${params}`);
  } catch (err) {
    console.error("[auth-google] start failed:", err.message);
    return fail(res, "google");
  }
}

async function callback(req, res) {
  try {
    const config = oauthConfig();
    if (!config) return fail(res, "google");

    const query = req.query && typeof req.query === "object" ? req.query : {};
    const code = typeof query.code === "string" ? query.code : "";
    const state = typeof query.state === "string" ? query.state : "";
    const expected = parseCookies(req.headers.cookie)[OAUTH_STATE_COOKIE];

    // Covers Google denial (?error=access_denied), missing code, and
    // every state problem — all one indistinguishable failure path.
    if (query.error || !code || !state || !expected || !safeEqual(state, expected)) {
      return fail(res, "google");
    }

    // One-time use: consume the state before any network I/O.
    clearStateCookie(res);

    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokenBody = await tokenRes.json().catch(() => null);
    if (
      !tokenRes.ok ||
      !tokenBody ||
      tokenBody.error ||
      typeof tokenBody.access_token !== "string"
    ) {
      throw new Error(`token exchange failed (${tokenRes.status})`);
    }

    const infoRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenBody.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const info = await infoRes.json().catch(() => null);
    if (!infoRes.ok || !info) throw new Error(`userinfo failed (${infoRes.status})`);
    if (info.email_verified !== true) throw new Error("google email not verified");

    const email = typeof info.email === "string" ? info.email.trim().toLowerCase() : "";
    if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
      throw new Error("google returned no usable email");
    }
    const name = typeof info.name === "string" ? info.name.trim().slice(0, MAX_NAME_LENGTH) : "";

    const found = findOrCreateUser(email, name);
    if (found.suspended) return fail(res, "suspended");

    res.cookie(SESSION_COOKIE, createSession(found.user.id), sessionCookieOptions());
    res.setHeader("Cache-Control", "no-store");
    // New accounts must pick a plan before the console is useful;
    // existing users go straight home.
    return res.redirect(`${dashboardOrigin()}${found.created ? "/billing" : "/"}`);
  } catch (err) {
    // Only err.message — never response bodies, never the access token.
    console.error("[auth-google] callback failed:", err.message);
    return fail(res, "google");
  }
}

module.exports = { start, callback };
