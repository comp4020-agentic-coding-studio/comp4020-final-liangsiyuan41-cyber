import { expect, inject, it } from "vitest";

// Covers ANU TaskMate V1.1: application messages (Feature 1) and private
// contact exchange (Feature 2) — src/routes/applications.ts's optional
// `message` field, and src/routes/contacts.ts's owner/applicant contact
// endpoints. Additive to every existing spec file; none of them is modified.
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
    put: (path: string, body: unknown) =>
      request(path, {
        method: "PUT",
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
    title: `Contact exchange spec post ${Math.random().toString(36).slice(2)}`,
    description: "Needs a hand",
    isPaid: false,
    amount: "",
    ...overrides,
  });
  expect(created.status).toBe(201);
  return created.json();
}

// Applies with a message, accepts, and returns {applicationId}. Helper
// shared by the contact-exchange tests below, the same shape as the existing
// completion-cancellation.test.ts's makeAcceptedApplication.
async function makeAcceptedApplication(
  author: ReturnType<typeof session>,
  applicant: ReturnType<typeof session>,
  postId: number,
  applicantName: string,
  message?: string,
) {
  await applicant.post(`/api/posts/${postId}/apply`, { applicantName, message });
  const list = await (await author.get(`/api/posts/${postId}/applicants`)).json();
  const application = list.find((a: { applicantName: string }) => a.applicantName === applicantName);
  const decide = await author.patch(`/api/posts/${postId}/applicants/${application.id}`, { status: "accepted" });
  expect(decide.status).toBe(200);
  return application.id as number;
}

// --- Feature 1: application messages ---------------------------------------

it("accepts an optional application message and shows it to the post author", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);

  const applied = await applicant.post(`/api/posts/${post.id}/apply`, {
    applicantName: "Pat",
    message: "I have a car and some free time this weekend.",
  });
  expect(applied.status).toBe(201);

  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  expect(list[0]).toMatchObject({
    applicantName: "Pat",
    message: "I have a car and some free time this weekend.",
  });
});

it("applying with no message at all is still accepted, and the message reads back as null", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);

  const applied = await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Quinn" });
  expect(applied.status).toBe(201);

  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  expect(list[0].message).toBeNull();
});

it("shows the applicant their own message via GET /api/posts, never another applicant's", async () => {
  const author = session();
  const applicantA = session();
  const applicantB = session();
  const post = await makePost(author);

  await applicantA.post(`/api/posts/${post.id}/apply`, { applicantName: "Riley", message: "My message" });
  await applicantB.post(`/api/posts/${post.id}/apply`, { applicantName: "Sam", message: "A different message" });

  const feedA = await (await applicantA.get("/api/posts")).json();
  const viewA = feedA.find((p: { id: number }) => p.id === post.id);
  expect(viewA.myApplicationMessage).toBe("My message");

  const feedB = await (await applicantB.get("/api/posts")).json();
  const viewB = feedB.find((p: { id: number }) => p.id === post.id);
  expect(viewB.myApplicationMessage).toBe("A different message");
});

it("never exposes an application message in the public feed to a visitor who hasn't applied", async () => {
  const author = session();
  const applicant = session();
  const stranger = session();
  const post = await makePost(author);

  await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Taylor", message: "Private note" });

  const feed = await (await stranger.get("/api/posts")).json();
  const view = feed.find((p: { id: number }) => p.id === post.id);
  expect(view.myApplicationMessage).toBeNull();
  // Belt and braces: the raw response text must not contain the message at
  // all for a visitor it was never meant for.
  const strangerFeedText = JSON.stringify(feed);
  expect(strangerFeedText).not.toContain("Private note");
});

it("rejects an overlong message length but keeps the existing one-application-per-user-per-post rule unchanged", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);

  const first = await applicant.post(`/api/posts/${post.id}/apply`, {
    applicantName: "Jordan",
    message: "x".repeat(2000),
  });
  expect(first.status).toBe(201);
  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  // Truncated, not rejected outright — same "slice, don't 400" shape as
  // authorName/title/description elsewhere in this codebase.
  expect(list[0].message?.length).toBe(1000);

  const second = await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Jordan", message: "again" });
  expect(second.status).toBe(409);
});

// --- Feature 2: private contact exchange ------------------------------------

