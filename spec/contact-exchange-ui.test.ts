import { JSDOM } from "jsdom";
import { expect, inject, it } from "vitest";

// Covers the Contact Details interface redesign: two clearly separated
// sub-panels ("Other Participant's Contact" / "My Contact Details") with
// name/role/method/value, a Copy button, a clear empty state, editing via
// the existing save form, and the same behaviour on My Posts, My
// Applications and a community page's Manage Applicants panel. The backend
// access-control contract this sits on top of (accepted/completed only, the
// correct two parties only) is unchanged and already covered by
// spec/contact-exchange.test.ts — these tests drive the real rendered pages
// with jsdom, the same way spec/navigation.test.ts and
// spec/my-activity.test.ts do, rather than re-testing the API.
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
    cookie: () => cookie,
    get: (path: string) => request(path),
    post: (path: string, body: unknown) =>
      request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    put: (path: string, body: unknown) =>
      request(path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    patch: (path: string, body: unknown) =>
      request(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

async function makePost(author: ReturnType<typeof session>, overrides: Record<string, unknown> = {}) {
  const created = await author.post("/api/posts", {
    authorName: "Owner",
    category: "campus_help",
    title: `Contact UI spec post ${Math.random().toString(36).slice(2)}`,
    description: "Needs a hand",
    isPaid: false,
    amount: "",
    ...overrides,
  });
  expect(created.status).toBe(201);
  return created.json();
}

async function makeAcceptedApplication(
  author: ReturnType<typeof session>,
  applicant: ReturnType<typeof session>,
  postId: number,
  applicantName: string,
) {
  await applicant.post(`/api/posts/${postId}/apply`, { applicantName });
  const list = await (await author.get(`/api/posts/${postId}/applicants`)).json();
  const application = list.find((a: { applicantName: string }) => a.applicantName === applicantName);
  const decide = await author.patch(`/api/posts/${postId}/applicants/${application.id}`, { status: "accepted" });
  expect(decide.status).toBe(200);
  return application.id as number;
}

// Loads a page through jsdom with runScripts, threading a session cookie by
// hand (jsdom's window.fetch has no cookie jar) — the same pattern
// navigation.test.ts and my-activity.test.ts already use.
async function loadPage(path: string, cookie: string | undefined) {
  const pageUrl = new URL(path, baseUrl).toString();
  const dom = await JSDOM.fromURL(pageUrl, {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (input: string, init: RequestInit = {}) =>
        fetch(new URL(input, pageUrl), { ...init, headers: { ...init.headers, ...(cookie ? { cookie } : {}) } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).EventSource = class {
        addEventListener(): void {}
      };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 900));
  return dom;
}

function contactSectionFor(doc: Document, postId: number) {
  return doc.querySelector(`.post-card[data-post-id="${postId}"] .contact-section`);
}

it("My Applications shows two clearly separated sub-panels: Other Participant's Contact and My Contact Details", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author, { authorName: "Riley Owner" });
  const applicationId = await makeAcceptedApplication(author, applicant, post.id, "Jordan Applicant");

  await author.put(`/api/posts/${post.id}/applicants/${applicationId}/contact`, {
    contactMethod: "email",
    contactValue: "riley@example.com",
  });

  const dom = await loadPage("/my-activity", applicant.cookie());
  const section = contactSectionFor(dom.window.document, post.id);
  expect(section, "Contact Details section renders once accepted").not.toBeNull();

  const headings = Array.from(section!.querySelectorAll(".contact-party-heading")).map((h) => h.textContent);
  expect(headings).toEqual(["Other Participant's Contact", "My Contact Details"]);
  dom.window.close();
});

it("displays the other participant's name, role, preferred method and shared contact information", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author, { authorName: "Morgan Owner" });
  const applicationId = await makeAcceptedApplication(author, applicant, post.id, "Taylor Applicant");

  await author.put(`/api/posts/${post.id}/applicants/${applicationId}/contact`, {
    contactMethod: "whatsapp",
    contactValue: "+61 400 777 888",
  });

  const dom = await loadPage("/my-activity", applicant.cookie());
  const section = contactSectionFor(dom.window.document, post.id);
  const otherPanel = section!.querySelector(".contact-party-other");

  expect(otherPanel!.textContent).toContain("Morgan Owner");
  expect(otherPanel!.textContent).toContain("Post Owner");
  expect(otherPanel!.textContent).toContain("WhatsApp");
  expect(otherPanel!.textContent).toContain("+61 400 777 888");
  dom.window.close();
});

