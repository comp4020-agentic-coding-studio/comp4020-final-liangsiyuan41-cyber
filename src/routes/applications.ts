import type { IncomingMessage, ServerResponse } from "node:http";
import { db } from "../db.ts";
import { broadcast } from "../events.ts";
import { notifyNewApplication } from "./notifications.ts";
import { setDisplayName, type Session } from "../session.ts";

export type ApplicationStatus = "pending" | "accepted" | "declined" | "completed" | "cancelled";

// The only transitions the state machine allows. Both the author's "decline
// a cancellation request" (there isn't one — see CLAUDE.md's Cancellation
// requirements) and "edit a completed/cancelled record" are deliberately
// absent: completed and cancelled are terminal, and nothing transitions back
// to pending. Enforced here, not just hidden in the UI, so a crafted PATCH
// can't skip the author's decision.
const ALLOWED_TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  pending: ["accepted", "declined"],
  accepted: ["completed", "cancelled"],
  declined: [],
  completed: [],
  cancelled: [],
};

const getPostStmt = db.prepare("SELECT id, author_session_id FROM posts WHERE id = ?");

// UNIQUE (post_id, applicant_session_id) in the schema is what actually
// prevents a double-apply under concurrent requests — the check only avoids
// a wasted round trip for the ordinary case; the constraint is what's load
// bearing. See docs/adr-0001-concurrent-applications.md.
const insertApplicationStmt = db.prepare(`
  INSERT INTO applications (post_id, applicant_session_id, applicant_name, message)
  VALUES (?, ?, ?, ?)
`);

const countApplicationsStmt = db.prepare("SELECT COUNT(*) AS n FROM applications WHERE post_id = ?");

const listApplicantsStmt = db.prepare(`
  SELECT id, applicant_name, message, status, cancellation_requested, cancellation_reason, created_at
  FROM applications
  WHERE post_id = ?
  ORDER BY created_at ASC
`);

const getApplicationStmt = db.prepare("SELECT id, post_id, status FROM applications WHERE id = ?");

const getApplicationByPostAndSessionStmt = db.prepare(
  "SELECT id, post_id, status FROM applications WHERE post_id = ? AND applicant_session_id = ?",
);

// Any author decision resolves whatever cancellation request was outstanding
// — there's nothing left to approve once the application has moved on, so
// the request flag and reason are cleared alongside the status itself.
const updateStatusStmt = db.prepare(
  "UPDATE applications SET status = ?, cancellation_requested = 0, cancellation_reason = NULL WHERE id = ?",
);

const requestCancellationStmt = db.prepare(
  "UPDATE applications SET cancellation_requested = 1, cancellation_reason = ? WHERE id = ?",
);

const ALL_STATUSES: readonly ApplicationStatus[] = ["pending", "accepted", "declined", "completed", "cancelled"];

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
  const post = getPostStmt.get(postId) as { id: number; author_session_id: string } | undefined;
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
  // Optional: an applicant may apply with no message at all. 1000 chars
  // mirrors the generosity of a post's own description field above it.
  const message = isNonEmptyString(b.message) ? b.message.trim().slice(0, 1000) : null;

  setDisplayName(session.id, applicantName);

  let applicationId: number;
  try {
    const result = insertApplicationStmt.run(postId, session.id, applicantName, message);
    applicationId = result.lastInsertRowid as number;
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
  notifyNewApplication(postId, post.author_session_id, session.id, applicationId, applicantName);
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
    message: string | null;
    status: ApplicationStatus;
    cancellation_requested: number;
    cancellation_reason: string | null;
    created_at: string;
  }[];

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify(
      rows.map((row) => ({
        id: row.id,
        applicantName: row.applicant_name,
        // The application message is as private as the cancellation reason
        // just below it — visible only to the post author and the applicant
        // who wrote it, never in the public feed. This endpoint already only
        // returns to the author (see the ownership check above).
        message: row.message,
        status: row.status,
        cancellationRequested: Boolean(row.cancellation_requested),
        // The reason is private to the author and that one applicant — this
        // endpoint already only returns to the author (see the ownership
        // check above), so handing it back here doesn't widen who sees it.
        cancellationReason: row.cancellation_reason,
        createdAt: row.created_at,
      })),
    ),
  );
}

// Author decisions: accept/decline a pending applicant, or mark an accepted
// one completed/cancelled. Each application is transitioned independently —
// deciding on one never touches any other applicant's row, matching the C9
// decision that applying never closes a post to anyone else
// (docs/adr-0001-concurrent-applications.md). This also covers the author
// directly cancelling an accepted participant, and the author approving a
// participant's own cancellation request (same transition, accepted ->
// cancelled; the request is just what prompted it).
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
  const status = ALL_STATUSES.includes(b.status as ApplicationStatus) ? (b.status as ApplicationStatus) : null;
  if (!status) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `status must be one of ${ALL_STATUSES.filter((s) => s !== "pending").join(", ")}` }));
    return;
  }

  if (!ALLOWED_TRANSITIONS[application.status].includes(status)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `cannot move an application from '${application.status}' to '${status}'` }));
    return;
  }

  // Completing or cancelling always resolves any outstanding cancellation
  // request on this application — there's nothing left for the author to
  // approve once the application has reached a terminal state.
  updateStatusStmt.run(status, applicationId);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ id: applicationId, postId, status }));

  // Identifier only, same reasoning as application:count: the applicant's
  // own session re-fetches GET /api/posts for its authoritative, per-viewer
  // status rather than trusting a broadcast payload (ADR 0001).
  broadcast("application:status", { postId });
}

// The applicant's own request to step back from an acceptance. Scoped by
// (postId, the caller's own session) rather than an application id — the
// applicant's browser only ever knows a post id (from the public feed), the
// same shape as applyToPost above, not the internal application id the
// author's view uses. This never changes `status` itself — only the post
// author's decision does that (see setApplicationStatus) — so a request
// alone can't be mistaken for an already-resolved cancellation, matching
// CLAUDE.md's requirement to keep a request and a completed cancellation as
// distinct states.
export async function requestCancellation(
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
  postId: number,
): Promise<void> {
  const application = getApplicationByPostAndSessionStmt.get(postId, session.id) as
    | { id: number; post_id: number; status: ApplicationStatus }
    | undefined;
  if (!application) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "you have no application on this post" }));
    return;
  }

  if (application.status !== "accepted") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "only an accepted application can have cancellation requested" }));
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
  const reason = isNonEmptyString(b.reason) ? b.reason.trim().slice(0, 500) : null;

  requestCancellationStmt.run(reason, application.id);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ id: application.id, postId, cancellationRequested: true }));

  // Identifier only — the author's open session re-fetches the applicant
  // list for the authoritative view, same as every other status change here.
  broadcast("application:status", { postId });
}
