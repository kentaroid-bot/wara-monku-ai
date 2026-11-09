// Serve only the published build; no keys, project sources or directory listings.
const http = require("node:http"),
  fs = require("node:fs"),
  path = require("node:path");
const base = path.join(__dirname, "dist");
const routes = new Set([
  "",
  "user",
  "signup",
  "shop",
  "account",
  "support",
  "communities",
  "communities/new",
  "mock",
  "devnet",
]);
const assets = new Set([
  "v3/main.js",
  "v3/style.css",
  "devnet/app.js",
  "devnet/style.css",
  "devnet/deployment.json",
  "mock/model.js",
  "LICENSE",
  "app.js",
]);
http
  .createServer((req, res) => {
    const name = req.url.split("?")[0].replace(/^\/|\/$/g, "");
    const file = routes.has(name)
      ? path.join(name, "index.html")
      : assets.has(name)
        ? name
        : null;
    if (!file || !["GET", "HEAD"].includes(req.method)) {
      res.writeHead(404);
      return res.end();
    }
    fs.readFile(path.join(base, file), (err, buf) => {
      if (err) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, {
        "Content-Type":
          {
            html: "text/html",
            css: "text/css",
            js: "text/javascript",
            json: "application/json",
          }[file.split(".").pop()] || "text/plain",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : buf);
    });
  })
  .listen(Number(process.env.PORT || 8787), "127.0.0.1");