it("shows a Copy button for the other participant's shared contact information, carrying the right value", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);
  const applicationId = await makeAcceptedApplication(author, applicant, post.id, "Avery Applicant");

  await author.put(`/api/posts/${post.id}/applicants/${applicationId}/contact`, {
    contactMethod: "phone",
    contactValue: "0412 345 678",
  });

  const dom = await loadPage("/my-activity", applicant.cookie());
  const section = contactSectionFor(dom.window.document, post.id);
  const copyBtn = section!.querySelector(".contact-party-other .copy-contact-btn");

  expect(copyBtn, "Copy button renders next to the other participant's contact value").not.toBeNull();
  expect(copyBtn!.getAttribute("data-copy-value")).toBe("0412 345 678");
  dom.window.close();
});

it("shows a clear empty-state message when the other participant hasn't shared contact details", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author, { authorName: "Casey Owner" });
  await makeAcceptedApplication(author, applicant, post.id, "Devon Applicant");
  // Neither side has saved anything yet.

  const dom = await loadPage("/my-activity", applicant.cookie());
  const section = contactSectionFor(dom.window.document, post.id);
  const otherPanel = section!.querySelector(".contact-party-other");

  expect(otherPanel!.querySelector(".copy-contact-btn")).toBeNull();
  const emptyMessage = otherPanel!.querySelector(".contact-empty")?.textContent ?? "";
  expect(emptyMessage).toContain("Casey Owner");
  expect(emptyMessage.toLowerCase()).toContain("hasn't shared");
  dom.window.close();
});

it("shows my own saved contact method and contact information separately from the other participant's", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);
  const applicationId = await makeAcceptedApplication(author, applicant, post.id, "Ellis Applicant");

  await author.put(`/api/posts/${post.id}/applicants/${applicationId}/contact`, {
    contactMethod: "email",
    contactValue: "owner@example.com",
  });
  await applicant.put(`/api/posts/${post.id}/my-contact`, { contactMethod: "wechat", contactValue: "ellis_wechat" });

  const dom = await loadPage("/my-activity", applicant.cookie());
  const section = contactSectionFor(dom.window.document, post.id);
  const ownPanel = section!.querySelector(".contact-party-own");
  const otherPanel = section!.querySelector(".contact-party-other");

  expect(ownPanel!.textContent).toContain("WeChat");
  expect(ownPanel!.textContent).toContain("ellis_wechat");
  expect(ownPanel!.textContent).not.toContain("owner@example.com");
  expect(otherPanel!.textContent).not.toContain("ellis_wechat");
  dom.window.close();
});

it("lets a user edit their own contact details via the existing save form, overwriting the previous value", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);
  await makeAcceptedApplication(author, applicant, post.id, "Frankie Applicant");

  await applicant.put(`/api/posts/${post.id}/my-contact`, { contactMethod: "phone", contactValue: "old-number" });

  const dom = await loadPage("/my-activity", applicant.cookie());
  const section = contactSectionFor(dom.window.document, post.id);
  const form = section!.querySelector(".contact-form") as HTMLFormElement;
  expect(form, "the save form is present for editing").not.toBeNull();

  const select = form.elements.namedItem("contactMethod") as HTMLSelectElement;
  const input = form.elements.namedItem("contactValue") as HTMLInputElement;
  expect(input.value, "the form is pre-filled with the current saved value").toBe("old-number");

  select.value = "email";
  input.value = "new-email@example.com";
  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));

  await new Promise((resolve) => setTimeout(resolve, 700));

  const successEl = dom.window.document.querySelector(`.post-card[data-post-id="${post.id}"] .contact-success`);
  expect(successEl?.textContent).toBe("Saved.");
  dom.window.close();

  const serverSide = await (await applicant.get(`/api/posts/${post.id}/my-contact`)).json();
  expect(serverSide.own).toMatchObject({ contactMethod: "email", contactValue: "new-email@example.com" });
});

it("applies the same two-panel Contact Details UI consistently on My Posts", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author, { authorName: "Gale Owner" });
  const applicationId = await makeAcceptedApplication(author, applicant, post.id, "Harper Applicant");
  await applicant.put(`/api/posts/${post.id}/my-contact`, { contactMethod: "email", contactValue: "harper@example.com" });

  const dom = await loadPage("/my-activity", author.cookie());
  const toggleBtn = dom.window.document.querySelector(`.applicants-toggle[data-post-id="${post.id}"]`);
  expect(toggleBtn).not.toBeNull();
  toggleBtn!.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 700));

  const section = dom.window.document.querySelector(`.post-card[data-post-id="${post.id}"] .contact-section`);
  expect(section, "Manage Applicants shows the Contact Details section too").not.toBeNull();
  const headings = Array.from(section!.querySelectorAll(".contact-party-heading")).map((h) => h.textContent);
  expect(headings).toEqual(["Other Participant's Contact", "My Contact Details"]);

  const otherPanel = section!.querySelector(".contact-party-other");
  expect(otherPanel!.textContent).toContain("Harper Applicant");
  expect(otherPanel!.textContent).toContain("harper@example.com");
  dom.window.close();
});