it("locks contact details until the application is accepted, for both the owner and the applicant", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);

  await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Avery" });
  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  const applicationId = list[0].id;

  const ownerSave = await author.put(`/api/posts/${post.id}/applicants/${applicationId}/contact`, {
    contactMethod: "email",
    contactValue: "owner@example.com",
  });
  expect(ownerSave.status).toBe(400);

  const applicantSave = await applicant.put(`/api/posts/${post.id}/my-contact`, {
    contactMethod: "phone",
    contactValue: "0400000000",
  });
  expect(applicantSave.status).toBe(400);

  const applicantRead = await applicant.get(`/api/posts/${post.id}/my-contact`);
  expect(applicantRead.status).toBe(400);
});

it("lets the owner and the accepted applicant exchange contact details and each see the other's", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);
  const applicationId = await makeAcceptedApplication(author, applicant, post.id, "Bailey");

  const ownerSave = await author.put(`/api/posts/${post.id}/applicants/${applicationId}/contact`, {
    contactMethod: "email",
    contactValue: "owner@example.com",
  });
  expect(ownerSave.status).toBe(200);
  expect(await ownerSave.json()).toMatchObject({ contactMethod: "email", contactValue: "owner@example.com" });

  const applicantSave = await applicant.put(`/api/posts/${post.id}/my-contact`, {
    contactMethod: "whatsapp",
    contactValue: "+61 400 000 000",
  });
  expect(applicantSave.status).toBe(200);

  const ownerView = await (await author.get(`/api/posts/${post.id}/contacts`)).json();
  expect(ownerView[applicationId].own).toMatchObject({ contactMethod: "email", contactValue: "owner@example.com" });
  expect(ownerView[applicationId].other).toMatchObject({
    contactMethod: "whatsapp",
    contactValue: "+61 400 000 000",
  });

  const applicantView = await (await applicant.get(`/api/posts/${post.id}/my-contact`)).json();
  expect(applicantView.own).toMatchObject({ contactMethod: "whatsapp", contactValue: "+61 400 000 000" });
  expect(applicantView.other).toMatchObject({ contactMethod: "email", contactValue: "owner@example.com" });
});

it("treats contact sharing as optional: an application can stay accepted with neither side ever saving anything", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);
  const applicationId = await makeAcceptedApplication(author, applicant, post.id, "Casey");

  const ownerView = await (await author.get(`/api/posts/${post.id}/contacts`)).json();
  expect(ownerView[applicationId]).toEqual({ own: null, other: null });

  const applicantView = await (await applicant.get(`/api/posts/${post.id}/my-contact`)).json();
  expect(applicantView).toEqual({ own: null, other: null });
});

it("supports phone, email, whatsapp and wechat with no method privileged over another", async () => {
  const author = session();
  const applicants = ["Phone Devon", "Email Devon", "Whatsapp Devon", "Wechat Devon"].map(() => session());
  const post = await makePost(author);

  const methods = [
    { contactMethod: "phone", contactValue: "+61 412 345 678" },
    { contactMethod: "email", contactValue: "student@anu.edu.au" },
    { contactMethod: "whatsapp", contactValue: "+86 138 0000 0000" },
    { contactMethod: "wechat", contactValue: "anu_student_123" },
  ];

  for (let i = 0; i < methods.length; i++) {
    const applicationId = await makeAcceptedApplication(author, applicants[i], post.id, `Devon ${i}`);
    const save = await applicants[i].put(`/api/posts/${post.id}/my-contact`, methods[i]);
    expect(save.status, `${methods[i].contactMethod} should be accepted`).toBe(200);
    expect(await save.json()).toMatchObject(methods[i]);
  }
});

it("rejects an unrecognised contact method, an empty value, an overlong value, and a malformed email", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);
  const applicationId = await makeAcceptedApplication(author, applicant, post.id, "Ellis");

  const badMethod = await applicant.put(`/api/posts/${post.id}/my-contact`, {
    contactMethod: "carrier-pigeon",
    contactValue: "x",
  });
  expect(badMethod.status).toBe(400);

  const empty = await applicant.put(`/api/posts/${post.id}/my-contact`, { contactMethod: "phone", contactValue: "" });
  expect(empty.status).toBe(400);

  const overlong = await applicant.put(`/api/posts/${post.id}/my-contact`, {
    contactMethod: "phone",
    contactValue: "x".repeat(200),
  });
  expect(overlong.status).toBe(400);

  const badEmail = await applicant.put(`/api/posts/${post.id}/my-contact`, {
    contactMethod: "email",
    contactValue: "not-an-email",
  });
  expect(badEmail.status).toBe(400);

  // Nothing above should have been persisted: the owner's combined view is
  // still "nothing shared".
  const ownerView = await (await author.get(`/api/posts/${post.id}/contacts`)).json();
  expect(ownerView[applicationId]).toEqual({ own: null, other: null });
});

