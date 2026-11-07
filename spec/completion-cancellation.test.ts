import { expect, inject, it } from "vitest";

// Covers Individual Participation Completion and Cancellation: the
// pending -> accepted/declined -> completed/cancelled state machine, author-only
// completion, applicant-only cancellation requests, author approval of a
// cancellation (or direct cancellation with no request), independent handling
// of multiple accepted participants, persistence, and the application:status
// SSE signal. Additive to applicants.test.ts and taskmate.test.ts — neither
// file is modified.
const baseUrl = inject("baseUrl");

// Same cookie-jar-per-closure pattern as the other spec files: fetch() in
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
  };
}

async function makePost(author: ReturnType<typeof session>, overrides: Record<string, unknown> = {}) {
  const created = await author.post("/api/posts", {
    authorName: "Owner",
    category: "campus_help",
    title: `Completion spec post ${Math.random().toString(36).slice(2)}`,
    description: "Needs a hand",
    isPaid: false,
    amount: "",
    ...overrides,
  });
  expect(created.status).toBe(201);
  return created.json();
}

// Helper: applicant applies, author accepts, returns the application id.
async function makeAcceptedApplication(
  author: ReturnType<typeof session>,
  applicant: ReturnType<typeof session>,
  postId: number,
  applicantName: string,
) {
  await applicant.post(`/api/posts/${postId}/apply`, { applicantName });
  const list = await (await author.get(`/api/posts/${postId}/applicants`)).json();
  const application = list.find((a: { applicantName: string }) => a.applicantName === applicantName);
  const decide = await author.patch(`/api/posts/${postId}/applicants/${application.id}`, { status: "accepted" });
  expect(decide.status).toBe(200);
  return application.id as number;
}

it("allows pending -> accepted -> completed and rejects completing a pending application", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);

  await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Pat" });
  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  const applicationId = list[0].id;

  // Pending cannot jump straight to completed or cancelled.
  const directComplete = await author.patch(`/api/posts/${post.id}/applicants/${applicationId}`, {
    status: "completed",
  });
  expect(directComplete.status).toBe(400);
  const directCancel = await author.patch(`/api/posts/${post.id}/applicants/${applicationId}`, {
    status: "cancelled",
  });
  expect(directCancel.status).toBe(400);

  await author.patch(`/api/posts/${post.id}/applicants/${applicationId}`, { status: "accepted" });

  const complete = await author.patch(`/api/posts/${post.id}/applicants/${applicationId}`, { status: "completed" });
  expect(complete.status).toBe(200);
  expect(await complete.json()).toMatchObject({ id: applicationId, postId: post.id, status: "completed" });

  const reread = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  expect(reread.find((a: { id: number }) => a.id === applicationId).status).toBe("completed");
});

it("rejects transitions out of terminal states (completed, cancelled, declined)", async () => {
  const author = session();
  const bob = session();
  const carol = session();
  const dave = session();
  const post = await makePost(author);

  // declined is terminal.
  await bob.post(`/api/posts/${post.id}/apply`, { applicantName: "Bob" });
  let list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  const bobId = list.find((a: { applicantName: string }) => a.applicantName === "Bob").id;
  await author.patch(`/api/posts/${post.id}/applicants/${bobId}`, { status: "declined" });
  const bobAccept = await author.patch(`/api/posts/${post.id}/applicants/${bobId}`, { status: "accepted" });
  expect(bobAccept.status).toBe(400);

  // completed is terminal.
  const carolId = await makeAcceptedApplication(author, carol, post.id, "Carol");
  await author.patch(`/api/posts/${post.id}/applicants/${carolId}`, { status: "completed" });
  const carolCancel = await author.patch(`/api/posts/${post.id}/applicants/${carolId}`, { status: "cancelled" });
  expect(carolCancel.status).toBe(400);

  // cancelled is terminal.
  const daveId = await makeAcceptedApplication(author, dave, post.id, "Dave");
  await author.patch(`/api/posts/${post.id}/applicants/${daveId}`, { status: "cancelled" });
  const daveComplete = await author.patch(`/api/posts/${post.id}/applicants/${daveId}`, { status: "completed" });
  expect(daveComplete.status).toBe(400);

  list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  expect(list.find((a: { id: number }) => a.id === bobId).status).toBe("declined");
  expect(list.find((a: { id: number }) => a.id === carolId).status).toBe("completed");
  expect(list.find((a: { id: number }) => a.id === daveId).status).toBe("cancelled");
});

