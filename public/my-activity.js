// My Activity (Part 2 #2): My Posts and My Applications, both filtered from
// the current visitor's own GET /api/posts view server-side-isolated by
// session (src/routes/posts.ts scopes isOwnPost/appliedByMe to session.id),
// not a new endpoint — every post in this list already carries everything
// each section needs to render. Applicant-management and cancellation
// controls are the exact same renderPostCard/attachFeedInteractions used by
// the main feed (post-card.js), so accepting/declining/completing/cancelling
// here is identical to doing it from a community page.

const myPostsFeedEl = document.getElementById("my-posts-feed");
const myPostsEmptyEl = document.getElementById("my-posts-empty");
const myApplicationsFeedEl = document.getElementById("my-applications-feed");
const myApplicationsEmptyEl = document.getElementById("my-applications-empty");
const postsLiveEl = document.querySelector('[data-live-for="posts"]');
const applicationsLiveEl = document.querySelector('[data-live-for="applications"]');

let posts = [];
let hasLoadedOnce = false;

// Each section gets its own applicant-panel state — a panel opened in "My
// Posts" shouldn't affect "My Applications" (which never shows one anyway,
// since renderApplicantPanel only renders for isOwnPost rows, but keeping
// the state separate avoids any cross-section coupling). contactState is
// shared: its keys are namespaced "owner:<applicationId>" / "applicant:
// <postId>" (post-card.js), and a post never appears in both sections at
// once, so there's no risk of the two colliding.
const contactState = new Map();
// V1.2: Comments panel state is likewise shared across both sections — any
// post can be commented on regardless of which section shows it, and a post
// only ever appears in one section at a time, so there's no risk of the two
// colliding (same reasoning as contactState above).
const expandedCommentPosts = new Set();
const commentsCache = new Map();
const commentMessages = new Map();
const postsPanelState = {
  expandedApplicantPosts: new Set(),
  applicantsCache: new Map(),
  cardMessages: new Map(),
  contactState,
  expandedCommentPosts,
  commentsCache,
  commentMessages,
};
const applicationsPanelState = {
  expandedApplicantPosts: new Set(),
  applicantsCache: new Map(),
  cardMessages: new Map(),
  contactState,
  expandedCommentPosts,
  commentsCache,
  commentMessages,
};

function renderSection(feedEl, emptyEl, visiblePosts, panelState) {
  if (!feedEl) return;
  feedEl.innerHTML = visiblePosts.map((post) => renderPostCard(post, panelState)).join("");
  if (emptyEl) emptyEl.hidden = visiblePosts.length > 0;
}

function renderAll() {
  const myPosts = posts.filter((p) => p.isOwnPost);
  const myApplications = posts.filter((p) => p.appliedByMe);
  renderSection(myPostsFeedEl, myPostsEmptyEl, myPosts, postsPanelState);
  renderSection(myApplicationsFeedEl, myApplicationsEmptyEl, myApplications, applicationsPanelState);
}

async function refreshOpenApplicantPanels() {
  const ownPostIds = new Set(posts.filter((p) => p.isOwnPost).map((p) => p.id));
  for (const panelState of [postsPanelState, applicationsPanelState]) {
    for (const postId of panelState.expandedApplicantPosts) {
      if (!ownPostIds.has(postId)) {
        panelState.expandedApplicantPosts.delete(postId);
        panelState.applicantsCache.delete(postId);
        continue;
      }
      const res = await fetch(`/api/posts/${postId}/applicants`);
      panelState.applicantsCache.set(postId, res.ok ? await res.json() : []);
    }
  }
  // My Posts' expandedApplicantPosts is the only one that can ever hold an
  // id (My Applications never renders a Manage Applicants toggle — that
  // section is for posts the visitor applied to, not owns), so it's the
  // only one that matters for the owner side of refreshContactState; the
  // applicant side checks appliedByMe/status directly, not expansion.
  await refreshContactState(posts, { expandedApplicantPosts: postsPanelState.expandedApplicantPosts, contactState });
  await refreshOpenCommentPanels(posts, { expandedCommentPosts, commentsCache });
  renderAll();
}

async function loadPosts() {
  try {
    const res = await fetch("/api/posts");
    posts = await res.json();
  } catch {
    if (!hasLoadedOnce) {
      const message = "Couldn't load your activity — check your connection.";
      if (postsLiveEl) postsLiveEl.textContent = message;
      if (applicationsLiveEl) applicationsLiveEl.textContent = message;
    }
    return;
  }
  if (!hasLoadedOnce) {
    if (postsLiveEl) postsLiveEl.textContent = "";
    if (applicationsLiveEl) applicationsLiveEl.textContent = "";
  }
  hasLoadedOnce = true;
  renderAll();
  await refreshOpenApplicantPanels();
}

if (myPostsFeedEl) {
  attachFeedInteractions(myPostsFeedEl, {
    ...postsPanelState,
    reload: loadPosts,
    rerender: renderAll,
  });
}
if (myApplicationsFeedEl) {
  attachFeedInteractions(myApplicationsFeedEl, {
    ...applicationsPanelState,
    reload: loadPosts,
    rerender: renderAll,
  });
}

function connectEvents() {
  const source = new EventSource("/events");
  source.addEventListener("post:created", loadPosts);
  source.addEventListener("application:count", loadPosts);
  source.addEventListener("application:status", loadPosts);
  source.addEventListener("post:liked", loadPosts);
  source.addEventListener("comment:created", loadPosts);
  source.addEventListener("comment:deleted", loadPosts);
  source.addEventListener("open", loadPosts);
}

if (postsLiveEl) postsLiveEl.textContent = "Loading…";
if (applicationsLiveEl) applicationsLiveEl.textContent = "Loading…";

loadPosts();
connectEvents();
