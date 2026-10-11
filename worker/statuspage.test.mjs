// The cron's Statuspage push, with the server, the Worker's route and Statuspage stubbed:
//   node worker/statuspage.test.mjs
const { pushStatus } = await import("./valheim-proxy.js");
const env = { STATUSPAGE_API_KEY: "k", STATUSPAGE_PAGE_ID: "p",
              STATUSPAGE_SERVER_COMPONENT_ID: "srv", STATUSPAGE_WEBMAP_COMPONENT_ID: "map" };
let fails = 0; const ok = (name, cond, detail = "") => { if (!cond) fails++; console.log((cond ? "ok  " : "FAIL") + " " + name + (detail ? " -- " + detail : "")); };
let serverUp = true; const patched = {};
globalThis.fetch = async (u, init = {}) => {
  const url = String(u);
  if (url.startsWith("https://api.statuspage.io/")) {
    patched[url.split("/components/")[1].replace(".json", "")] = JSON.parse(init.body).component.status;
    return new Response("{}");
  }
  if (url.includes("sslip.io:27021")) {
    if (!serverUp) throw new TypeError("connect refused");
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }
  throw new Error("unexpected fetch " + url);
};
let r = await pushStatus(env, {});
ok("both up", r.server && r.map && patched.srv === "operational" && patched.map === "operational", JSON.stringify(patched));
serverUp = false;
r = await pushStatus(env, {});
ok("a dead server takes the map with it", !r.server && !r.map && patched.srv === "major_outage" && patched.map === "major_outage", JSON.stringify(patched));
ok("no key, no push", (await pushStatus({}, {})) === null);
if (fails) process.exit(1);
