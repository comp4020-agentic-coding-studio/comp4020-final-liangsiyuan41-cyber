const CATEGORY_LABELS = {
  campus_help: "Campus Help",
  study_together: "Study Together",
  social_connect: "Social Connect",
  campus_events: "Campus Events",
};

const STATUS_LABELS = {
  pending: "Pending",
  accepted: "Accepted",
  declined: "Declined",
  completed: "Completed",
  cancelled: "Cancelled",
};

const feedEl = document.getElementById("feed");
const feedEmptyEl = document.getElementById("feed-empty");
const liveIndicatorEl = document.querySelector(".live-indicator");
// The post form only exists on the homepage at this stage (see CLAUDE.md:
// Part 1 keeps the existing posting form where it is — each community page's
// "Create Post" entry point just links back to it). Every reference to it
// below is guarded so app.js keeps working unchanged on pages without one.
const postForm = document.getElementById("post-form");
const formStatusEl = postForm ? postForm.querySelector(".form-status") : null;
const amountField = postForm ? postForm.querySelector(".amount-field") : null;

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

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function renderApplicantActions(post, a) {
  if (a.status === "pending") {
    return `
      <button type="button" class="decide-btn accept" data-post-id="${post.id}" data-application-id="${a.id}" data-status="accepted">Accept</button>
      <button type="button" class="decide-btn decline" data-post-id="${post.id}" data-application-id="${a.id}" data-status="declined">Decline</button>
    `;
  }
  if (a.status === "accepted") {
    return `
      <button type="button" class="decide-btn complete" data-post-id="${post.id}" data-application-id="${a.id}" data-status="completed">Mark Completed</button>
      <button type="button" class="decide-btn cancel" data-post-id="${post.id}" data-application-id="${a.id}" data-status="cancelled">${a.cancellationRequested ? "Approve Cancellation" : "Cancel"}</button>
    `;
  }
  // completed and cancelled are terminal — nothing left to do with this row.
  return "";
}

function renderApplicantPanel(post) {
  if (!post.isOwnPost) return "";

  const isOpen = expandedApplicantPosts.has(post.id);
  const applicants = applicantsCache.get(post.id);

  let body = "";
  if (isOpen) {
    if (!applicants) {
      body = `<p class="applicants-status">Loading…</p>`;
    } else if (applicants.length === 0) {
      body = `<p class="applicants-status">No applicants yet.</p>`;
    } else {
      body = `
        <ul class="applicant-list">
          ${applicants
            .map(
              (a) => `
            <li class="applicant-row" data-application-id="${a.id}">
              <div class="applicant-row-main">
                <span class="applicant-name">${escapeHtml(a.applicantName)}</span>
                <span class="status-pill status-${a.status}">${STATUS_LABELS[a.status] ?? a.status}</span>
                <span class="applicant-actions">
                  ${renderApplicantActions(post, a)}
                </span>
              </div>
              ${
                a.cancellationRequested
                  ? `<p class="cancellation-note">Requested cancellation${a.cancellationReason ? `: “${escapeHtml(a.cancellationReason)}”` : ""}</p>`
                  : ""
              }
            </li>
          `,
            )
            .join("")}
        </ul>
      `;
    }
  }

  return `
    <div class="applicant-panel">
      <button type="button" class="applicants-toggle" data-post-id="${post.id}" aria-expanded="${isOpen}">
        ${isOpen ? "Hide applicants" : "Manage applicants"}
      </button>
      ${isOpen ? `<div class="applicants-body">${body}</div>` : ""}
    </div>
  `;
}

