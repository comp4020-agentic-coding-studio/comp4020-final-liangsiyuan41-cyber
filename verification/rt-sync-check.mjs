// Ad-hoc verification script for C9 real-time sync. Not part of spec/ (which
// runs in CI) — this is a manual, one-off check mirroring exactly how the
// crit and the brief describe testing it: two independent sessions, each
// with no shared cookies (like two separate browser profiles), watched
// simultaneously, measuring actual wall-clock delivery time.
const BASE = "http://localhost:8099";

function makeSession(label) {
  let cookie = "";
  const fetchWithCookie = async (path, opts = {}) => {
    const res = await fetch(new URL(path, BASE), {
      ...opts,
      headers: { ...(opts.headers ?? {}), cookie },
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return res;
  };

  async function openEvents(onEvent) {
    const res = await fetchWithCookie("/events");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const eventLine = chunk.split("\n").find((l) => l.startsWith("event: "));
          const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (eventLine && dataLine) {
            onEvent(eventLine.slice(7), JSON.parse(dataLine.slice(6)), performance.now());
          }
        }
      }
    })();
    return () => reader.cancel();
  }

  return { label, fetchWithCookie, openEvents };
}

async function main() {
  const alice = makeSession("alice"); // acts in one "browser"
  const bob = makeSession("bob"); // watches in a second, cookie-isolated "browser"

  const bobEvents = [];
  const closeBob = await bob.openEvents((event, data, t) => bobEvents.push({ event, data, t }));
  const aliceEvents = [];
  const closeAlice = await alice.openEvents((event, data, t) => aliceEvents.push({ event, data, t }));

  await new Promise((r) => setTimeout(r, 300)); // let both SSE connections settle

  // --- Test 1: Alice creates a post; Bob (a separate session/tab) should
  // see a post:created event propagate without Bob doing anything. ---
  const t0 = performance.now();
  const createRes = await alice.fetchWithCookie("/api/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      authorName: "Alice",
      category: "study_together",
      title: "COMP4020 crit prep",
      description: "Study session before crit 9",
      isPaid: false,
    }),
  });
  const post = await createRes.json();
  await new Promise((r) => setTimeout(r, 400));

  const bobSawPostCreated = bobEvents.find((e) => e.event === "post:created" && e.data.id === post.id);
  console.log(
    "post:created reached Bob's session:",
    !!bobSawPostCreated,
    bobSawPostCreated ? `after ${(bobSawPostCreated.t - t0).toFixed(0)}ms` : "",
  );

  // Bob's session re-fetches on the event (what the real client does) — and
  // since Bob never shared cookies with Alice, isOwnPost/appliedByMe here
  // must be false/false for him, not Alice's values.
  const bobView = await bob.fetchWithCookie("/api/posts").then((r) => r.json());
  const bobsPost = bobView.find((p) => p.id === post.id);
  console.log("Bob's view of Alice's post — isOwnPost:", bobsPost.isOwnPost, "appliedByMe:", bobsPost.appliedByMe);

  // --- Test 2: Bob applies; Alice's open session should see the updated
  // application count live, without Alice reloading. ---
  const t1 = performance.now();
  const applyRes = await bob.fetchWithCookie(`/api/posts/${post.id}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ applicantName: "Bob" }),
  });
  const applyResult = await applyRes.json();
  await new Promise((r) => setTimeout(r, 400));

  const aliceSawCount = aliceEvents.find((e) => e.event === "application:count" && e.data.postId === post.id);
  console.log(
    "application:count reached Alice's session:",
    !!aliceSawCount,
    aliceSawCount ? `after ${(aliceSawCount.t - t1).toFixed(0)}ms` : "",
    "count:",
    aliceSawCount?.data.applicationCount,
  );

  // --- Test 3: concurrent applications from two distinct, unrelated
  // sessions to the same post both succeed (the C9 multi-user decision). ---
  const carol = makeSession("carol");
  const dave = makeSession("dave");
  const [carolApply, daveApply] = await Promise.all([
    carol.fetchWithCookie(`/api/posts/${post.id}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applicantName: "Carol" }),
    }),
    dave.fetchWithCookie(`/api/posts/${post.id}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applicantName: "Dave" }),
    }),
  ]);
  console.log("concurrent applies — Carol status:", carolApply.status, "Dave status:", daveApply.status);
  const finalCount = await alice.fetchWithCookie("/api/posts").then((r) => r.json());
  console.log("final application count after 3 distinct applicants:", finalCount.find((p) => p.id === post.id).applicationCount);

  // --- Test 4: a same session double-applying is rejected, post stays open
  // for everyone else (not auto-closed). ---
  const doubleApply = await bob.fetchWithCookie(`/api/posts/${post.id}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ applicantName: "Bob" }),
  });
  console.log("Bob double-applying status (expect 409):", doubleApply.status);

  // --- Test 5: reconnection behaviour — a brand new session that never had
  // an SSE connection open still sees fully authoritative current state on
  // its first GET, simulating "come back later / reconnect". ---
  const erin = makeSession("erin");
  const erinView = await erin.fetchWithCookie("/api/posts").then((r) => r.json());
  const erinsPost = erinView.find((p) => p.id === post.id);
  console.log(
    "late-joining session sees authoritative state — applicationCount:",
    erinsPost.applicationCount,
    "isOwnPost:",
    erinsPost.isOwnPost,
    "appliedByMe:",
    erinsPost.appliedByMe,
  );

  closeBob();
  closeAlice();
}

main().then(() => process.exit(0));
