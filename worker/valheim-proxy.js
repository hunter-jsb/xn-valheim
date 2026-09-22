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
  // One document per tick: every small block the map polls, plus a revision per
  // large layer so the page asks for a layer only when its picture changed.
  "/state":    { ttl: 2 },
  "/players":  { ttl: 0 },
  "/config":   { ttl: 60 },
  // The layers carry a content revision in ?v= from /state. A request that names a
  // revision can sit on the edge for an hour, since a changed picture has a new
  // name; a request without one keeps the short TTL for pages that poll them plain.
  "/fog":      { ttl: 5, image: true, versioned: true, vttl: 3600 },
  "/chart":    { ttl: 60, image: true, versioned: true, vttl: 86400 },   // one flat biome chart per world
  "/forest": { ttl: 60, image: true, versioned: true, vttl: 3600 },
  "/trails": { ttl: 60, image: true, versioned: true, vttl: 3600 },   // where people walk, a sweep at a time
  "/structures": { ttl: 30, image: true, versioned: true, vttl: 3600 },
  "/stats/players": { ttl: 30 },   // per-player tallies; changes slowly
  "/pieces":  { ttl: 30, versioned: true, vttl: 3600 },        // every placed piece as a footprint; changes only as people build
  "/features": { ttl: 60, versioned: true, vttl: 3600 },       // the world's geography and its names; changes when someone names a place
  "/at":       { ttl: 30, query: true },                        // what is at a spot (?x=&z=), for a click on the map
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
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "authorization, content-type");
  return h;
}

// ---------- writes ----------
// The few things a signed-in member may change. Each is forwarded to the mod with
// the shared write token (WRITE_TOKEN, the mod's announce token) and who did it,
// so the mod never sees Discord and the token never reaches a browser.
const WRITES = new Set(["/names", "/pins"]);   // naming a place; placing, changing or taking up a pin
async function write(request, url, env) {
  const u = await who(request, env);
  if (!u) return json({ error: "sign in first" }, 401);
  if (!env.WRITE_TOKEN) return json({ error: "writes are not configured" }, 503);
  let upstream;
  try {
    upstream = await fetch(UPSTREAM + url.pathname, {
      method: "POST",
      headers: { "content-type": "application/json", "x-announce-token": env.WRITE_TOKEN,
                 "x-user": encodeURIComponent(u.name || ""), "x-user-id": u.id || "" },
      body: await request.text(),
    });
  } catch (e) {
    return json({ error: "upstream unreachable" }, 502);
  }
  const body = await upstream.text();
  return new Response(body, { status: upstream.status,
    headers: { ...Object.fromEntries(cors()), "content-type": "application/json", "cache-control": "no-store" } });
}

