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
  "/locations": { ttl: 60 },                                   // the world's explored locations, for the tour; rebuilt each sweep
  "/at":       { ttl: 30, query: true },                        // what is at a spot (?x=&z=), for a click on the map
  // The 3D view: a 256 m chunk's ground and objects by ?cx=&cz=, the model library's
  // index. The page names rev.height / rev.objects / rev.models from /state as ?v=, so a
  // chunk can sit on the edge for an hour; an unwalked chunk's 404 is never kept.
  "/height":   { ttl: 30, query: true, versioned: true, vttl: 3600 },
  "/objects":  { ttl: 30, query: true, versioned: true, vttl: 3600 },
  "/prefabs":  { ttl: 30, versioned: true, vttl: 3600 },
  // The unfogged world render. Deliberately not at /map: the honour system is
  // the actual policy, this just avoids leaving a one-click URL lying around.
  // versioned: the page's ?v= is forwarded, so it is part of the edge cache key and a
  // new render is reachable the moment the page bumps it -- no route renaming, no purge
  "/base-6f3a9c2e": { ttl: 86400, upstream: "/map.jpg", noNavigate: true, image: true, versioned: true },
};
// The model library's files, /models/<hash>.glb and /models/tex_<name>.png: generic game
// models, the same for every world, and named by content (a model's ?v= is its hash).
// The mod itself refuses any name that is not one of those two shapes.
const MODELS = { ttl: 86400, versioned: true, vttl: 86400 };

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
const WRITES = new Set(["/names", "/pins", "/settings", "/discord/guilds", "/discord/channels"]);   // naming a place; a pin; a setting; the settings picker (admins)
const ADMIN = new Set(["/settings", "/discord/guilds", "/discord/channels"]);                            // what only the Discord admin role may touch
// An admin is the guild's owner, a member with a role that carries Discord's own
// administrator permission, or one with the role DISCORD_ADMIN_ROLE names. The
// guild is read once in a while; for anything that matters the member is read
// again, so a role taken away bites at once.
let guild = { at: 0, owner: null, admins: new Set() };
async function guildInfo(env) {
  if (Date.now() - guild.at < 300000 || !env.DISCORD_BOT_TOKEN) return guild;
  try {
    const h = { headers: { authorization: "Bot " + env.DISCORD_BOT_TOKEN } };
    const g = await (await fetch(`${DISCORD}/guilds/${env.DISCORD_GUILD_ID}`, h)).json();
    const roles = await (await fetch(`${DISCORD}/guilds/${env.DISCORD_GUILD_ID}/roles`, h)).json();
    const admins = new Set((Array.isArray(roles) ? roles : []).filter(r => (BigInt(r.permissions || "0") & 8n) !== 0n || r.id === env.DISCORD_ADMIN_ROLE).map(r => r.id));
    if (env.DISCORD_ADMIN_ROLE) admins.add(env.DISCORD_ADMIN_ROLE);
    guild = { at: Date.now(), owner: g.owner_id || null, admins };
  } catch (e) {}
  return guild;
}
async function admin(u, env, live) {
  if (!u) return false;
  const g = await guildInfo(env);
  let roles = u.roles || [];
  if (live && env.DISCORD_BOT_TOKEN) {
    try {
      const m = await (await fetch(`${DISCORD}/guilds/${env.DISCORD_GUILD_ID}/members/${u.id}`,
        { headers: { authorization: "Bot " + env.DISCORD_BOT_TOKEN } })).json();
      if (!m.user) return false;                        // no longer in the guild
      roles = m.roles || [];
    } catch (e) { return false; }
  }
  return u.id === g.owner || roles.some(r => g.admins.has(r)) || (!!env.DISCORD_ADMIN_ROLE && roles.includes(env.DISCORD_ADMIN_ROLE));
}
// The mod itself posts what happened to the log channel now (Discord.Tell); this
// just forwards the write and the admin check. The mod's answer still carries a
// "log" field for a caller that wants it -- harmless, just unused here.
async function write(request, url, env) {
  const u = await who(request, env);
  if (!u) return json({ error: "sign in first" }, 401);
  if (!env.WRITE_TOKEN) return json({ error: "writes are not configured" }, 503);
  const needsAdmin = ADMIN.has(url.pathname);
  if (needsAdmin && !await admin(u, env, true)) return json({ error: "admins only" }, 403);
  let upstream;
  try {
    upstream = await fetch(UPSTREAM + url.pathname + (request.method === "GET" ? url.search : ""), {
      method: request.method,
      headers: { "content-type": "application/json", "x-announce-token": env.WRITE_TOKEN,
                 "x-user": encodeURIComponent(u.name || ""), "x-user-id": u.id || "", ...(needsAdmin ? { "x-admin": "1" } : {}) },
      body: request.method === "POST" ? await request.text() : undefined,
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
// Secrets: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_GUILD_ID, SESSION_SECRET,
// and AUTH_PRIVATE_KEY (PKCS8, base64) for the maps that sign in from elsewhere.
const DISCORD = "https://discord.com/api/v10";
const SESSION_DAYS = 30, ELSEWHERE_DAYS = 7;   // a map elsewhere cannot ask us whether someone is still an admin, so its sessions are short
const enc = s => new TextEncoder().encode(s);
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
// A sign-in's state and a session are signed under different keys: a state is
// handed to anyone who asks for the login page, and must never pass for a session.
const hmac = (env, kind) => crypto.subtle.importKey("raw", enc(env.SESSION_SECRET + (kind ? "\n" + kind : "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
async function sign(env, obj, kind) {
  const body = b64u(enc(JSON.stringify(obj)));
  return body + "." + b64u(await crypto.subtle.sign("HMAC", await hmac(env, kind), enc(body)));
}
// the object a token carries, or null when it is missing, forged or expired
async function open(env, token, kind) {
  const i = (token || "").lastIndexOf(".");
  if (i < 0) return null;
  try {
    const body = token.slice(0, i);
    if (!await crypto.subtle.verify("HMAC", await hmac(env, kind), unb64u(token.slice(i + 1)), enc(body))) return null;
    const obj = JSON.parse(new TextDecoder().decode(unb64u(body)));
    return obj.exp > Date.now() / 1000 ? obj : null;
  } catch (e) { return null; }
}
// A map the mod serves on its own address cannot hold a secret of ours, so its
// session is signed with a private key here and checked there with the public one
// the mod ships (worker/auth-public.pem).
let rsaKey = null;
const rsa = async env => rsaKey || (rsaKey = await crypto.subtle.importKey("pkcs8",
  Uint8Array.from(atob(env.AUTH_PRIVATE_KEY), c => c.charCodeAt(0)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]));
async function signFor(env, obj) {
  const body = b64u(enc(JSON.stringify(obj)));
  return body + "." + b64u(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await rsa(env), enc(body)));
}
const cookie = (request, name) => (new RegExp("(?:^|;\\s*)" + name + "=([^;]+)").exec(request.headers.get("cookie") || "") || [])[1] || null;
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
async function who(request, env) {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") || "");
  const u = m ? await open(env, m[1]) : null;
  return u && typeof u.id === "string" && u.id ? u : null;      // a session names someone
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj),
  { status, headers: { ...Object.fromEntries(cors()), "content-type": "application/json", "cache-control": "no-store" } });
const SHELL = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0f0e;color:#e7e2d4;font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">`;
const PAGE_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", "referrer-policy": "no-referrer" };
const page = (text, status, back) => new Response(`${SHELL}
<p style="max-width:28rem;padding:1rem">${text} <a href="${escHtml(back || [...ALLOWED_ORIGINS][0])}" style="color:#c9a15a">Back to the map</a></p>`,
  { status, headers: PAGE_HEADERS });

// ---------- sign-in for maps elsewhere ----------
// Any server running the mod signs in through here: its map sends the person along
// with the guild that gates it, and gets them back with a session only that map
// will take (aud). The page in between names where the session is going and wants
// a click, so no site can pull a visitor's Discord name through here in silence;
// the cookie ties that click to the browser that was shown the page.
async function elsewhere(url, env, to, origin, gid) {
  if (!env.AUTH_PRIVATE_KEY) return json({ error: "sign-in for other maps is not configured" }, 404);
  if (!origin || url.searchParams.get("aud") !== origin || !/^\d{15,22}$/.test(gid)) return json({ error: "bad return address" }, 400);
  const n = b64u(crypto.getRandomValues(new Uint8Array(18)));
  const state = await sign(env, { to, gid, aud: origin, n, exp: Date.now() / 1000 + 600 }, "state");
  const btn = "display:inline-block;padding:.55rem 1.1rem;border-radius:8px;text-decoration:none;font-weight:600";
  return new Response(`${SHELL}
<div style="max-width:30rem;padding:1.2rem">
<p style="font-size:1.15rem;font-weight:700;margin:0 0 .4rem">Sign in to this map with Discord?</p>
<p style="margin:0 0 .3rem;color:#c9a15a;word-break:break-all">${escHtml(origin)}</p>
<p style="margin:0 0 1.1rem;color:#a9a493;font-size:.9rem">It will learn your Discord name, your picture and your roles in its server. Only members of that server can sign in.</p>
<a href="/auth/go?state=${encodeURIComponent(state)}" style="${btn};background:#c9a15a;color:#16140f">Continue</a>
<a href="${escHtml(to)}" style="${btn};color:#a9a493">Cancel</a></div>`,
    { status: 200, headers: { ...PAGE_HEADERS, "set-cookie": `xnv_n=${n}; Path=/auth; Max-Age=600; Secure; HttpOnly; SameSite=Lax` } });
}
// the guild among the person's own, for whether they own it and what they may do there
async function guildOf(bearer, gid) {
  let after = "";
  for (let i = 0; i < 3; i++) {
    const list = await (await fetch(`${DISCORD}/users/@me/guilds?limit=200${after ? "&after=" + after : ""}`, bearer)).json();
    if (!Array.isArray(list)) return null;
    const g = list.find(x => x.id === gid);
    if (g || list.length < 200) return g || null;
    after = list[list.length - 1].id;
  }
  return null;
}

async function auth(request, url, env) {
  if (!env.DISCORD_CLIENT_ID || !env.SESSION_SECRET) return json({ error: "sign-in is not configured" }, 404);
  const back = url.origin + "/auth";              // the one redirect registered on the Discord app
  if (url.pathname === "/auth/login") {
    // the page to return to must be one of ours: the token rides back in its hash
    const to = url.searchParams.get("to") || "", gid = url.searchParams.get("guild");
    let origin = null; try { const t = new URL(to); if (t.protocol === "https:" || t.protocol === "http:") origin = t.origin; } catch (e) {}
    if (gid !== null) return elsewhere(url, env, to, origin, gid);
    if (!origin || !ALLOWED_ORIGINS.has(origin)) return json({ error: "bad return address" }, 400);
    const state = await sign(env, { to, exp: Date.now() / 1000 + 600 }, "state");
    const q = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: "code", redirect_uri: back,
      scope: "identify guilds.members.read", state, prompt: "none" });
    return Response.redirect("https://discord.com/oauth2/authorize?" + q, 302);
  }
  if (url.pathname === "/auth/go") {              // the click on the page elsewhere() showed
    const raw = url.searchParams.get("state"), state = await open(env, raw, "state");
    if (!state || !state.to || !state.gid || cookie(request, "xnv_n") !== state.n) return page("That sign-in link has expired.", 400, state && state.aud);
    const q = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: "code", redirect_uri: back,
      scope: "identify guilds guilds.members.read", state: raw, prompt: "none" });
    return Response.redirect("https://discord.com/oauth2/authorize?" + q, 302);
  }
  if (url.pathname === "/auth") {                 // Discord sends the person back here
    const state = await open(env, url.searchParams.get("state"), "state");
    const code = url.searchParams.get("code");
    if (!state || !state.to || !code) return page("That sign-in link has expired.", 400, state && state.aud);
    if (state.gid && cookie(request, "xnv_n") !== state.n) return page("That sign-in link has expired.", 400, state.aud);
    const tok = await (await fetch(DISCORD + "/oauth2/token", { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code", code, redirect_uri: back }) })).json();
    if (!tok.access_token) return page("Discord did not accept that sign-in. Try again.", 400, state.aud);
    const bearer = { headers: { authorization: "Bearer " + tok.access_token } };
    const me = await (await fetch(DISCORD + "/users/@me", bearer)).json();
    // the member record doubles as the gate: a person outside the guild has none
    const member = await (await fetch(`${DISCORD}/users/@me/guilds/${state.gid || env.DISCORD_GUILD_ID}/member`, bearer)).json();
    if (!me.id || !member.user) return page(state.gid ? "You need to be in this map's Discord server to sign in." : "You need to be in the server's Discord to sign in.", 403, state.aud);
    const mine = { id: me.id, name: member.nick || me.global_name || me.username, avatar: me.avatar || null, roles: member.roles || [] };
    let session;
    if (state.gid) {                              // a map elsewhere: it decides who is an admin, from what Discord says of them
      const g = await guildOf(bearer, state.gid);
      session = await signFor(env, { ...mine, owner: !!(g && g.owner), perms: String((g && g.permissions) || "0"),
        guild: state.gid, aud: state.aud, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ELSEWHERE_DAYS * 86400 });
    } else session = await sign(env, { ...mine, exp: Date.now() / 1000 + SESSION_DAYS * 86400 });
    const dest = new URL(state.to);
    dest.hash = (dest.hash ? dest.hash.slice(1) + "&" : "") + "session=" + session;
    return Response.redirect(dest.toString(), 302);
  }
  if (url.pathname === "/auth/me") {
    const u = await who(request, env);
    return json(u ? { id: u.id, name: u.name, avatar: u.avatar, exp: u.exp, admin: await admin(u, env, false) } : {}, u ? 200 : 401);
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    if (WRITES.has(url.pathname) && (request.method === "POST" || ADMIN.has(url.pathname))) return write(request, url, env);
    if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: cors() });

    if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) return auth(request, url, env);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, upstream: UPSTREAM, routes: Object.keys(ROUTES) }),
        { headers: { ...Object.fromEntries(cors()), "content-type": "application/json" } });
    }

    const route = ROUTES[url.pathname] || (url.pathname.startsWith("/models/") ? MODELS : null);
    if (!route) return new Response("not found", { status: 404, headers: cors() });

    // Pasting this into an address bar is a document request; the page's <img>
    // is not. Refuse the former so the whole map isn't one click from curiosity.
    if (route.noNavigate && request.headers.get("Sec-Fetch-Dest") === "document") {
      return new Response("not found", { status: 404, headers: cors() });
    }


    // a named revision, not merely a query: /height's ?cx=&cz= alone must not sit for an hour
    const ttl = route.versioned && url.searchParams.has("v") && route.vttl ? route.vttl : route.ttl;
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
    headers.set("content-type", ct || "application/json");
    headers.set("cache-control", ttl ? `public, max-age=${ttl}` : "no-store");
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
