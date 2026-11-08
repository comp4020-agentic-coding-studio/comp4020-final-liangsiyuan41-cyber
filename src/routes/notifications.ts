import type { ServerResponse } from "node:http";
import { db } from "../db.ts";
import { broadcast } from "../events.ts";
import type { Session } from "../session.ts";

// V1.2 (follow-up): in-app notifications. Two kinds for this first version —
// "someone applied to your post" and "someone commented on your post" — both
// addressed to the post's author only. Deliberately narrow in scope: no
// email/push, no WebSockets (SSE already does the job), no digesting or
// grouping, matching the feature's own "keep this lightweight" instruction.
export type NotificationType = "new_application" | "new_comment";

interface NotificationRow {
  id: number;
  type: NotificationType;
  post_id: number;
  application_id: number | null;
  actor_name: string;
  is_read: number;
  created_at: string;
  post_title: string;
}

const insertNotificationStmt = db.prepare(`
  INSERT INTO notifications (recipient_session_id, type, post_id, application_id, actor_name)
  VALUES (?, ?, ?, ?, ?)
`);

// Joins in the post's current title at read time rather than freezing a copy
// of it into the notification row — if a post were ever editable later, a
// notification would still describe the right post rather than a stale
// title. (No rename/edit feature exists yet, but this costs nothing extra.)
const listNotificationsStmt = db.prepare(`
  SELECT n.id, n.type, n.post_id, n.application_id, n.actor_name, n.is_read, n.created_at, p.title AS post_title
  FROM notifications n
  JOIN posts p ON p.id = n.post_id
  WHERE n.recipient_session_id = ?
  ORDER BY n.created_at DESC
  LIMIT 50
`);

const countUnreadStmt = db.prepare(
  "SELECT COUNT(*) AS n FROM notifications WHERE recipient_session_id = ? AND is_read = 0",
);

const getNotificationStmt = db.prepare("SELECT id, recipient_session_id FROM notifications WHERE id = ?");
const markReadStmt = db.prepare("UPDATE notifications SET is_read = 1 WHERE id = ?");
const markAllReadStmt = db.prepare(
  "UPDATE notifications SET is_read = 1 WHERE recipient_session_id = ? AND is_read = 0",
);

// Called from applyToPost (src/routes/applications.ts) and createComment
// (src/routes/comments.ts) — never exported for any other use, so every
// notification this app can ever create traces back to one of those two
// call sites. Never notifies the actor about their own action: the post
// author applying to or commenting on their own post is a legitimate
// existing path (likes/comments have no ownership restriction), and
// notifying yourself about your own action would just be noise.
// Neither function broadcasts the recipient's session id, or anything else
// identifying — a session id is effectively a bearer credential (it's the
// cookie value), so putting it in an SSE frame would hand every other open
// tab on the server a way to read a stranger's notifications. Instead,
// "notification:new" carries no payload at all; every connected client
// (whether or not it's the actual recipient) just re-fetches its own
// GET /api/notifications, the same broadcast-identifier-then-refetch shape
// every other event in this app already uses (ADR-0001) — here pushed to
// its logical limit of "no identifier either", since even the postId isn't
// this viewer's business unless the notification turns out to be theirs.
export function notifyNewApplication(
  postId: number,
  postOwnerSessionId: string,
  applicantSessionId: string,
  applicationId: number,
  applicantName: string,
): void {
  // A post's own author can't apply to their own post today (applying and
  // owning are mutually exclusive in current usage), but this guard costs
  // nothing and keeps the "never notify yourself" rule true regardless of
  // whether that ever changes.
  if (postOwnerSessionId === applicantSessionId) return;
  insertNotificationStmt.run(postOwnerSessionId, "new_application", postId, applicationId, applicantName);
  broadcast("notification:new", {});
}

export function notifyNewComment(
  postId: number,
  postOwnerSessionId: string,
  commenterSessionId: string,
  commenterName: string,
): void {
  if (postOwnerSessionId === commenterSessionId) return;
  insertNotificationStmt.run(postOwnerSessionId, "new_comment", postId, null, commenterName);
  broadcast("notification:new", {});
}

function serialiseNotification(row: NotificationRow) {
  return {
    id: row.id,
    type: row.type,
    postId: row.post_id,
    applicationId: row.application_id,
    actorName: row.actor_name,
    postTitle: row.post_title,
    isRead: Boolean(row.is_read),
    createdAt: row.created_at,
  };
}

// Every notification is scoped to recipient_session_id = this caller's own
// session.id in the WHERE clause itself — there is no notification id or
// postId a caller can pass to read another session's notifications; the
// list is always "mine", the same shape as GET /api/posts/:id/my-contact.
export function listNotifications(res: ServerResponse, session: Session): void {
  const rows = listNotificationsStmt.all(session.id) as unknown as NotificationRow[];
  const { n: unreadCount } = countUnreadStmt.get(session.id) as { n: number };

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      notifications: rows.map(serialiseNotification),
      unreadCount,
    }),
  );
}

// Marks one notification read — only the recipient can do this. A stranger
// guessing another session's notification id gets 404 (not 403): whether
// that id exists at all is itself not this caller's business, the same
// "not found, not forbidden" shape used where leaking existence would be
// the more surprising behaviour.
export function markNotificationRead(res: ServerResponse, session: Session, notificationId: number): void {
  const notification = getNotificationStmt.get(notificationId) as
    | { id: number; recipient_session_id: string }
    | undefined;
  if (!notification || notification.recipient_session_id !== session.id) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "notification not found" }));
    return;
  }

  markReadStmt.run(notificationId);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ id: notificationId, isRead: true }));
}

export function markAllNotificationsRead(res: ServerResponse, session: Session): void {
  markAllReadStmt.run(session.id);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}
