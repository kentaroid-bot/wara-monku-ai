// Run with PLAYWRIGHT_MODULE / CHROME_BIN after npm run build.
import assert from "node:assert/strict";
import {build} from "esbuild";
import {resolve} from "node:path";
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const bundle=await build({stdin:{contents:`
import {iineStage,bindIineGame} from './mainstream/iine-game.mjs';
import {memoFields,bindMemoChips} from './mainstream/memo-ui.mjs';
window.mount=(remaining,initial=0,member=true)=>{
  document.querySelector('main').innerHTML='<form>'+iineStage()+memoFields(true)+'</form>';
  const form=document.querySelector('form'); bindMemoChips(form);
  window.game=bindIineGame(form,{remaining,initial,member});
  form.onsubmit=e=>e.preventDefault();
}; mount(3,10);`,resolveDir:process.cwd()},bundle:true,write:false,platform:"browser",define:{global:"globalThis"}});
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN});
try {
 for (const width of [320,390,1024]) for (const colorScheme of ["light","dark"]) {
  const page=await browser.newPage({viewport:{width,height:844},colorScheme}), errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  await page.route("**/*",route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==="/game.js") return route.fulfill({contentType:"text/javascript",body:bundle.outputFiles[0].text});
    if(path.startsWith("/v3/ehon/")) return route.fulfill({path:resolve("dist", "."+path)});
    if(path==="/style.css") return route.fulfill({path:resolve("dist/v3/style.css")});
    return route.fulfill({contentType:"text/html",body:'<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><main></main><script src="/game.js"></script>'});
  });
  await page.goto("https://wara.test/");
  const count=page.locator("[data-count]"), send=page.locator('button[type="submit"]');
  assert.equal(await count.innerText(),"3");
  assert.equal(await page.locator(".charge-dots .red-dot").count(),3);
  await page.locator("[data-tap]").click(); assert.equal(await count.innerText(),"3");
  await page.locator(".payment-memo summary").click();
  await page.locator('[data-reaction="😊"]').click();
  assert.equal(await page.locator('input[name="reaction"]').inputValue(),"😊");
  await page.evaluate(()=>document.querySelector('form').dataset.busy="1");
  await page.locator("[data-minus]").click(); await page.locator("[data-reset]").click();
  assert.equal(await count.innerText(),"3");
  await page.evaluate(()=>delete document.querySelector('form').dataset.busy);
  await page.locator("[data-minus]").click(); assert.equal(await count.innerText(),"2");
  assert.equal(await page.locator('input[name="reaction"]').inputValue(),"👍");
  await page.locator("[data-reset]").click(); assert.equal(await count.innerText(),"0"); assert.ok(await send.isDisabled());
  for (const [remaining,member] of [[0,true],[10,false]]) {
    await page.evaluate(([remaining,member])=>mount(remaining,0,member),[remaining,member]);
    assert.ok(await page.locator("[data-tap]").isDisabled()); assert.ok(await send.isDisabled());
  }
  await page.evaluate(()=>mount(10,5));
  const duration=await page.evaluate(async()=>{const start=performance.now();await game.success();return performance.now()-start;});
  assert.ok(duration>=1250); assert.equal(await page.locator(".gift-flight").innerText(),"+500");
  await page.emulateMedia({reducedMotion:"reduce"}); await page.evaluate(()=>mount(10));
  await page.locator("[data-tap]").click();
  assert.equal(await page.locator(".iine-particles span").count(),0);
  assert.ok(await page.evaluate(async()=>{const start=performance.now();await game.success();return performance.now()-start<100;}));
  assert.deepEqual(errors,[]);
  console.log("PASS game: remaining cap, zero/nonmember, custom reaction, busy lock, reset, reduced motion");
  await page.close();
 }
} finally {await browser.close();}
