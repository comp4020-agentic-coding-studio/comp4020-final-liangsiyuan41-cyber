import type { IncomingMessage, ServerResponse } from "node:http";
import { db } from "../db.ts";
import { broadcast } from "../events.ts";
import { setDisplayName, type Session } from "../session.ts";

// V1.2 Feature 2 (Comments): a simple, flat, public comment list per post.
// Deliberately no nesting, no edit, no moderation queue — see the feature's
// own scope note. Stored as plain text (never pre-rendered HTML) and always
// escaped by the client at render time, the same discipline every other
// free-text field in this app already follows (post titles/descriptions,
// application messages) — see public/post-card.js's escapeHtml, used again
// for comments there. Nothing server-side ever treats a comment body as
// markup: SQLite stores and returns it as an opaque string via a
// parameterised statement, so there is no SQL-injection surface either.
const MAX_MESSAGE_LENGTH = 500;
const MAX_NAME_LENGTH = 80;

// A minimal per-session cooldown against comment spam: this is a public,
// unmoderated list, so without some limit a single session could flood a
// post with rapid posts. A fixed cooldown (not a sliding window/token
// bucket) keeps this simple and easy to verify, matching the feature's
// "basic rate limiting" requirement rather than a general-purpose scheme.
// In-memory only — same tradeoff as src/events.ts's client Set: fine for
// this app's single-process deployment (fly.toml: one machine), resets on
// restart, and never persisted, so it isn't a migration concern.
const RATE_LIMIT_WINDOW_MS = 10_000;
const lastCommentAtBySession = new Map<string, number>();

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const getPostStmt = db.prepare("SELECT id FROM posts WHERE id = ?");
const insertCommentStmt = db.prepare(`
  INSERT INTO post_comments (post_id, author_session_id, author_name, message)
  VALUES (?, ?, ?, ?)
`);
const listCommentsStmt = db.prepare(`
  SELECT id, author_session_id, author_name, message, created_at
  FROM post_comments
  WHERE post_id = ?
  ORDER BY created_at ASC
`);
const getCommentStmt = db.prepare("SELECT id, post_id, author_session_id FROM post_comments WHERE id = ?");
const getCommentRowStmt = db.prepare(
  "SELECT id, author_session_id, author_name, message, created_at FROM post_comments WHERE id = ?",
);
const deleteCommentStmt = db.prepare("DELETE FROM post_comments WHERE id = ?");

interface CommentRow {
  id: number;
  author_session_id: string;
  author_name: string;
  message: string;
  created_at: string;
}

function serialiseComment(row: CommentRow, sessionId: string) {
  return {
    id: row.id,
    authorName: row.author_name,
    message: row.message,
    createdAt: row.created_at,
    // Lets the client show a Delete control only on the viewer's own
    // comments — the same "server decides, UI just reflects it" shape as
    // isOwnPost/appliedByMe elsewhere. The actual delete endpoint below
    // re-checks ownership itself regardless of what the client sends.
    isOwnComment: row.author_session_id === sessionId,
  };
}

// Public: every visitor sees every comment on a post, same as the post
// itself — comments carry no private data (see module comment above).
export function listComments(res: ServerResponse, session: Session, postId: number): void {
  const post = getPostStmt.get(postId);
  if (!post) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "post not found" }));
    return;
  }

  const rows = listCommentsStmt.all(postId) as unknown as CommentRow[];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(rows.map((row) => serialiseComment(row, session.id))));
}

export async function createComment(
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

  const lastAt = lastCommentAtBySession.get(session.id);
  if (lastAt !== undefined && Date.now() - lastAt < RATE_LIMIT_WINDOW_MS) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "please wait a moment before posting another comment" }));
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
  const authorName = isNonEmptyString(b.authorName) ? b.authorName.trim().slice(0, MAX_NAME_LENGTH) : null;
  const message = isNonEmptyString(b.message) ? b.message.trim().slice(0, MAX_MESSAGE_LENGTH) : null;

  if (!authorName || !message) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "authorName and message are required" }));
    return;
  }

  setDisplayName(session.id, authorName);

  const result = insertCommentStmt.run(postId, session.id, authorName, message);
  lastCommentAtBySession.set(session.id, Date.now());

  const row = getCommentRowStmt.get(result.lastInsertRowid) as unknown as CommentRow;
  const comment = serialiseComment(row, session.id);

  res.writeHead(201, { "Content-Type": "application/json" });
  res.end(JSON.stringify(comment));

  // Identifier only, same reasoning as application:count/application:status
  // (docs/adr-0001-…md): the comment body is never broadcast, so a session
  // that hasn't loaded it yet can't receive it from the event itself — every
  // client re-fetches GET /api/posts/:id/comments, which is the public,
  // authoritative list.
  broadcast("comment:created", { postId });
}

// Only the comment's own author may delete it — enforced here, server-side,
// not just by hiding the Delete button in the UI (the same discipline as
// every other ownership check in this app: listApplicants, setApplicationStatus,
// saveOwnerContact all re-check on the server rather than trusting the
// client's view of who owns what).
export function deleteComment(res: ServerResponse, session: Session, postId: number, commentId: number): void {
  const comment = getCommentStmt.get(commentId) as
    | { id: number; post_id: number; author_session_id: string }
    | undefined;
  if (!comment || comment.post_id !== postId) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "comment not found" }));
    return;
  }
  if (comment.author_session_id !== session.id) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "only the comment's author can delete it" }));
    return;
  }

  deleteCommentStmt.run(commentId);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ id: commentId, postId }));

  broadcast("comment:deleted", { postId });
}
