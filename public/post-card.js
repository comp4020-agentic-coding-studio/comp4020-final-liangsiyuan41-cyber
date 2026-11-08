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

// V1.1 Feature 2: a dropdown, not free text, so every value is one of a
// fixed, platform-neutral set — no contact method is presented as the
// default or the "normal" one.
const CONTACT_METHOD_LABELS = {
  phone: "Phone Number",
  email: "Email",
  whatsapp: "WhatsApp",
  wechat: "WeChat",
};

// Contact Details only ever renders for an application that's actually
// unlocked it (see src/routes/contacts.ts's CONTACT_UNLOCKED_STATUSES) — kept
// here too so the UI never offers a save control the server would reject.
const CONTACT_UNLOCKED_STATUSES = new Set(["accepted", "completed"]);

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

// One <option> list shared by every contact-method <select> on the page.
function contactMethodOptions(selected) {
  return Object.entries(CONTACT_METHOD_LABELS)
    .map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`)
    .join("");
}

function formatContact(contact) {
  if (!contact) return null;
  return `${CONTACT_METHOD_LABELS[contact.contactMethod] ?? contact.contactMethod}: ${escapeHtml(contact.contactValue)}`;
}

// Renders the Contact Details section for one accepted/completed
// application. `own`/`other` are {contactMethod, contactValue, updatedAt} or
// null (not yet shared) — the caller (owner or applicant view) already did
// the access check server-side by the time this data exists at all; this is
// pure presentation, same as renderApplicantPanel.
//
// `role` ("owner" | "applicant") only changes which endpoint the form saves
// to and which state-map key it reads — the markup and the four states
// (loading, empty, saving/error, saved) are identical either side. The
// owner's save targets one specific application (postId + applicationId, one
// contact exchange per accepted applicant); the applicant's save targets
// their own application on this post (postId alone — the same "no
// application id in the URL" shape src/routes/applications.ts's
// requestCancellation already uses, since a visitor can only ever have one
// application per post).
function renderContactSection(post, { applicationId, role }, contactState) {
  const key = role === "owner" ? `owner:${applicationId}` : `applicant:${post.id}`;
  const state = contactState?.get(key) ?? {};
  const { own, other } = state.contacts ?? { own: null, other: null };
  const status = state.status; // undefined | 'loading' | 'saving' | 'error' | 'success'
  const errorMessage = state.error;

  const otherLabel = role === "owner" ? "Applicant's contact information" : "Post owner's contact information";
  const otherLine = other
    ? `<p class="contact-shared"><strong>${otherLabel}:</strong> ${formatContact(other)}</p>`
    : `<p class="contact-empty">${role === "owner" ? "The applicant hasn't" : "The post owner hasn't"} shared contact details yet.</p>`;

  const selectedMethod = own?.contactMethod ?? "phone";
  const savedValue = own?.contactValue ?? "";

  return `
    <div class="contact-section" data-role="${role}">
      <h4 class="contact-heading">Contact Details</h4>
      ${status === "loading" ? `<p class="contact-loading">Loading contact details…</p>` : ""}
      ${otherLine}
      <form class="contact-form" data-post-id="${post.id}" data-application-id="${applicationId ?? ""}" data-role="${role}">
        <label class="contact-field">
          Preferred contact method
          <select name="contactMethod">${contactMethodOptions(selectedMethod)}</select>
        </label>
        <label class="contact-field">
          Contact information
          <input type="text" name="contactValue" maxlength="150" placeholder="e.g. a phone number, email or handle" value="${escapeHtml(savedValue)}" />
        </label>
        <button type="submit" class="save-contact-btn" ${status === "saving" ? "disabled" : ""}>
          ${status === "saving" ? "Saving…" : "Save Contact Details"}
        </button>
        ${status === "error" ? `<p class="contact-error" role="alert">${escapeHtml(errorMessage ?? "Could not save — please try again.")}</p>` : ""}
        ${status === "success" ? `<p class="contact-success" role="status">Saved.</p>` : ""}
      </form>
    </div>
  `;
}

function renderApplicantPanel(post, { expandedApplicantPosts, applicantsCache, contactState }) {
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
              ${a.message ? `<p class="application-message"><strong>Message:</strong> ${escapeHtml(a.message)}</p>` : ""}
              ${
                a.cancellationRequested
                  ? `<p class="cancellation-note">Requested cancellation${a.cancellationReason ? `: “${escapeHtml(a.cancellationReason)}”` : ""}</p>`
                  : ""
              }
              ${CONTACT_UNLOCKED_STATUSES.has(a.status) ? renderContactSection(post, { applicationId: a.id, role: "owner" }, contactState) : ""}
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
//
// `cardMessages` (postId -> string, optional) carries a transient
// error/feedback line for a card whose last action failed — e.g. a network
// error on Apply. It's not part of the post's own data, so it's passed
// alongside it rather than folded into `post`.
//
// `contactState` is shared with renderApplicantPanel (and passed through to
// renderContactSection below) — the applicant's own Contact Details section
// renders here, on their own card, once their application is accepted.
function renderPostCard(post, { expandedApplicantPosts, applicantsCache, cardMessages, contactState }) {
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

  const message = cardMessages?.get(post.id);
  const myMessage = !post.isOwnPost && post.appliedByMe && post.myApplicationMessage;
  const myContactSection =
    !post.isOwnPost && post.appliedByMe && CONTACT_UNLOCKED_STATUSES.has(post.myApplicationStatus)
      ? renderContactSection(post, { role: "applicant" }, contactState)
      : "";

  return `
    <li class="post-card" data-post-id="${post.id}">
      <div class="post-card-header">
        <span class="category-pill">${CATEGORY_LABELS[post.category] ?? post.category}</span>
        <span class="price-pill ${post.isPaid ? "paid" : "free"}">${priceLabel}</span>
      </div>
      <h3>${escapeHtml(post.title)}</h3>
      <p class="post-description">${escapeHtml(post.description)}</p>
      ${myMessage ? `<p class="application-message"><strong>Your message:</strong> ${escapeHtml(post.myApplicationMessage)}</p>` : ""}
      <div class="post-card-footer">
        <span class="author">by ${escapeHtml(post.authorName)}</span>
        <span class="application-count" data-count-for="${post.id}">
          ${post.applicationCount} applicant${post.applicationCount === 1 ? "" : "s"}
        </span>
        ${applyControl}
      </div>
      ${myContactSection}
      ${message ? `<p class="post-card-message" role="status">${escapeHtml(message)}</p>` : ""}
      ${renderApplicantPanel(post, { expandedApplicantPosts, applicantsCache, contactState })}
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

  // Fetches the owner's contact exchanges for one post as soon as its
  // Manage Applicants panel is opened, so an already-accepted applicant's
  // Contact Details section doesn't sit on stale/empty data until the next
  // SSE-triggered full reload — see refreshContactState below, which covers
  // the ongoing/periodic case this complements.
  async function loadOwnerContacts(postId) {
    if (!ctx.contactState) return;
    try {
      const res = await fetch(`/api/posts/${postId}/contacts`);
      if (!res.ok) return;
      const byApplicationId = await res.json();
      for (const [applicationId, contacts] of Object.entries(byApplicationId)) {
        const key = `owner:${applicationId}`;
        const prior = ctx.contactState.get(key) ?? {};
        ctx.contactState.set(key, { ...prior, contacts });
      }
    } catch {
      // Leave contactState as-is; the periodic refresh retries.
    }
  }

  function setMessage(postId, message) {
    if (!ctx.cardMessages) return;
    if (message) ctx.cardMessages.set(postId, message);
    else ctx.cardMessages.delete(postId);
  }

  containerEl.addEventListener("click", async (e) => {
    const btn = e.target.closest(".apply-btn");
    if (!btn) return;

    const postId = Number(btn.dataset.postId);
    const defaultName = ctx.getDefaultApplicantName ? ctx.getDefaultApplicantName() : "";
    const applicantName = defaultName || prompt("Your name, so the poster knows who applied:");
    if (!applicantName) return;
    // Feature 1: an optional message alongside the existing name prompt —
    // same "prompt, empty is fine" shape as request-cancellation's reason
    // below, so applying with no message at all stays exactly one dialog
    // when a display name is already known.
    const applicationMessage = prompt("Optional: add a message for the post owner (visible to them only).") ?? "";

    btn.disabled = true;
    btn.textContent = "Applying…";
    setMessage(postId, null);

    try {
      const res = await fetch(`/api/posts/${postId}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicantName, message: applicationMessage }),
      });

      if (res.status === 409) {
        // Someone else's tab for the same session got there first — the
        // server, not this click, is the source of truth here.
        setMessage(postId, "You've already applied to this post.");
        await ctx.reload();
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setMessage(postId, body.error ?? "Could not apply — please try again.");
        btn.disabled = false;
        btn.textContent = "Apply";
        ctx.rerender();
        return;
      }

      await ctx.reload();
    } catch {
      setMessage(postId, "Network error — your application was not sent.");
      btn.disabled = false;
      btn.textContent = "Apply";
      ctx.rerender();
    }
  });

  containerEl.addEventListener("click", async (e) => {
    const btn = e.target.closest(".request-cancellation-btn");
    if (!btn) return;

    const postId = Number(btn.dataset.postId);
    const reason = prompt("Optional: let the post author know why (visible only to them).") ?? "";

    btn.disabled = true;
    btn.textContent = "Requesting…";
    setMessage(postId, null);

    try {
      const res = await fetch(`/api/posts/${postId}/cancellation-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (res.ok) {
        await ctx.reload();
      } else {
        const body = await res.json().catch(() => ({}));
        setMessage(postId, body.error ?? "Could not request cancellation — please try again.");
        btn.disabled = false;
        btn.textContent = "Request Cancellation";
        ctx.rerender();
      }
    } catch {
      setMessage(postId, "Network error — your request was not sent.");
      btn.disabled = false;
      btn.textContent = "Request Cancellation";
      ctx.rerender();
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
      await Promise.all([loadApplicants(postId), loadOwnerContacts(postId)]);
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
          await Promise.all([loadApplicants(Number(postId)), loadOwnerContacts(Number(postId))]);
        }
      } finally {
        ctx.rerender();
      }
    }
  });

  // Feature 2: saving either side's Contact Details. One listener covers
  // both the owner's per-applicant form (PUT .../applicants/:id/contact) and
  // the applicant's own form (PUT .../my-contact) — which endpoint to call
  // is read straight off the form's own data-role attribute set by
  // renderContactSection, so there's no risk of the two getting crossed.
  containerEl.addEventListener("submit", async (e) => {
    const form = e.target.closest(".contact-form");
    if (!form) return;
    e.preventDefault();

    const { postId, applicationId, role } = form.dataset;
    const key = role === "owner" ? `owner:${applicationId}` : `applicant:${postId}`;
    const url =
      role === "owner" ? `/api/posts/${postId}/applicants/${applicationId}/contact` : `/api/posts/${postId}/my-contact`;

    const contactMethod = form.elements.contactMethod.value;
    const contactValue = form.elements.contactValue.value;

    const existing = ctx.contactState?.get(key) ?? {};
    ctx.contactState?.set(key, { ...existing, status: "saving" });
    ctx.rerender();

    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactMethod, contactValue }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const prior = ctx.contactState?.get(key) ?? {};
        ctx.contactState?.set(key, { ...prior, status: "error", error: body.error ?? "Could not save." });
        ctx.rerender();
        return;
      }
      const saved = await res.json();
      const prior = ctx.contactState?.get(key) ?? {};
      const contacts = prior.contacts ?? { own: null, other: null };
      ctx.contactState?.set(key, { ...prior, status: "success", contacts: { ...contacts, own: saved } });
      ctx.rerender();
    } catch {
      const prior = ctx.contactState?.get(key) ?? {};
      ctx.contactState?.set(key, { ...prior, status: "error", error: "Network error — not saved." });
      ctx.rerender();
    }
  });
}