it("only the post author can mark an accepted participant completed", async () => {
  const author = session();
  const applicant = session();
  const stranger = session();
  const post = await makePost(author);

  const applicationId = await makeAcceptedApplication(author, applicant, post.id, "Erin");

  const strangerAttempt = await stranger.patch(`/api/posts/${post.id}/applicants/${applicationId}`, {
    status: "completed",
  });
  expect(strangerAttempt.status).toBe(403);

  const applicantAttempt = await applicant.patch(`/api/posts/${post.id}/applicants/${applicationId}`, {
    status: "completed",
  });
  expect(applicantAttempt.status).toBe(403);

  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  expect(list.find((a: { id: number }) => a.id === applicationId).status).toBe("accepted");

  const authorAttempt = await author.patch(`/api/posts/${post.id}/applicants/${applicationId}`, {
    status: "completed",
  });
  expect(authorAttempt.status).toBe(200);
});

it("only the applicant themself can request cancellation of their own accepted application", async () => {
  const author = session();
  const applicant = session();
  const stranger = session();
  const post = await makePost(author);

  await makeAcceptedApplication(author, applicant, post.id, "Frank");

  // A stranger with no application on this post can't request cancellation.
  const strangerAttempt = await stranger.post(`/api/posts/${post.id}/cancellation-request`, {});
  expect(strangerAttempt.status).toBe(404);

  // The author isn't the applicant either, and has no application of their own here.
  const authorAttempt = await author.post(`/api/posts/${post.id}/cancellation-request`, {});
  expect(authorAttempt.status).toBe(404);

  const applicantAttempt = await applicant.post(`/api/posts/${post.id}/cancellation-request`, {
    reason: "Schedule conflict",
  });
  expect(applicantAttempt.status).toBe(200);
  expect(await applicantAttempt.json()).toMatchObject({ postId: post.id, cancellationRequested: true });

  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  const app = list.find((a: { applicantName: string }) => a.applicantName === "Frank");
  expect(app.cancellationRequested).toBe(true);
  expect(app.cancellationReason).toBe("Schedule conflict");
  // The request alone must not look like an already-resolved cancellation.
  expect(app.status).toBe("accepted");
});

it("rejects a cancellation request for a pending (not yet accepted) application", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);

  await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Grace" });

  const res = await applicant.post(`/api/posts/${post.id}/cancellation-request`, {});
  expect(res.status).toBe(400);
});

it("lets the author approve a cancellation request, moving the application to cancelled", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);

  const applicationId = await makeAcceptedApplication(author, applicant, post.id, "Hank");
  await applicant.post(`/api/posts/${post.id}/cancellation-request`, { reason: "Can't make it" });

  const approve = await author.patch(`/api/posts/${post.id}/applicants/${applicationId}`, { status: "cancelled" });
  expect(approve.status).toBe(200);

  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  const app = list.find((a: { id: number }) => a.id === applicationId);
  expect(app.status).toBe("cancelled");
  // Nothing left to approve once resolved.
  expect(app.cancellationRequested).toBe(false);

  const applicantFeed = await (await applicant.get("/api/posts")).json();
  const applicantView = applicantFeed.find((p: { id: number }) => p.id === post.id);
  expect(applicantView.myApplicationStatus).toBe("cancelled");
});

it("lets the author cancel an accepted participant directly, with no prior request", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);

  const applicationId = await makeAcceptedApplication(author, applicant, post.id, "Ivy");

  const cancel = await author.patch(`/api/posts/${post.id}/applicants/${applicationId}`, { status: "cancelled" });
  expect(cancel.status).toBe(200);

  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  const app = list.find((a: { id: number }) => a.id === applicationId);
  expect(app.status).toBe("cancelled");
  expect(app.cancellationRequested).toBe(false);
});

it("completes one accepted participant without affecting another's independent completion or cancellation", async () => {
  const author = session();
  const bob = session();
  const carol = session();
  const dave = session();
  const post = await makePost(author);

  const bobId = await makeAcceptedApplication(author, bob, post.id, "Bob");
  const carolId = await makeAcceptedApplication(author, carol, post.id, "Carol");
  const daveId = await makeAcceptedApplication(author, dave, post.id, "Dave");

  await author.patch(`/api/posts/${post.id}/applicants/${bobId}`, { status: "completed" });

  let list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  expect(list.find((a: { id: number }) => a.id === bobId).status).toBe("completed");
  expect(list.find((a: { id: number }) => a.id === carolId).status).toBe("accepted");
  expect(list.find((a: { id: number }) => a.id === daveId).status).toBe("accepted");

  await carol.post(`/api/posts/${post.id}/cancellation-request`, { reason: "No longer needed" });
  await author.patch(`/api/posts/${post.id}/applicants/${carolId}`, { status: "cancelled" });
  await author.patch(`/api/posts/${post.id}/applicants/${daveId}`, { status: "completed" });

  list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  expect(list.find((a: { id: number }) => a.id === bobId).status).toBe("completed");
  expect(list.find((a: { id: number }) => a.id === carolId).status).toBe("cancelled");
  expect(list.find((a: { id: number }) => a.id === daveId).status).toBe("completed");
});