it("applies the same two-panel Contact Details UI consistently on a community page's Manage Applicants", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author, { category: "study_together", authorName: "Indigo Owner" });
  await makeAcceptedApplication(author, applicant, post.id, "Jules Applicant");
  await applicant.put(`/api/posts/${post.id}/my-contact`, { contactMethod: "wechat", contactValue: "jules_wechat" });

  const dom = await loadPage("/community/study-together", author.cookie());
  const toggleBtn = dom.window.document.querySelector(`.applicants-toggle[data-post-id="${post.id}"]`);
  expect(toggleBtn).not.toBeNull();
  toggleBtn!.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 700));

  const section = dom.window.document.querySelector(`.post-card[data-post-id="${post.id}"] .contact-section`);
  expect(section).not.toBeNull();
  const headings = Array.from(section!.querySelectorAll(".contact-party-heading")).map((h) => h.textContent);
  expect(headings).toEqual(["Other Participant's Contact", "My Contact Details"]);
  expect(section!.querySelector(".contact-party-other")!.textContent).toContain("jules_wechat");
  dom.window.close();
});

it("never renders a Contact Details section for a pending, declined or cancelled application", async () => {
  const author = session();
  const pendingApplicant = session();
  const declinedApplicant = session();
  const cancelledApplicant = session();
  const post = await makePost(author);

  await pendingApplicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Pending Applicant" });

  const declinedAppId = await (async () => {
    await declinedApplicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Declined Applicant" });
    const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
    const app = list.find((a: { applicantName: string }) => a.applicantName === "Declined Applicant");
    await author.patch(`/api/posts/${post.id}/applicants/${app.id}`, { status: "declined" });
    return app.id;
  })();

  const cancelledAppId = await makeAcceptedApplication(author, cancelledApplicant, post.id, "Cancelled Applicant");
  await author.patch(`/api/posts/${post.id}/applicants/${cancelledAppId}`, { status: "cancelled" });

  // The post owner's Manage Applicants panel: only the (nonexistent, here)
  // accepted/completed row would show Contact Details — none of pending,
  // declined or cancelled should.
  const dom = await loadPage("/my-activity", author.cookie());
  const toggleBtn = dom.window.document.querySelector(`.applicants-toggle[data-post-id="${post.id}"]`);
  toggleBtn!.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 700));

  const rows = Array.from(dom.window.document.querySelectorAll(`.post-card[data-post-id="${post.id}"] .applicant-row`));
  expect(rows.length).toBe(3);
  for (const row of rows) {
    expect(row.querySelector(".contact-section"), `${row.querySelector(".applicant-name")?.textContent} row`).toBeNull();
  }
  dom.window.close();

  // And the declined/cancelled applicants' own cards never show one either.
  const declinedDom = await loadPage("/my-activity", declinedApplicant.cookie());
  expect(
    declinedDom.window.document.querySelector(`.post-card[data-post-id="${post.id}"] .contact-section`),
  ).toBeNull();
  declinedDom.window.close();

  const cancelledDom = await loadPage("/my-activity", cancelledApplicant.cookie());
  expect(
    cancelledDom.window.document.querySelector(`.post-card[data-post-id="${post.id}"] .contact-section`),
  ).toBeNull();
  cancelledDom.window.close();

  void declinedAppId;
});

it("regression: existing Manage Applicants actions and application message still render alongside the redesigned Contact Details", async () => {
  const author = session();
  const applicant = session();
  const post = await makePost(author);
  await applicant.post(`/api/posts/${post.id}/apply`, { applicantName: "Kendall Applicant", message: "Keen to help" });

  const list = await (await author.get(`/api/posts/${post.id}/applicants`)).json();
  await author.patch(`/api/posts/${post.id}/applicants/${list[0].id}`, { status: "accepted" });

  const dom = await loadPage("/my-activity", author.cookie());
  const toggleBtn = dom.window.document.querySelector(`.applicants-toggle[data-post-id="${post.id}"]`);
  toggleBtn!.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 700));

  const row = dom.window.document.querySelector(`.post-card[data-post-id="${post.id}"] .applicant-row`);
  expect(row!.querySelector(".application-message")?.textContent).toContain("Keen to help");
  expect(row!.querySelector(".decide-btn.complete")).not.toBeNull();
  expect(row!.querySelector(".decide-btn.cancel")).not.toBeNull();
  expect(row!.querySelector(".contact-section")).not.toBeNull();
  dom.window.close();
});
