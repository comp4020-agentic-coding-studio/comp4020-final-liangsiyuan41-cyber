import type { ServerResponse } from "node:http";
import type { Session } from "../session.ts";

export function whoami(res: ServerResponse, session: Session): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ displayName: session.displayName }));
}
