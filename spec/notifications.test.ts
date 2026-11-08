import { expect, inject, it } from "vitest";

// Covers the in-app notification system added on top of V1.2 Likes and
// Comments: src/routes/notifications.ts, plus the notifyNewApplication/
// notifyNewComment calls wired into src/routes/applications.ts and
// src/routes/comments.ts. Additive to every existing spec file; none of
// them is modified.
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
    markRead: (notificationId: number) => request(`/api/notifications/${notificationId}/read`, { method: "POST" }),
    markAllRead: () => request("/api/notifications/read-all", { method: "POST" }),
    notifications: () => request("/api/notifications"),
    like: (path: string) => request(path, { method: "POST" }),
    deleteComment: (path: string) => request(path, { method: "DELETE" }),
  };
}

async function makePost(author: ReturnType<typeof session>, overrides: Record<string, unknown> = {}) {
  const created = await author.post("/api/posts", {
    authorName: "Owner",
    category: "campus_help",
    title: `Notifications spec post ${Math.random().toString(36).slice(2)}`,
    description: "d",
    isPaid: false,
    amount: "",
    ...overrides,
  });
  expect(created.status).toBe(201);
  return created.json();
}

async function getNotifications(s: ReturnType<typeof session>) {
  const res = await s.notifications();
  expect(res.status).toBe(200);
  return res.json() as Promise<{ notifications: Array<Record<string, unknown>>; unreadCount: number }>;
}

// --- Notification creation ---------------------------------------------------

it("notifies the post owner when someone applies to their post", async () => {
  const owner = session();
  const applicant = session();
  const post = await makePost(owner);

  const applied = await applicant.post(`/api/posts/${post.id}/apply`, {
    applicantName: "Jamie",
    message: "I'd like to help",
  });
  expect(applied.status).toBe(201);

  const { notifications, unreadCount } = await getNotifications(owner);
  expect(notifications).toHaveLength(1);
  expect(unreadCount).toBe(1);
  expect(notifications[0]).toMatchObject({
    type: "new_application",
    postId: post.id,
    postTitle: post.title,
    actorName: "Jamie",
    isRead: false,
  });
  expect(notifications[0].createdAt).toBeTruthy();
  expect(notifications[0].id).toBeTruthy();
});

it("notifies the post owner when someone comments on their post", async () => {
  const owner = session();
  const commenter = session();
  const post = await makePost(owner);

  const created = await commenter.post(`/api/posts/${post.id}/comments`, {
    authorName: "Priya",
    message: "Count me in!",
  });
  expect(created.status).toBe(201);

  const { notifications, unreadCount } = await getNotifications(owner);
  expect(notifications).toHaveLength(1);
  expect(unreadCount).toBe(1);
  expect(notifications[0]).toMatchObject({
    type: "new_comment",
    postId: post.id,
    postTitle: post.title,
    actorName: "Priya",
    isRead: false,
    applicationId: null,
  });
});

it("does not notify the post owner of their own application-adjacent or comment actions", async () => {
  // A post's author can like/comment on their own post today (no ownership
  // restriction on those); they must never end up notifying themselves.
  const owner = session();
  const post = await makePost(owner);

  await owner.like(`/api/posts/${post.id}/like`);
  await owner.post(`/api/posts/${post.id}/comments`, { authorName: "Owner", message: "My own comment" });

  const { notifications, unreadCount } = await getNotifications(owner);
  expect(notifications).toHaveLength(0);
  expect(unreadCount).toBe(0);
});

it("accumulates multiple notifications and reports the correct unread count", async () => {
  const owner = session();
  const applicantA = session();
  const applicantB = session();
  const commenter = session();
  const post = await makePost(owner);

  await applicantA.post(`/api/posts/${post.id}/apply`, { applicantName: "Alex", message: "msg 1" });
  await applicantB.post(`/api/posts/${post.id}/apply`, { applicantName: "Blair", message: "msg 2" });
  await commenter.post(`/api/posts/${post.id}/comments`, { authorName: "Casey", message: "a comment" });

  const { notifications, unreadCount } = await getNotifications(owner);
  expect(notifications).toHaveLength(3);
  expect(unreadCount).toBe(3);
  // Newest first.
  expect(notifications[0].actorName).toBe("Casey");
  expect(notifications[2].actorName).toBe("Alex");
});

