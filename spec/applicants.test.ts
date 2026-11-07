import { expect, inject, it } from "vitest";

// Covers the Applicant Management and Acceptance feature: the author-only
// applicant list, accept/decline decisions, ownership enforcement, status
// persistence, multiple-accepted-applicants, and the application:status SSE
// signal. Additive to taskmate.test.ts — that file's C9 coverage (posting,
// applying, concurrency, post:created broadcast) is untouched.
const baseUrl = inject("baseUrl");

// Same cookie-jar-per-closure pattern as taskmate.test.ts: fetch() in Node
// doesn't keep cookies between calls, and each "session" here needs to stay
// genuinely independent.
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
    title: `Applicant spec post ${Math.random().toString(36).slice(2)}`,
    description: "Needs some applicants",
    isPaid: false,
    amount: "",
    ...overrides,
  });
  expect(created.status).toBe(201);
  return created.json();
}

it("every new application starts pending", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);

  const applied = await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Pending Pat" });
  expect(applied.status).toBe(201);

  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ applicantName: "Pending Pat", status: "pending" });
});

it("the post author can view all applicants with their names and statuses", async () => {
  const author = session();
  const bob = session();
  const carol = session();
  const post = await makePost(author);

  await bob.post(`/api/posts/${post.id}/apply`, { applicantName: "Bob" });
  await carol.post(`/api/posts/${post.id}/apply`, { applicantName: "Carol" });

  const res = await author.get(`/api/posts/${post.id}/applicants`);
  expect(res.status).toBe(200);
  const list = await res.json();
  expect(list.map((a: { applicantName: string }) => a.applicantName).sort()).toEqual(["Bob", "Carol"]);
  for (const a of list) expect(a.status).toBe("pending");
});

it("denies a non-author access to the applicant list and to decisions", async () => {
  const author = session();
  const applicant = session();
  const stranger = session();
  const post = await makePost(author);

  const applied = await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Dana" });
  const { applicationCount } = await applied.json();
  expect(applicationCount).toBe(1);

  const listRes = await stranger.get(`/api/posts/${post.id}/applicants`);
  expect(listRes.status).toBe(403);

  // Even the applicant themself — not the author — can't see the full list
  // or decide on it.
  const applicantListRes = await applicant.get(`/api/posts/${post.id}/applicants`);
  expect(applicantListRes.status).toBe(403);

  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  const applicationId = list[0].id;

  const decideRes = await stranger.patch(`/api/posts/${post.id}/applicants/${applicationId}`, {
    status: "accepted",
  });
  expect(decideRes.status).toBe(403);

  // The status truly never moved.
  const after = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  expect(after[0].status).toBe("pending");
});

it("lets the author accept an applicant, and the decision persists", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);

  await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Erin" });
  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  const applicationId = list[0].id;

  const decide = await author.patch(`/api/posts/${post.id}/applicants/${applicationId}`, { status: "accepted" });
  expect(decide.status).toBe(200);
  expect(await decide.json()).toMatchObject({ id: applicationId, postId: post.id, status: "accepted" });

  // Persistence: a fresh read (simulating a reload) shows the same status.
  const reread = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  expect(reread.find((a: { id: number }) => a.id === applicationId).status).toBe("accepted");

  // The applicant's own session sees their status via GET /api/posts.
  const applicantFeed = await (await applicant.get("/api/posts")).json();
  const applicantView = applicantFeed.find((p: { id: number }) => p.id === post.id);
  expect(applicantView.appliedByMe).toBe(true);
  expect(applicantView.myApplicationStatus).toBe("accepted");
});

it("lets the author decline an applicant, and the decision persists", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);

  await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Frank" });
  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  const applicationId = list[0].id;

  const decide = await author.patch(`/api/posts/${post.id}/applicants/${applicationId}`, { status: "declined" });
  expect(decide.status).toBe(200);

  const reread = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  expect(reread.find((a: { id: number }) => a.id === applicationId).status).toBe("declined");

  const applicantFeed = await (await applicant.get("/api/posts")).json();
  const applicantView = applicantFeed.find((p: { id: number }) => p.id === post.id);
  expect(applicantView.myApplicationStatus).toBe("declined");
});

