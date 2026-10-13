import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { db } from "./db.ts";

const COOKIE_NAME = "taskmate_session";

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export interface Session {
  id: string;
  displayName: string | null;
}

const getSessionStmt = db.prepare("SELECT id, display_name FROM sessions WHERE id = ?");
const insertSessionStmt = db.prepare("INSERT INTO sessions (id) VALUES (?)");
const setNameStmt = db.prepare("UPDATE sessions SET display_name = ? WHERE id = ?");

// Finds or creates the visitor's session from their cookie. This is a
// temporary visitor identity (a random id plus a self-chosen name, not
// verified ANU auth) — see docs/adr-0001-concurrent-applications.md for why
// that's enough for C9, and the sessions table for how a real account could
// extend it later.
export function resolveSession(req: IncomingMessage, res: ServerResponse): Session {
  const cookies = parseCookies(req.headers.cookie);
  const existingId = cookies[COOKIE_NAME];

  if (existingId) {
    const row = getSessionStmt.get(existingId) as { id: string; display_name: string | null } | undefined;
    if (row) return { id: row.id, displayName: row.display_name };
  }

  const id = randomUUID();
  insertSessionStmt.run(id);
  // Fly's proxy terminates TLS in front of the app (fly.toml), so the
  // connection the browser sees is https even though this process only ever
  // sees plain http; x-forwarded-proto is how it tells us which was used.
  // Locally there's no proxy, so `Secure` would silently stop the cookie
  // being set at all over http://localhost.
  const isHttps = req.headers["x-forwarded-proto"] === "https";
  const secure = isHttps ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${id}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=31536000`,
  );
  return { id, displayName: null };
}

export function setDisplayName(sessionId: string, name: string): void {
  setNameStmt.run(name, sessionId);
}