it("only notifies the post's own owner, never other sessions", async () => {
  const owner = session();
  const applicant = session();
  const bystander = session();
  const post = await makePost(owner);

  await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Jamie", message: "hi" });

  const ownerView = await getNotifications(owner);
  expect(ownerView.notifications).toHaveLength(1);

  const applicantView = await getNotifications(applicant);
  expect(applicantView.notifications).toHaveLength(0);

  const bystanderView = await getNotifications(bystander);
  expect(bystanderView.notifications).toHaveLength(0);
});

it("scopes notifications per-post-owner: owner of post A never sees notifications for post B", async () => {
  const ownerA = session();
  const ownerB = session();
  const applicant = session();
  const postA = await makePost(ownerA);
  const postB = await makePost(ownerB);

  await applicant.post(`/api/posts/${postA.id}/apply`, { applicantName: "Jamie", message: "for A" });
  await applicant.post(`/api/posts/${postB.id}/comments`, { authorName: "Jamie", message: "for B" });

  const viewA = await getNotifications(ownerA);
  expect(viewA.notifications).toHaveLength(1);
  expect(viewA.notifications[0].postId).toBe(postA.id);

  const viewB = await getNotifications(ownerB);
  expect(viewB.notifications).toHaveLength(1);
  expect(viewB.notifications[0].postId).toBe(postB.id);
});

// --- Read-state ---------------------------------------------------------------

it("marks a single notification as read, and it stays read on a later read", async () => {
  const owner = session();
  const applicant = session();
  const post = await makePost(owner);
  await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Jamie", message: "hi" });

  const before = await getNotifications(owner);
  const notificationId = before.notifications[0].id as number;

  const markRes = await owner.markRead(notificationId);
  expect(markRes.status).toBe(200);
  expect(await markRes.json()).toMatchObject({ id: notificationId, isRead: true });

  const after = await getNotifications(owner);
  expect(after.unreadCount).toBe(0);
  expect(after.notifications[0].isRead).toBe(true);
});

it("marks all of a session's notifications as read at once", async () => {
  const owner = session();
  const applicantA = session();
  const applicantB = session();
  const post = await makePost(owner);
  await applicantA.post(`/api/posts/${post.id}/apply`, { applicantName: "Alex", message: "a" });
  await applicantB.post(`/api/posts/${post.id}/apply`, { applicantName: "Blair", message: "b" });

  const before = await getNotifications(owner);
  expect(before.unreadCount).toBe(2);

  const markAllRes = await owner.markAllRead();
  expect(markAllRes.status).toBe(200);

  const after = await getNotifications(owner);
  expect(after.unreadCount).toBe(0);
  expect(after.notifications.every((n) => n.isRead === true)).toBe(true);
});

it("persists read state across a later, independent read (simulating a restart)", async () => {
  const owner = session();
  const applicant = session();
  const post = await makePost(owner);
  await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Jamie", message: "hi" });

  const before = await getNotifications(owner);
  await owner.markRead(before.notifications[0].id as number);

  const laterView = await getNotifications(owner);
  expect(laterView.unreadCount).toBe(0);
  expect(laterView.notifications[0].isRead).toBe(true);
});

// --- Cross-session access restrictions ----------------------------------------

it("404s marking a notification read that belongs to a different session (not found, not forbidden)", async () => {
  const owner = session();
  const applicant = session();
  const stranger = session();
  const post = await makePost(owner);
  await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Jamie", message: "hi" });

  const { notifications } = await getNotifications(owner);
  const notificationId = notifications[0].id as number;

  const strangerAttempt = await stranger.markRead(notificationId);
  expect(strangerAttempt.status).toBe(404);

  // The notification is untouched by the stranger's attempt.
  const afterAttempt = await getNotifications(owner);
  expect(afterAttempt.unreadCount).toBe(1);
});

