import type { IncomingMessage, ServerResponse } from "node:http";
import { db } from "../db.ts";
import { broadcast } from "../events.ts";
import { setDisplayName, type Session } from "../session.ts";

const CATEGORIES = ["campus_help", "study_together", "social_connect", "campus_events"] as const;
export type Category = (typeof CATEGORIES)[number];

interface PostRow {
  id: number;
  author_session_id: string;
  author_name: string;
  category: Category;
  title: string;
  description: string;
  is_paid: number;
  amount: string | null;
  created_at: string;
}

const listPostsStmt = db.prepare(`
  SELECT p.*, COUNT(a.id) AS application_count
  FROM posts p
  LEFT JOIN applications a ON a.post_id = p.id
  GROUP BY p.id
  ORDER BY p.created_at DESC
`);

const insertPostStmt = db.prepare(`
  INSERT INTO posts (author_session_id, author_name, category, title, description, is_paid, amount)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const getPostStmt = db.prepare("SELECT * FROM posts WHERE id = ?");

function serialisePost(row: PostRow & { application_count: number }) {
  return {
    id: row.id,
    authorName: row.author_name,
    category: row.category,
    title: row.title,
    description: row.description,
    isPaid: Boolean(row.is_paid),
    amount: row.amount,
    createdAt: row.created_at,
    applicationCount: row.application_count,
  };
}

export function listPosts(_req: IncomingMessage, res: ServerResponse): void {
  const rows = listPostsStmt.all() as unknown as (PostRow & { application_count: number })[];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(rows.map(serialisePost)));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export async function createPost(req: IncomingMessage, res: ServerResponse, session: Session): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  const b = body as Record<string, unknown>;
  const authorName = isNonEmptyString(b.authorName) ? b.authorName.trim().slice(0, 80) : null;
  const category = CATEGORIES.includes(b.category as Category) ? (b.category as Category) : null;
  const title = isNonEmptyString(b.title) ? b.title.trim().slice(0, 120) : null;
  const description = isNonEmptyString(b.description) ? b.description.trim().slice(0, 2000) : null;
  const isPaid = b.isPaid === true;
  const amount = isPaid && isNonEmptyString(b.amount) ? b.amount.trim().slice(0, 40) : null;

  if (!authorName || !category || !title || !description) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "authorName, category, title and description are required" }));
    return;
  }

  setDisplayName(session.id, authorName);

  const result = insertPostStmt.run(session.id, authorName, category, title, description, isPaid ? 1 : 0, amount);
  const row = getPostStmt.get(result.lastInsertRowid) as unknown as PostRow;
  const post = serialisePost({ ...row, application_count: 0 });

  res.writeHead(201, { "Content-Type": "application/json" });
  res.end(JSON.stringify(post));

  broadcast("post:created", post);
}
