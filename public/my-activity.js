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

let posts = [];

// Each section gets its own applicant-panel state — a panel opened in "My
// Posts" shouldn't affect "My Applications" (which never shows one anyway,
// since renderApplicantPanel only renders for isOwnPost rows, but keeping
// the state separate avoids any cross-section coupling).
const postsPanelState = { expandedApplicantPosts: new Set(), applicantsCache: new Map() };
const applicationsPanelState = { expandedApplicantPosts: new Set(), applicantsCache: new Map() };

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
  renderAll();
}

async function loadPosts() {
  const res = await fetch("/api/posts");
  posts = await res.json();
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
  source.addEventListener("open", loadPosts);
}

loadPosts();
connectEvents();
