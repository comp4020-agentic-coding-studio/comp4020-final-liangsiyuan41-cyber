import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import "./db.ts";
import { resolveSession } from "./session.ts";
import { addClient } from "./events.ts";
import { listPosts, createPost } from "./routes/posts.ts";
import { applyToPost, listApplicants, setApplicationStatus } from "./routes/applications.ts";
import { whoami } from "./routes/whoami.ts";
import { renderReadmePage } from "./readme.ts";

const PORT = Number(process.env.PORT ?? 8080);

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
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

  if (pathname === "/" && req.method === "GET") {
    await serveStatic("/index.html", res);
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
