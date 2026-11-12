// The build and static server share this explicit publication boundary.
const appRoutes = Object.freeze(["", "user", "signup", "shop", "register", "support", "account", "communities", "communities/new"]);
const specialRoutes = Object.freeze({ devnet: "app/index.html", mock: "index.html" });
const copies = Object.freeze({
  "assets/wara-avatar.png": "assets/wara-avatar.png",
  "v3/style.css": "mainstream/style.css",
  "devnet/style.css": "app/style.css",
  "devnet/deployment.json": "deployments/devnet.json",
  "mock/model.js": "model.js",
  LICENSE: "LICENSE",
});
const bundles = Object.freeze({
  "v3/google-phone.js": "mainstream/google-phone.mjs",
  "v3/main.js": "mainstream/main.mjs",
  "devnet/app.js": "app/main.mjs",
});
module.exports = Object.freeze({ appRoutes, specialRoutes, copies, bundles,
  routes: Object.freeze([...appRoutes, ...Object.keys(specialRoutes)]),
  assets: Object.freeze([...Object.keys(copies), ...Object.keys(bundles)]),
});
