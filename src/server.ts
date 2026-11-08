import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import "./db.ts";
import { resolveSession } from "./session.ts";
import { addClient } from "./events.ts";
import { listPosts, createPost } from "./routes/posts.ts";
import { applyToPost, listApplicants, setApplicationStatus, requestCancellation } from "./routes/applications.ts";
import { getOwnerContacts, saveOwnerContact, getApplicantContact, saveApplicantContact } from "./routes/contacts.ts";
import { whoami } from "./routes/whoami.ts";
import { renderReadmePage } from "./readme.ts";

const PORT = Number(process.env.PORT ?? 8080);

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// Real, independently navigable routes for the four community pages — each
// one is a server-returned HTML document, not a client-side route, so a
// direct open, a refresh, and the browser's own back/forward all work the
// same way they do for any traditional multi-page site, with no router to
// get wrong. The slug in the URL is a presentation detail only; it's mapped
// to the file here and nowhere else (the category values posts are actually
// stored and filtered under remain exactly what src/routes/posts.ts already
// uses — see public/app.js's per-page data-category attribute).
const COMMUNITY_PAGES: Record<string, string> = {
  "/community/campus-help": "/community/campus-help.html",
  "/community/study-together": "/community/study-together.html",
  "/community/social-connect": "/community/social-connect.html",
  "/community/campus-events": "/community/campus-events.html",
};

// Part 2: the posting form and the My Activity view each get their own real,
// directly-navigable route too, the same reasoning as COMMUNITY_PAGES above.
const STANDALONE_PAGES: Record<string, string> = {
  "/create": "/create.html",
  "/my-activity": "/my-activity.html",
};

async function serveStatic(path: string, res: ServerResponse): Promise<boolean> {
  try {
    const data = await readFile(`public${path}`);
    res.writeHead(200, { "Content-Type": STATIC_TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://internal");
  const { pathname } = url;

  if (pathname === "/readme/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderReadmePage());
    return;
  }

  if (pathname === "/events" && req.method === "GET") {
    resolveSession(req, res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    addClient(res);
    return;
  }

  if (pathname === "/api/whoami" && req.method === "GET") {
    const session = resolveSession(req, res);
    whoami(res, session);
    return;
  }

  if (pathname === "/api/posts" && req.method === "GET") {
    const session = resolveSession(req, res);
    listPosts(req, res, session);
    return;
  }

  if (pathname === "/api/posts" && req.method === "POST") {
    const session = resolveSession(req, res);
    await createPost(req, res, session);
    return;
  }

  const applyMatch = pathname.match(/^\/api\/posts\/(\d+)\/apply$/);
  if (applyMatch && req.method === "POST") {
    const session = resolveSession(req, res);
    await applyToPost(req, res, session, Number(applyMatch[1]));
    return;
  }

  const applicantsMatch = pathname.match(/^\/api\/posts\/(\d+)\/applicants$/);
  if (applicantsMatch && req.method === "GET") {
    const session = resolveSession(req, res);
    listApplicants(res, session, Number(applicantsMatch[1]));
    return;
  }

  const decisionMatch = pathname.match(/^\/api\/posts\/(\d+)\/applicants\/(\d+)$/);
  if (decisionMatch && req.method === "PATCH") {
    const session = resolveSession(req, res);
    await setApplicationStatus(req, res, session, Number(decisionMatch[1]), Number(decisionMatch[2]));
    return;
  }

  const cancellationMatch = pathname.match(/^\/api\/posts\/(\d+)\/cancellation-request$/);
  if (cancellationMatch && req.method === "POST") {
    const session = resolveSession(req, res);
    await requestCancellation(req, res, session, Number(cancellationMatch[1]));
    return;
  }

  // V1.1 Feature 2: private contact exchange. Two pairs of routes — one for
  // the post author (scoped to a specific application they received), one
  // for an applicant (scoped to their own application on this post, the same
  // "no application id in the URL" shape requestCancellation above uses).
  const ownerContactsMatch = pathname.match(/^\/api\/posts\/(\d+)\/contacts$/);
  if (ownerContactsMatch && req.method === "GET") {
    const session = resolveSession(req, res);
    getOwnerContacts(res, session, Number(ownerContactsMatch[1]));
    return;
  }

  const ownerContactSaveMatch = pathname.match(/^\/api\/posts\/(\d+)\/applicants\/(\d+)\/contact$/);
  if (ownerContactSaveMatch && req.method === "PUT") {
    const session = resolveSession(req, res);
    await saveOwnerContact(req, res, session, Number(ownerContactSaveMatch[1]), Number(ownerContactSaveMatch[2]));
    return;
  }

  const myContactMatch = pathname.match(/^\/api\/posts\/(\d+)\/my-contact$/);
  if (myContactMatch && req.method === "GET") {
    const session = resolveSession(req, res);
    getApplicantContact(res, session, Number(myContactMatch[1]));
    return;
  }
  if (myContactMatch && req.method === "PUT") {
    const session = resolveSession(req, res);
    await saveApplicantContact(req, res, session, Number(myContactMatch[1]));
    return;
  }

  if (pathname === "/" && req.method === "GET") {
    await serveStatic("/index.html", res);
    return;
  }

  const communityFile = COMMUNITY_PAGES[pathname];
  if (communityFile && req.method === "GET") {
    await serveStatic(communityFile, res);
    return;
  }

  const standaloneFile = STANDALONE_PAGES[pathname];
  if (standaloneFile && req.method === "GET") {
    await serveStatic(standaloneFile, res);
    return;
  }

  if (req.method === "GET" && (await serveStatic(pathname, res))) {
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("unhandled request error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal server error" }));
    } else {
      res.end();
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ANU TaskMate listening on 0.0.0.0:${PORT}`);
});
