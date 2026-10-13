import type { IncomingMessage, ServerResponse } from "node:http";
import { db } from "../db.ts";
import { broadcast } from "../events.ts";
import { setDisplayName, type Session } from "../session.ts";

const getPostStmt = db.prepare("SELECT id FROM posts WHERE id = ?");

// UNIQUE (post_id, applicant_session_id) in the schema is what actually
// prevents a double-apply under concurrent requests — the check only avoids
// a wasted round trip for the ordinary case; the constraint is what's load
// bearing. See docs/adr-0001-concurrent-applications.md.
const insertApplicationStmt = db.prepare(`
  INSERT INTO applications (post_id, applicant_session_id, applicant_name)
  VALUES (?, ?, ?)
`);

const countApplicationsStmt = db.prepare("SELECT COUNT(*) AS n FROM applications WHERE post_id = ?");

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