function renderFeed() {
  if (!feedEl) return;

  let visible = PAGE_CATEGORY ? posts.filter((p) => p.category === PAGE_CATEGORY) : posts;
  if (LATEST_LIMIT) visible = visible.slice(0, LATEST_LIMIT);

  feedEl.innerHTML = visible
    .map((post) => {
      const priceLabel = post.isPaid ? `Paid${post.amount ? ` · ${escapeHtml(post.amount)}` : ""}` : "Free";
      const statusBadge = `<span class="badge applied status-${post.myApplicationStatus}">${STATUS_LABELS[post.myApplicationStatus] ?? "Applied"}</span>`;
      const requestCancellationBtn = `<button type="button" class="request-cancellation-btn" data-post-id="${post.id}">Request Cancellation</button>`;
      const applyControl = post.isOwnPost
        ? `<span class="badge">Your post</span>`
        : post.appliedByMe
          ? post.myApplicationStatus === "accepted"
            ? post.myCancellationRequested
              ? `${statusBadge}<span class="badge cancellation-pending">Cancellation requested</span>`
              : `${statusBadge}${requestCancellationBtn}`
            : statusBadge
          : `<button type="button" class="apply-btn" data-post-id="${post.id}">Apply</button>`;

      return `
        <li class="post-card" data-post-id="${post.id}">
          <div class="post-card-header">
            <span class="category-pill">${CATEGORY_LABELS[post.category] ?? post.category}</span>
            <span class="price-pill ${post.isPaid ? "paid" : "free"}">${priceLabel}</span>
          </div>
          <h3>${escapeHtml(post.title)}</h3>
          <p class="post-description">${escapeHtml(post.description)}</p>
          <div class="post-card-footer">
            <span class="author">by ${escapeHtml(post.authorName)}</span>
            <span class="application-count" data-count-for="${post.id}">
              ${post.applicationCount} applicant${post.applicationCount === 1 ? "" : "s"}
            </span>
            ${applyControl}
          </div>
          ${renderApplicantPanel(post)}
        </li>
      `;
    })
    .join("");

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

async function loadWhoami() {
  const res = await fetch("/api/whoami");
  const data = await res.json();
  myDisplayName = data.displayName;
  if (myDisplayName && postForm) {
    postForm.elements.authorName.value = myDisplayName;
  }
}

if (postForm) {
  // A community page's "Create Post" link can arrive at the homepage form
  // with ?category=campus_help etc. (see public/community/*.html) so the
  // form opens pre-set to the category the visitor came from.
  const presetCategory = new URLSearchParams(location.search).get("category");
  if (presetCategory && postForm.elements.category.querySelector(`option[value="${presetCategory}"]`)) {
    postForm.elements.category.value = presetCategory;
  }

  postForm.querySelectorAll('input[name="isPaid"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      amountField.hidden = postForm.elements.isPaid.value !== "paid";
    });
  });

  postForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    formStatusEl.textContent = "Posting…";

    const formData = new FormData(postForm);
    const body = {
      authorName: formData.get("authorName"),
      category: formData.get("category"),
      title: formData.get("title"),
      description: formData.get("description"),
      isPaid: formData.get("isPaid") === "paid",
      amount: formData.get("amount"),
    };

    try {
      const res = await fetch("/api/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        formStatusEl.textContent = err.error ?? "Could not post — please check the form.";
        return;
      }
      const post = await res.json();
      posts = [post, ...posts];
      renderFeed();
      formStatusEl.textContent = "Posted.";
      postForm.elements.title.value = "";
      postForm.elements.description.value = "";
      setTimeout(() => {
        formStatusEl.textContent = "";
      }, 2000);
    } catch {
      formStatusEl.textContent = "Network error — your post was not saved.";
    }
  });
}

feedEl.addEventListener("click", async (e) => {
  const btn = e.target.closest(".apply-btn");
  if (!btn) return;

  const postId = btn.dataset.postId;
  const defaultName = postForm ? postForm.elements.authorName.value.trim() : myDisplayName ?? "";
  const applicantName = defaultName || prompt("Your name, so the poster knows who applied:");
  if (!applicantName) return;

  btn.disabled = true;
  btn.textContent = "Applying…";

  try {
    const res = await fetch(`/api/posts/${postId}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applicantName }),
    });

    if (res.status === 409) {
      // Someone else's tab for the same session got there first — the
      // server, not this click, is the source of truth here.
      await loadPosts();
      return;
    }
    if (!res.ok) {
      btn.disabled = false;
      btn.textContent = "Apply";
      return;
    }

    await loadPosts();
  } catch {
    btn.disabled = false;
    btn.textContent = "Apply";
  }
});

feedEl.addEventListener("click", async (e) => {
  const btn = e.target.closest(".request-cancellation-btn");
  if (!btn) return;

  const reason = prompt("Optional: let the post author know why (visible only to them).") ?? "";

  btn.disabled = true;
  btn.textContent = "Requesting…";

  try {
    const res = await fetch(`/api/posts/${btn.dataset.postId}/cancellation-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    if (res.ok) {
      await loadPosts();
    } else {
      btn.disabled = false;
      btn.textContent = "Request Cancellation";
    }
  } catch {
    btn.disabled = false;
    btn.textContent = "Request Cancellation";
  }
});

feedEl.addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest(".applicants-toggle");
  if (toggleBtn) {
    const postId = Number(toggleBtn.dataset.postId);
    if (expandedApplicantPosts.has(postId)) {
      expandedApplicantPosts.delete(postId);
      renderFeed();
      return;
    }
    expandedApplicantPosts.add(postId);
    renderFeed();
    await loadApplicants(postId);
    renderFeed();
    return;
  }

  const decideBtn = e.target.closest(".decide-btn");
  if (decideBtn) {
    const { postId, applicationId, status } = decideBtn.dataset;
    decideBtn.disabled = true;
    try {
      const res = await fetch(`/api/posts/${postId}/applicants/${applicationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        await loadApplicants(Number(postId));
      }
    } finally {
      renderFeed();
    }
  }
});

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
  liveIndicatorEl.textContent = message;
  clearTimeout(liveTimeout);
  liveTimeout = setTimeout(() => {
    liveIndicatorEl.textContent = "";
  }, 1500);
}

loadWhoami();
loadPosts();
connectEvents();