it("rejects cancellation-request and decision calls for a post that doesn't exist", async () => {
  const someone = session();
  const cancelRes = await someone.post("/api/posts/999999999/cancellation-request", {});
  expect(cancelRes.status).toBe(404);

  const decideRes = await someone.patch("/api/posts/999999999/applicants/1", { status: "completed" });
  expect(decideRes.status).toBe(404);
});

it("persists completed and cancelled statuses for a later read (simulating a restart)", async () => {
  const author = session();
  const bob = session();
  const carol = session();
  const post = await makePost(author);

  const bobId = await makeAcceptedApplication(author, bob, post.id, "Bob");
  const carolId = await makeAcceptedApplication(author, carol, post.id, "Carol");
  await author.patch(`/api/posts/${post.id}/applicants/${bobId}`, { status: "completed" });
  await author.patch(`/api/posts/${post.id}/applicants/${carolId}`, { status: "cancelled" });

  // A later, independent read (same shape as what a server restart would
  // need to still answer correctly from SQLite) shows the same statuses.
  const laterList = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  expect(laterList.find((a: { id: number }) => a.id === bobId).status).toBe("completed");
  expect(laterList.find((a: { id: number }) => a.id === carolId).status).toBe("cancelled");
});

it("broadcasts application:status over /events when a participant is completed or cancelled", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);
  const applicationId = await makeAcceptedApplication(author, applicant, post.id, "Judy");

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
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("event: application:status")) return buffer;
    }
  })();

  await new Promise((resolve) => setTimeout(resolve, 50));

  const t0 = performance.now();
  const complete = await author.patch(`/api/posts/${post.id}/applicants/${applicationId}`, { status: "completed" });
  expect(complete.status).toBe(200);

  const received = await Promise.race([
    eventPromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);
  const elapsedMs = performance.now() - t0;
  controller.abort();

  expect(received, "no application:status event arrived on /events within 5s").not.toBeNull();
  // "within approximately one second" per the brief.
  expect(elapsedMs).toBeLessThan(1000);
});

it("broadcasts application:status over /events when an applicant requests cancellation", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);
  await makeAcceptedApplication(author, applicant, post.id, "Karl");

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
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("event: application:status")) return buffer;
    }
  })();

  await new Promise((resolve) => setTimeout(resolve, 50));

  const t0 = performance.now();
  const request = await applicant.post(`/api/posts/${post.id}/cancellation-request`, { reason: "Private reason" });
  expect(request.status).toBe(200);

  const received = await Promise.race([
    eventPromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);
  const elapsedMs = performance.now() - t0;
  controller.abort();

  expect(received, "no application:status event arrived on /events within 5s").not.toBeNull();
  expect(elapsedMs).toBeLessThan(1000);
  // Broadcasts carry only an identifier, never the private reason — see
  // ADR 0001 and src/routes/applications.ts.
  expect(received).not.toContain("Private reason");
});

it("regression: existing C9 and applicant-management behaviour still works", async () => {
  const author = session();
  const applicant = session();

  const created = await author.post("/api/posts", {
    authorName: "Regression Author 2",
    category: "social_connect",
    title: `Completion regression post ${Math.random().toString(36).slice(2)}`,
    description: "Still works",
    isPaid: false,
    amount: "",
  });
  expect(created.status).toBe(201);
  const post = await created.json();

  const applied = await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Regression Applicant 2" });
  expect(applied.status).toBe(201);

  const second = await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Regression Applicant 2" });
  expect(second.status).toBe(409);

  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  expect(list).toHaveLength(1);
  expect(list[0].status).toBe("pending");
  expect(list[0].cancellationRequested).toBe(false);

  const decline = await author.patch(`/api/posts/${post.id}/applicants/${list[0].id}`, { status: "declined" });
  expect(decline.status).toBe(200);

  const feed = await (await applicant.get("/api/posts")).json();
  const view = feed.find((p: { id: number }) => p.id === post.id);
  expect(view.myApplicationStatus).toBe("declined");
  expect(view.myCancellationRequested).toBe(false);
});