// Fetches the contact exchange for every post/application that currently has
// Contact Details unlocked and visible, and fills in `contactState` (a Map,
// same shape/ownership as applicantsCache) so renderContactSection has
// something to show. Called by app.js and my-activity.js's load/refresh
// cycle, the same place applicantsCache is kept in sync — not from inside
// attachFeedInteractions, since this needs the full `posts` list, which only
// the caller (not the event-delegation layer here) has in scope.
async function refreshContactState(posts, { expandedApplicantPosts, contactState }) {
  for (const post of posts) {
    if (post.isOwnPost) {
      // Only fetch for a post whose Manage Applicants panel is actually
      // open — same "don't fetch what isn't visible" discipline
      // applicantsCache already follows.
      if (!expandedApplicantPosts.has(post.id)) continue;
      try {
        const res = await fetch(`/api/posts/${post.id}/contacts`);
        if (!res.ok) continue;
        const byApplicationId = await res.json();
        for (const [applicationId, contacts] of Object.entries(byApplicationId)) {
          const key = `owner:${applicationId}`;
          const prior = contactState.get(key) ?? {};
          // Don't clobber an in-flight save or a just-shown success/error —
          // only refresh the read-only `contacts` data itself.
          contactState.set(key, { ...prior, contacts });
        }
      } catch {
        // Leave whatever was already in contactState; the next refresh
        // (SSE-triggered reload) tries again.
      }
    } else if (post.appliedByMe && CONTACT_UNLOCKED_STATUSES.has(post.myApplicationStatus)) {
      const key = `applicant:${post.id}`;
      try {
        const res = await fetch(`/api/posts/${post.id}/my-contact`);
        if (!res.ok) continue;
        const contacts = await res.json();
        const prior = contactState.get(key) ?? {};
        contactState.set(key, { ...prior, contacts });
      } catch {
        // Same as above.
      }
    }
  }
}