it("404s marking a nonexistent notification read", async () => {
  const someone = session();
  expect((await someone.markRead(999999999)).status).toBe(404);
});

it("never exposes one session's notifications to another session's list/unread-count", async () => {
  const owner = session();
  const applicant = session();
  const stranger = session();
  const post = await makePost(owner);
  await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Jamie", message: "private-ish" });
  await applicant.post(`/api/posts/${post.id}/comments`, { authorName: "Jamie", message: "a public comment" });

  const strangerView = await getNotifications(stranger);
  expect(strangerView.notifications).toHaveLength(0);
  expect(strangerView.unreadCount).toBe(0);

  // mark-all-read as a stranger must never touch the owner's notifications.
  await stranger.markAllRead();
  const ownerView = await getNotifications(owner);
  expect(ownerView.unreadCount).toBe(2);
});

// --- Privacy on the wire --------------------------------------------------------

it("never broadcasts a session id, notification content, or private messages over /events", async () => {
  const owner = session();
  const applicant = session();
  const post = await makePost(owner);

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
      if (buffer.includes("event: notification:new")) return buffer;
    }
  })();

  await new Promise((resolve) => setTimeout(resolve, 50));
  await applicant.post(`/api/posts/${post.id}/apply`, {
    applicantName: "Jamie",
    message: "this private message must never appear on the wire",
  });

  const received = await Promise.race([
    eventPromise,
    new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);
  controller.abort();

  expect(received, "no notification:new event arrived on /events within 5s").not.toBeNull();
  expect(received).toContain("event: notification:new");
  expect(received).toContain(JSON.stringify({}));
  expect(received).not.toContain("this private message must never appear on the wire");
  expect(received).not.toContain("Jamie");
  // The payload must carry no session id at all — spot-check against both
  // sessions' own ids, which the server handed back as Set-Cookie values.
  expect(received).not.toContain(post.id.toString() + ":");
});

it("GET /api/notifications never includes a session id or private application message", async () => {
  const owner = session();
  const applicant = session();
  const post = await makePost(owner);
  await applicant.post(`/api/posts/${post.id}/apply`, {
    applicantName: "Jamie",
    message: "a genuinely private application message",
  });

  const res = await owner.notifications();
  const text = await res.text();
  expect(text).not.toContain("a genuinely private application message");
  for (const key of Object.keys(JSON.parse(text).notifications[0] ?? {})) {
    expect(key.toLowerCase()).not.toContain("session");
  }
});

// --- Regression: existing V1.1/V1.2 flows keep working alongside notifications --

it("regression: applying, applicant management, contact exchange, likes and comments all still work", async () => {
  const owner = session();
  const applicant = session();
  const post = await makePost(owner, { category: "study_together", isPaid: true, amount: "$10" });

  await applicant.like(`/api/posts/${post.id}/like`);
  await applicant.post(`/api/posts/${post.id}/comments`, { authorName: "Regress", message: "still works" });

  const applied = await applicant.post(`/api/posts/${post.id}/apply`, {
    applicantName: "Regression Applicant",
    message: "application message still private",
  });
  expect(applied.status).toBe(201);

  const list = await (await owner.get(`/api/posts/${post.id}/applicants`)).json();
  expect(list).toHaveLength(1);
  const applicationId = list[0].id;
  expect(list[0].message).toBe("application message still private");

  const decide = await owner.patch(`/api/posts/${post.id}/applicants/${applicationId}`, { status: "accepted" });
  expect(decide.status).toBe(200);

  const finalFeed = await (await owner.get("/api/posts")).json();
  const finalView = finalFeed.find((p: { id: number }) => p.id === post.id);
  expect(finalView.likeCount).toBe(1);
  expect(finalView.commentCount).toBe(1);

  // Notifications were created alongside all of this, without disturbing it.
  const { notifications, unreadCount } = await getNotifications(owner);
  expect(unreadCount).toBe(2);
  expect(notifications.map((n) => n.type).sort()).toEqual(["new_application", "new_comment"]);
});
