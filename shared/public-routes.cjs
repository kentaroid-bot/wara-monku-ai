// The build and static server share this explicit publication boundary.
const appRoutes = Object.freeze(["", "user", "signup", "shop", "register", "support", "account", "communities", "communities/new"]);
const specialRoutes = Object.freeze({ devnet: "app/index.html", mock: "index.html" });
const copies = Object.freeze({
  "manifest.webmanifest": "mainstream/manifest.webmanifest",
  "assets/wara-avatar.png": "assets/wara-avatar.png",
  "v3/ehon/heart.webp": "assets/ehon/heart.webp",
  "v3/ehon/sender.webp": "assets/ehon/sender.webp",
  "v3/ehon/receiver.webp": "assets/ehon/receiver.webp",
  "v3/ehon/paper-tile.webp": "assets/ehon/paper-tile.webp",
  "v3/ehon/nav-home.webp": "assets/ehon/nav-home.webp",
  "v3/ehon/nav-community.webp": "assets/ehon/nav-community.webp",
  "v3/ehon/nav-guide.webp": "assets/ehon/nav-guide.webp",
  "v3/ehon/nav-account.webp": "assets/ehon/nav-account.webp",
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