it("accepting one applicant never changes another applicant's status", async () => {
  const author = session();
  const bob = session();
  const carol = session();
  const post = await makePost(author);

  await bob.post(`/api/posts/${post.id}/apply`, { applicantName: "Bob" });
  await carol.post(`/api/posts/${post.id}/apply`, { applicantName: "Carol" });

  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  const bobApp = list.find((a: { applicantName: string }) => a.applicantName === "Bob");
  const carolApp = list.find((a: { applicantName: string }) => a.applicantName === "Carol");

  await author.patch(`/api/posts/${post.id}/applicants/${bobApp.id}`, { status: "accepted" });

  const afterOne = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  expect(afterOne.find((a: { id: number }) => a.id === bobApp.id).status).toBe("accepted");
  expect(afterOne.find((a: { id: number }) => a.id === carolApp.id).status).toBe("pending");

  // Accepting a second applicant too must succeed and leave the first intact
  // — the product decision explicitly allows multiple accepted applicants.
  await author.patch(`/api/posts/${post.id}/applicants/${carolApp.id}`, { status: "accepted" });

  const afterBoth = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  expect(afterBoth.find((a: { id: number }) => a.id === bobApp.id).status).toBe("accepted");
  expect(afterBoth.find((a: { id: number }) => a.id === carolApp.id).status).toBe("accepted");
});

it("rejects a decision on an application id that belongs to a different post", async () => {
  const author = session();
  const otherAuthor = session();
  const applicant = session();

  const postA = await makePost(author);
  const postB = await makePost(otherAuthor);
  await applicant.post(`/api/posts/${postA.id}/apply`, { applicantName: "Grace" });

  const listA = await (await author.get(`/api/posts/${postA.id}/applicants`)).json();
  const applicationId = listA[0].id;

  // postB's author trying to decide an application that belongs to postA.
  const res = await otherAuthor.patch(`/api/posts/${postB.id}/applicants/${applicationId}`, {
    status: "accepted",
  });
  expect(res.status).toBe(404);
});

it("rejects an invalid status value and setting status back to pending", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);

  await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Hank" });
  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  const applicationId = list[0].id;

  const bogus = await author.patch(`/api/posts/${post.id}/applicants/${applicationId}`, { status: "bogus" });
  expect(bogus.status).toBe(400);

  const toPending = await author.patch(`/api/posts/${post.id}/applicants/${applicationId}`, { status: "pending" });
  expect(toPending.status).toBe(400);
});

it("404s applicant list and decisions for a post that doesn't exist", async () => {
  const someone = session();
  const listRes = await someone.get("/api/posts/999999999/applicants");
  expect(listRes.status).toBe(404);

  const decideRes = await someone.patch("/api/posts/999999999/applicants/1", { status: "accepted" });
  expect(decideRes.status).toBe(404);
});

it("broadcasts application:status over /events when the author decides", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);
  await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Ivy" });
  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  const applicationId = list[0].id;

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
  const decide = await author.patch(`/api/posts/${post.id}/applicants/${applicationId}`, { status: "accepted" });
  expect(decide.status).toBe(200);

  const received = await Promise.race([
    eventPromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);
  const elapsedMs = performance.now() - t0;
  controller.abort();

  expect(received, "no application:status event arrived on /events within 5s").not.toBeNull();
  expect(received).toContain("event: application:status");
  // "within approximately one second" per the brief; SSE delivery itself is
  // near-instant, this just guards against a regression that stops firing.
  expect(elapsedMs).toBeLessThan(1000);
});

it("regression: C9 posting and applying still work alongside applicant management", async () => {
  const author = session();
  const applicant = session();

  const created = await author.post("/api/posts", {
    authorName: "Regression Author",
    category: "study_together",
    title: `Regression post ${Math.random().toString(36).slice(2)}`,
    description: "Still works",
    isPaid: true,
    amount: "$15",
  });
  expect(created.status).toBe(201);
  const post = await created.json();
  expect(post.isPaid).toBe(true);
  expect(post.amount).toBe("$15");
  expect(post.myApplicationStatus).toBe(null);

  const applied = await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Regression Applicant" });
  expect(applied.status).toBe(201);
  expect((await applied.json()).applicationCount).toBe(1);

  const second = await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Regression Applicant" });
  expect(second.status).toBe(409);

  const feed = await (await applicant.get("/api/posts")).json();
  const view = feed.find((p: { id: number }) => p.id === post.id);
  expect(view.appliedByMe).toBe(true);
  expect(view.myApplicationStatus).toBe("pending");
});
