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
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (post_id, applicant_session_id)
  );

  CREATE INDEX IF NOT EXISTS idx_applications_post_id ON applications(post_id);
`);

// Older `/data` volumes (and local dev DBs) predate the `status` column —
// CREATE TABLE IF NOT EXISTS above won't add it to a table that already
// exists, so migrate it in by hand, guarded so this stays safe to run on
// every boot.
const applicationColumns = db.prepare("PRAGMA table_info(applications)").all() as { name: string }[];
if (!applicationColumns.some((c) => c.name === "status")) {
  db.exec(`
    ALTER TABLE applications
    ADD COLUMN status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined'))
  `);
}