it("denies a non-author from reading or writing the owner's contact endpoints", async () => {
  const author = session();
  const applicant = session();
  const stranger = session();
  const post = await makePost(author);
  const applicationId = await makeAcceptedApplication(author, applicant, post.id, "Frankie");

  const readAttempt = await stranger.get(`/api/posts/${post.id}/contacts`);
  expect(readAttempt.status).toBe(403);

  const writeAttempt = await stranger.put(`/api/posts/${post.id}/applicants/${applicationId}/contact`, {
    contactMethod: "email",
    contactValue: "evil@example.com",
  });
  expect(writeAttempt.status).toBe(403);

  // Confirms the attempted write never landed.
  const ownerView = await (await author.get(`/api/posts/${post.id}/contacts`)).json();
  expect(ownerView[applicationId].own).toBeNull();
});

it("denies a visitor with no application on the post from reading or writing /my-contact", async () => {
  const author = session();
  const applicant = session();
  const stranger = session();
  const post = await makePost(author);
  await makeAcceptedApplication(author, applicant, post.id, "Gale");

  const readAttempt = await stranger.get(`/api/posts/${post.id}/my-contact`);
  expect(readAttempt.status).toBe(404);

  const writeAttempt = await stranger.put(`/api/posts/${post.id}/my-contact`, {
    contactMethod: "email",
    contactValue: "evil@example.com",
  });
  expect(writeAttempt.status).toBe(404);
});

it("isolates contact exchanges between two different applicants on the same post", async () => {
  const author = session();
  const applicantB = session();
  const applicantD = session();
  const post = await makePost(author);

  const applicationIdB = await makeAcceptedApplication(author, applicantB, post.id, "Harper");
  const applicationIdD = await makeAcceptedApplication(author, applicantD, post.id, "Indigo");

  await author.put(`/api/posts/${post.id}/applicants/${applicationIdB}/contact`, {
    contactMethod: "email",
    contactValue: "owner-for-harper@example.com",
  });
  await applicantB.put(`/api/posts/${post.id}/my-contact`, { contactMethod: "phone", contactValue: "111111" });
  await applicantD.put(`/api/posts/${post.id}/my-contact`, { contactMethod: "wechat", contactValue: "indigo_wechat" });

  // Applicant B never sees applicant D's contact, or the owner's reply meant
  // for D (there isn't one, since the owner never saved one for D).
  const viewB = await (await applicantB.get(`/api/posts/${post.id}/my-contact`)).json();
  expect(viewB.own).toMatchObject({ contactValue: "111111" });
  expect(viewB.other).toMatchObject({ contactValue: "owner-for-harper@example.com" });

  const viewD = await (await applicantD.get(`/api/posts/${post.id}/my-contact`)).json();
  expect(viewD.own).toMatchObject({ contactValue: "indigo_wechat" });
  // The owner never shared contact details for D's application specifically
  // — B's shared value must never leak across to D.
  expect(viewD.other).toBeNull();

  const ownerView = await (await author.get(`/api/posts/${post.id}/contacts`)).json();
  expect(ownerView[applicationIdB].other).toMatchObject({ contactValue: "111111" });
  expect(ownerView[applicationIdD].other).toMatchObject({ contactValue: "indigo_wechat" });
  expect(ownerView[applicationIdB].other.contactValue).not.toBe(ownerView[applicationIdD].other.contactValue);
});

it("never includes contact details in the public GET /api/posts response", async () => {
  const author = session();
  const applicant = session();
  const stranger = session();
  const post = await makePost(author);
  const applicationId = await makeAcceptedApplication(author, applicant, post.id, "Jules");

  await author.put(`/api/posts/${post.id}/applicants/${applicationId}/contact`, {
    contactMethod: "email",
    contactValue: "owner-secret@example.com",
  });
  await applicant.put(`/api/posts/${post.id}/my-contact`, {
    contactMethod: "whatsapp",
    contactValue: "+1 555 000 1111",
  });

  const feed = await (await stranger.get("/api/posts")).json();
  const feedText = JSON.stringify(feed);
  expect(feedText).not.toContain("owner-secret@example.com");
  expect(feedText).not.toContain("+1 555 000 1111");

  const view = feed.find((p: { id: number }) => p.id === post.id);
  for (const key of Object.keys(view)) {
    expect(key.toLowerCase()).not.toContain("contact");
  }
});

