// After npm run build, run with Playwright installed: node tests/bottom-nav.browser.mjs
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN });
const origin = "https://wara.test";
if (process.env.HOME_SCREENSHOT_DIR) await mkdir(process.env.HOME_SCREENSHOT_DIR,{recursive:true});
const tabs = [
  ["/", "お財布"], ["/communities/", "コミュニティ"],
  ["/support/", "使い方"], ["/account/", "アカウント"],
];

try {
  for (const [width, colorScheme] of [320,390,1024].flatMap(width => ["light","dark"].map(theme => [width,theme]))) {
    const page = await browser.newPage({ viewport: { width, height: 850 }, colorScheme, reducedMotion:"no-preference" });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    // A logged-out visitor can read the guide even with the API unavailable.
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || url.pathname.startsWith("/api/")) return route.abort();
      const file = url.pathname.endsWith("/") ? url.pathname + "index.html" : url.pathname;
      return route.fulfill({ path: resolve("dist", "." + file) });
    });
    await page.goto(origin + "/support/");
    const nav = page.getByRole("navigation");
    assert.equal(await nav.getByRole("link").count(), 4);
    assert.equal(await page.locator("#quick, #quick-menu").count(), 0);
    const checkWelcome = async () => {
      await page.locator(".welcome").waitFor();
      assert.equal(await page.locator(".home-stage").count(),0);
      assert.equal(await page.locator(".welcome p").innerText(),"毎日届く10 iineで感謝を贈れます。受け取ったWARAは、明日も財布に残ります。");
      assert.equal(await page.locator('.welcome a.action').getAttribute("href"),"/signup/");
    };
    const checkHome = async () => {
      await page.locator(".home-signin").waitFor();
      assert.equal(await page.locator(".welcome").count(),0);
      assert.equal(await page.locator(".home-send").getAttribute("aria-label"),"相手を選ぶ");
      assert.equal(await page.locator(".home-send .visually-hidden").innerText(),"相手を選ぶ");
      assert.equal(await page.locator(".home-send-label").innerText(),"おくる");
      assert.equal(await page.locator(".home-receive-label").innerText(),"うけとる");
      assert.equal(await page.locator(".home-receive").getAttribute("aria-label"),"受け取る");
      assert.equal(await page.locator(".home-signin").getAttribute("href"),"/signup/");
      assert.ok(await page.evaluate(() => {
        const box = s => document.querySelector(s).getBoundingClientRect();
        const intersects = (a,b) => a.left<b.right && a.right>b.left && a.top<b.bottom && a.bottom>b.top;
        const label=box(".home-send-label"), signup=box(".home-signin");
        return [".top-counters",".theme",".home-sender"].every(s=>!intersects(label,box(s))) &&
          !intersects(signup,box(".home-receive img")) && signup.top>=box(".home-sender").bottom &&
          signup.width>=44 && signup.height>=44 && signup.height<60 &&
          box(".home-receive-label").bottom<box("nav").top && document.documentElement.scrollWidth<=innerWidth;
      }),"labels and single-line sign-in button fit around artwork and navigation");
      assert.ok(await page.evaluate(() => {
        const box=s=>document.querySelector(s).getBoundingClientRect();
        const clear=(a,b)=>a.right<=b.left || a.left>=b.right || a.bottom<=b.top || a.top>=b.bottom;
        const animations=[".home-sender",".home-receive img"].map(s=>document.querySelector(s).getAnimations()[0]);
        if (animations.some(a=>!a)) return false;
        animations.forEach(a=>{a.pause();a.currentTime=0;});
        let valid=true;
        for (const a of animations) {
          for (let step=0;step<=40;step++) {
            a.currentTime=Number(a.effect.getTiming().duration)*step/40;
            valid &&= clear(box(".home-send-label"),box(".home-sender")) &&
              clear(box(".home-signin"),box(".home-receive img")) &&
              box(".home-signin").top>=box(".home-sender").bottom && document.documentElement.scrollWidth<=innerWidth;
          }
          a.currentTime=0;
        }
        animations.forEach(a=>a.play());
        return valid;
      }),"signed-out labels and sign-in remain clear throughout both idle cycles");
    };
    const boxes = [];
    for (const [path, name] of tabs) {
      const link = nav.getByRole("link", { name, exact: true });
      assert.equal(await link.getAttribute("title"), name);
      assert.equal(await link.locator('img.nav-icon[src^="/v3/ehon/"]').count(), 1);
      await link.locator("img").evaluate(img => img.decode());
      assert.equal(await link.locator(".nav-label").innerText(), name);
      await link.click();
      assert.equal(new URL(page.url()).pathname, path);
      assert.equal(new URL(page.url()).origin,origin);
      assert.equal(await link.getAttribute("target"),null,"tabs navigate within the installed app");
      assert.equal(await page.locator('link[rel="manifest"]').getAttribute("href"),"/manifest.webmanifest");
      assert.equal(await page.locator('meta[name="apple-mobile-web-app-capable"]').getAttribute("content"),"yes");
      assert.equal(await page.locator('meta[name="mobile-web-app-capable"]').getAttribute("content"),"yes");
      assert.equal(await page.locator('meta[name="apple-mobile-web-app-status-bar-style"]').getAttribute("content"),"default");
      assert.equal(await page.locator('meta[name="apple-mobile-web-app-title"]').getAttribute("content"),"WARA");
      assert.equal(await page.locator('link[rel="apple-touch-icon"]').getAttribute("href"),"/assets/wara-avatar.png");
      assert.equal(await page.locator('meta[name="theme-color"]').getAttribute("content"),"#f8f4e8");
      const manifest=await page.evaluate(async()=>await (await fetch(document.querySelector('link[rel="manifest"]').href)).json());
      assert.equal(manifest.scope,"/"); assert.equal(manifest.display,"standalone");
      assert.ok(new URL(page.url()).pathname.startsWith(manifest.scope));
      await page.waitForSelector('nav a[aria-current="page"]');
      assert.equal(await nav.locator('[aria-current="page"]').count(), 1);
      assert.equal(await link.getAttribute("aria-current"), "page");
      assert.equal(await link.evaluate(a => getComputedStyle(a, "::after").content), '""');
      const box = await link.boundingBox();
      assert.ok(box.height >= 44 && box.width >= 44);
      boxes.push(box);
      if (path === "/") await checkHome();
      if (["/communities/","/account/"].includes(path)) await checkWelcome();
      if (process.env.HOME_SCREENSHOT_DIR && colorScheme === "light" && width <= 390 && path !== "/support/") {
        const screen = path === "/" ? "home" : path.split("/")[1];
        await page.screenshot({path:resolve(process.env.HOME_SCREENSHOT_DIR,`${width}-light-signed-out-${screen}.png`),fullPage:true});
      }
      if (path === "/support/") {
        assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "使い方");
        assert.ok(await page.getByRole("heading", { name: "携帯をお持ちでない方へ" }).isVisible());
        if (process.env.NAV_SCREENSHOT_DIR)
          await page.screenshot({ path: resolve(process.env.NAV_SCREENSHOT_DIR, width + "-" + colorScheme + ".png") });
      }
    }
    for (const [i, b] of boxes.entries()) {
      assert.ok(Math.abs(b.width - boxes[0].width) < 1);
      assert.ok(Math.abs(b.x - (boxes[0].x + i * boxes[0].width)) < 1);
      assert.equal(b.y, boxes[0].y);
    }
    await page.goto(origin+"/user/"); await checkHome();
    await page.goto(origin+"/communities/new/"); await checkWelcome();
    for (const path of ["/shop/","/shop/?mode=receive","/register/"]) {
      await page.goto(origin+path);
      await page.waitForSelector('nav [data-tab="wallet"][aria-current="page"]');
      await checkWelcome();
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.locator(".theme").click();
    assert.equal(await page.evaluate(()=>localStorage.getItem("wara.theme")),colorScheme === "light" ? "dark" : "light");
    await page.reload();
    assert.equal(await page.evaluate(()=>document.documentElement.style.colorScheme),colorScheme === "light" ? "dark" : "light");
    await page.emulateMedia({media:"print"});
    assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme),"light");
    assert.equal(await page.locator("nav").evaluate(el=>getComputedStyle(el).display),"none");
    await page.emulateMedia({media:"screen"});
    assert.deepEqual(errors, []);
    console.log(`PASS navigation ${width}px ${colorScheme}: signed-out routes, labels, sign-in layout, welcome, theme and print`);
    await page.close();
  }
} finally {
  await browser.close();
}
