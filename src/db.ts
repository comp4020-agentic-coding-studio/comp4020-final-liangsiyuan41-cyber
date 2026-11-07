import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH ?? "/data/taskmate.db";

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_session_id TEXT NOT NULL REFERENCES sessions(id),
    author_name TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('campus_help', 'study_together', 'social_connect', 'campus_events')),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    is_paid INTEGER NOT NULL CHECK (is_paid IN (0, 1)),
    amount TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id),
    applicant_session_id TEXT NOT NULL REFERENCES sessions(id),
    applicant_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'accepted', 'declined', 'completed', 'cancelled')),
    cancellation_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancellation_requested IN (0, 1)),
    cancellation_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (post_id, applicant_session_id)
  );

  CREATE INDEX IF NOT EXISTS idx_applications_post_id ON applications(post_id);
`);

// Older `/data` volumes predate parts of this schema. CREATE TABLE IF NOT
// EXISTS above only applies to a table that doesn't exist yet, so bring an
// existing `applications` table up to date by hand. Each step below is
// guarded so running this on every boot — including against an
// already-migrated database — is a no-op.
const applicationColumns = db.prepare("PRAGMA table_info(applications)").all() as { name: string }[];
const hasStatusColumn = applicationColumns.some((c) => c.name === "status");

if (!hasStatusColumn) {
  // Pre-applicant-management (C9) databases have no status column at all;
  // adding it straight at the final, widened CHECK is correct since there's
  // no narrower constraint to conflict with.
  db.exec(`
    ALTER TABLE applications
    ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'accepted', 'declined', 'completed', 'cancelled'))
  `);
} else {
  // Applicant-management-era databases have `status` but with the narrower
  // 3-value CHECK (pending/accepted/declined) from that stage. SQLite has no
  // ALTER TABLE to widen a CHECK constraint in place, so the table is rebuilt:
  // a new table with the wider constraint, existing rows copied across
  // unchanged, then the old table is swapped out. This preserves every
  // column value, the UNIQUE(post_id, applicant_session_id) constraint, the
  // foreign keys, and (because INSERT ... SELECT carries ids across
  // explicitly) the existing autoincrement sequence — verified against a
  // temporary copy of an applicant-management-era database, and run twice in
  // a row to confirm it's a no-op the second time, before being applied here.
  const tableSql = (
    db.prepare("SELECT sql FROM sqlite_master WHERE name = 'applications'").get() as { sql: string }
  ).sql;
  const needsWiderCheck = !tableSql.includes("'completed'");
  if (needsWiderCheck) {
    db.exec("BEGIN");
    try {
      db.exec(`
        CREATE TABLE applications_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          post_id INTEGER NOT NULL REFERENCES posts(id),
          applicant_session_id TEXT NOT NULL REFERENCES sessions(id),
          applicant_name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'accepted', 'declined', 'completed', 'cancelled')),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          UNIQUE (post_id, applicant_session_id)
        )
      `);
      db.exec(`
        INSERT INTO applications_new (id, post_id, applicant_session_id, applicant_name, status, created_at)
        SELECT id, post_id, applicant_session_id, applicant_name, status, created_at FROM applications
      `);
      db.exec("DROP TABLE applications");
      db.exec("ALTER TABLE applications_new RENAME TO applications");
      db.exec("CREATE INDEX IF NOT EXISTS idx_applications_post_id ON applications(post_id)");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

const applicationColumnsAfterStatus = db.prepare("PRAGMA table_info(applications)").all() as { name: string }[];
if (!applicationColumnsAfterStatus.some((c) => c.name === "cancellation_requested")) {
  db.exec(`
    ALTER TABLE applications
    ADD COLUMN cancellation_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancellation_requested IN (0, 1))
  `);
}
if (!applicationColumnsAfterStatus.some((c) => c.name === "cancellation_reason")) {
  db.exec("ALTER TABLE applications ADD COLUMN cancellation_reason TEXT");
}