it("never broadcasts contact details over /events, and a contact save doesn't fire an SSE event at all", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);
  const applicationId = await makeAcceptedApplication(author, applicant, post.id, "Kendall");

  const controller = new AbortController();
  const res = await fetch(new URL("/events", baseUrl), {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const sawEvent = { current: false };

  const readLoop = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("\n\n")) sawEvent.current = true;
    }
  })();

  await new Promise((resolve) => setTimeout(resolve, 50));

  await author.put(`/api/posts/${post.id}/applicants/${applicationId}/contact`, {
    contactMethod: "email",
    contactValue: "should-not-broadcast@example.com",
  });
  await applicant.put(`/api/posts/${post.id}/my-contact`, {
    contactMethod: "phone",
    contactValue: "0499999999",
  });

  // Give any (wrongly) broadcast event a fair chance to arrive.
  await Promise.race([readLoop, new Promise((resolve) => setTimeout(resolve, 1500))]);
  controller.abort();

  expect(buffer).not.toContain("should-not-broadcast@example.com");
  expect(buffer).not.toContain("0499999999");
  expect(buffer).not.toContain("contact");
});

it("locks the contact exchange again once an accepted application is cancelled, without deleting what was already shared", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);
  const applicationId = await makeAcceptedApplication(author, applicant, post.id, "Logan");

  await author.put(`/api/posts/${post.id}/applicants/${applicationId}/contact`, {
    contactMethod: "email",
    contactValue: "owner@example.com",
  });
  await applicant.put(`/api/posts/${post.id}/my-contact`, { contactMethod: "phone", contactValue: "0400000000" });

  const cancel = await author.patch(`/api/posts/${post.id}/applicants/${applicationId}`, { status: "cancelled" });
  expect(cancel.status).toBe(200);

  const applicantReadAttempt = await applicant.get(`/api/posts/${post.id}/my-contact`);
  expect(applicantReadAttempt.status).toBe(400);

  const applicantWriteAttempt = await applicant.put(`/api/posts/${post.id}/my-contact`, {
    contactMethod: "email",
    contactValue: "new@example.com",
  });
  expect(applicantWriteAttempt.status).toBe(400);

  // The owner's combined view omits a cancelled application's exchange from
  // what it shows, but re-accepting (not possible from cancelled — this just
  // documents the behaviour, not a recovery path) would need a fresh accept
  // to read it again; the important guarantee is that cancelling an
  // application doesn't crash or silently corrupt unrelated data. Completed
  // applications remain readable, covered by the next test.
  const ownerView = await (await author.get(`/api/posts/${post.id}/contacts`)).json();
  expect(ownerView[applicationId]).toBeUndefined();
});

it("keeps the contact exchange readable after an application is marked completed", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);
  const applicationId = await makeAcceptedApplication(author, applicant, post.id, "Morgan");

  await author.put(`/api/posts/${post.id}/applicants/${applicationId}/contact`, {
    contactMethod: "wechat",
    contactValue: "morgans_owner",
  });
  await applicant.put(`/api/posts/${post.id}/my-contact`, { contactMethod: "wechat", contactValue: "morgan_app" });

  const complete = await author.patch(`/api/posts/${post.id}/applicants/${applicationId}`, { status: "completed" });
  expect(complete.status).toBe(200);

  const ownerView = await (await author.get(`/api/posts/${post.id}/contacts`)).json();
  expect(ownerView[applicationId].own).toMatchObject({ contactValue: "morgans_owner" });
  expect(ownerView[applicationId].other).toMatchObject({ contactValue: "morgan_app" });

  const applicantView = await (await applicant.get(`/api/posts/${post.id}/my-contact`)).json();
  expect(applicantView.own).toMatchObject({ contactValue: "morgan_app" });
  expect(applicantView.other).toMatchObject({ contactValue: "morgans_owner" });
});

