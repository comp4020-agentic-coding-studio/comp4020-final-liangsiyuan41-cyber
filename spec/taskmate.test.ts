import { expect, inject, it } from "vitest";

// Additive to invariants.test.ts — covers the C9 feature set itself: the
// post/apply round trip, session isolation, the multi-user concurrency
// decision (concurrent applies all succeed, a post never auto-closes, the
// same session can't double-apply), and that a change is actually announced
// over SSE. invariants.test.ts stays untouched; these are TaskMate's own.
const baseUrl = inject("baseUrl");

// fetch() in Node doesn't keep a cookie jar between calls, and the two
// sessions in these tests need to stay genuinely independent, so each
// "session" is just a small closure remembering whatever Set-Cookie it last
// saw and sending it back.
function session() {
  let cookie: string | undefined;

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(new URL(path, baseUrl), {
      ...init,
      headers: { ...init.headers, ...(cookie ? { cookie } : {}) },
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return res;
  }

  return {
    get: (path: string) => request(path),
    post: (path: string, body: unknown) =>
      request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

it("two independent sessions see each other's post and can both apply to it", async () => {
  const author = session();
  const applicant = session();

  const created = await author.post("/api/posts", {
    authorName: "Alice",
    category: "campus_help",
    title: `Spec test post ${Math.random().toString(36).slice(2)}`,
    description: "Needs a hand with something",
    isPaid: false,
    amount: "",
  });
  expect(created.status).toBe(201);
  const post = await created.json();

  // The author's own view: it's their post, they haven't applied to it.
  const authorFeed = await (await author.get("/api/posts")).json();
  const ownView = authorFeed.find((p: { id: number }) => p.id === post.id);
  expect(ownView.isOwnPost).toBe(true);
  expect(ownView.appliedByMe).toBe(false);

  // A different session applies — this is the C9 decision: applying doesn't
  // close the post to anyone else.
  const applied = await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Bob" });
  expect(applied.status).toBe(201);
  const { applicationCount } = await applied.json();
  expect(applicationCount).toBe(1);

  const applicantFeed = await (await applicant.get("/api/posts")).json();
  const applicantView = applicantFeed.find((p: { id: number }) => p.id === post.id);
  expect(applicantView.isOwnPost).toBe(false);
  expect(applicantView.appliedByMe).toBe(true);
  expect(applicantView.applicationCount).toBe(1);
});

it("rejects a second apply from the same session, but never closes the post", async () => {
  const author = session();
  const applicant = session();

  const created = await author.post("/api/posts", {
    authorName: "Carol",
    category: "study_together",
    title: `Spec test post ${Math.random().toString(36).slice(2)}`,
    description: "Study group for finals",
    isPaid: false,
    amount: "",
  });
  const post = await created.json();

  const first = await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Dave" });
  expect(first.status).toBe(201);

  const second = await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Dave" });
  expect(second.status).toBe(409);
  const body = await second.json();
  // Rejected, but the post is still open — the count it reports is unchanged,
  // and a third, distinct session can still apply right after.
  expect(body.applicationCount).toBe(1);

  const another = session();
  const third = await another.post(`/api/posts/${post.id}/apply`, { applicantName: "Erin" });
  expect(third.status).toBe(201);
  expect((await third.json()).applicationCount).toBe(2);
});

it("rejects applying to a post that doesn't exist", async () => {
  const applicant = session();
  const res = await applicant.post("/api/posts/999999999/apply", { applicantName: "Nobody" });
  expect(res.status).toBe(404);
});

it("broadcasts a post:created event over /events when a post is made", async () => {
  const controller = new AbortController();
  const res = await fetch(new URL("/events", baseUrl), {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  const eventPromise = (async () => {
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("event: post:created")) return buffer;
    }
  })();

  // Give the stream a moment to register as an open client before posting,
  // same as app.js does in practice.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const author = session();
  const created = await author.post("/api/posts", {
    authorName: "Fiona",
    category: "social_connect",
    title: `Spec test post ${Math.random().toString(36).slice(2)}`,
    description: "Looking for coffee chat buddies",
    isPaid: false,
    amount: "",
  });
  expect(created.status).toBe(201);

  const received = await Promise.race([
    eventPromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);
  controller.abort();

  expect(received, "no post:created event arrived on /events within 5s").not.toBeNull();
  expect(received).toContain("event: post:created");
});
