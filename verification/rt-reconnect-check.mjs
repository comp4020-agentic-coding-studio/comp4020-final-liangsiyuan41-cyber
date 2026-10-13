// Verifies the reconnection decision from docs/adr-0001: a client that was
// disconnected while something changed must not miss that change — it's
// never trusted to have seen the SSE event, only to re-fetch state once
// it's connected again. Ad-hoc, not part of spec/.
const BASE = "http://localhost:8099";

function makeSession() {
  let cookie = "";
  return async (path, opts = {}) => {
    const res = await fetch(new URL(path, BASE), { ...opts, headers: { ...(opts.headers ?? {}), cookie } });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return res;
  };
}

async function main() {
  const fetchWithCookie = makeSession();
  const other = makeSession();

  // Open an SSE connection, then abruptly cancel it (simulates a dropped
  // connection — phone sleeps, wifi blips, server restarts).
  const res = await fetchWithCookie("/events");
  const reader = res.body.getReader();
  await new Promise((r) => setTimeout(r, 200));
  await reader.cancel();
  console.log("SSE connection opened, then abruptly cancelled (simulating a drop)");

  // While this session is "disconnected", someone else posts and a third
  // party applies — events this session could never have received.
  const post = await other("/api/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      authorName: "Frank",
      category: "campus_events",
      title: "Missed while offline",
      description: "Created while the other session was disconnected",
      isPaid: false,
    }),
  }).then((r) => r.json());

  await other(`/api/posts/${post.id}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ applicantName: "Grace" }),
  });

  console.log("while disconnected: a new post was made and someone applied to it");

  // The disconnected session "comes back" (what the client's SSE `open`
  // handler triggers in the real app) — it must see full current state from
  // a plain GET, not rely on anything it missed.
  const freshView = await fetchWithCookie("/api/posts").then((r) => r.json());
  const seenPost = freshView.find((p) => p.id === post.id);
  console.log(
    "on reconnect, GET /api/posts shows the missed post:",
    !!seenPost,
    "with correct application count:",
    seenPost?.applicationCount,
  );
}

main().then(() => process.exit(0));
