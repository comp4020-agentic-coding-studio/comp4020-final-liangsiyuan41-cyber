# ADR 0001: Concurrent applications to the same post

## Status

Accepted, implemented in C9.

## Context

TaskMate is a mutual-support board, not a gig marketplace with a single
assignable worker per task. Multiple students can reasonably want to help with
or join the same opportunity (study group, event helpers, moving help), and
the brief's C9 crit specifically requires a multi-user decision: a concrete
choice about what happens when more than one visitor acts on the same piece of
shared state at the same time, with alternatives considered.

The shared state here is a post's application list. The question: what should
happen when a second student applies to a post someone has already applied
to, and what should happen when many students apply concurrently?

Alternatives considered:

1. **First application closes the post.** Simplest to build, matches a
   marketplace mental model (one job, one hire). Rejected: it punishes
   students who load the page a few seconds later than someone else, doesn't
   match "mutual support community," and removes information (who else wanted
   to help) that the author might want later. It also pushes a harder
   problem — picking a winner fairly under concurrent requests — into this
   stage for no real benefit, since nothing yet *uses* that selection.
2. **Author must approve before a post is "live" for applications**,
   i.e. an explicit accept/reject workflow gating who can apply. Rejected for
   C9: it's genuine new scope (notifications, author-side review UI, pending
   vs. active state) beyond what this stage asks for, and it's exactly the
   A3 "post authors review/select applicants" feature already deferred. Doing
   it now would be scope creep against the approved plan.
3. **Allow concurrent applications, cap at N, then close.** Avoids the
   fairness problem of alternative 1 a little, but still needs a correct
   answer to "what happens when application N and N+1 arrive at the same
   instant," so it doesn't actually remove the hard part, and adds a magic
   number with no product reason behind it yet.
4. **Allow unlimited concurrent applications per post; block only exact
   duplicates from the same visitor.** Chosen. See below.

## Decision

- Any number of distinct sessions may apply to the same post. Applying never
  closes a post or removes it from other students' view.
- A given session may apply to a given post at most once. This is enforced
  as a database constraint, not application logic:
  `UNIQUE (post_id, applicant_session_id)` on the `applications` table
  (`src/db.ts`). The route handler (`src/routes/applications.ts`) does a
  pre-check first to avoid a wasted round trip and return a clean error
  message, but the constraint is what actually prevents a double-apply if two
  requests from the same session arrive at effectively the same time — two
  concurrent `INSERT`s racing each other hit the same unique index, and
  exactly one wins, the same way two different sessions racing to insert
  distinct rows both succeed. No in-memory lock, mutex, or "check then write"
  gap in application code is relied on for correctness; SQLite's own
  constraint enforcement is.
- `POST /api/posts/:id/apply` returns `201` with the current
  `applicationCount` on success, `409` with the current `applicationCount` on
  a repeat from the same session, and `404` if the post doesn't exist. In no
  case does the response or the underlying data say the post is closed.
- Real-time propagation only ever broadcasts an *identifier*
  (`{ postId, applicationCount }` or `{ id }` for a new post — see
  `src/events.ts`), never a full, per-viewer-shaped object. Every client
  reacts to the broadcast by re-fetching `GET /api/posts`, which recomputes
  `isOwnPost` / `appliedByMe` against *that* visitor's session. This matters
  for the same underlying reason as the concurrency decision: what's true
  for one visitor (they already applied) is not true for another, and a
  naive broadcast-the-object approach would silently leak or misapply that
  per-viewer truth to everyone else connected at the time.

## Consequences

- A post's `applicationCount` is always an accurate, monotonically
  increasing count of distinct students who've expressed interest — useful
  information for the author even before any selection mechanism exists.
- Nothing currently stops an author from seeing (and, later, choosing among)
  more applicants than they need; that review/selection step is explicitly
  out of scope for C9 and is the planned A3 extension referenced in
  `README.md`'s "what's deliberately not here yet" section.
- Because correctness rests on a database constraint rather than
  request-handling logic, it holds regardless of request ordering, retries,
  or multiple server-side async paths touching the same post — verified
  directly under genuine concurrent HTTP requests from distinct sessions
  (`verification/rt-sync-check.mjs`) and again against the containerized
  deploy image (`spec/taskmate.test.ts`).
- If a future stage needs single-winner semantics (e.g. an author "accepts"
  one applicant), that's additive: a new `status` column or table, not a
  change to this constraint or to how applying itself behaves.
