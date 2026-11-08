# ANU TaskMate — Harness

These rules formalise practices and decisions already established across
V1.0–V1.2 — they are being written down now, for the first time, to carry
forward into future development, not restated from an earlier CLAUDE.md.

## 1. Product purpose

TaskMate is a mutual-support campus board, not a competitive gig marketplace.
Posts may be free or paid; neither is the "real" use case. Every design
decision should ask whether it serves inclusive, cross-cultural student
connection — not just transaction completion.

> Evidence: README.md §§1–2 (vision); four community categories in
> src/db.ts's `CHECK (category IN (...))` constraint, not just "jobs."

## 2. Applications: multiple applicants, one per session, no re-apply after rejection

- Any number of distinct sessions may apply to the same post. Applying never
  closes a post or hides it from other students.
- A given session may apply to a given post at most once, enforced as a
  database constraint (`UNIQUE (post_id, applicant_session_id)`), not just an
  application-level check — the check exists only to return a clean error
  without a wasted round trip; the constraint is what's actually load-bearing
  under concurrent requests.
- Once an application is `declined`, there is no transition back to
  `pending` — the status state machine has no edge out of `declined`.

> Evidence: docs/adr-0001-concurrent-applications.md (full context/options/
> decision/consequences); src/db.ts:43 (`UNIQUE` constraint);
> src/routes/applications.ts `applyToPost` (constraint-driven 409 on
> duplicate, comment: "Multiple different students applying concurrently is
> allowed and expected; this only rejects the SAME visitor applying twice.");
> ALLOWED_TRANSITIONS table in src/routes/applications.ts (`declined: []`).

## 3. Per-applicant status lifecycle

Applications move through `pending → accepted/declined`, and from `accepted`
only to `completed` or `cancelled` (with a cancellation-request/reason
sub-flow). Only the post's own author may change status; this is a
server-side authorization check, not a UI affordance.

> Evidence: `CHECK (status IN ('pending','accepted','declined','completed',
> 'cancelled'))` in src/db.ts; `cancellation_requested`/`cancellation_reason`
> columns (src/db.ts:40–41); `post.author_session_id !== session.id` → 403
> checks in src/routes/applications.ts; spec/applicants.test.ts,
> spec/completion-cancellation.test.ts.

## 4. Private data must never leak through public APIs or SSE

Application messages and contact details (phone/email/WhatsApp/WeChat) are
private to the two parties in an accepted application. They must never
appear in:
- `GET /api/posts` (the public feed),
- any SSE broadcast payload (`src/events.ts`'s `broadcast()`),
- logs (no `console.log`/`console.error` of a request body containing one).

Contact details unlock only once an application reaches `accepted` or
`completed` — never before, and access is re-checked (not just unlocked
once) after cancellation.

A broadcast should carry an identifier at most (e.g. `postId`,
`applicationCount`), never a per-viewer-shaped object — the real state is
always re-fetched from an authenticated endpoint that recomputes what's true
for *that* caller.

> Evidence: src/routes/contacts.ts top-of-file comment ("Nothing here is ever
> broadcast over SSE... nothing here is ever logged"); `CONTACT_UNLOCKED_
> STATUSES = new Set(["accepted", "completed"])`; docs/adr-0001 §"Real-time
> propagation only ever broadcasts an identifier..."; spec/likes-comments.test.ts
> ("never broadcasts...beyond a postId identifier"); spec/notifications.test.ts
> ("never broadcasts a session id, notification content, or private messages
> over /events").

## 5. Server-side authorization and DB constraints enforce the important rules

Ownership checks (post author vs. applicant vs. comment author) and
dedup/uniqueness rules are enforced in route handlers and database
constraints — never assumed from the frontend, and never trusted from a
client-supplied flag. Where a race is possible (duplicate apply, duplicate
like), the DB constraint — not a check-then-write in application code — is
what actually prevents it.

> Evidence: 403 checks throughout src/routes/applications.ts and
> src/routes/contacts.ts; `UNIQUE` constraints in src/db.ts for applications,
> post_likes, and contact_details(application_id, role); docs/adr-0001's
> explicit framing ("No in-memory lock, mutex, or 'check then write' gap in
> application code is relied on for correctness; SQLite's own constraint
> enforcement is").

## 6. Comments are public; application messages and contact details are not

Comments are a flat, public, unmoderated list attached to a post — visible to
any visitor, same as the post itself. This is a deliberate contrast with
application messages (private to the applicant and post owner) and contact
details (private to the two parties in an accepted application, see §4).
Don't blur this distinction when extending either feature.

> Evidence: src/routes/comments.ts top comment ("a simple, flat, public
> comment list per post"); spec/likes-comments.test.ts ("shows comments to
> any visitor, including one who never commented (public, not
> application-scoped)"); contrast with src/routes/contacts.ts's
> `CONTACT_UNLOCKED_STATUSES` gate.

## 7. Likes, comments, and notifications follow the existing session-identity and privacy model

- Likes carry no private information (just "this session liked this post") —
  no permission check beyond having a session is needed to read or write one.
- Notifications are scoped strictly to `recipient_session_id = caller's own
  session.id` in every query — there is no notification id or postId a
  caller can pass to read someone else's notifications. A stranger probing
  another session's notification id gets 404, not 403 (existence itself is
  not the stranger's business).
- A session id is a bearer credential (it's the cookie value) — never put it
  in an SSE payload. The `notification:new` signal carries no payload at
  all; every client re-fetches its own `GET /api/notifications`.
- Never notify a user about their own action (e.g. commenting on or applying
  to one's own post should not generate a self-notification).

> Evidence: src/routes/likes.ts top comment; src/routes/notifications.ts
> (`WHERE n.recipient_session_id = ?` scoping; 404-not-403 comment on
> `markNotificationRead`; empty-payload broadcast with inline rationale);
> spec/notifications.test.ts (self-notification exclusion, cross-session
> 404s, empty-unreadCount for a stranger, no session id on the wire).

## 8. AI implementation must be checked against realistic user journeys, not just green tests

Passing automated tests does not mean the feature is right — verify by
actually using the deployed app as different sessions/browsers would,
including real-time behavior (does an update actually appear live, with no
reload, for a *different* open session), not just by reading code or relying
on a simulated DOM.

> Evidence: PROCESS.md §4 ("manual testing... revealed problems that were not
> obvious from the code or automated test results"; "even when tests passed,
> realistic user journeys could reveal missing functionality"); the
> notification-bell investigation itself (real headless-Chrome verification
> of live SSE updates, not just jsdom, before concluding the fix needed was a
> visibility signal, not a new real-time system).

## 9. Database migrations must be additive, compatibility-tested, and backed up

- Every schema change uses `CREATE TABLE IF NOT EXISTS` and guarded
  `ALTER TABLE ... ADD COLUMN` checks — idempotent, never destructive, never
  rewriting or dropping existing columns/tables.
- Before any production deploy, a migration must be run against a real copy
  of the production database (not just a synthetic fixture) and confirmed to
  preserve existing row counts and pass `PRAGMA integrity_check`.
- A checksum-verified backup must exist, stored both on the Fly volume and
  outside it, before any production migration is applied.
- No production data may be created, modified, or deleted without explicit
  user approval — this includes test posts, applications, likes, comments,
  and notifications.

> Evidence: src/db.ts's `CREATE TABLE IF NOT EXISTS` / guarded `ALTER TABLE
> ADD COLUMN` pattern throughout (status, cancellation_requested,
> cancellation_reason, message columns; post_likes, post_comments,
> notifications tables).

## 10. Do not modify PROCESS.md or Reflection files without explicit approval

These are the student's own account of the work and judgment calls behind
it. Treat them as authored content, not something to rewrite, paraphrase, or
"improve" on your own initiative — insert only exact, pre-approved text, and
only when explicitly asked to.

> Evidence: standing instruction given and followed in this session's
> documentation-update task (exact approved paragraphs inserted verbatim,
> nothing else touched, diffs verified as pure insertions before committing).

## 11. Do not merge, push, or deploy without explicit approval

Implementation, testing, and local verification can proceed without asking
each time; merging to main, pushing to origin/main, and deploying to
Fly.io require the user's explicit go-ahead first, every time — approving
one deploy does not pre-approve the next.

> Evidence: standing instruction given across the V1.2 notification feature
> and the V1.2 merge/deploy task, in both cases followed (work committed to
> the feature branch only until explicit approval; merge/push/deploy
> performed only after an explicit "Approved" message, with a remote backup
> branch taken first).
