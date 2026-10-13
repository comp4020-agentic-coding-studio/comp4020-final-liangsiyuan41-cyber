// Sanity check: with several simultaneous SSE listeners open (closer to
// "a pod of classmates testing at once" than a single pair), does delivery
// stay fast for all of them? Ad-hoc, not part of spec/.
const BASE = "http://localhost:8099";

function makeSession() {
  let cookie = "";
  const fetchWithCookie = async (path, opts = {}) => {
    const res = await fetch(new URL(path, BASE), { ...opts, headers: { ...(opts.headers ?? {}), cookie } });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return res;
  };
  async function openEvents(onEvent) {
    const res = await fetchWithCookie("/events");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const eventLine = chunk.split("\n").find((l) => l.startsWith("event: "));
          if (eventLine) onEvent(eventLine.slice(7), performance.now());
        }
      }
    })();
    return () => reader.cancel();
  }
  return { fetchWithCookie, openEvents };
}

async function main() {
  const N = 10;
  const listeners = Array.from({ length: N }, () => makeSession());
  const arrivals = listeners.map(() => []);
  const closers = await Promise.all(
    listeners.map((s, i) => s.openEvents((event, t) => arrivals[i].push({ event, t }))),
  );

  await new Promise((r) => setTimeout(r, 300));

  const poster = makeSession();
  const t0 = performance.now();
  await poster.fetchWithCookie("/api/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      authorName: "Henry",
      category: "social_connect",
      title: "Fan-out check",
      description: "Testing delivery to many open tabs",
      isPaid: false,
    }),
  });

  await new Promise((r) => setTimeout(r, 400));

  const deliveries = arrivals.map((events, i) => {
    const e = events.find((ev) => ev.event === "post:created");
    return e ? e.t - t0 : null;
  });
  console.log(`delivered to ${deliveries.filter((d) => d !== null).length}/${N} listeners`);
  console.log("latencies (ms):", deliveries.map((d) => d?.toFixed(0)));
  console.log("max latency:", Math.max(...deliveries.filter((d) => d !== null)).toFixed(0), "ms");

  closers.forEach((c) => c());
}

main().then(() => process.exit(0));
