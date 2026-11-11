// Run after npm run build with Playwright available (PLAYWRIGHT_MODULE / CHROME_BIN optional).
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import QRCode from 'qrcode';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const bundle = await build({ stdin: { contents: `import {scannerBox} from './mainstream/scan.mjs'; window.mount = () => { scannerBox(document.querySelector('main'), 'store', v => window.accepted = v); }; mount();`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'browser', define: { global: 'globalThis' } });
const origin = 'https://wara.test';
const key = '11111111111111111111111111111111';
const invoice = `${origin}/shop/?group=${key}&store=${key}&ina=2`;
const qr = await QRCode.toBuffer(invoice, { margin: 4, scale: 6 });
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN });
try {
  for (const width of [320, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><main></main><script src="/scanner.js"></script>' });
      if (path === '/style.css') return route.fulfill({ path: resolve('dist/v3/style.css') });
      if (path === '/scanner.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
      return route.abort();
    });
    await page.addInitScript(() => {
      window.mode = 'denied'; window.calls = []; window.streams = [];
      const originalPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (window.mode === 'blocked') return Promise.reject(new DOMException('test autoplay restriction', 'NotAllowedError'));
        if (window.mode === 'aborted') return Promise.reject(new DOMException('test interrupted playback', 'AbortError'));
        return originalPlay.call(this);
      };
      navigator.mediaDevices.getUserMedia = async constraints => {
        window.calls.push(constraints);
        if (window.mode === 'denied') throw new DOMException('test permission denial', 'NotAllowedError');
        if (window.mode === 'fallback' && constraints.video !== true) throw new DOMException('test constraint failure', 'OverconstrainedError');
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 360;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 360, 360);
        const stream = canvas.captureStream(5); window.streams.push(stream);
        window.drawQr = async src => {
          const image = new Image(); image.src = src; await image.decode();
          ctx.drawImage(image, 0, 0, 360, 360);
          stream.getVideoTracks()[0].requestFrame();
        };
        return stream;
      };
    });
    await page.goto(origin);
    await page.locator('summary').click();
    const status = page.getByRole('status'), video = page.locator('video');
    assert.match(await status.innerText(), /「許可」を選んで/);
    await page.getByRole('button', { name: 'カメラを開く', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role=status]').textContent.includes('アドレスバー'));
    assert.match(await status.innerText(), /「許可」にして再試行.*QR画像を選ぶ/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.SCANNER_SCREENSHOT_DIR) {
      await mkdir(process.env.SCANNER_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: resolve(process.env.SCANNER_SCREENSHOT_DIR, `${width}-permission.png`) });
    }
    for (const mode of ['blocked', 'aborted', 'fallback']) {
      await page.evaluate(mode => { window.mode = mode; window.calls = []; }, mode);
      await page.getByRole('button', { name: 'カメラを開く', exact: true }).click();
      await page.waitForFunction(() => !!document.querySelector('video').srcObject);
      if (mode !== 'fallback') {
        await page.waitForFunction(() => document.querySelector('video').controls);
        assert.match(await status.innerText(), /再生ボタン/);
      } else assert.deepEqual(await page.evaluate(() => calls[1]), { video: true, audio: false });
      assert.equal(await video.evaluate(v => v.muted && v.autoplay && v.playsInline && v.srcObject.getTracks()[0].readyState === 'live'), true);
      await page.getByRole('button', { name: '停止', exact: true }).click();
      assert.equal(await video.evaluate(v => v.srcObject), null);
      assert.equal(await page.evaluate(() => streams.every(s => s.getTracks().every(t => t.readyState === 'ended'))), true);
    }
    // A real video frame can still be decoded after the explicit play() rejection.
    await page.evaluate(() => window.mode = 'blocked');
    await page.getByRole('button', { name: 'カメラを開く', exact: true }).click();
    await page.evaluate(src => drawQr(src), 'data:image/png;base64,' + qr.toString('base64'));
    await page.waitForFunction(() => !!window.accepted);
    assert.equal(await page.evaluate(() => accepted), invoice);
    assert.equal(await video.evaluate(v => v.srcObject), null);
    await page.evaluate(() => window.accepted = null);
    // The image path remains usable after permission and playback failures.
    await page.locator('input[type=file]').setInputFiles({ name: 'invoice.png', mimeType: 'image/png', buffer: qr });
    await page.waitForFunction(() => !!window.accepted);
    assert.equal(await page.evaluate(() => accepted), invoice);
    // Closing and removing a scanner stop the camera as well.
    await page.evaluate(() => window.mode = 'ok');
    await page.getByRole('button', { name: 'カメラを開く', exact: true }).click();
    await page.locator('summary').click();
    await page.waitForFunction(() => !document.querySelector('video').srcObject);
    await page.locator('summary').click();
    await page.getByRole('button', { name: 'カメラを開く', exact: true }).click();
    await page.locator('details').evaluate(el => el.remove());
    await page.waitForFunction(() => streams.every(s => s.getTracks().every(t => t.readyState === 'ended')));
    assert.deepEqual(errors, []);
    console.log(`PASS scanner mobile ${width}px: permission, autoplay/abort, fallback, video/file QR, stop/close/remove`);
    await page.close();
  }
} finally { await browser.close(); }
