import { JSDOM } from "jsdom";
import { expect, inject, it } from "vitest";

// Covers Part 2 #2: /my-activity — My Posts and My Applications, both
// correctly session-isolated (no other visitor's posts/applications leak
// into either section), and the existing applicant-management/cancellation
// controls still work when driven from this page. Additive; no existing
// spec file is modified by this one.
const baseUrl = inject("baseUrl");

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
    cookie: () => cookie,
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

// Drives the real page through jsdom the same way navigation.test.ts does,
// using an externally-supplied session cookie rather than letting the page
// mint its own — jsdom's window.fetch has no cookie jar, so the cookie has
// to be threaded through by hand.
async function loadMyActivityAs(cookie: string | undefined) {
  const pageUrl = new URL("/my-activity", baseUrl).toString();
  const dom = await JSDOM.fromURL(pageUrl, {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (input: string, init: RequestInit = {}) =>
        fetch(new URL(input, pageUrl), { ...init, headers: { ...init.headers, ...(cookie ? { cookie } : {}) } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).EventSource = class {
        addEventListener(): void {}
      };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 900));
  return dom;
}

it("serves /my-activity as a real, direct route with both sections", async () => {
  const res = await fetch(new URL("/my-activity", baseUrl));
  expect(res.status).toBe(200);
  const html = await res.text();
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  expect(doc.getElementById("my-posts-feed")).not.toBeNull();
  expect(doc.getElementById("my-applications-feed")).not.toBeNull();
  expect(doc.querySelector("h1")?.textContent).toBe("My Activity");

  const second = await fetch(new URL("/my-activity", baseUrl));
  expect(await second.text()).toEqual(html);
});

it("My Posts shows only posts the visitor authored, and never another visitor's posts", async () => {
  const author = session();
  const otherAuthor = session();
  const unique = Math.random().toString(36).slice(2);

  await author.post("/api/posts", {
    authorName: "MyPosts Author",
    category: "campus_help",
    title: `MyPosts mine ${unique}`,
    description: "d",
    isPaid: false,
    amount: "",
  });
  await otherAuthor.post("/api/posts", {
    authorName: "MyPosts Other",
    category: "campus_help",
    title: `MyPosts not-mine ${unique}`,
    description: "d",
    isPaid: false,
    amount: "",
  });

  const dom = await loadMyActivityAs(author.cookie());
  const titles = Array.from(dom.window.document.querySelectorAll("#my-posts-feed h3")).map((h) => h.textContent);
  expect(titles).toContain(`MyPosts mine ${unique}`);
  expect(titles).not.toContain(`MyPosts not-mine ${unique}`);

  const appTitles = Array.from(dom.window.document.querySelectorAll("#my-applications-feed h3")).map(
    (h) => h.textContent,
  );
  expect(appTitles).not.toContain(`MyPosts mine ${unique}`);
  dom.window.close();
});

it("My Applications shows only posts the visitor applied to, with their own application status", async () => {
  const author = session();
  const applicant = session();
  const stranger = session();
  const unique = Math.random().toString(36).slice(2);

  const created = await author.post("/api/posts", {
    authorName: "MyApps Author",
    category: "study_together",
    title: `MyApps post ${unique}`,
    description: "d",
    isPaid: false,
    amount: "",
  });
  const post = await created.json();
  const applied = await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "MyApps Applicant" });
  expect(applied.status).toBe(201);

  const dom = await loadMyActivityAs(applicant.cookie());
  const appTitles = Array.from(dom.window.document.querySelectorAll("#my-applications-feed h3")).map(
    (h) => h.textContent,
  );
  expect(appTitles).toContain(`MyApps post ${unique}`);
  const badge = dom.window.document.querySelector(`.post-card[data-post-id="${post.id}"] .badge`);
  expect(badge?.textContent?.trim()).toBe("Pending");
  dom.window.close();

  // A stranger who never applied sees neither section populated with it.
  const strangerDom = await loadMyActivityAs(stranger.cookie());
  const strangerAppTitles = Array.from(strangerDom.window.document.querySelectorAll("#my-applications-feed h3")).map(
    (h) => h.textContent,
  );
  const strangerPostTitles = Array.from(strangerDom.window.document.querySelectorAll("#my-posts-feed h3")).map(
    (h) => h.textContent,
  );
  expect(strangerAppTitles).not.toContain(`MyApps post ${unique}`);
  expect(strangerPostTitles).not.toContain(`MyApps post ${unique}`);
  strangerDom.window.close();
});

