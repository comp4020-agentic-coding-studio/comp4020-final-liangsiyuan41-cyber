import type { IncomingMessage, ServerResponse } from "node:http";
import { db } from "../db.ts";
import { broadcast } from "../events.ts";
import { setDisplayName, type Session } from "../session.ts";

export type ApplicationStatus = "pending" | "accepted" | "declined";

const getPostStmt = db.prepare("SELECT id, author_session_id FROM posts WHERE id = ?");

// UNIQUE (post_id, applicant_session_id) in the schema is what actually
// prevents a double-apply under concurrent requests — the check only avoids
// a wasted round trip for the ordinary case; the constraint is what's load
// bearing. See docs/adr-0001-concurrent-applications.md.
const insertApplicationStmt = db.prepare(`
  INSERT INTO applications (post_id, applicant_session_id, applicant_name)
  VALUES (?, ?, ?)
`);

const countApplicationsStmt = db.prepare("SELECT COUNT(*) AS n FROM applications WHERE post_id = ?");

const listApplicantsStmt = db.prepare(`
  SELECT id, applicant_name, status, created_at
  FROM applications
  WHERE post_id = ?
  ORDER BY created_at ASC
`);

const getApplicationStmt = db.prepare("SELECT id, post_id, status FROM applications WHERE id = ?");

const updateStatusStmt = db.prepare("UPDATE applications SET status = ? WHERE id = ?");

const STATUSES = ["pending", "accepted", "declined"] as const;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export async function applyToPost(
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
  postId: number,
): Promise<void> {
  const post = getPostStmt.get(postId);
  if (!post) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "post not found" }));
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  const b = body as Record<string, unknown>;
  const applicantName = isNonEmptyString(b.applicantName) ? b.applicantName.trim().slice(0, 80) : null;
  if (!applicantName) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "applicantName is required" }));
    return;
  }

  setDisplayName(session.id, applicantName);

  try {
    insertApplicationStmt.run(postId, session.id, applicantName);
  } catch (err) {
    // SQLITE_CONSTRAINT_UNIQUE: this session already applied to this post.
    // Multiple different students applying concurrently is allowed and
    // expected; this only rejects the SAME visitor applying twice.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE constraint failed")) {
      const { n } = countApplicationsStmt.get(postId) as { n: number };
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "you already applied to this post", applicationCount: n }));
      return;
    }
    throw err;
  }

  const { n } = countApplicationsStmt.get(postId) as { n: number };
  res.writeHead(201, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ postId, applicationCount: n }));

  broadcast("application:count", { postId, applicationCount: n });
}

// Only the post's author may see who applied — this is private
// applicant-management information, not public feed data (see
// CLAUDE.md's Applicant Management requirements). Enforced here, server-side,
// not just by hiding the UI section from other visitors.
export function listApplicants(res: ServerResponse, session: Session, postId: number): void {
  const post = getPostStmt.get(postId) as { id: number; author_session_id: string } | undefined;
  if (!post) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "post not found" }));
    return;
  }
  if (post.author_session_id !== session.id) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "only the post author can view applicants" }));
    return;
  }

  const rows = listApplicantsStmt.all(postId) as {
    id: number;
    applicant_name: string;
    status: ApplicationStatus;
    created_at: string;
  }[];

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify(
      rows.map((row) => ({
        id: row.id,
        applicantName: row.applicant_name,
        status: row.status,
        createdAt: row.created_at,
      })),
    ),
  );
}

// Author decisions: accept/decline a single applicant. Accepting one
// applicant never touches any other applicant's row — there is no "reject
// everyone else" side effect, matching the C9 decision that applying never
// closes a post to anyone else (docs/adr-0001-concurrent-applications.md).
export async function setApplicationStatus(
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
  postId: number,
  applicationId: number,
): Promise<void> {
  const post = getPostStmt.get(postId) as { id: number; author_session_id: string } | undefined;
  if (!post) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "post not found" }));
    return;
  }
  if (post.author_session_id !== session.id) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "only the post author can decide applications" }));
    return;
  }

  const application = getApplicationStmt.get(applicationId) as
    | { id: number; post_id: number; status: ApplicationStatus }
    | undefined;
  if (!application || application.post_id !== postId) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "application not found" }));
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  const b = body as Record<string, unknown>;
  const status = STATUSES.includes(b.status as ApplicationStatus) ? (b.status as ApplicationStatus) : null;
  if (!status || status === "pending") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "status must be 'accepted' or 'declined'" }));
    return;
  }

  updateStatusStmt.run(status, applicationId);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ id: applicationId, postId, status }));

  // Identifier only, same reasoning as application:count: the applicant's
  // own session re-fetches GET /api/posts for its authoritative, per-viewer
  // status rather than trusting a broadcast payload (ADR 0001).
  broadcast("application:status", { postId });
}