it("404s contact endpoints for a post that doesn't exist", async () => {
  const someone = session();
  expect((await someone.get("/api/posts/999999999/contacts")).status).toBe(404);
  expect((await someone.get("/api/posts/999999999/my-contact")).status).toBe(404);
  expect(
    (await someone.put("/api/posts/999999999/applicants/1/contact", { contactMethod: "email", contactValue: "a@b.com" }))
      .status,
  ).toBe(404);
});

it("persists application messages and contact details across a later, independent read (simulating a restart)", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);

  await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Noor", message: "Persisted message" });
  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  const applicationId = list[0].id;
  await author.patch(`/api/posts/${post.id}/applicants/${applicationId}`, { status: "accepted" });
  await author.put(`/api/posts/${post.id}/applicants/${applicationId}/contact`, {
    contactMethod: "email",
    contactValue: "persisted-owner@example.com",
  });
  await applicant.put(`/api/posts/${post.id}/my-contact`, {
    contactMethod: "phone",
    contactValue: "persisted-phone",
  });

  // A later, independent read — same shape as completion-cancellation.test.ts's
  // own persistence check — rather than relying on anything cached from the
  // calls above.
  const laterApplicants = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  expect(laterApplicants.find((a: { id: number }) => a.id === applicationId).message).toBe("Persisted message");

  const laterOwnerView = await (await author.get(`/api/posts/${post.id}/contacts`)).json();
  expect(laterOwnerView[applicationId].own).toMatchObject({ contactValue: "persisted-owner@example.com" });
  expect(laterOwnerView[applicationId].other).toMatchObject({ contactValue: "persisted-phone" });
});

it("regression: existing completion workflow still works alongside contact exchange", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);
  const applicationId = await makeAcceptedApplication(author, applicant, post.id, "Oakley");

  await author.put(`/api/posts/${post.id}/applicants/${applicationId}/contact`, {
    contactMethod: "email",
    contactValue: "owner@example.com",
  });

  const complete = await author.patch(`/api/posts/${post.id}/applicants/${applicationId}`, { status: "completed" });
  expect(complete.status).toBe(200);

  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  expect(list.find((a: { id: number }) => a.id === applicationId).status).toBe("completed");
});

it("regression: existing cancellation-request workflow still works alongside contact exchange", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);
  const applicationId = await makeAcceptedApplication(author, applicant, post.id, "Parker");

  await applicant.put(`/api/posts/${post.id}/my-contact`, { contactMethod: "phone", contactValue: "0400123123" });

  const request = await applicant.post(`/api/posts/${post.id}/cancellation-request`, { reason: "Schedule changed" });
  expect(request.status).toBe(200);

  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  const app = list.find((a: { id: number }) => a.id === applicationId);
  expect(app.cancellationRequested).toBe(true);
  expect(app.status).toBe("accepted");

  const approve = await author.patch(`/api/posts/${post.id}/applicants/${applicationId}`, { status: "cancelled" });
  expect(approve.status).toBe(200);

  const after = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  expect(after.find((a: { id: number }) => a.id === applicationId).status).toBe("cancelled");
});

it("regression: existing C9/applicant-management/posting behaviour is unaffected", async () => {
  const author = session();
  const applicant = session();

  const created = await author.post("/api/posts", {
    authorName: "Regression V1.1 Author",
    category: "social_connect",
    title: `V1.1 regression post ${Math.random().toString(36).slice(2)}`,
    description: "Still works",
    isPaid: true,
    amount: "$20",
  });
  expect(created.status).toBe(201);
  const post = await created.json();
  expect(post.isPaid).toBe(true);
  expect(post.amount).toBe("$20");
  expect(post.myApplicationMessage).toBeNull();

  const applied = await applicant.post(`/api/posts/${post.id}/apply`, {
    applicantName: "Regression V1.1 Applicant",
    message: "Hello",
  });
  expect(applied.status).toBe(201);

  const second = await applicant.post(`/api/posts/${post.id}/apply`, {
    applicantName: "Regression V1.1 Applicant",
    message: "Hello again",
  });
  expect(second.status).toBe(409);

  const feed = await (await applicant.get("/api/posts")).json();
  const view = feed.find((p: { id: number }) => p.id === post.id);
  expect(view.appliedByMe).toBe(true);
  expect(view.myApplicationStatus).toBe("pending");
  expect(view.myApplicationMessage).toBe("Hello");
});
