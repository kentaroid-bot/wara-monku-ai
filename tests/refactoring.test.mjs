import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { once } from "node:events";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import publicRoutes from "../shared/public-routes.cjs";
import securityHeaders from "../shared/security-headers.cjs";
import server from "../serve.js";
import * as keys from "../mainstream/storage-keys.mjs";
import { memberSessionKey } from "../mainstream/identity.mjs";
import { pendingInvite } from "../mainstream/community-privacy.mjs";
import { twinCards } from "../mainstream/balances.mjs";
import { showGuide } from "../mainstream/views/guide.mjs";

test("persisted storage names and legacy exports remain compatible", () => {
  assert.deepEqual({
    theme:keys.themeKey, warmth:keys.warmthKey, member:keys.memberSessionKey,
    active:keys.activeIdentityKey, signedout:keys.phantomSignedOutKey,
    access:keys.accessVersionKey, afterInvite:keys.afterInviteKey, afterSignin:keys.afterSigninKey,
    introduced:keys.introducedKey, salt:keys.identitySaltKey, backend:keys.identityBackendKey,
    accounts:keys.identityAccountsPrefix, account:keys.identityAccountKey("id"), source:keys.identitySourceKey("id"),
    pending:keys.pendingKey("wallet"), directory:keys.policyDirectoryKey("program"),
    private:keys.inviteKey("group","wallet"), capability:keys.privateInviteKey("group","wallet","invite"),
    pendingInvite:keys.pendingInvite("group"), invite:keys.sessionInviteKey("group"),
  }, {
    theme:"wara.theme", warmth:"wara.v03.warmth.last", member:"wara.member",
    active:"wara.v03.active", signedout:"wara.phantom.signedout", access:"wara.access.version",
    afterInvite:"wara.after-invite", afterSignin:"wara.v03.after-signin", introduced:"wara.introduced",
    salt:"wara.v03.identity.salt", backend:"wara.v03.identity.backend", accounts:"wara.v03.identity.account.",
    account:"wara.v03.identity.account.id", source:"wara.v03.identity.source.id",
    pending:"wara.v3.pending.wallet", directory:"wara.v03.policy-directory.program",
    private:"wara.private.wallet.group", capability:"wara.private.wallet.group.invite",
    pendingInvite:"wara.pending-invite.group", invite:"wara.invite.group",
  });
  assert.equal(memberSessionKey,keys.memberSessionKey);
  assert.equal(pendingInvite,keys.pendingInvite);
});

test("guide retains its content and links without inline styles", async () => {
  const el = {};
  showGuide(el);
  assert.match(el.innerHTML,/100 WARA/);
  assert.match(el.innerHTML,/還元はありません/);
  assert.match(el.innerHTML,/href="\/communities\/"/);
  assert.match(el.innerHTML,/class="guide-steps"/);
  assert.doesNotMatch(el.innerHTML,/\sstyle=/);
  const css = await readFile(new URL("../mainstream/style.css",import.meta.url),"utf8");
  assert.match(css,/\.guide-steps > li \+ li/);
});

test("publication manifest exactly covers the generated files and preserves legacy routes", async () => {
  const directory = fileURLToPath(new URL("../dist/",import.meta.url));
  const files = await readdir(directory,{recursive:true,withFileTypes:true});
  const generated = files.filter(f=>f.isFile())
    .map(f=>relative(directory,join(f.parentPath,f.name)).replaceAll("\\", "/")).sort();
  assert.deepEqual(generated,[...publicRoutes.routes.map(r=>(r ? r+"/" : "")+"index.html"),...publicRoutes.assets,"_headers"].sort());
  for (const route of ["", "shop", "communities/new", "devnet", "mock"]) assert.ok(publicRoutes.routes.includes(route));
  assert.equal(new Set(publicRoutes.routes).size,publicRoutes.routes.length);
  assert.equal(new Set(publicRoutes.assets).size,publicRoutes.assets.length);
  // Imported UI modules belong to the existing bundle, not new public source routes.
  const client = await readFile(new URL("../dist/v3/main.js",import.meta.url),"utf8");
  assert.match(client,/iine-stage/);
  assert.equal(publicRoutes.assets.includes("v3/iine-game.mjs"),false);
  const headers = await readFile(new URL("../dist/_headers",import.meta.url),"utf8");
  for (const [name,value] of Object.entries(securityHeaders)) assert.ok(headers.includes(`${name}: ${value}`));
});

