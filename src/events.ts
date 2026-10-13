import type { ServerResponse } from "node:http";

const clients = new Set<ServerResponse>();

export function addClient(res: ServerResponse): void {
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

// Fan-out only: tells open tabs *something* changed so they can re-fetch the
// authoritative data (see docs/adr-0001-concurrent-applications.md on why the
// event itself never carries state clients should trust as final).
export function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}
