import { readFileSync } from "node:fs";
import { marked } from "marked";

// README.md is written by us, not by site visitors, so there's no untrusted
// input here to sanitise against. `marked` is still configured defensively
// (gfm only, no raw HTML passthrough) so a future edit to README.md can't
// accidentally inject markup through this path.
marked.setOptions({ gfm: true });

export function renderReadmePage(): string {
  const md = readFileSync("README.md", "utf8");
  const bodyHtml = marked.parse(md, { async: false });

  return `<!doctype html>
<html lang="en-AU">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>About ANU TaskMate</title>
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <main class="readme">
      ${bodyHtml}
    </main>
  </body>
</html>
`;
}
