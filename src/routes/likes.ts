import type { ServerResponse } from "node:http";
import { db } from "../db.ts";
import { broadcast } from "../events.ts";
import type { Session } from "../session.ts";

// V1.2 Feature 2 (Likes): a simple public reaction, public precisely because
// it carries no private information at all — just "this session liked this
// post", never a name or message. No permission check beyond "you have a
// session" is needed to read or write it, unlike applicant management or
// contact exchange, which both gate on ownership.
const getPostStmt = db.prepare("SELECT id FROM posts WHERE id = ?");

// UNIQUE (post_id, session_id) in the schema is what actually prevents a
// duplicate like under concurrent requests — same reasoning as applications'
// UNIQUE (post_id, applicant_session_id) (docs/adr-0001-…md): the constraint
// is load bearing, not the existence check below, which only avoids a
// wasted round trip and gives a clean idempotent response for the ordinary
// case of a client retrying or double-clicking.
const insertLikeStmt = db.prepare("INSERT INTO post_likes (post_id, session_id) VALUES (?, ?)");
const deleteLikeStmt = db.prepare("DELETE FROM post_likes WHERE post_id = ? AND session_id = ?");
const countLikesStmt = db.prepare("SELECT COUNT(*) AS n FROM post_likes WHERE post_id = ?");
const hasLikedStmt = db.prepare("SELECT 1 FROM post_likes WHERE post_id = ? AND session_id = ?");

function respondWithLikeState(res: ServerResponse, postId: number, likedByMe: boolean): void {
  const { n } = countLikesStmt.get(postId) as { n: number };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ postId, likeCount: n, likedByMe }));
}

export function likePost(res: ServerResponse, session: Session, postId: number): void {
  const post = getPostStmt.get(postId);
  if (!post) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "post not found" }));
    return;
  }

  // Already liked by this session: respond with the current state rather
  // than erroring — liking is idempotent from the visitor's point of view
  // (the UI's Like button always means "make this liked", not "add a like
  // even if I already have one"). No broadcast here: nothing changed.
  if (hasLikedStmt.get(postId, session.id)) {
    respondWithLikeState(res, postId, true);
    return;
  }

  try {
    insertLikeStmt.run(postId, session.id);
  } catch (err) {
    // SQLITE_CONSTRAINT_UNIQUE: a concurrent request from the same session
    // (e.g. a double-click) got there first between the check above and
    // this insert. The outcome is the same either way — this session has
    // liked the post — so this isn't an error from the caller's view, and
    // nothing changed that a broadcast would need to announce.
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("UNIQUE constraint failed")) throw err;
    respondWithLikeState(res, postId, true);
    return;
  }

  respondWithLikeState(res, postId, true);

  // Identifier only, same reasoning as application:count (docs/adr-0001-…md):
  // likedByMe is per-viewer, so the broadcast never carries it — every
  // client re-fetches GET /api/posts, which recomputes likedByMe against
  // *that* visitor's own session.
  broadcast("post:liked", { postId });
}

export function unlikePost(res: ServerResponse, session: Session, postId: number): void {
  const post = getPostStmt.get(postId);
  if (!post) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "post not found" }));
    return;
  }

  const wasLiked = hasLikedStmt.get(postId, session.id);
  deleteLikeStmt.run(postId, session.id);
  respondWithLikeState(res, postId, false);

  if (wasLiked) broadcast("post:liked", { postId });
}
