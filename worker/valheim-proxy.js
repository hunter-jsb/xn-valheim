// Cloudflare Worker: HTTPS + CORS front for the Valheim WebMap mod.
//
// The site is HTTPS and the mod speaks plain HTTP on a bare IP, so a browser
// can't fetch it directly (mixed content, and the mod sends no CORS header).
// A Worker can: it fetches server-side, where neither rule applies, and returns
// the bytes with a CORS header. That removes the need to poll-and-commit
// snapshots, so the page can read live data every few seconds.

const UPSTREAM = "http://170-23-227-3.sslip.io:27021"; // Workers refuse fetch() to a bare IP (error 1003)
const ALLOWED_ORIGINS = new Set([
  "https://hunter-jsb.github.io",
  "http://localhost:8899", // local preview
]);

// Only these are proxied. Everything else 404s, so this can't be used as an
// open relay to arbitrary hosts or paths.
const ROUTES = {
  "/messages": { ttl: 0 },
  "/players":  { ttl: 0 },
  "/pins":     { ttl: 0 },
  "/config":   { ttl: 60 },
  "/fog":      { ttl: 5, image: true },
  "/forest": { ttl: 60, image: true },
  "/forest/stats": { ttl: 30 },
  "/structures": { ttl: 30, image: true },
  "/structures/refresh": { ttl: 0 },
  "/structures/stats": { ttl: 10 },
  // boats and carts move; freshness comes from nudging the sweep below
  "/vehicles": { ttl: 3, nudge: true },
  "/portals": { ttl: 30 },        // portals move only when someone rebuilds one
  "/graves":  { ttl: 30 },        // a grave appears on a death and goes when it is emptied
  // The unfogged world render. Deliberately not at /map: the honour system is
  // the actual policy, this just avoids leaving a one-click URL lying around.
  // versioned: the page's ?v= is forwarded, so it is part of the edge cache key and a
  // new render is reachable the moment the page bumps it -- no route renaming, no purge
  "/base-6f3a9c2e": { ttl: 86400, upstream: "/map.jpg", noNavigate: true, image: true, versioned: true },
};

// Wildcard rather than echoing Origin: these responses are edge-cached, and a
// cached per-origin header would be served to the wrong origin. The data is
// public regardless, and the path allowlist is what stops this being a relay.
function cors() {
  const h = new Headers();
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  return h;
}

// The mod rebuilds vehicle positions only when its world sweep runs, every two
// minutes, and that sweep walks ~370k ZDOs on the same CPU as the game -- so it
// is not something to simply run more often. Instead a request for /vehicles
// asks for one, at most once per NUDGE_SECONDS, so sweeps happen while someone
// is actually watching the map and not at all when nobody is.
//
// Only a real page view asks: the nudge is gated on the site's own Origin, so a
// scraper or a bare curl reads whatever is current and never costs a sweep.
//
// The rate limit is the edge cache holding the refresh response itself -- the
// same mechanism the routes above use, rather than the Cache API, which is
// documented as a no-op on workers.dev and would fail open, turning every poll
// into a sweep. Still per-PoP: viewers on different continents each get their
// own window. Bounding it globally needs server-side state; this is
// deliberately the cheap version, and an in-progress sweep refuses a second.
const NUDGE_SECONDS = 90;
function nudgeSweep(ctx) {
  ctx.waitUntil(
    fetch(UPSTREAM + "/structures/refresh", {
      cf: { cacheEverything: true,
            cacheTtlByStatus: { "200-299": NUDGE_SECONDS, "300-399": 0,
                                "400-499": 0, "500-599": 0 } },
    }).catch(() => {}));                     // a missed nudge just means stale data
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, upstream: UPSTREAM, routes: Object.keys(ROUTES) }),
        { headers: { ...Object.fromEntries(cors()), "content-type": "application/json" } });
    }

    const route = ROUTES[url.pathname];
    if (!route) return new Response("not found", { status: 404, headers: cors() });

    // Pasting this into an address bar is a document request; the page's <img>
    // is not. Refuse the former so the whole map isn't one click from curiosity.
    if (route.noNavigate && request.headers.get("Sec-Fetch-Dest") === "document") {
      return new Response("not found", { status: 404, headers: cors() });
    }

    if (route.nudge && ctx && ALLOWED_ORIGINS.has(request.headers.get("Origin"))) {
      try { nudgeSweep(ctx); } catch (e) {}
    }

    let upstream;
    try {
      // cacheTtlByStatus, never a blanket cacheTtl: with cacheEverything a flat TTL
      // caches errors too, and one fetch during a restart then poisons that edge
      // for the whole TTL -- which reads as "the map is broken for one player".
      upstream = await fetch(UPSTREAM + (route.upstream || url.pathname) + (route.versioned ? url.search : ""), {
        method: "GET",
        cf: route.ttl
          ? { cacheEverything: true,
              cacheTtlByStatus: { "200-299": route.ttl, "300-399": 0, "400-499": 0, "500-599": 0 } }
          : { cacheTtl: 0 },
      });
    } catch (e) {
      // The game server being down must not look like the Worker being broken.
      return new Response(JSON.stringify({ error: "upstream unreachable" }),
        { status: 502, headers: { ...Object.fromEntries(cors()), "content-type": "application/json" } });
    }

    // A 2xx is not enough: the mod answers 200 with an empty body until a texture
    // has rendered once, and cached, that is a broken image for the whole TTL.
    // Images only -- an empty /pins just means nobody has placed one.
    if (route.image && upstream.headers.get("content-length") === "0") {
      return new Response(JSON.stringify({ error: "not rendered yet" }),
        { status: 503, headers: { ...Object.fromEntries(cors()),
                                  "content-type": "application/json",
                                  "cache-control": "no-store" } });
    }

    const headers = cors();
    const ct = upstream.headers.get("content-type");
    // the mod misspells this one as "applicaion/json"
    headers.set("content-type", ct && !ct.startsWith("applicaion") ? ct : "application/json");
    headers.set("cache-control", route.ttl ? `public, max-age=${route.ttl}` : "no-store");
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
