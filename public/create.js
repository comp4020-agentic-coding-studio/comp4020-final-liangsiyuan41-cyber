// Dedicated Create Post page (Part 2 #1). Same fields, validation and
// session behaviour as the old homepage form (src/routes/posts.ts is
// unchanged), just on its own route so the homepage can stay focused on
// community discovery.

const CATEGORY_SLUGS = {
  campus_help: "campus-help",
  study_together: "study-together",
  social_connect: "social-connect",
  campus_events: "campus-events",
};

const postForm = document.getElementById("post-form");
const formStatusEl = postForm.querySelector(".form-status");
const amountField = postForm.querySelector(".amount-field");

// A community page's "Create Post" link arrives here with
// ?category=campus_help etc. so the form opens pre-set to the category the
// visitor came from.
const presetCategory = new URLSearchParams(location.search).get("category");
if (presetCategory && postForm.elements.category.querySelector(`option[value="${presetCategory}"]`)) {
  postForm.elements.category.value = presetCategory;
}

postForm.querySelectorAll('input[name="isPaid"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    amountField.hidden = postForm.elements.isPaid.value !== "paid";
  });
});

async function loadWhoami() {
  const res = await fetch("/api/whoami");
  const data = await res.json();
  if (data.displayName) {
    postForm.elements.authorName.value = data.displayName;
  }
}

function setStatus(message, kind) {
  formStatusEl.textContent = message;
  formStatusEl.classList.remove("success", "error");
  if (kind) formStatusEl.classList.add(kind);
}

postForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus("Posting…", null);

  const formData = new FormData(postForm);
  const category = formData.get("category");
  const body = {
    authorName: formData.get("authorName"),
    category,
    title: formData.get("title"),
    description: formData.get("description"),
    isPaid: formData.get("isPaid") === "paid",
    amount: formData.get("amount"),
  };

  const submitBtn = postForm.querySelector('button[type="submit"]');

  try {
    submitBtn.disabled = true;
    const res = await fetch("/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setStatus(err.error ?? "Could not post — please check the form.", "error");
      submitBtn.disabled = false;
      return;
    }

    // The post is already committed server-side by the time this response
    // comes back (src/routes/posts.ts inserts before replying), so the
    // community page's own GET /api/posts on load picks it up immediately —
    // no need to pass the post itself through the navigation.
    setStatus("Posted! Taking you to the community page…", "success");
    const slug = CATEGORY_SLUGS[category] ?? "";
    location.href = slug ? `/community/${slug}` : "/";
  } catch {
    setStatus("Network error — your post was not saved.", "error");
    submitBtn.disabled = false;
  }
});

loadWhoami();