test("all published routes/assets are served with report-only CSP and HSTS; other paths stay closed", async t => {
  const http = server.createServer();
  http.listen(0,"127.0.0.1");
  await once(http,"listening");
  t.after(()=>new Promise(resolve=>{http.close(resolve);http.closeAllConnections();}));
  const origin = `http://127.0.0.1:${http.address().port}`;
  for (const path of [...publicRoutes.routes.map(r=>`/${r}${r ? "/" : ""}`),...publicRoutes.assets.map(a=>"/"+a)]) {
    const response = await fetch(origin+path,{method:"HEAD"});
    assert.equal(response.status,200,path);
    assert.equal(await response.text(),"");
    if (path.endsWith(".webp")) {
      assert.equal(response.headers.get("Content-Type"),"image/webp");
      const get=await fetch(origin+path);
      assert.equal(get.status,200); assert.equal(get.headers.get("Content-Type"),"image/webp");
      assert.ok((await get.arrayBuffer()).byteLength>0);
    }
    for (const [name,value] of Object.entries(securityHeaders)) assert.equal(response.headers.get(name),value,path);
    assert.equal(response.headers.get("Content-Security-Policy"),null);
  }
  assert.equal(securityHeaders["Strict-Transport-Security"],"max-age=31536000; includeSubDomains");
  const csp = securityHeaders["Content-Security-Policy-Report-Only"];
  for (const directive of ["script-src 'self' https://apis.google.com https://accounts.google.com", "style-src 'self'", "img-src 'self' data: blob:", "connect-src 'self' https:", "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com", "object-src 'none'"])
    assert.ok(csp.includes(directive),directive);
  for (const path of ["/worker/index.mjs","/package.json","/_headers","/missing","/v3/../serve.js"])
    assert.equal((await fetch(origin+path)).status,404,path);
  assert.equal((await fetch(origin+"/shop/",{method:"POST"})).status,404);
  assert.match(await (await fetch(origin+"/support/")).text(),/<html/);
});


test("home celebration uses decorative cutouts without HTML inline styles", async () => {
  const html = twinCards({remaining:10,funds:new Map()});
  assert.doesNotMatch(html,/\sstyle\s*=/i);
  assert.match(html,/<div class="home-send-fx" aria-hidden="true"><div class="home-sun-halo"><\/div>/);
  assert.equal((html.match(/class="fx-particle /g) || []).length,12);
  assert.equal((html.match(/<img class="fx-particle fx-heart" src="\/v3\/ehon\/heart.webp" alt="">/g) || []).length,4);
  for (const name of ["index.html","balances.mjs","iine-game.mjs"]) {
    assert.doesNotMatch(await readFile(new URL("../mainstream/"+name,import.meta.url),"utf8"),/\sstyle\s*=/i,name);
  }
});

test("standalone manifest is published with the correct MIME type and root scope", async t => {
  const http=server.createServer(); http.listen(0,"127.0.0.1"); await once(http,"listening");
  t.after(()=>new Promise(resolve=>{http.close(resolve);http.closeAllConnections();}));
  const origin=`http://127.0.0.1:${http.address().port}`;
  const response=await fetch(origin+"/manifest.webmanifest");
  assert.equal(response.status,200);
  assert.equal(response.headers.get("Content-Type"),"application/manifest+json");
  const manifest=await response.json();
  assert.equal(manifest.scope,"/"); assert.equal(manifest.start_url,"/"); assert.equal(manifest.display,"standalone");
  assert.equal(manifest.name,"WARA | iineのお財布"); assert.equal(manifest.lang,"ja");
  assert.equal(manifest.theme_color,"#f8f4e8");
  const icon=manifest.icons[0], png=Buffer.from(await (await fetch(origin+icon.src)).arrayBuffer());
  assert.equal(icon.sizes,`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
  for (const route of publicRoutes.appRoutes) {
    const html=await (await fetch(origin+"/"+route+(route ? "/" : ""))).text();
    assert.match(html,/<link rel="manifest" href="\/manifest.webmanifest">/);
    assert.match(html,/<meta name="apple-mobile-web-app-capable" content="yes">/);
  }
});
