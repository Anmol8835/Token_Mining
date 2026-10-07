#!/usr/bin/env node
// ============================================================
// One-off data backfill for per-user scoping. Run on the box
// that owns data/app.db (i.e. inside the llm-proxy container):
//
//   docker compose exec llm-proxy node db/backfill.js claim-keys <userId> --apply
//   docker compose exec llm-proxy node db/backfill.js claim-usage <userId> --apply
//
// claim-keys: attach API keys created before accounts existed
// (user_id IS NULL) to a user. Without keyId arguments every
// unowned key is listed. Only NULL-owned keys are ever touched —
// a key that already belongs to someone else is never silently
// reassigned.
//
// claim-usage: move usage_daily rows recorded as 'anonymous'
// (zero-key bootstrap traffic) to a user. If the target
// (user_id, day) row already exists, that day is SKIPPED unless
// --merge is given, which sums the values into the target row and
// deletes the anonymous one in a single transaction.
//
// Both modes DRY RUN by default — nothing is written without
// --apply. <userId> accepts an id or an email.
// ============================================================

const db = require("../lib/db");

const USAGE = `usage:
  node db/backfill.js claim-keys  <userId> [keyId...] [--apply]
  node db/backfill.js claim-usage <userId> [day...]   [--apply] [--merge]

  userId   account id (uuid) or email
  keyId    explicit api_keys.id values; default = every NULL-owned key
  day      explicit usage_daily days ('YYYY-MM-DD'); default = all 'anonymous' rows
  --apply  write changes (default is a dry run)
  --merge  claim-usage only: sum into an existing (user, day) row instead of skipping`;

const args = process.argv.slice(2);
const cmd = args[0];
const apply = args.includes("--apply");
const merge = args.includes("--merge");
const positional = args.slice(1).filter((a) => !a.startsWith("--"));
const target = positional[0];
const extra = positional.slice(1);

if (cmd !== "claim-keys" && cmd !== "claim-usage") {
  console.error(USAGE);
  process.exit(1);
}
if (!target) {
  console.error("missing <userId>\n\n" + USAGE);
  process.exit(1);
}
if (merge && cmd !== "claim-usage") {
  console.error("--merge is only meaningful for claim-usage\n\n" + USAGE);
  process.exit(1);
}

const user = db
  .prepare("SELECT id, email FROM users WHERE id = ? OR email = ?")
  .get(target, target);
if (!user) {
  console.error(`no such user: ${target} (pass an account id or email)`);
  process.exit(1);
}

const who = `${user.email} (${user.id})`;
console.log(`target: ${who}`);
console.log(apply ? "mode: APPLY\n" : "mode: DRY RUN — nothing will be written (pass --apply)\n");

if (cmd === "claim-keys") {
  const rows = extra.length
    ? db
        .prepare(
          `SELECT * FROM api_keys WHERE id IN (${extra.map(() => "?").join(", ")})`
        )
        .all(...extra)
    : db
        .prepare("SELECT * FROM api_keys WHERE user_id IS NULL ORDER BY created_at")
        .all();

  const claimable = [];
  for (const row of rows) {
    const label = `${row.id}  ${row.name}  ${row.prefix}…`;
    if (row.user_id === null) {
      claimable.push(row);
      console.log(`claim   ${label}${row.revoked_at ? "  (revoked)" : ""}`);
    } else if (row.user_id === user.id) {
      console.log(`already ${label}  (already owned by the target)`);
    } else {
      console.log(`SKIP    ${label}  (owned by ${row.user_id} — reassign deliberately, not here)`);
    }
  }
  for (const id of extra) {
    if (!rows.some((r) => r.id === id)) console.log(`SKIP    ${id}  (no such key)`);
  }

  if (!claimable.length) {
    console.log("\nnothing to claim.");
    process.exit(0);
  }
  if (!apply) {
    console.log(`\n${claimable.length} key(s) would be attached to ${who}.`);
    process.exit(0);
  }

  const stmt = db.prepare(
    "UPDATE api_keys SET user_id = ? WHERE id = ? AND user_id IS NULL"
  );
  let changed = 0;
  db.transaction(() => {
    for (const row of claimable) changed += stmt.run(user.id, row.id).changes;
  })();
  console.log(`\nattached ${changed} key(s) to ${who}.`);
  process.exit(0);
}

// ---- claim-usage ----
const daysFilter = extra.length
  ? ` AND day IN (${extra.map(() => "?").join(", ")})`
  : "";
const rows = db
  .prepare(
    `SELECT * FROM usage_daily WHERE user_id = 'anonymous'${daysFilter} ORDER BY day`
  )
  .all(...extra);

if (!rows.length) {
  console.log("no 'anonymous' usage rows found.");
  process.exit(0);
}

const hasTarget = db.prepare(
  "SELECT 1 FROM usage_daily WHERE user_id = ? AND day = ?"
);
const moves = [];
const merges = [];
const skipped = [];
for (const row of rows) {
  const exists = !!hasTarget.get(user.id, row.day);
  if (!exists) moves.push(row);
  else if (merge) merges.push(row);
  else skipped.push(row);
  console.log(
    `${exists ? (merge ? "merge" : "SKIP ") : "move "} ${row.day}  ` +
      `${row.requests} req  $${row.cost_usd.toFixed(4)}` +
      (exists && !merge ? "  (target row exists — pass --merge to sum)" : "")
  );
}

if (!apply) {
  console.log(
    `\nwould move ${moves.length} day(s)` +
      (merge ? `, merge ${merges.length} day(s)` : `, skip ${skipped.length} day(s)`) +
      ` to ${who}.`
  );
  process.exit(0);
}

const mergeStmt = db.prepare(
  `UPDATE usage_daily SET
     requests            = requests + ?,
     input_tokens        = input_tokens + ?,
     output_tokens       = output_tokens + ?,
     cache_read_tokens   = cache_read_tokens + ?,
     cache_write_tokens  = cache_write_tokens + ?,
     cost_usd            = cost_usd + ?,
     classifier_cost_usd = classifier_cost_usd + ?,
     baseline_cost_usd   = baseline_cost_usd + ?
   WHERE user_id = ? AND day = ?`
);
const moveStmt = db.prepare(
  "UPDATE usage_daily SET user_id = ? WHERE user_id = 'anonymous' AND day = ?"
);
const deleteStmt = db.prepare(
  "DELETE FROM usage_daily WHERE user_id = 'anonymous' AND day = ?"
);

db.transaction(() => {
  for (const row of merges) {
    mergeStmt.run(
      row.requests,
      row.input_tokens,
      row.output_tokens,
      row.cache_read_tokens,
      row.cache_write_tokens,
      row.cost_usd,
      row.classifier_cost_usd,
      row.baseline_cost_usd,
      user.id,
      row.day
    );
    deleteStmt.run(row.day);
  }
  for (const row of moves) moveStmt.run(user.id, row.day);
})();

console.log(
  `\nmoved ${moves.length} day(s)` +
    (merge ? `, merged ${merges.length} day(s)` : "") +
    ` to ${who}.`
);