it("an empty-state message shows for a visitor with no posts or applications", async () => {
  const freshVisitor = session();
  // Force a session cookie to exist without creating any posts/applications.
  await freshVisitor.get("/api/whoami");

  const dom = await loadMyActivityAs(freshVisitor.cookie());
  const postsEmpty = dom.window.document.getElementById("my-posts-empty");
  const appsEmpty = dom.window.document.getElementById("my-applications-empty");
  expect(postsEmpty?.hidden).toBe(false);
  expect(appsEmpty?.hidden).toBe(false);
  dom.window.close();
});

it("accept/decline from My Posts' applicant panel works exactly as it does from a community page", async () => {
  const author = session();
  const applicant = session();
  const unique = Math.random().toString(36).slice(2);

  const created = await author.post("/api/posts", {
    authorName: "MyActivity Decide Author",
    category: "social_connect",
    title: `MyActivity decide ${unique}`,
    description: "d",
    isPaid: false,
    amount: "",
  });
  const post = await created.json();
  await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "MyActivity Decide Applicant" });

  const dom = await loadMyActivityAs(author.cookie());
  const toggleBtn = dom.window.document.querySelector(`.applicants-toggle[data-post-id="${post.id}"]`);
  expect(toggleBtn, "manage-applicants toggle renders on My Posts").not.toBeNull();
  toggleBtn!.dispatchEvent(new dom.window.Event("click", { bubbles: true }));

  await new Promise((resolve) => setTimeout(resolve, 500));

  const acceptBtn = dom.window.document.querySelector(`.decide-btn.accept[data-post-id="${post.id}"]`);
  expect(acceptBtn, "accept control renders for the pending applicant").not.toBeNull();
  acceptBtn!.dispatchEvent(new dom.window.Event("click", { bubbles: true }));

  await new Promise((resolve) => setTimeout(resolve, 600));

  const statusPill = dom.window.document.querySelector(`[data-post-id="${post.id}"] .status-pill`);
  expect(statusPill?.textContent).toBe("Accepted");
  dom.window.close();

  // Persisted server-side, same as the community-page flow.
  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  expect(list[0].status).toBe("accepted");
});

it("requesting cancellation from My Applications works exactly as it does from a community page", async () => {
  const author = session();
  const applicant = session();
  const unique = Math.random().toString(36).slice(2);

  const created = await author.post("/api/posts", {
    authorName: "MyActivity Cancel Author",
    category: "campus_events",
    title: `MyActivity cancel ${unique}`,
    description: "d",
    isPaid: false,
    amount: "",
  });
  const post = await created.json();
  await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "MyActivity Cancel Applicant" });
  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  await author.patch(`/api/posts/${post.id}/applicants/${list[0].id}`, { status: "accepted" });

  const dom = await loadMyActivityAs(applicant.cookie());
  const cancelBtn = dom.window.document.querySelector(`.request-cancellation-btn[data-post-id="${post.id}"]`);
  expect(cancelBtn, "request-cancellation control renders on My Applications").not.toBeNull();
  cancelBtn!.dispatchEvent(new dom.window.Event("click", { bubbles: true }));

  await new Promise((resolve) => setTimeout(resolve, 700));

  const pendingBadge = dom.window.document.querySelector(`[data-post-id="${post.id}"] .cancellation-pending`);
  expect(pendingBadge?.textContent).toBe("Cancellation requested");
  dom.window.close();

  const reread = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  expect(reread[0].cancellationRequested).toBe(true);
});
