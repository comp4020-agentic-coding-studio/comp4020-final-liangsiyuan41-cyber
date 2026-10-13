# Verification scripts

Ad-hoc scripts, not run by `pnpm check` and not part of the course's `spec/`.
They exist to document C9's real-time claim with actual measurements, run
against a locally started server:

```
DB_PATH=/tmp/taskmate-rt.db PORT=8099 node src/server.ts &
node verification/rt-sync-check.mjs
node verification/rt-reconnect-check.mjs
node verification/rt-fanout-check.mjs
```

- `rt-sync-check.mjs` — two independent, cookie-isolated sessions (no
  shared state, like two browser profiles): a post made in one reaches the
  other's open SSE connection, and an application made in one updates the
  other's live count. Also checks the C9 multi-user decision directly:
  distinct sessions applying concurrently to the same post all succeed, a
  session applying twice is rejected (409), and the post never auto-closes.
- `rt-reconnect-check.mjs` — a session's SSE connection is abruptly
  cancelled, changes happen it never saw pushed to it, then a fresh
  `GET /api/posts` on "reconnect" is checked against what actually changed.
- `rt-fanout-check.mjs` — ten simultaneous SSE listeners, checking delivery
  latency doesn't degrade with more open tabs.

Latest run: all three events delivered in single-digit-to-low-teens
milliseconds, well under the brief's "about a second" — see `PROCESS.md`
for the full numbers and what each result means for the C9 decision.
