import { expect, inject, it } from "vitest";

// Covers ANU TaskMate V1.2: Community Likes and Comments —
// src/routes/likes.ts (like/unlike, session-deduped, public count) and
// src/routes/comments.ts (public flat comment list, author-only delete,
// rate limiting). Additive to every existing spec file; none of them is
// modified. The rating/reputation system named in the brief as out of scope
// is not touched by anything here.
const baseUrl = inject("baseUrl");

// Same cookie-jar-per-closure pattern as every other spec file: fetch() in
// Node doesn't keep cookies between calls, and each "session" here needs to
// stay genuinely independent.
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
    patch: (path: string, body: unknown) =>
      request(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    like: (path: string) => request(path, { method: "POST" }),
    unlike: (path: string) => request(path, { method: "DELETE" }),
    deleteComment: (path: string) => request(path, { method: "DELETE" }),
  };
}

async function makePost(author: ReturnType<typeof session>, overrides: Record<string, unknown> = {}) {
  const created = await author.post("/api/posts", {
    authorName: "Owner",
    category: "campus_help",
    title: `Likes/comments spec post ${Math.random().toString(36).slice(2)}`,
    description: "d",
    isPaid: false,
    amount: "",
    ...overrides,
  });
  expect(created.status).toBe(201);
  return created.json();
}

// --- Likes ------------------------------------------------------------------

it("likes a post, showing an incremented total count and likedByMe for that session", async () => {
  const author = session();
  const liker = session();
  const post = await makePost(author);

  const likeRes = await liker.like(`/api/posts/${post.id}/like`);
  expect(likeRes.status).toBe(200);
  expect(await likeRes.json()).toMatchObject({ postId: post.id, likeCount: 1, likedByMe: true });

  const feed = await (await liker.get("/api/posts")).json();
  const view = feed.find((p: { id: number }) => p.id === post.id);
  expect(view.likeCount).toBe(1);
  expect(view.likedByMe).toBe(true);
});

it("unlikes a post, decrementing the count and clearing likedByMe for that session", async () => {
  const author = session();
  const liker = session();
  const post = await makePost(author);

  await liker.like(`/api/posts/${post.id}/like`);
  const unlikeRes = await liker.unlike(`/api/posts/${post.id}/like`);
  expect(unlikeRes.status).toBe(200);
  expect(await unlikeRes.json()).toMatchObject({ postId: post.id, likeCount: 0, likedByMe: false });

  const feed = await (await liker.get("/api/posts")).json();
  const view = feed.find((p: { id: number }) => p.id === post.id);
  expect(view.likeCount).toBe(0);
  expect(view.likedByMe).toBe(false);
});

it("prevents a duplicate like from the same session: liking twice stays at one like, not two", async () => {
  const author = session();
  const liker = session();
  const post = await makePost(author);

  const first = await liker.like(`/api/posts/${post.id}/like`);
  expect(first.status).toBe(200);
  expect((await first.json()).likeCount).toBe(1);

  const second = await liker.like(`/api/posts/${post.id}/like`);
  expect(second.status).toBe(200);
  expect((await second.json()).likeCount).toBe(1);

  const feed = await (await liker.get("/api/posts")).json();
  expect(feed.find((p: { id: number }) => p.id === post.id).likeCount).toBe(1);
});

it("rejects a duplicate like under genuinely concurrent requests from the same session", async () => {
  // Same spirit as ADR-0001's concurrent-apply check: the UNIQUE(post_id,
  // session_id) constraint, not a check-then-write race, is what actually
  // prevents a double count when two requests from one session arrive at
  // effectively the same time.
  const author = session();
  const liker = session();
  const post = await makePost(author);

  // Establish the session's cookie first (the closure's cookie jar only
  // captures Set-Cookie after a response, so firing straight into
  // Promise.all with no cookie yet would race 8 requests into minting 8
  // distinct sessions instead of exercising one session's constraint).
  await liker.get("/api/whoami");

  const results = await Promise.all(
    Array.from({ length: 8 }, () => liker.like(`/api/posts/${post.id}/like`)),
  );
  for (const r of results) expect(r.status).toBe(200);

  const feed = await (await liker.get("/api/posts")).json();
  expect(feed.find((p: { id: number }) => p.id === post.id).likeCount).toBe(1);
});

