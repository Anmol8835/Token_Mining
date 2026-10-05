#!/usr/bin/env node
// ============================================================
// Create a dashboard account. No open signup yet — accounts are
// created by the operator, on the box that owns data/app.db:
//
//   docker compose exec llm-proxy node db/create-user.js you@example.com "Your Name"
//   docker compose exec llm-proxy node db/create-user.js --reset you@example.com
//
// The password is prompted (hidden when stdin is a TTY); for
// scripts, pipe password + confirm as two lines:
//   printf 'pw\npw\n' | docker compose exec -T llm-proxy node db/create-user.js you@example.com
// (a single piped line is used for both)
// ============================================================

const crypto = require("crypto");
const readline = require("readline");
const bcrypt = require("bcryptjs");
const db = require("../lib/db");

const RESET = process.argv[2] === "--reset";
const email = RESET ? process.argv[3] : process.argv[2];
const name = RESET ? null : process.argv[3] || null;
if (!email || !email.includes("@")) {
  console.error("usage: node db/create-user.js [--reset] <email> [name]");
  process.exit(1);
}

/** Hidden prompt for TTYs. */
function askHidden(label) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(label, (answer) => {
      rl.close();
      resolve(answer);
    });
    // readline echoes typed input via _writeToOutput — mute it,
    // keep only newlines (the prompt itself was written above).
    rl._writeToOutput = (s) => {
      if (s === "\r\n" || s === "\n") rl.output.write(s);
    };
  });
}

/**
 * Password + confirm. TTY: two hidden prompts. Piped: read stdin
 * ONCE (two prompts against one exhausted stdin deadlock — the
 * second 'end' never fires and node exits 0 with nothing done);
 * first line = password, second = confirm (single line = both).
 */
async function promptPassword() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    await new Promise((resolve) => {
      process.stdin.on("data", (c) => chunks.push(c));
      process.stdin.on("end", resolve);
      process.stdin.resume();
    });
    const lines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
    const password = (lines[0] || "").trim();
    const confirm = (lines.length > 1 ? lines[1] : lines[0] || "").trim();
    return { password, confirm };
  }
  return {
    password: await askHidden("Password: "),
    confirm: await askHidden("Confirm: "),
  };
}

(async () => {
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing && !RESET) {
    console.error(`user ${email} already exists (use --reset to change the password)`);
    process.exit(1);
  }
  if (!existing && RESET) {
    console.error(`no such user: ${email}`);
    process.exit(1);
  }

  const { password, confirm } = await promptPassword();
  if (password.length < 8) {
    console.error("password must be at least 8 characters");
    process.exit(1);
  }
  if (password !== confirm) {
    console.error("passwords do not match");
    process.exit(1);
  }

  const hash = bcrypt.hashSync(password, 12);
  if (RESET) {
    db.prepare("UPDATE users SET password_hash = ? WHERE email = ?").run(hash, email);
    console.log(`reset password for ${email}`);
  } else {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, name, created_at, status)
       VALUES (?, ?, ?, ?, ?, 'active')`
    ).run(crypto.randomUUID(), email, hash, name, Date.now());
    console.log(`created user ${email}${name ? ` (${name})` : ""}`);
  }
})();
