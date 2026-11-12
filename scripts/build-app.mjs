import { build } from "esbuild";
import { mkdir, copyFile, rm, readFile, writeFile } from "node:fs/promises";
import publicRoutes from "../shared/public-routes.cjs";
import { dirname } from "node:path";
import securityHeaders from "../shared/security-headers.cjs";

// Publish only this explicit list: never copy a repository, private/, or keypairs.
await rm("dist", { recursive: true, force: true });
const browserBuild = { bundle: true, platform: "browser", target: ["es2022"], minify: true };
for (const [destination, source] of Object.entries(publicRoutes.bundles)) {
  await build({
    ...browserBuild,
    entryPoints: [source],
    outfile: `dist/${destination}`,
    ...(destination === "v3/google-phone.js" ? {format: "esm"} : {define: {global: "globalThis"}}),
    ...(destination === "v3/main.js" ? {external: ["/v3/google-phone.js"]} : {}),
  });
}
for (const route of publicRoutes.routes) {
  await mkdir(`dist/${route}`, { recursive: true });
  if (route !== "mock")
    await copyFile(publicRoutes.specialRoutes[route] || "mainstream/index.html", `dist/${route}/index.html`);
}
for (const [destination, source] of Object.entries(publicRoutes.copies)) {
  await mkdir(dirname(`dist/${destination}`), { recursive: true });
  await copyFile(source, `dist/${destination}`);
}
const mock = (await readFile(publicRoutes.specialRoutes.mock, "utf8"))
  .replace('href="app/index.html"', 'href="/devnet/"')
  .replace('href="README.md"', 'href="https://github.com/kentaroid-bot/emergency-straw-protocol/blob/main/README.md"')
  .replace('href="DESIGN.md"', 'href="https://github.com/kentaroid-bot/emergency-straw-protocol/blob/main/DESIGN.md"');
await writeFile("dist/mock/index.html", mock);
await writeFile("dist/_headers", "/*\n" + Object.entries(securityHeaders)
  .map(([name, value]) => `  ${name}: ${value}\n`).join(""));
console.log("Built dist/: Devnet app + offline mock; explicit public files only, no CDN");
