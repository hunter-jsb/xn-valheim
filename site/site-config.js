/* site-config.js -- the one file a deployment edits. Everything else in docs/ is
 * deployment-blind: this names our server, our world render, our brand and the
 * links off this site. The mod's package writes its own beside the same pages.
 */
window.XNV = {
  api:    "https://valheim-proxy.hunterjsb.workers.dev",
  base:   "/base-6f3a9c2e",
  brand:  "Xandaris Valheim",
  links:  [{label: "Status",  href: "https://xnmc.statuspage.io"},
           {label: "Discord", href: "https://discord.gg/UDGfVrTQs6"},
           {label: "Map mod", href: "https://github.com/hunter-jsb/valheim-webmap"}],
  status: "https://xnmc.statuspage.io/api/v2/summary.json",
  repo:   "https://github.com/hunter-jsb/xn-valheim",
};
