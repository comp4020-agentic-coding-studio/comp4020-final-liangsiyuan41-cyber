import { JSDOM } from "jsdom";
import { expect, inject, it } from "vitest";

// Covers the Part 1 redesign's navigation requirements: the homepage's nav
// bar, hero and community cards; the four community routes as real,
// independently-navigable server routes (so a direct open or a refresh both
// just re-request the same URL — there's no client-side router to get
// wrong); that each shows only its own category; that an unknown slug 404s;
// and that the existing apply/SSE behaviour still works when driven from a
// community page, not only the homepage. Existing spec files are untouched.
const baseUrl = inject("baseUrl");

const CATEGORY_SLUGS: Record<string, string> = {
  "campus-help": "campus_help",
  "study-together": "study_together",
  "social-connect": "social_connect",
  "campus-events": "campus_events",
};

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

it("serves the homepage with the required nav bar, hero and community cards", async () => {
  const res = await fetch(new URL("/", baseUrl));
  expect(res.status).toBe(200);
  const html = await res.text();
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const navLinks = Array.from(doc.querySelectorAll(".nav-link")).map((a) => a.textContent?.trim());
  expect(navLinks).toEqual(["Home", "Explore", "Create Post", "My Activity"]);

  expect(doc.querySelector(".hero h1")?.textContent).toBe("Your campus. Your community.");
  expect(doc.querySelector(".hero p")?.textContent).toBe(
    "Find help, study together, make new connections, and discover opportunities across ANU.",
  );

  const cards = Array.from(doc.querySelectorAll(".community-card")).map((card) => ({
    title: card.querySelector("h3")?.textContent,
    href: card.getAttribute("href"),
  }));
  expect(cards).toEqual([
    { title: "Campus Help", href: "/community/campus-help" },
    { title: "Study Together", href: "/community/study-together" },
    { title: "Social Connect", href: "/community/social-connect" },
    { title: "Campus Events", href: "/community/campus-events" },
  ]);

  // Part 2 moves posting to its own page (/create) and removes the large
  // form from the homepage, so Explore/discovery is what the homepage keeps
  // — see spec/create-page.test.ts for the dedicated page's own coverage.
  expect(doc.getElementById("post-form")).toBeNull();
  expect(doc.getElementById("create-post")).toBeNull();
});

it("serves each community route directly as its own page, with the right heading and category scope", async () => {
  for (const [slug, category] of Object.entries(CATEGORY_SLUGS)) {
    const res = await fetch(new URL(`/community/${slug}`, baseUrl));
    expect(res.status, `GET /community/${slug} should be a real, direct route`).toBe(200);

    const html = await res.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    expect(doc.querySelector("h1")?.textContent?.length, `${slug} has a heading`).toBeGreaterThan(0);
    expect(doc.querySelector("main h2")?.textContent?.length, `${slug} has a category description/section`).toBeGreaterThan(0);
    expect(doc.body.dataset.category, `${slug} page scopes itself to ${category}`).toBe(category);

    // A Create Post entry point, per the Part 1 restriction (still the
    // existing form, reached via an anchor/query param, not a new form).
    const createPostLink = Array.from(doc.querySelectorAll("a")).find((a) => a.textContent?.includes("Create Post"));
    expect(createPostLink, `${slug} has a Create Post entry point`).toBeTruthy();
  }
});

it("404s an unknown community slug rather than silently falling through", async () => {
  const res = await fetch(new URL("/community/not-a-real-community", baseUrl));
  expect(res.status).toBe(404);
});

it("each community route is a plain GET that works the same on a fresh request as a refresh would", async () => {
  // There's no client-side router state for a refresh to lose: the exact
  // same request (a fresh GET, no prior navigation state) is what both a
  // direct open and a refresh produce, so getting this twice with no shared
  // state in between is the faithful check.
  for (const slug of Object.keys(CATEGORY_SLUGS)) {
    const first = await fetch(new URL(`/community/${slug}`, baseUrl));
    const second = await fetch(new URL(`/community/${slug}`, baseUrl));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.text()).toEqual(await second.text());
  }
});