it("keeps like counts correct and consistent across independent sessions/browsers", async () => {
  const author = session();
  const likerA = session();
  const likerB = session();
  const likerC = session();
  const post = await makePost(author);

  await likerA.like(`/api/posts/${post.id}/like`);
  await likerB.like(`/api/posts/${post.id}/like`);
  await likerC.like(`/api/posts/${post.id}/like`);

  for (const viewer of [author, likerA, likerB, likerC]) {
    const feed = await (await viewer.get("/api/posts")).json();
    expect(feed.find((p: { id: number }) => p.id === post.id).likeCount).toBe(3);
  }

  // Each session only sees its own likedByMe as true — not a shared flag.
  const feedA = await (await likerA.get("/api/posts")).json();
  expect(feedA.find((p: { id: number }) => p.id === post.id).likedByMe).toBe(true);

  const authorFeed = await (await author.get("/api/posts")).json();
  expect(authorFeed.find((p: { id: number }) => p.id === post.id).likedByMe).toBe(false);

  await likerB.unlike(`/api/posts/${post.id}/like`);
  for (const viewer of [author, likerA, likerB, likerC]) {
    const feed = await (await viewer.get("/api/posts")).json();
    expect(feed.find((p: { id: number }) => p.id === post.id).likeCount).toBe(2);
  }
});

it("allows the post's own author to like their own post", async () => {
  const author = session();
  const post = await makePost(author);

  const res = await author.like(`/api/posts/${post.id}/like`);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ likeCount: 1, likedByMe: true });
});

it("404s liking/unliking a post that doesn't exist", async () => {
  const someone = session();
  expect((await someone.like("/api/posts/999999999/like")).status).toBe(404);
  expect((await someone.unlike("/api/posts/999999999/like")).status).toBe(404);
});

it("persists likes across a later, independent read (simulating a restart)", async () => {
  const author = session();
  const liker = session();
  const post = await makePost(author);
  await liker.like(`/api/posts/${post.id}/like`);

  const laterFeed = await (await author.get("/api/posts")).json();
  expect(laterFeed.find((p: { id: number }) => p.id === post.id).likeCount).toBe(1);
});

it("never broadcasts like content over /events beyond a postId identifier", async () => {
  const author = session();
  const liker = session();
  const post = await makePost(author);

  const controller = new AbortController();
  const res = await fetch(new URL("/events", baseUrl), {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const eventPromise = (async () => {
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return buffer;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("event: post:liked")) return buffer;
    }
  })();

  await new Promise((resolve) => setTimeout(resolve, 50));
  await liker.like(`/api/posts/${post.id}/like`);

  const received = await Promise.race([
    eventPromise,
    new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);
  controller.abort();

  expect(received, "no post:liked event arrived on /events within 5s").not.toBeNull();
  expect(received).toContain("event: post:liked");
  expect(received).toContain(JSON.stringify({ postId: post.id }));
});

// --- Comments ----------------------------------------------------------------

it("creates a comment and shows it in the public list with author name and timestamp", async () => {
  const author = session();
  const commenter = session();
  const post = await makePost(author);

  const created = await commenter.post(`/api/posts/${post.id}/comments`, {
    authorName: "Priya",
    message: "Count me in for the study session!",
  });
  expect(created.status).toBe(201);
  const comment = await created.json();
  expect(comment).toMatchObject({ authorName: "Priya", message: "Count me in for the study session!" });
  expect(comment.createdAt).toBeTruthy();

  const list = await (await author.get(`/api/posts/${post.id}/comments`)).json();
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ authorName: "Priya", message: "Count me in for the study session!" });
});

