/* map-core.js — the world map, shared by the live map and the planning board.
 *
 * The rendering rule: everything crisp is blitted or stroked into one
 * screen-space canvas per view change, never scaled by a CSS transform. Under a
 * transform Chrome GPU-scales a 1:1 raster with bilinear filtering (12 m pixels
 * came out a smear, and image-rendering cannot reach that path) and caps how
 * finely it rasterises a 2048 px vector layer (builds came out as blobs). Drawn
 * at 1:1 against the current view, both stay sharp at any zoom.
 *
 * One global, no modules, no build step: two pages load it with a plain script tag.
 */
const MapCore = (() => {
"use strict";

// ---------- geometry ----------
// The map is a square texture of the world: 2048 px at 12 m a pixel, per /config.
const geom = {pixel: 12, size: 2048, world: "Mothership"};
function setGeom(c){
  c = c || {};
  geom.pixel = c.pixel_size || 12;
  geom.size  = c.texture_size || 2048;
  geom.world = c.world_name || "Mothership";
  return geom;
}
// world -> texture pixels, the same transform the mod's own UI uses
function toPx(x, z){ return {px: x/geom.pixel + geom.size/2, py: geom.size/2 - z/geom.pixel}; }
function toWorld(px, py){ return {x: (px - geom.size/2)*geom.pixel, z: (geom.size/2 - py)*geom.pixel}; }

// Roofs until zoom 16: below that a 2 m piece is under 3 px and a floor plan
// would be a smudge. At 120 a 2 m piece is 20 px and a plan can be read.
const PLAN_ZOOM = 16, MAX_ZOOM = 120;

// ---------- the server, through the Worker ----------
// No committed snapshots: both pages read the game server through a Cloudflare
// Worker that adds HTTPS + CORS.
async function api(base, path){
  const r = await fetch(base + path, {cache: "no-store"});
  if(!r.ok) throw new Error(path + " " + r.status);
  return r;
}
const fetchJSON = (base, path) => api(base, path).then(r => r.json());
// One document per tick carries every small block a page shows, plus a revision
// per large layer.
const fetchState = base => fetchJSON(base, "/state");
async function fetchConfig(base){ return setGeom(await fetchJSON(base, "/config")); }

// ---------- layers ----------
// The rasters are megabytes; a revision in /state says when one actually moved,
// and ?v=<rev> lets the edge keep that version for an hour. A replacement decodes
// off screen and is swapped in, so a refresh never blanks the map.
const BASE_TEX = "/base-6f3a9c2e";      // the world render, versioned by hand
function layers(base, onLoad){
  const imgs = {}, rev = {};
  for(const k of ["base", "forest", "struct", "fog"]){
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.addEventListener("load", () => { if(onLoad) onLoad(k); });
    imgs[k] = img;
  }
  const ready = k => { const i = imgs[k]; return !!(i && i.complete && i.naturalWidth); };
  function load(k, path, v, after){
    const img = imgs[k], p = new Image();
    p.crossOrigin = "anonymous";
    p.onload = () => { img.src = p.src; if(after) after(); };
    p.src = base + path + (v == null ? "" : "?v=" + v);
  }
  // The base render is the whole world: it must never be seen without the fog
  // mask over it, so a page reveals itself only when both have decoded.
  function whenReady(keys, fn){
    let n = 0;
    const hit = () => { if(++n >= keys.length) fn(); };
    for(const k of keys){ if(ready(k)) hit(); else imgs[k].addEventListener("load", hit, {once: true}); }
  }
  // o: {pieces(list, json), structures (bool or fn, checked after pieces), onFog()}
  async function sync(r, o){
    o = o || {}; r = r || {};
    if(o.pieces && r.pieces !== rev.pieces){
      try{
        const pj = await fetchJSON(base, "/pieces?v=" + r.pieces);
        if(pj && pj.pieces){ rev.pieces = r.pieces; o.pieces(parsePieces(pj), pj); }
      }catch(e){}
    }
    if(r.forest !== rev.forest){ rev.forest = r.forest; load("forest", "/forest", r.forest); }
    const wantStruct = typeof o.structures === "function" ? o.structures() : o.structures;
    if(wantStruct && r.structures !== rev.structures){ rev.structures = r.structures; load("struct", "/structures", r.structures); }
    if(r.fog !== rev.fog){ rev.fog = r.fog; load("fog", "/fog", r.fog, o.onFog); }
  }
  return {imgs, rev, ready, load, whenReady, sync,
          loadBase: () => load("base", BASE_TEX, "4k")};
}

// ---------- rasters ----------
// One blit per layer, of the visible window only: base, forest twice, the
// structures raster while the pieces are absent, fog last. Nearest-neighbour for
// the base once a texture pixel is bigger than a screen pixel.
// v: {scale, tx, ty, w, h, pix?}   o: {bg, forest, structures, fogReady}
function drawRasters(g, v, imgs, o){
  o = o || {};
  const W = v.w, H = v.h, pix = v.pix || 1;
  g.setTransform(pix, 0, 0, pix, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = "source-over";
  g.fillStyle = o.bg || "#0a0c0a";
  g.fillRect(0, 0, W, H);
  const sx = -v.tx/v.scale, sy = -v.ty/v.scale, sw = W/v.scale, sh = H/v.scale;
  const blit = (img, smooth, op) => {
    if(!img || !img.complete || !img.naturalWidth) return;
    const k = img.naturalWidth/geom.size;            // source px per texture px
    g.imageSmoothingEnabled = smooth;
    g.globalCompositeOperation = op;
    try{ g.drawImage(img, sx*k, sy*k, sw*k, sh*k, 0, 0, W, H); }catch(e){}
  };
  const fogIn = o.fogReady === undefined
    ? !!(imgs.fog && imgs.fog.complete && imgs.fog.naturalWidth) : !!o.fogReady;
  if(fogIn){
    blit(imgs.base, v.scale < 3, "source-over");
    // multiplied twice, which squares the effect: dense woods go markedly darker
    // while a thinned patch barely moves, so the difference reads at a glance
    if(o.forest){ blit(imgs.forest, true, "multiply"); blit(imgs.forest, true, "multiply"); }
    if(o.structures) blit(imgs.struct, true, "source-over");
    blit(imgs.fog, true, "multiply");                // unexplored ground stays dark
  }
  g.globalCompositeOperation = "source-over";
  g.imageSmoothingEnabled = true;
}

// ---------- builds ----------
// The same rules the server uses for footprints, applied to how a piece is drawn.
const kindOf = n => { n = n.toLowerCase();
  return n.includes("sapling") ? "crop" : n.includes("roof") ? "roof" : n.includes("floor") ? "floor"
       : /wall|fence|gate|beam|stake/.test(n) ? "wall" : n.includes("pole") ? "pole" : "prop"; };
// Floors, walls, furniture, then roofs: up close the roof tint hides nothing,
// zoomed out the solid roof covers the beams and interior walls beneath it.
const ORDER = ["floor", "wall", "pole", "prop", "crop", "roof"];
// Roofs are lit from the north-west: the slope facing the light goes lighter and
// the far slope darker, so a gable reads as a roof rather than a flat tile.
const LIGHT = 315;
function shade(hex, yaw){
  const f = 1 + 0.35*Math.cos((yaw - LIGHT)*Math.PI/180), v = parseInt(hex, 16);
  const ch = b => Math.min(255, Math.round(((v >> b) & 255)*f)).toString(16).padStart(2, "0");
  return ch(16) + ch(8) + ch(0);
}
// Each piece becomes a rect centred on its position, sized in texture px from its
// footprint in metres and turned by its yaw. Every storey of a build lands on the
// same footprint, so one rect per (kind, position, yaw) survives; a ridge piece
// is flat and keeps its plain colour.
function parsePieces(json){
  const per = 1/geom.pixel, half = geom.size/2, prefabs = (json && json.prefabs) || [];
  const seen = new Set(), out = [];
  for(const [k, x, z, yaw] of (json && json.pieces) || []){
    const p = prefabs[k]; if(!p) continue;
    const kind = kindOf(p.n);
    const key = kind + ":" + x.toFixed(1) + ":" + z.toFixed(1) + ":" + yaw;
    if(seen.has(key)) continue; seen.add(key);
    out.push({kind, yaw,
              px: x*per + half, py: half - z*per,
              w: Math.max(p.w*per, 0.08), d: Math.max(p.d*per, 0.08),
              c: "#" + (kind === "roof" && !p.n.includes("_top") ? shade(p.c, yaw) : p.c)});
  }
  return out.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}
// A build in ground nobody has walked is not drawn. Until the fog has decoded,
// nothing is dropped rather than everything.
const FOGN = 512;
function filterExplored(pieces, fogImg){
  let d = null;
  try{
    if(fogImg && fogImg.complete && fogImg.naturalWidth){
      const c = document.createElement("canvas"); c.width = c.height = FOGN;
      const g = c.getContext("2d", {willReadFrequently: true});
      g.drawImage(fogImg, 0, 0, FOGN, FOGN);
      d = g.getImageData(0, 0, FOGN, FOGN).data;
    }
  }catch(e){ d = null; }
  if(!d) return pieces;
  const k = FOGN/geom.size;
  return pieces.filter(p => {
    const x = Math.min(FOGN-1, Math.max(0, (p.px*k)|0)), y = Math.min(FOGN-1, Math.max(0, (p.py*k)|0));
    return d[(y*FOGN + x)*4] > 40;
  });
}
// Up close a base reads as a floor plan: walls as lines, floors a tint, roofs
// barely there, furniture solid -- every storey lands on the same footprint, so
// opaque fills would stack to a slab. fill 1 / stroke 1 mean the piece's own colour.
const PLAN_STYLE = {
  floor: {fill: 1, alpha: .30, stroke: "rgba(40,28,16,.30)", lw: 1},
  wall:  {stroke: "rgba(38,26,14,.55)", lw: 1.2},
  pole:  {fill: 1, alpha: .8},
  prop:  {fill: 1, alpha: .9, stroke: "rgba(0,0,0,.5)", lw: 1},
  crop:  {fill: "#7fb35a", alpha: .9},
  roof:  {fill: 1, alpha: .10},
};
// Zoomed out a base is what the sky sees: its roofs. Each roof is fattened by a
// stroke in its own lit or shadowed tone, so a base stays a mark at world zoom
// without a halo colour of its own; walls thin to the faint lines of the plan.
const ROOF_STYLE = {
  floor: {fill: 1, alpha: .7},
  wall:  {stroke: "rgba(30,20,10,.45)", lw: 1},
  pole:  {fill: 1, alpha: .9},
  prop:  {fill: 1, alpha: .9},
  crop:  {fill: "#7fb35a", alpha: .9},
  roof:  {fill: 1, alpha: 1, stroke: 1, lw: 1.5},
};
// o: {plan} -- the floor plan, or the roofs. Pieces arrive already in draw order.
function drawPieces(g, v, pieces, o){
  if(!pieces || !pieces.length) return;
  const S = (o && o.plan) ? PLAN_STYLE : ROOF_STYLE, pix = v.pix || 1;
  g.save();
  g.setTransform(pix, 0, 0, pix, 0, 0);
  g.globalCompositeOperation = "source-over";
  g.lineJoin = "miter";
  for(const p of pieces){
    const st = S[p.kind]; if(!st) continue;
    const x = v.tx + p.px*v.scale, y = v.ty + p.py*v.scale;
    const w = p.w*v.scale, d = p.d*v.scale, m = w + d;
    if(x < -m || y < -m || x > v.w + m || y > v.h + m) continue;
    g.save();
    g.translate(x, y);
    if(p.yaw) g.rotate(p.yaw*Math.PI/180);
    g.beginPath();
    g.rect(-w/2, -d/2, w, d);
    if(st.fill){ g.globalAlpha = st.alpha; g.fillStyle = st.fill === 1 ? p.c : st.fill; g.fill(); }
    if(st.stroke){ g.globalAlpha = 1; g.lineWidth = st.lw; g.strokeStyle = st.stroke === 1 ? p.c : st.stroke; g.stroke(); }
    g.restore();
  }
  g.restore();
  g.globalAlpha = 1;
}

// ---------- marker icons ----------
// [path, fill, strokeless?] -- flat silhouettes with a dark halo (paint-order:
// stroke) so they hold over meadow green, rock grey and water; one hue per
// family. One source feeds the SVG symbols and the canvas stamps.
const ICONS = {
  "raft":[["M10 4.6h8.4v6.8h-6v3.2h-2.4z","#ae5139"],
          ["M2.6 13.8h5.8v5.6H2.6zM9.3 13.8h5.8v5.6H9.3zM16 13.8h5.8v5.6H16z","#d2a271"]],
  "karve":[["M6.4 3.2h11.2v7.6h-4.2v4h-2.8v-4H6.4z","#ae5139"],
           ["M1.8 12.6h20.4c-1 4.4-4.8 7-10.2 7S2.8 17 1.8 12.6z","#d2a271"]],
  "longship":[["M4.6 2.4h14.8v8.2h-6v4.4h-2.8v-4.4H4.6z","#ae5139"],
              ["M1.6 8.6c1.8.8 2.6 2.2 2.6 4.2h15.6c0-2 .8-3.4 2.6-4.2-.8 2-.4 3.6 0 5.2-.8 4.4-5 6.8-10.4 6.8S2.4 18.2 1.6 13.8c.4-1.6.8-3.2 0-5.2z","#d2a271"]],
  "cart":[["M16.6 7 21 3.6l1.4 2-4.4 3.4z","#c08a4a"],
          ["M2.2 6.6h17.2l-2.4 7.6H4.6z","#c08a4a"],
          ["M5.1 17a2.9 2.9 0 1 0 5.8 0a2.9 2.9 0 1 0-5.8 0","#e3bd85"],
          ["M12.5 17a2.9 2.9 0 1 0 5.8 0a2.9 2.9 0 1 0-5.8 0","#e3bd85"]],
  "portal":[["M4.4 20.6v-9a7.6 7.6 0 0 1 15.2 0v9h-4.4v-9a3.2 3.2 0 0 0-6.4 0v9z","#6fd8e6"],
            ["M9.6 20.6v-9a2.4 2.4 0 0 1 4.8 0v9z","rgba(111,216,230,.38)",1]],
  "grave":[["M12 3.2c-4.9 0-8.4 3.3-8.4 7.9 0 2.7 1.3 4.7 3 5.8v2.1c0 1 .8 1.8 1.8 1.8h7.2c1 0 1.8-.8 1.8-1.8v-2.1c1.7-1.1 3-3.1 3-5.8 0-4.6-3.5-7.9-8.4-7.9z","#d9c7a6"],
           ["M5.9 11.2a2.5 2.8 0 1 0 5 0a2.5 2.8 0 1 0-5 0","#14130e",1],
           ["M13.1 11.2a2.5 2.8 0 1 0 5 0a2.5 2.8 0 1 0-5 0","#14130e",1],
           ["M12 14.2 13.6 17h-3.2z","#14130e",1]],
  "pin-dot":[["M6.2 12a5.8 5.8 0 1 0 11.6 0a5.8 5.8 0 1 0-11.6 0","#e8b45f"]],
  "pin-fire":[["M13 2.4c.8 4-1.6 5.2-3.4 7.2-2 2.2-3.2 4.4-3.2 6.6 0 3.6 2.6 6 5.6 6s5.6-2.4 5.6-6c0-4.4-2.8-8.6-4.6-13.8z","#ef8b3f"],
              ["M12 11.6c2 2.2 3 3.6 3 5 0 1.8-1.3 3-3 3s-3-1.2-3-3c0-1.4 1-2.8 3-5z","#f8cf72",1]],
  "pin-mine":[["M5.8 18.8 9 21 16.8 9.4 13.6 7.2z","#c2914b"],
              ["M8.6 4.2Q20.4 1.2 21.6 13 15.2 8 8.6 4.2z","#e8b45f"]],
  "pin-house":[["M12 3.2 22 12h-3.2v8.4H5.2V12H2z","#e8b45f"],
               ["M10.2 20.4v-5.2h3.6v5.2z","#14130e",1]],
  "pin-cave":[["M1.8 20.6 6.4 11.4 9.2 13.4 13 7.6 16.8 13.2 18.8 11.6 22.2 20.6z","#e8b45f"],
              ["M8.4 20.6c0-3.8 1.6-6.2 3.6-6.2s3.6 2.4 3.6 6.2z","#14130e",1]],
  "plan":[["M3.4 3.4h17.2v17.2H3.4z","#a8784a"],
          ["M11.2 3.4h1.6v17.2h-1.6zM3.4 11.2h17.2v1.6H3.4z","#0f1310",1]],
};
function spriteSVG(icons){
  icons = icons || ICONS;
  return Object.keys(icons).map(k =>
    `<symbol id="ic-${k}" viewBox="0 0 24 24" stroke="#0b0e0b" stroke-width="2.6" stroke-linejoin="round" paint-order="stroke">`
    + icons[k].map(p => `<path d="${p[0]}" fill="${p[1]}"${p[2] ? ' stroke="none"' : ""}/>`).join("")
    + `</symbol>`).join("");
}
// once per page, before anything referencing #ic-* is parsed
function injectSprite(el, icons){
  if(!el || el.dataset.sprite) return;
  el.innerHTML = spriteSVG(icons);
  el.dataset.sprite = "1";
}
// the same paths as Path2D, for stamping icons onto a canvas
function iconPaths(icons){
  icons = icons || ICONS;
  const out = {};
  for(const k in icons) out[k] = icons[k].map(p => [new Path2D(p[0]), p[1], p[2]]);
  return out;
}
// Keyed on the prefab name the mod reports. A hull it doesn't know still draws as
// a boat rather than vanishing, so a ship added in a later patch needs no change.
const VEHICLE = {
  raft:       {icon: "raft",     label: "Raft",     size: 15},
  karve:      {icon: "karve",    label: "Karve",    size: 18},
  vikingship: {icon: "longship", label: "Longship", size: 22},
  cart:       {icon: "cart",     label: "Cart",     size: 16},
};
function vehicleStyle(m){
  const v = VEHICLE[(m.name || "").toLowerCase()];
  if(v) return v;
  return m.kind === "cart" ? VEHICLE.cart : {icon: "karve", label: m.name || "Boat", size: 18};
}
const PIN_ICON = {dot: "pin-dot", fire: "pin-fire", mine: "pin-mine", house: "pin-house", cave: "pin-cave"};

// ---------- odds and ends ----------
// The mod's pin CSV: id,stamp,type,owner,x,z,text -- and the text may hold commas.
function parsePins(lines){
  if(typeof lines === "string") lines = lines.split("\n");
  return (lines || []).map(line => {
    const f = String(line).split(",");
    if(f.length < 6) return null;
    const x = parseFloat(f[4]), z = parseFloat(f[5]);
    if(!isFinite(x) || !isFinite(z)) return null;
    return Object.assign({type: f[2], owner: f[3], text: f.slice(6).join(",").trim(), x, z}, toPx(x, z));
  }).filter(Boolean);
}
function ago(iso){
  const d = (Date.now() - new Date(iso).getTime())/1000;
  if(!isFinite(d)) return "";
  if(d < 90) return "just now";
  if(d < 3600) return Math.round(d/60) + "m ago";
  if(d < 86400) return Math.round(d/3600) + "h ago";
  return Math.round(d/86400) + "d ago";
}
function esc(t){ return String(t).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

return {geom, setGeom, toPx, toWorld, PLAN_ZOOM, MAX_ZOOM,
        api, fetchJSON, fetchState, fetchConfig, layers, BASE_TEX,
        drawRasters, kindOf, ORDER, shade, parsePieces, filterExplored, drawPieces,
        ICONS, spriteSVG, injectSprite, iconPaths, VEHICLE, vehicleStyle, PIN_ICON,
        parsePins, ago, esc};
})();