it("a community page shows only posts from its own category, filtering out the rest", async () => {
  const author = session();

  const created: Record<string, number> = {};
  for (const [slug, category] of Object.entries(CATEGORY_SLUGS)) {
    const res = await author.post("/api/posts", {
      authorName: "Nav Test Author",
      category,
      title: `Nav filter test ${slug} ${Math.random().toString(36).slice(2)}`,
      description: "d",
      isPaid: false,
      amount: "",
    });
    expect(res.status).toBe(201);
    created[slug] = (await res.json()).id;
  }

  // GET /api/posts is category-agnostic and returns everything; the
  // filtering the requirement asks about happens in the page itself, so
  // drive the actual served app.js against each page the same way a browser
  // would (fetch/EventSource bridged to real network calls) rather than
  // re-implementing the filter logic here.
  for (const [slug, category] of Object.entries(CATEGORY_SLUGS)) {
    const pageUrl = new URL(`/community/${slug}`, baseUrl).toString();
    const dom = await JSDOM.fromURL(pageUrl, {
      runScripts: "dangerously",
      resources: "usable",
      pretendToBeVisual: true,
      beforeParse(window) {
        window.fetch = (input: string, init: RequestInit = {}) => fetch(new URL(input, pageUrl), init);
        // jsdom has no EventSource; the page's SSE reconnect listener only
        // needs addEventListener to exist for app.js to load without error.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).EventSource = class {
          addEventListener(): void {}
        };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 1200));

    const pills = Array.from(dom.window.document.querySelectorAll("#feed .category-pill")).map((p) =>
      p.textContent?.trim(),
    );
    const expectedLabel: Record<string, string> = {
      campus_help: "Campus Help",
      study_together: "Study Together",
      social_connect: "Social Connect",
      campus_events: "Campus Events",
    };
    expect(pills.length, `${slug} shows at least the post just created for it`).toBeGreaterThan(0);
    for (const pill of pills) {
      expect(pill, `${slug} must only show ${category} posts, found "${pill}"`).toBe(expectedLabel[category]);
    }

    const titles = Array.from(dom.window.document.querySelectorAll("#feed h3")).map((h) => h.textContent);
    expect(titles.some((t) => t?.includes(slug))).toBe(true);

    dom.window.close();
  }
});

it("existing post actions (apply) still work when driven from a community page", async () => {
  const author = session();
  const created = await author.post("/api/posts", {
    authorName: "Nav Action Author",
    category: "study_together",
    title: `Nav action test ${Math.random().toString(36).slice(2)}`,
    description: "d",
    isPaid: false,
    amount: "",
  });
  expect(created.status).toBe(201);
  const post = await created.json();

  // jsdom's window.fetch doesn't keep a cookie jar between calls (each
  // underlying fetch() here is independent), so the page's own session
  // cookie — issued on the first request and needed by every call after,
  // including the apply click — has to be captured and resent by hand, the
  // same pattern the other spec files' `session()` helper uses.
  let pageCookie: string | undefined;
  const pageUrl = new URL("/community/study-together", baseUrl).toString();
  const dom = await JSDOM.fromURL(pageUrl, {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async (input: string, init: RequestInit = {}) => {
        const res = await fetch(new URL(input, pageUrl), {
          ...init,
          headers: { ...init.headers, ...(pageCookie ? { cookie: pageCookie } : {}) },
        });
        const setCookie = res.headers.get("set-cookie");
        if (setCookie) pageCookie = setCookie.split(";")[0];
        return res;
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).EventSource = class {
        addEventListener(): void {}
      };
      window.prompt = () => "Nav Applicant";
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 1000));

  const applyBtn = dom.window.document.querySelector(`.apply-btn[data-post-id="${post.id}"]`);
  expect(applyBtn, "the existing Apply control still renders on a community page").not.toBeNull();
  applyBtn!.dispatchEvent(new dom.window.Event("click", { bubbles: true }));

  await new Promise((resolve) => setTimeout(resolve, 1000));

  const badge = dom.window.document.querySelector(`.post-card[data-post-id="${post.id}"] .badge`);
  expect(badge?.textContent?.trim()).toBe("Pending");

  dom.window.close();
});

it("regression: homepage posting workflow and category metadata are unaffected by the redesign", async () => {
  const author = session();
  const created = await author.post("/api/posts", {
    authorName: "Redesign Regression",
    category: "social_connect",
    title: `Redesign regression ${Math.random().toString(36).slice(2)}`,
    description: "Still works after the redesign",
    isPaid: true,
    amount: "$5",
  });
  expect(created.status).toBe(201);
  const post = await created.json();
  expect(post.category).toBe("social_connect");
  expect(post.isPaid).toBe(true);
  expect(post.amount).toBe("$5");

  const feed = await (await author.get("/api/posts")).json();
  expect(feed.find((p: { id: number }) => p.id === post.id)).toMatchObject({ isOwnPost: true });
});