// ---------- who you are ----------
// Discord's OAuth2 code flow, with membership of our guild as the gate. The
// session is a signed token the page keeps and sends as a bearer: the site and
// this Worker are different origins, and a cross-site cookie is what Safari and
// Firefox now drop. Nothing is stored here; the signature is the whole state.
// Secrets: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_GUILD_ID, SESSION_SECRET.
const DISCORD = "https://discord.com/api/v10";
const SESSION_DAYS = 30;
const enc = s => new TextEncoder().encode(s);
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const hmac = env => crypto.subtle.importKey("raw", enc(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
async function sign(env, obj) {
  const body = b64u(enc(JSON.stringify(obj)));
  return body + "." + b64u(await crypto.subtle.sign("HMAC", await hmac(env), enc(body)));
}
// the object a token carries, or null when it is missing, forged or expired
async function open(env, token) {
  const i = (token || "").lastIndexOf(".");
  if (i < 0) return null;
  try {
    const body = token.slice(0, i);
    if (!await crypto.subtle.verify("HMAC", await hmac(env), unb64u(token.slice(i + 1)), enc(body))) return null;
    const obj = JSON.parse(new TextDecoder().decode(unb64u(body)));
    return obj.exp > Date.now() / 1000 ? obj : null;
  } catch (e) { return null; }
}
async function who(request, env) {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") || "");
  return m ? open(env, m[1]) : null;
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj),
  { status, headers: { ...Object.fromEntries(cors()), "content-type": "application/json", "cache-control": "no-store" } });
const page = (text, status) => new Response(`<!doctype html><meta charset="utf-8"><title>Sign in</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0f0e;color:#e7e2d4;font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">
<p style="max-width:28rem;padding:1rem">${text} <a href="${[...ALLOWED_ORIGINS][0]}" style="color:#c9a15a">Back to the map</a></p>`,
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

async function auth(request, url, env) {
  if (!env.DISCORD_CLIENT_ID || !env.SESSION_SECRET) return json({ error: "sign-in is not configured" }, 404);
  const back = url.origin + "/auth";              // the one redirect registered on the Discord app
  if (url.pathname === "/auth/login") {
    // the page to return to must be one of ours: the token rides back in its hash
    const to = url.searchParams.get("to") || "";
    let origin = null; try { origin = new URL(to).origin; } catch (e) {}
    if (!origin || !ALLOWED_ORIGINS.has(origin)) return json({ error: "bad return address" }, 400);
    const state = await sign(env, { to, exp: Date.now() / 1000 + 600 });
    const q = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: "code", redirect_uri: back,
      scope: "identify guilds.members.read", state, prompt: "none" });
    return Response.redirect("https://discord.com/oauth2/authorize?" + q, 302);
  }
  if (url.pathname === "/auth") {                 // Discord sends the person back here
    const state = await open(env, url.searchParams.get("state"));
    const code = url.searchParams.get("code");
    if (!state || !code) return page("That sign-in link has expired.", 400);
    const tok = await (await fetch(DISCORD + "/oauth2/token", { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code", code, redirect_uri: back }) })).json();
    if (!tok.access_token) return page("Discord did not accept that sign-in. Try again.", 400);
    const bearer = { headers: { authorization: "Bearer " + tok.access_token } };
    const me = await (await fetch(DISCORD + "/users/@me", bearer)).json();
    // the member record doubles as the gate: a person outside the guild has none
    const member = await (await fetch(`${DISCORD}/users/@me/guilds/${env.DISCORD_GUILD_ID}/member`, bearer)).json();
    if (!me.id || !member.user) return page("You need to be in the server's Discord to sign in.", 403);
    const session = await sign(env, { id: me.id, name: member.nick || me.global_name || me.username,
      avatar: me.avatar || null, roles: member.roles || [], exp: Date.now() / 1000 + SESSION_DAYS * 86400 });
    const dest = new URL(state.to);
    dest.hash = (dest.hash ? dest.hash.slice(1) + "&" : "") + "session=" + session;
    return Response.redirect(dest.toString(), 302);
  }
  if (url.pathname === "/auth/me") {
    const u = await who(request, env);
    return json(u ? { id: u.id, name: u.name, avatar: u.avatar, exp: u.exp } : {}, u ? 200 : 401);
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    if (request.method === "POST" && WRITES.has(url.pathname)) return write(request, url, env);
    if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: cors() });

    if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) return auth(request, url, env);

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


    const ttl = route.versioned && url.search && route.vttl ? route.vttl : route.ttl;
    let upstream;
    try {
      // cacheTtlByStatus, never a blanket cacheTtl: with cacheEverything a flat TTL
      // caches errors too, and one fetch during a restart then poisons that edge
      // for the whole TTL -- which reads as "the map is broken for one player".
      upstream = await fetch(UPSTREAM + (route.upstream || url.pathname) + (route.versioned || route.query ? url.search : ""), {
        method: "GET",
        cf: ttl
          ? { cacheEverything: true,
              cacheTtlByStatus: { "200-299": ttl, "300-399": 0, "400-499": 0, "500-599": 0 } }
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
    headers.set("cache-control", ttl ? `public, max-age=${ttl}` : "no-store");
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