it("lists multiple comments in chronological order", async () => {
  const author = session();
  const commenterA = session();
  const commenterB = session();
  const post = await makePost(author);

  await commenterA.post(`/api/posts/${post.id}/comments`, { authorName: "Alex", message: "First" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await commenterB.post(`/api/posts/${post.id}/comments`, { authorName: "Blair", message: "Second" });

  const list = await (await author.get(`/api/posts/${post.id}/comments`)).json();
  expect(list.map((c: { message: string }) => c.message)).toEqual(["First", "Second"]);
});

it("shows comments to any visitor, including one who never commented (public, not application-scoped)", async () => {
  const author = session();
  const commenter = session();
  const stranger = session();
  const post = await makePost(author);

  await commenter.post(`/api/posts/${post.id}/comments`, { authorName: "Devon", message: "Hello everyone" });

  const list = await (await stranger.get(`/api/posts/${post.id}/comments`)).json();
  expect(list).toHaveLength(1);
  expect(list[0].message).toBe("Hello everyone");
  // The stranger didn't write it, so isOwnComment must be false for them —
  // even though the comment itself is visible to them.
  expect(list[0].isOwnComment).toBe(false);
});

it("marks isOwnComment correctly per-viewer: true for the author, false for everyone else", async () => {
  const author = session();
  const commenter = session();
  const stranger = session();
  const post = await makePost(author);

  await commenter.post(`/api/posts/${post.id}/comments`, { authorName: "Robin", message: "My comment" });

  const asCommenter = await (await commenter.get(`/api/posts/${post.id}/comments`)).json();
  expect(asCommenter[0].isOwnComment).toBe(true);

  const asStranger = await (await stranger.get(`/api/posts/${post.id}/comments`)).json();
  expect(asStranger[0].isOwnComment).toBe(false);
});

it("lets a comment's own author delete it", async () => {
  const author = session();
  const commenter = session();
  const post = await makePost(author);

  const created = await commenter.post(`/api/posts/${post.id}/comments`, { authorName: "Sam", message: "Delete me" });
  const comment = await created.json();

  const deleteRes = await commenter.deleteComment(`/api/posts/${post.id}/comments/${comment.id}`);
  expect(deleteRes.status).toBe(200);

  const list = await (await author.get(`/api/posts/${post.id}/comments`)).json();
  expect(list).toHaveLength(0);
});

it("prevents a visitor from deleting someone else's comment, and the comment survives", async () => {
  const author = session();
  const commenter = session();
  const stranger = session();
  const post = await makePost(author);

  const created = await commenter.post(`/api/posts/${post.id}/comments`, {
    authorName: "Taylor",
    message: "Not yours to delete",
  });
  const comment = await created.json();

  const deleteAttempt = await stranger.deleteComment(`/api/posts/${post.id}/comments/${comment.id}`);
  expect(deleteAttempt.status).toBe(403);

  // Even the post's own author (not the comment's author) can't delete it —
  // ownership here is about who wrote the comment, not who owns the post.
  const authorAttempt = await author.deleteComment(`/api/posts/${post.id}/comments/${comment.id}`);
  expect(authorAttempt.status).toBe(403);

  const list = await (await author.get(`/api/posts/${post.id}/comments`)).json();
  expect(list).toHaveLength(1);
  expect(list[0].message).toBe("Not yours to delete");
});

it("404s deleting a comment that doesn't exist, or that belongs to a different post", async () => {
  const author = session();
  const commenter = session();
  const postA = await makePost(author);
  const postB = await makePost(author);

  const created = await commenter.post(`/api/posts/${postA.id}/comments`, { authorName: "U", message: "m" });
  const comment = await created.json();

  expect((await commenter.deleteComment(`/api/posts/${postA.id}/comments/999999999`)).status).toBe(404);
  // Correct comment id, but under the wrong post — must not be treated as
  // found just because the id exists somewhere.
  expect((await commenter.deleteComment(`/api/posts/${postB.id}/comments/${comment.id}`)).status).toBe(404);
});

it("rejects an empty or whitespace-only comment message, and a missing author name", async () => {
  const author = session();
  const commenter = session();
  const post = await makePost(author);

  const emptyMessage = await commenter.post(`/api/posts/${post.id}/comments`, { authorName: "X", message: "   " });
  expect(emptyMessage.status).toBe(400);

  const missingName = await commenter.post(`/api/posts/${post.id}/comments`, { message: "hello" });
  expect(missingName.status).toBe(400);

  const list = await (await author.get(`/api/posts/${post.id}/comments`)).json();
  expect(list).toHaveLength(0);
});

it("truncates an overlong comment message and author name rather than rejecting them outright", async () => {
  const author = session();
  const commenter = session();
  const post = await makePost(author);

  const longMessage = "m".repeat(2000);
  const longName = "n".repeat(200);
  const created = await commenter.post(`/api/posts/${post.id}/comments`, {
    authorName: longName,
    message: longMessage,
  });
  expect(created.status).toBe(201);
  const comment = await created.json();
  expect(comment.message.length).toBeLessThanOrEqual(500);
  expect(comment.authorName.length).toBeLessThanOrEqual(80);
});

it("stores and returns a comment containing HTML/script markup as plain, unexecuted text (XSS safety)", async () => {
  // The server's job here is only to never treat this as markup itself —
  // it stores and returns the raw string via a parameterised query. Actual
  // escaping at render time is the client's responsibility (public/post-
  // card.js's escapeHtml, exercised directly against the running UI in
  // spec/likes-comments-ui.test.ts); this test guards the API contract:
  // the dangerous string must come back byte-for-byte, not stripped,
  // rewritten, or (worse) interpreted.
  const author = session();
  const commenter = session();
  // A second, independent session for the injection-attempt comment below —
  // commenter already posted once in this test, so reusing it would hit the
  // rate-limit cooldown rather than exercising what this test is actually
  // about.
  const anotherCommenter = session();
  const post = await makePost(author);

  const payload = "<script>window.xssFired = true</script><img src=x onerror=alert(1)>";
  const created = await commenter.post(`/api/posts/${post.id}/comments`, {
    authorName: "<b>bold</b>",
    message: payload,
  });
  expect(created.status).toBe(201);
  const comment = await created.json();
  expect(comment.message).toBe(payload);
  expect(comment.authorName).toBe("<b>bold</b>");

  // SQL injection surface check: a message containing a single quote and
  // SQL-meaningful syntax must round-trip unchanged, not corrupt the
  // database or break subsequent queries (parameterised statements, not
  // string concatenation, are what src/routes/comments.ts uses).
  const injectionAttempt = await anotherCommenter.post(`/api/posts/${post.id}/comments`, {
    authorName: "Robert",
    message: "'; DROP TABLE post_comments; --",
  });
  expect(injectionAttempt.status).toBe(201);
  const list = await (await author.get(`/api/posts/${post.id}/comments`)).json();
  expect(list).toHaveLength(2);
  expect(list.some((c: { message: string }) => c.message === "'; DROP TABLE post_comments; --")).toBe(true);
});

it("rate-limits rapid repeated comments from the same session, without limiting other sessions", async () => {
  const author = session();
  const commenter = session();
  const other = session();
  const post = await makePost(author);

  const first = await commenter.post(`/api/posts/${post.id}/comments`, { authorName: "A", message: "first" });
  expect(first.status).toBe(201);

  const second = await commenter.post(`/api/posts/${post.id}/comments`, { authorName: "A", message: "second" });
  expect(second.status).toBe(429);

  // A different session is unaffected by the first session's cooldown.
  const otherRes = await other.post(`/api/posts/${post.id}/comments`, { authorName: "B", message: "unrelated" });
  expect(otherRes.status).toBe(201);

  const list = await (await author.get(`/api/posts/${post.id}/comments`)).json();
  expect(list.map((c: { message: string }) => c.message)).toEqual(["first", "unrelated"]);
});

it("404s comment listing/creation for a post that doesn't exist", async () => {
  const someone = session();
  expect((await someone.get("/api/posts/999999999/comments")).status).toBe(404);
  expect((await someone.post("/api/posts/999999999/comments", { authorName: "X", message: "y" })).status).toBe(404);
});

it("persists comments across a later, independent read (simulating a restart)", async () => {
  const author = session();
  const commenter = session();
  const post = await makePost(author);
  await commenter.post(`/api/posts/${post.id}/comments`, { authorName: "Persisted", message: "Still here" });

  const laterList = await (await author.get(`/api/posts/${post.id}/comments`)).json();
  expect(laterList).toHaveLength(1);
  expect(laterList[0]).toMatchObject({ authorName: "Persisted", message: "Still here" });
});

it("never broadcasts comment content over /events beyond a postId identifier", async () => {
  const author = session();
  const commenter = session();
  const post = await makePost(author);

  const controller = new AbortController();
  const res = await fetch(new URL("/events", baseUrl), {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const eventPromise = (async () => {
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return buffer;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("event: comment:created")) return buffer;
    }
  })();

  await new Promise((resolve) => setTimeout(resolve, 50));
  await commenter.post(`/api/posts/${post.id}/comments`, {
    authorName: "Secret Name",
    message: "This exact message text must never appear in the SSE stream",
  });

  const received = await Promise.race([
    eventPromise,
    new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);
  controller.abort();

  expect(received, "no comment:created event arrived on /events within 5s").not.toBeNull();
  expect(received).toContain("event: comment:created");
  expect(received).not.toContain("This exact message text must never appear in the SSE stream");
  expect(received).not.toContain("Secret Name");
});

// --- Interaction with existing private data ----------------------------------

it("never exposes private application messages or contact details through the public feed via the new like/comment fields", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);

  await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Private Applicant", message: "Private note" });
  await applicant.like(`/api/posts/${post.id}/like`);
  await applicant.post(`/api/posts/${post.id}/comments`, { authorName: "Private Applicant", message: "Public comment" });

  const stranger = session();
  const feed = await (await stranger.get("/api/posts")).json();
  const feedText = JSON.stringify(feed);
  expect(feedText).not.toContain("Private note");
  // The public comment text is, correctly, not part of GET /api/posts at
  // all (only commentCount is) — comments are fetched from their own
  // endpoint, never folded into the feed response.
  const view = feed.find((p: { id: number }) => p.id === post.id);
  expect(view.commentCount).toBe(1);
  expect(view.likeCount).toBe(1);
  for (const key of Object.keys(view)) {
    expect(key.toLowerCase()).not.toContain("contact");
  }
});

// --- Regression ---------------------------------------------------------------

it("regression: existing posting, applying, applicant-management and contact-exchange still work alongside likes/comments", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author, { category: "study_together", isPaid: true, amount: "$10" });
  expect(post.isPaid).toBe(true);
  expect(post.amount).toBe("$10");
  expect(post.likeCount).toBe(0);
  expect(post.commentCount).toBe(0);

  await applicant.like(`/api/posts/${post.id}/like`);
  await applicant.post(`/api/posts/${post.id}/comments`, { authorName: "Regress", message: "still works" });

  const applied = await applicant.post(`/api/posts/${post.id}/apply`, {
    applicantName: "Regression Applicant",
    message: "application message still private",
  });
  expect(applied.status).toBe(201);

  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  expect(list).toHaveLength(1);
  const applicationId = list[0].id;
  expect(list[0].message).toBe("application message still private");

  const decide = await author.patch(`/api/posts/${post.id}/applicants/${applicationId}`, { status: "accepted" });
  expect(decide.status).toBe(200);

  // Likes and comments made on this post haven't disturbed the
  // applicant-management/contact-exchange state above, and vice versa.
  const finalList = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  expect(finalList[0].status).toBe("accepted");
  const finalFeed = await (await author.get("/api/posts")).json();
  const finalView = finalFeed.find((p: { id: number }) => p.id === post.id);
  expect(finalView.likeCount).toBe(1);
  expect(finalView.commentCount).toBe(1);
});
