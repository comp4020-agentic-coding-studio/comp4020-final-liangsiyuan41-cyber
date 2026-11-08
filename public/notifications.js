// In-app notification bell (V1.2 follow-up). Loaded on every page alongside
// app.js/my-activity.js/create.js — see each page's <script> tags and the
// shared .site-nav markup in every public/*.html — so the unread count and
// dropdown are available everywhere, not just on My Activity, matching the
// requirement that the owner gets a visible signal wherever they happen to
// be browsing when it arrives.

const NOTIFICATION_TYPE_LABEL = {
  new_application: "applied to",
  new_comment: "commented on",
};

function escapeHtmlForNotifications(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function formatNotificationTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// Every notification type links to My Posts (the "relevant application
// management area" the requirement asks for): a new application is managed
// there via Manage Applicants, and a new comment's post — along with its
// Comments panel — is right there too. The notification payload only
// carries postId/postTitle, not category (src/routes/notifications.ts), so
// linking straight to the post's own community page would need a second
// lookup just to resolve postId -> category; My Posts already lists every
// post the owner authored, with both controls one click away.
function renderNotificationItem(n) {
  const verb = NOTIFICATION_TYPE_LABEL[n.type] ?? "interacted with";
  return `
    <li class="notification-item ${n.isRead ? "" : "unread"}" data-notification-id="${n.id}">
      <a href="/my-activity" class="notification-link" data-notification-id="${n.id}">
        <p class="notification-text">
          <strong>${escapeHtmlForNotifications(n.actorName)}</strong> ${verb}
          <strong>${escapeHtmlForNotifications(n.postTitle)}</strong>
        </p>
        <p class="notification-time">${formatNotificationTime(n.createdAt)}</p>
      </a>
    </li>
  `;
}

function initNotifications() {
  const bellBtn = document.getElementById("notification-bell");
  if (!bellBtn) return; // Page has no nav bell slot (shouldn't happen — every page shares .site-nav).

  const countEl = document.getElementById("notification-count");
  const dropdownEl = document.getElementById("notification-dropdown");
  const listEl = document.getElementById("notification-list");
  const emptyEl = document.getElementById("notification-empty");
  const markAllBtn = document.getElementById("notification-mark-all-read");

  let notifications = [];
  let isOpen = false;

  function render() {
    countEl.textContent = String(notifications.filter((n) => !n.isRead).length);
    countEl.hidden = notifications.every((n) => n.isRead);
    bellBtn.setAttribute("aria-expanded", String(isOpen));
    dropdownEl.hidden = !isOpen;

    if (notifications.length === 0) {
      listEl.innerHTML = "";
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    listEl.innerHTML = notifications.map(renderNotificationItem).join("");
  }

  async function load() {
    try {
      const res = await fetch("/api/notifications");
      if (!res.ok) return;
      const data = await res.json();
      notifications = data.notifications;
    } catch {
      // Leave whatever was already loaded; the next SSE signal or poll retries.
    }
    render();
  }

  bellBtn.addEventListener("click", () => {
    isOpen = !isOpen;
    render();
    if (isOpen) load();
  });

  // Closing on an outside click, same convenience every dropdown menu needs
  // — without this the panel only ever closes by clicking the bell again.
  document.addEventListener("click", (e) => {
    if (!isOpen) return;
    if (bellBtn.contains(e.target) || dropdownEl.contains(e.target)) return;
    isOpen = false;
    render();
  });

  markAllBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      const res = await fetch("/api/notifications/read-all", { method: "POST" });
      if (res.ok) {
        notifications = notifications.map((n) => ({ ...n, isRead: true }));
        render();
      }
    } catch {
      // Leave as-is; the user can retry.
    }
  });

  // Marking a single notification read happens as a side effect of clicking
  // through to it (that's the clear moment the owner has "seen" it), not
  // from a separate button — simpler, and matches how most notification
  // bells behave.
  listEl.addEventListener("click", (e) => {
    const link = e.target.closest(".notification-link");
    if (!link) return;
    const id = Number(link.dataset.notificationId);
    fetch(`/api/notifications/${id}/read`, { method: "POST" }).catch(() => {});
    // Not awaited: this is a fire-and-forget side effect of navigating away,
    // the same pattern this app already uses for broadcast-triggered
    // refetches it doesn't block rendering on.
  });

  function connectEvents() {
    const source = new EventSource("/events");
    // The broadcast carries no identifier at all (src/routes/notifications.ts)
    // — every connected client just re-fetches its own list on the signal,
    // same shape as every other SSE-triggered reload in this app.
    source.addEventListener("notification:new", load);
    source.addEventListener("open", load);
  }

  load();
  connectEvents();
}

initNotifications();
