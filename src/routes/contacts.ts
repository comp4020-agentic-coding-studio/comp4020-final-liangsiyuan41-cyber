import type { IncomingMessage, ServerResponse } from "node:http";
import { db } from "../db.ts";
import type { Session } from "../session.ts";

// V1.1 Feature 2: private contact exchange, unlocked only once an
// application has actually been accepted (or completed, which is always
// reached via accepted — see src/routes/applications.ts's ALLOWED_TRANSITIONS
// and docs/adr-0001-concurrent-applications.md). Nothing here is broadcast
// over SSE (see src/events.ts call sites below: there are none) and nothing
// here is ever logged — every handler below only ever writes the JSON
// response, never console.log/error with a request body in it.
const CONTACT_UNLOCKED_STATUSES = new Set(["accepted", "completed"]);

export type ContactMethod = "phone" | "email" | "whatsapp" | "wechat";
const CONTACT_METHODS: readonly ContactMethod[] = ["phone", "email", "whatsapp", "wechat"];

interface ContactRow {
  contact_method: ContactMethod;
  contact_value: string;
  updated_at: string;
}

function serialiseContact(row: ContactRow | undefined) {
  if (!row) return null;
  return { contactMethod: row.contact_method, contactValue: row.contact_value, updatedAt: row.updated_at };
}

const getPostStmt = db.prepare("SELECT id, author_session_id FROM posts WHERE id = ?");
const getApplicationStmt = db.prepare("SELECT id, post_id, status FROM applications WHERE id = ?");
const getApplicationByPostAndSessionStmt = db.prepare(
  "SELECT id, post_id, status FROM applications WHERE post_id = ? AND applicant_session_id = ?",
);
const getContactStmt = db.prepare(
  "SELECT contact_method, contact_value, updated_at FROM contact_details WHERE application_id = ? AND role = ?",
);
const getContactsForApplicationsStmt = db.prepare(`
  SELECT application_id, role, contact_method, contact_value, updated_at
  FROM contact_details
  WHERE application_id IN (SELECT value FROM json_each(?))
`);
const upsertContactStmt = db.prepare(`
  INSERT INTO contact_details (application_id, role, contact_method, contact_value)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(application_id, role) DO UPDATE SET
    contact_method = excluded.contact_method,
    contact_value = excluded.contact_value,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
`);

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

// Loose, platform-neutral validation: enforces a method from the fixed list,
// a sane length, and — only for email — a basic shape check, since "basic
// shape" is the one thing actually specific to that method. Phone, WhatsApp
// and WeChat identifiers vary too much by country/platform to validate more
// strictly than "non-empty, reasonable length" without privileging one
// region's format over another (see the feature's "do not privilege any
// particular platform or nationality" requirement).
function validateContact(b: Record<string, unknown>): { method: ContactMethod; value: string } | null {
  const method = CONTACT_METHODS.includes(b.contactMethod as ContactMethod) ? (b.contactMethod as ContactMethod) : null;
  if (!method) return null;

  const rawValue = typeof b.contactValue === "string" ? b.contactValue.trim() : "";
  if (!rawValue || rawValue.length > 150) return null;

  if (method === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawValue)) return null;

  return { method, value: rawValue };
}

// The post author's view of every accepted/completed applicant's contact
// exchange on one post, in a single request (the Manage Applicants panel
// already lazy-loads the applicant list this way — see post-card.js). Scoped
// to applications the caller owns the post of; an applicant who isn't the
// author gets nothing from this endpoint regardless of what they pass, since
// postId alone decides which applications are even considered.
export function getOwnerContacts(res: ServerResponse, session: Session, postId: number): void {
  const post = getPostStmt.get(postId) as { id: number; author_session_id: string } | undefined;
  if (!post) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "post not found" }));
    return;
  }
  if (post.author_session_id !== session.id) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "only the post author can view contact exchanges" }));
    return;
  }

  const applicationIds = (
    db.prepare("SELECT id, status FROM applications WHERE post_id = ?").all(postId) as {
      id: number;
      status: string;
    }[]
  ).filter((a) => CONTACT_UNLOCKED_STATUSES.has(a.status));

  const result: Record<number, { own: ReturnType<typeof serialiseContact>; other: ReturnType<typeof serialiseContact> }> =
    {};
  if (applicationIds.length > 0) {
    const rows = getContactsForApplicationsStmt.all(JSON.stringify(applicationIds.map((a) => a.id))) as {
      application_id: number;
      role: "owner" | "applicant";
      contact_method: ContactMethod;
      contact_value: string;
      updated_at: string;
    }[];
    for (const { id } of applicationIds) {
      const ownRow = rows.find((r) => r.application_id === id && r.role === "owner");
      const otherRow = rows.find((r) => r.application_id === id && r.role === "applicant");
      result[id] = { own: serialiseContact(ownRow), other: serialiseContact(otherRow) };
    }
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
}

