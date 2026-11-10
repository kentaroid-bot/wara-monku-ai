// After npm run build, run with Playwright installed: node tests/bottom-nav.browser.mjs
import assert from "node:assert/strict";
import { resolve } from "node:path";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN });
const origin = "https://wara.test";
const tabs = [
  ["/", "お財布"], ["/communities/", "コミュニティ・市場"],
  ["/support/", "使い方"], ["/account/", "アカウント"],
];

try {
  for (const [width, colorScheme] of [[320, "light"], [390, "dark"], [1024, "light"], [1024, "dark"]]) {
    const page = await browser.newPage({ viewport: { width, height: 850 }, colorScheme });
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
    const boxes = [];
    for (const [path, name] of tabs) {
      const link = nav.getByRole("link", { name, exact: true });
      assert.equal(await link.getAttribute("title"), name);
      await link.click();
      assert.equal(new URL(page.url()).pathname, path);
      await page.waitForSelector('nav a[aria-current="page"]');
      assert.equal(await nav.locator('[aria-current="page"]').count(), 1);
      assert.equal(await link.getAttribute("aria-current"), "page");
      assert.equal(await link.evaluate(a => getComputedStyle(a, "::after").content), '""');
      const box = await link.boundingBox();
      assert.ok(box.height >= 44 && box.width >= 44);
      boxes.push(box);
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
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser.close();
}
