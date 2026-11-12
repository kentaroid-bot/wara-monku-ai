import { build } from "esbuild";
import { mkdir, copyFile, rm, readFile, writeFile } from "node:fs/promises";
import securityHeaders from "../shared/security-headers.cjs";

// Publish only this explicit list: never copy a repository, private/, or keypairs.
await rm("dist", { recursive: true, force: true });
for (const directory of ["devnet", "mock", "assets", "v3"]) {
  await mkdir(`dist/${directory}`, { recursive: true });
}

const browserBuild = {
  bundle: true,
  platform: "browser",
  target: ["es2022"],
  minify: true,
};
await build({
  ...browserBuild,
  entryPoints: ["mainstream/google-phone.mjs"],
  format: "esm",
  outfile: "dist/v3/google-phone.js",
});
await build({
  ...browserBuild,
  entryPoints: ["mainstream/main.mjs"],
  external: ["/v3/google-phone.js"],
  outfile: "dist/v3/main.js",
  define: { global: "globalThis" },
});
await build({
  ...browserBuild,
  entryPoints: ["app/main.mjs"],
  outfile: "dist/devnet/app.js",
  define: { global: "globalThis" },
  sourcemap: false,
});

const routes = ["", "user", "signup", "shop", "register", "support", "account", "communities", "communities/new"];
for (const route of routes) {
  await mkdir(`dist/${route}`, { recursive: true });
  await copyFile("mainstream/index.html", `dist/${route}/index.html`);
}
for (const [source, destination] of [
  ["assets/wara-avatar.png", "dist/assets/wara-avatar.png"],
  ["mainstream/style.css", "dist/v3/style.css"],
  ["app/index.html", "dist/devnet/index.html"],
  ["app/style.css", "dist/devnet/style.css"],
  ["deployments/devnet.json", "dist/devnet/deployment.json"],
  ["model.js", "dist/mock/model.js"],
  ["LICENSE", "dist/LICENSE"],
]) {
  await copyFile(source, destination);
}
const mock = (await readFile("index.html", "utf8"))
  .replace('href="app/index.html"', 'href="/devnet/"')
  .replace('href="README.md"', 'href="https://github.com/kentaroid-bot/emergency-straw-protocol/blob/main/README.md"')
  .replace('href="DESIGN.md"', 'href="https://github.com/kentaroid-bot/emergency-straw-protocol/blob/main/DESIGN.md"');
await writeFile("dist/mock/index.html", mock);
await writeFile("dist/_headers", "/*\n" + Object.entries(securityHeaders)
  .map(([name, value]) => `  ${name}: ${value}\n`).join(""));
console.log("Built dist/: Devnet app + offline mock; explicit public files only, no CDN");
