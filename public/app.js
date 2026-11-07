// The main feed: used by the homepage and each of the four community pages.
// Card rendering and the apply/manage-applicants/decide/cancel interactions
// live in post-card.js (loaded before this file — see each page's <script>
// tags) so My Activity can reuse exactly the same logic rather than a second
// copy of it.

const feedEl = document.getElementById("feed");
const feedEmptyEl = document.getElementById("feed-empty");
const liveIndicatorEl = document.querySelector(".live-indicator");

// A community page sets this on <body> to show only its own category, with
// no client-side tab filter standing in for a real page — see
// public/community/*.html. Absent (homepage) means "show the latest across
// every category", optionally capped by data-latest-limit.
const PAGE_CATEGORY = document.body.dataset.category || null;
const LATEST_LIMIT = document.body.dataset.latestLimit ? Number(document.body.dataset.latestLimit) : null;

let posts = [];
let myDisplayName = null;

// Applicant-management panels are fetched lazily, only for posts the current
// visitor owns (the server enforces that; see src/routes/applications.ts).
// Kept outside `posts` so an SSE-triggered re-render doesn't collapse an
// open panel or blank out data the author is currently looking at.
const expandedApplicantPosts = new Set();
const applicantsCache = new Map();

function renderFeed() {
  if (!feedEl) return;

  let visible = PAGE_CATEGORY ? posts.filter((p) => p.category === PAGE_CATEGORY) : posts;
  if (LATEST_LIMIT) visible = visible.slice(0, LATEST_LIMIT);

  feedEl.innerHTML = visible.map((post) => renderPostCard(post, { expandedApplicantPosts, applicantsCache })).join("");

  if (feedEmptyEl) feedEmptyEl.hidden = visible.length > 0;
}

async function loadApplicants(postId) {
  const res = await fetch(`/api/posts/${postId}/applicants`);
  if (!res.ok) {
    applicantsCache.set(postId, []);
    return;
  }
  applicantsCache.set(postId, await res.json());
}

async function loadPosts() {
  const res = await fetch("/api/posts");
  posts = await res.json();
  renderFeed();
  await refreshOpenApplicantPanels();
}

// Keeps any currently-open "Manage applicants" panel in sync with the
// server, the same re-fetch-on-signal pattern as the rest of the feed
// (see docs/adr-0001-…md) — an SSE application:status event never carries
// the applicant list itself, only an identifier.
async function refreshOpenApplicantPanels() {
  const ownPostIds = new Set(posts.filter((p) => p.isOwnPost).map((p) => p.id));
  for (const postId of expandedApplicantPosts) {
    if (!ownPostIds.has(postId)) {
      expandedApplicantPosts.delete(postId);
      applicantsCache.delete(postId);
      continue;
    }
    await loadApplicants(postId);
  }
  renderFeed();
}

if (feedEl) {
  attachFeedInteractions(feedEl, {
    expandedApplicantPosts,
    applicantsCache,
    reload: loadPosts,
    rerender: renderFeed,
    getDefaultApplicantName: () => myDisplayName ?? "",
  });
}

async function loadWhoami() {
  const res = await fetch("/api/whoami");
  const data = await res.json();
  myDisplayName = data.displayName;
}

function connectEvents() {
  const source = new EventSource("/events");

  source.addEventListener("post:created", () => {
    loadPosts();
    flashLive("New post");
  });

  source.addEventListener("application:count", () => {
    loadPosts();
    flashLive("Application count updated");
  });

  source.addEventListener("application:status", () => {
    loadPosts();
    flashLive("Application status updated");
  });

  // On any drop (network blip, server restart) EventSource reconnects on
  // its own; a fresh GET /api/posts on reconnect is what makes that safe —
  // no event this tab might have missed while disconnected is ever trusted,
  // only the server's current state is (see docs/adr-0001-…md).
  source.addEventListener("open", () => {
    loadPosts();
  });
}

let liveTimeout;
function flashLive(message) {
  if (!liveIndicatorEl) return;
  liveIndicatorEl.textContent = message;
  clearTimeout(liveTimeout);
  liveTimeout = setTimeout(() => {
    liveIndicatorEl.textContent = "";
  }, 1500);
}

loadWhoami();
loadPosts();
connectEvents();
