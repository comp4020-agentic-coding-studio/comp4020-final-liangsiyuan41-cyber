// Shared post-card rendering and interaction wiring, used by both the main
// feed (app.js, on the homepage and community pages) and My Activity
// (my-activity.js). Factored out so "My Posts" / "My Applications" reuse
// exactly the same markup, CSS classes and API calls as the main feed rather
// than a second, divergent implementation of the same business rules (apply,
// applicant management, completion, cancellation) — see Part 2's restriction
// against changing existing business rules or permission boundaries.

const CATEGORY_LABELS = {
  campus_help: "Campus Help",
  study_together: "Study Together",
  social_connect: "Social Connect",
  campus_events: "Campus Events",
};

const CATEGORY_SLUGS = {
  campus_help: "campus-help",
  study_together: "study-together",
  social_connect: "social-connect",
  campus_events: "campus-events",
};

const STATUS_LABELS = {
  pending: "Pending",
  accepted: "Accepted",
  declined: "Declined",
  completed: "Completed",
  cancelled: "Cancelled",
};

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

function renderApplicantPanel(post, { expandedApplicantPosts, applicantsCache }) {
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

// Renders one <li class="post-card">. Every field the card needs to show per
// Part 2 (#3 Post Card Improvements) — category, title/description, author,
// free/paid + amount, applicant count, this viewer's application status, and
// the action buttons appropriate to this viewer — is already present on the
// serialised post from GET /api/posts (src/routes/posts.ts), so this is pure
// presentation: no permission decision is made here that the server hasn't
// already made.
function renderPostCard(post, { expandedApplicantPosts, applicantsCache }) {
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
      ${renderApplicantPanel(post, { expandedApplicantPosts, applicantsCache })}
    </li>
  `;
}

// Wires up the apply / request-cancellation / manage-applicants / decide
// (accept, decline, complete, cancel) actions on a feed container, using
// event delegation the same way app.js's original single feed did. `ctx`
// supplies the mutable state (posts array, applicant cache/expansion) and a
// `rerender()` callback; this function owns no state of its own, so it works
// identically whether `containerEl` is the main feed or one of My Activity's
// two sections.
function attachFeedInteractions(containerEl, ctx) {
  async function loadApplicants(postId) {
    const res = await fetch(`/api/posts/${postId}/applicants`);
    if (!res.ok) {
      ctx.applicantsCache.set(postId, []);
      return;
    }
    ctx.applicantsCache.set(postId, await res.json());
  }
  ctx.loadApplicants = loadApplicants;

  containerEl.addEventListener("click", async (e) => {
    const btn = e.target.closest(".apply-btn");
    if (!btn) return;

    const defaultName = ctx.getDefaultApplicantName ? ctx.getDefaultApplicantName() : "";
    const applicantName = defaultName || prompt("Your name, so the poster knows who applied:");
    if (!applicantName) return;

    btn.disabled = true;
    btn.textContent = "Applying…";

    try {
      const res = await fetch(`/api/posts/${btn.dataset.postId}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicantName }),
      });

      if (res.status === 409) {
        // Someone else's tab for the same session got there first — the
        // server, not this click, is the source of truth here.
        await ctx.reload();
        return;
      }
      if (!res.ok) {
        btn.disabled = false;
        btn.textContent = "Apply";
        return;
      }

      await ctx.reload();
    } catch {
      btn.disabled = false;
      btn.textContent = "Apply";
    }
  });

  containerEl.addEventListener("click", async (e) => {
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
        await ctx.reload();
      } else {
        btn.disabled = false;
        btn.textContent = "Request Cancellation";
      }
    } catch {
      btn.disabled = false;
      btn.textContent = "Request Cancellation";
    }
  });

  containerEl.addEventListener("click", async (e) => {
    const toggleBtn = e.target.closest(".applicants-toggle");
    if (toggleBtn) {
      const postId = Number(toggleBtn.dataset.postId);
      if (ctx.expandedApplicantPosts.has(postId)) {
        ctx.expandedApplicantPosts.delete(postId);
        ctx.rerender();
        return;
      }
      ctx.expandedApplicantPosts.add(postId);
      ctx.rerender();
      await loadApplicants(postId);
      ctx.rerender();
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
        ctx.rerender();
      }
    }
  });
}