// The post author saving (or updating) their own contact details for one
// specific accepted/completed applicant. Deliberately scoped per application,
// not per author globally, matching the requirement to unlock a contact
// section "for that specific application" — the same author sharing contact
// details with two different accepted applicants saves them twice,
// independently.
export async function saveOwnerContact(
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
  postId: number,
  applicationId: number,
): Promise<void> {
  const post = getPostStmt.get(postId) as { id: number; author_session_id: string } | undefined;
  if (!post) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "post not found" }));
    return;
  }
  if (post.author_session_id !== session.id) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "only the post author can share contact details here" }));
    return;
  }

  const application = getApplicationStmt.get(applicationId) as
    | { id: number; post_id: number; status: string }
    | undefined;
  if (!application || application.post_id !== postId) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "application not found" }));
    return;
  }
  if (!CONTACT_UNLOCKED_STATUSES.has(application.status)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "contact details unlock once this application is accepted" }));
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  const parsed = validateContact(body as Record<string, unknown>);
  if (!parsed) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: `contactMethod must be one of ${CONTACT_METHODS.join(", ")}, and contactValue must be 1-150 characters (a valid-looking address for email)`,
      }),
    );
    return;
  }

  upsertContactStmt.run(applicationId, "owner", parsed.method, parsed.value);

  const saved = getContactStmt.get(applicationId, "owner") as unknown as ContactRow;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(serialiseContact(saved)));

  // No broadcast: contact details are never pushed over SSE (requirement —
  // see src/events.ts). Each side re-fetches explicitly when they open their
  // own Contact Details section.
}

// The applicant's own view of the contact exchange for their own application
// on this post. Scoped by (postId, the caller's own session), the same shape
// as requestCancellation in applications.ts — the applicant's browser only
// ever knows a post id, never another applicant's internal application id,
// so there is no id here another applicant could substitute to reach a
// different application.
export function getApplicantContact(res: ServerResponse, session: Session, postId: number): void {
  const application = getApplicationByPostAndSessionStmt.get(postId, session.id) as
    | { id: number; post_id: number; status: string }
    | undefined;
  if (!application) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "you have no application on this post" }));
    return;
  }
  if (!CONTACT_UNLOCKED_STATUSES.has(application.status)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "contact details unlock once this application is accepted" }));
    return;
  }

  const own = getContactStmt.get(application.id, "applicant") as ContactRow | undefined;
  const other = getContactStmt.get(application.id, "owner") as ContactRow | undefined;

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ own: serialiseContact(own), other: serialiseContact(other) }));
}

// The applicant saving (or updating) their own contact details, for their
// own accepted/completed application on this post only.
export async function saveApplicantContact(
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
  postId: number,
): Promise<void> {
  const application = getApplicationByPostAndSessionStmt.get(postId, session.id) as
    | { id: number; post_id: number; status: string }
    | undefined;
  if (!application) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "you have no application on this post" }));
    return;
  }
  if (!CONTACT_UNLOCKED_STATUSES.has(application.status)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "contact details unlock once this application is accepted" }));
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  const parsed = validateContact(body as Record<string, unknown>);
  if (!parsed) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: `contactMethod must be one of ${CONTACT_METHODS.join(", ")}, and contactValue must be 1-150 characters (a valid-looking address for email)`,
      }),
    );
    return;
  }

  upsertContactStmt.run(application.id, "applicant", parsed.method, parsed.value);

  const saved = getContactStmt.get(application.id, "applicant") as unknown as ContactRow;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(serialiseContact(saved)));
}
