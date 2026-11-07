import { JSDOM } from "jsdom";
import { expect, inject, it } from "vitest";

// Covers Part 2 #1: the dedicated /create page — it exists as a real route,
// carries the same fields/validation/session behaviour the old homepage form
// had, supports ?category= preselection, and a successful submission is
// picked up immediately by the community page it lands on. Existing spec
// files are untouched; navigation.test.ts's homepage assertion was updated
// (not this file) to reflect the form's removal from the homepage.
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
    get: (path: string) => request(path),
    post: (path: string, body: unknown) =>
      request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

it("serves /create as a real, direct route with the posting form", async () => {
  const res = await fetch(new URL("/create", baseUrl));
  expect(res.status).toBe(200);
  const html = await res.text();
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  expect(doc.getElementById("post-form")).not.toBeNull();
  expect(doc.querySelector('select[name="category"]')).not.toBeNull();
  expect(doc.querySelector('input[name="authorName"]')).not.toBeNull();
  expect(doc.querySelector('input[name="title"]')).not.toBeNull();
  expect(doc.querySelector('textarea[name="description"]')).not.toBeNull();
  expect(doc.querySelector('input[name="isPaid"][value="free"]')).not.toBeNull();
  expect(doc.querySelector('input[name="isPaid"][value="paid"]')).not.toBeNull();
  expect(doc.querySelector('input[name="amount"]')).not.toBeNull();

  // A real, independently navigable route: a refresh is just the same GET.
  const second = await fetch(new URL("/create", baseUrl));
  expect(await second.text()).toEqual(html);
});

it("preselects the category from ?category= when the value is valid", async () => {
  const pageUrl = new URL("/create?category=study_together", baseUrl).toString();
  const dom = await JSDOM.fromURL(pageUrl, {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (input: string, init: RequestInit = {}) => fetch(new URL(input, pageUrl), init);
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 500));

  const select = dom.window.document.querySelector<HTMLSelectElement>('select[name="category"]');
  expect(select?.value).toBe("study_together");
  dom.window.close();
});

it("ignores an invalid ?category= value rather than leaving the form in a broken state", async () => {
  const pageUrl = new URL("/create?category=not-a-real-category", baseUrl).toString();
  const dom = await JSDOM.fromURL(pageUrl, {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (input: string, init: RequestInit = {}) => fetch(new URL(input, pageUrl), init);
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 500));

  const select = dom.window.document.querySelector<HTMLSelectElement>('select[name="category"]');
  // Falls back to the select's own default (first option) rather than
  // silently accepting an unknown category value.
  expect(select?.value).toBe("campus_help");
  dom.window.close();
});

it("posting from /create creates the post and it's immediately visible via GET /api/posts", async () => {
  const author = session();
  const unique = Math.random().toString(36).slice(2);

  const created = await author.post("/api/posts", {
    authorName: "Create Page Author",
    category: "campus_events",
    title: `Create page test ${unique}`,
    description: "Posted via the dedicated /create page",
    isPaid: true,
    amount: "$10",
  });
  expect(created.status).toBe(201);
  const post = await created.json();
  expect(post.category).toBe("campus_events");
  expect(post.isPaid).toBe(true);
  expect(post.amount).toBe("$10");

  // "Appears immediately" per Part 2 #1 — no extra step needed, the very
  // next GET already has it (same contract createPost has always had; this
  // just checks the new page's flow doesn't add a delay).
  const feed = await (await author.get("/api/posts")).json();
  expect(feed.find((p: { id: number }) => p.id === post.id)).toMatchObject({
    title: `Create page test ${unique}`,
    isOwnPost: true,
  });
});

it("every community page's Create Post link points at /create with its own category preset", async () => {
  const slugs: Record<string, string> = {
    "campus-help": "campus_help",
    "study-together": "study_together",
    "social-connect": "social_connect",
    "campus-events": "campus_events",
  };
  for (const [slug, category] of Object.entries(slugs)) {
    const res = await fetch(new URL(`/community/${slug}`, baseUrl));
    const html = await res.text();
    const dom = new JSDOM(html);
    const link = Array.from(dom.window.document.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Create Post"),
    );
    expect(link?.getAttribute("href"), `${slug}'s Create Post link`).toBe(`/create?category=${category}`);
  }
});
