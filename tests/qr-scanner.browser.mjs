// Run after npm run build with Playwright available (PLAYWRIGHT_MODULE / CHROME_BIN / SCANNER_BROWSER optional).
// SCANNER_PHOTO_ONLY=1 runs image/UI regressions without the synthetic live-camera stream.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import QRCode from 'qrcode';
const browsers = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browserType = process.env.SCANNER_BROWSER || 'chromium';
const photoOnly = process.env.SCANNER_PHOTO_ONLY === '1';
const bundle = await build({ stdin: { contents: `import {scannerBox} from './mainstream/scan.mjs'; window.mount = () => { scannerBox(document.querySelector('main'), 'store', v => window.accepted = v); }; mount();`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'browser', define: { global: 'globalThis' } });
const origin = 'https://wara.test';
const key = '11111111111111111111111111111111';
const invoice = `${origin}/shop/?group=${key}&store=${key}&ina=2`;
const qr = await QRCode.toBuffer(invoice, { margin: 4, scale: 6 });
const largeQr = await QRCode.toBuffer(invoice, { margin: 4, scale: 60 });
// Valid large PNG plus trailing padding exercises both >10 MiB and >1600px paths.
const photo = Buffer.concat([largeQr, Buffer.alloc(12 * 1024 * 1024 - largeQr.length)]);
const imageGuidance = /「カメラ・写真でQRを読む」でも読み取れます。/;
const initialGuidance = 'ボタンを押して、カメラ撮影または写真からQRコードを読み取ってください。';
const browser = await browsers[browserType].launch({ executablePath: process.env.CHROME_BIN });
try {
  for (const width of [320, 390]) for (const profile of ['browser', 'phantom-ua', 'phantom-provider']) {
    const inAppBrowser = profile !== 'browser';
    const userAgent = inAppBrowser ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' + (profile === 'phantom-ua' ? ' Phantom/26.0' : '') : undefined;
    const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, userAgent });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const waitForQr = async () => {
      try { await page.waitForFunction(() => !!window.accepted, null, { timeout: 10000 }); }
      catch (cause) {
        const state = await page.evaluate(() => ({ status: document.querySelector('[role=status]').textContent, passes: window.photoPasses, files: [...document.querySelectorAll('input[type=file]')].map(i => i.files[0]?.name) }));
        throw new Error(`QR was not accepted: ${JSON.stringify({ ...state, errors })}`, { cause });
      }
    };
    await page.route('**/*', route => {
      // WebKit exposes blob image loads to routing; let the browser read selected files.
      if (route.request().url().startsWith('blob:')) return route.continue();
      const path = new URL(route.request().url()).pathname;
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><main></main><script src="/scanner.js"></script>' });
      if (path === '/style.css') return route.fulfill({ path: resolve('dist/v3/style.css') });
      if (path === '/scanner.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
      return route.abort();
    });
    await page.addInitScript(profile => {
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
      if (profile === 'phantom-provider') {
        window.phantom = { solana: { isPhantom: true } };
        Object.defineProperty(navigator, 'mediaDevices', { value: undefined });
      }
    }, profile);
    await page.goto(origin);
    await page.locator('summary').click();
    const status = page.getByRole('status'), video = page.locator('video');
    if (inAppBrowser) assert.equal(await status.innerText(), initialGuidance);
    else assert.match(await status.innerText(), /「許可」を選んで/);
    assert.equal(await page.locator('button').count(), inAppBrowser ? 0 : 2);
    assert.equal(await page.locator('label.button').count(), 1);
    assert.equal(await page.locator('.camera-capture, input[capture]').count(), 0);
    assert.equal(await page.locator('input[type=file]').count(), 1);
    assert.equal(await video.isVisible(), false);
    const picker = page.getByLabel('カメラ・写真でQRを読む', { exact: true });
    assert.equal(await picker.getAttribute('capture'), null);
    assert.equal(await picker.getAttribute('accept'), 'image/*');
    assert.equal(await page.locator('summary + label.file-picker').count(), 1);
    const pickerBounds = await page.locator('label.file-picker').boundingBox();
    assert.ok(pickerBounds.height >= 44 && pickerBounds.x >= 0 && pickerBounds.x + pickerBounds.width <= width);
    assert.deepEqual(await picker.evaluate(el => {
      const style = getComputedStyle(el);
      const parent = getComputedStyle(el.parentElement);
      return [style.opacity, style.position, style.inset, parent.position, parent.overflow];
    }), ['0', 'absolute', '0px', 'relative', 'hidden']);
    // Observe the state at the end of the synchronous change handler, before Image.onload.
    await page.evaluate(() => {
      window.selectionStates = [];
      window.photoPasses = [];
      const drawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        if (this.canvas === document.querySelector('canvas') && args.length === 9) photoPasses.push(args.slice(1));
        return drawImage.apply(this, args);
      };
      document.querySelectorAll('input[type=file]').forEach(input => input.addEventListener('change', () => {
        window.photoPasses = [];
        selectionStates.push({ name: input.files[0]?.name, status: document.querySelector('[role=status]').textContent });
      }));
    });
    if (!inAppBrowser) {
      assert.equal(await page.locator('button.button.secondary').count(), 2);
      await page.getByRole('button', { name: 'カメラを開く', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[role=status]').textContent.includes('アドレスバー'));
      assert.match(await status.innerText(), /「許可」にして再試行/);
      assert.match(await status.innerText(), imageGuidance);
      assert.equal(await video.isVisible(), false);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.SCANNER_SCREENSHOT_DIR) {
      await mkdir(process.env.SCANNER_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: resolve(process.env.SCANNER_SCREENSHOT_DIR, `${width}-${profile}.png`) });
    }
    if (!photoOnly && !inAppBrowser) {
      for (const mode of ['blocked', 'aborted', 'fallback']) {
        await page.evaluate(mode => { window.mode = mode; window.calls = []; }, mode);
        await page.getByRole('button', { name: 'カメラを開く', exact: true }).click();
        await page.waitForFunction(() => !!document.querySelector('video').srcObject);
        if (mode !== 'fallback') {
          await page.waitForFunction(() => document.querySelector('video').controls);
          assert.match(await status.innerText(), /再生ボタン/);
        } else assert.deepEqual(await page.evaluate(() => calls[1]), { video: true, audio: false });
        assert.equal(await video.isVisible(), true);
        assert.equal(await video.evaluate(v => v.muted && v.autoplay && v.playsInline && v.srcObject.getTracks()[0].readyState === 'live'), true);
        await page.getByRole('button', { name: '停止', exact: true }).click();
        assert.equal(await video.evaluate(v => v.srcObject), null);
        assert.equal(await video.isVisible(), false);
        assert.equal(await page.evaluate(() => streams.every(s => s.getTracks().every(t => t.readyState === 'ended'))), true);
      }
      // A real video frame can still be decoded after the explicit play() rejection.
      await page.evaluate(() => window.mode = 'blocked');
      await page.getByRole('button', { name: 'カメラを開く', exact: true }).click();
      await page.evaluate(src => drawQr(src), 'data:image/png;base64,' + qr.toString('base64'));
      await waitForQr();
      assert.equal(await page.evaluate(() => accepted), invoice);
      assert.equal(await video.evaluate(v => v.srcObject), null);
      await page.evaluate(() => window.accepted = null);
    }
    // The image path remains usable after permission and playback failures.
    await picker.setInputFiles({ name: 'invoice.png', mimeType: 'image/png', buffer: qr });
    await waitForQr();
    assert.equal(await page.evaluate(() => accepted), invoice);
    // The unified label opens the chooser, retains the file, and allows the same file twice.
    const callsBeforePicker = await page.evaluate(() => calls.length);
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.evaluate(() => window.accepted = null);
      const chooserEvent = page.waitForEvent('filechooser');
      await page.locator('label.file-picker').tap();
      const chooser = await chooserEvent;
      assert.equal(await picker.inputValue(), '');
      await chooser.setFiles({ name: 'camera-photo.png', mimeType: 'image/png', buffer: photo });
      await waitForQr();
      assert.equal(await page.evaluate(() => accepted), invoice);
      assert.match(await picker.inputValue(), /camera-photo\.png$/);
      assert.deepEqual(await page.evaluate(() => selectionStates.at(-1)), { name: 'camera-photo.png', status: 'QRコードを解析しています…' });
      assert.equal(await page.locator('canvas').evaluate(c => Math.max(c.width, c.height)), 900);
    }
    assert.equal(await page.evaluate(() => calls.length), callsBeforePicker);
    // Real 12 MP photos: a small QR in the centre and near the edge (outside the crop).
    for (const placement of ['centre', 'edge']) {
      const image = await page.evaluate(async ({ src, placement }) => {
        const qr = new Image(); qr.src = src; await qr.decode();
        const photo = document.createElement('canvas'); photo.width = 4032; photo.height = 3024;
        const ctx = photo.getContext('2d'); ctx.fillStyle = '#eee'; ctx.fillRect(0, 0, photo.width, photo.height);
        ctx.drawImage(qr, placement === 'centre' ? (4032 - 300) / 2 : 40, (3024 - 300) / 2, 300, 300);
        return photo.toDataURL('image/png').split(',')[1];
      }, { src: 'data:image/png;base64,' + qr.toString('base64'), placement });
      await page.evaluate(() => window.accepted = null);
      await picker.setInputFiles({ name: `${placement}.png`, mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
      await waitForQr();
      assert.equal(await page.evaluate(() => accepted), invoice);
      const passes = await page.evaluate(() => photoPasses);
      assert.ok(passes.length >= 1 && passes.length <= 4);
      // Resampling differs by engine; Chromium fixtures specifically require later passes.
      if (browserType === 'chromium') assert.equal(passes.length, placement === 'centre' ? 2 : 4);
      console.log(`${browserType} ${width}px ${profile} ${placement} photo decoded in ${passes.length} passes`);
    }
    await page.evaluate(() => window.accepted = null);
    await picker.setInputFiles({ name: 'broken.heic', mimeType: 'image/heic', buffer: Buffer.from('invalid image') });
    await page.waitForFunction(() => document.querySelector('[role=status]').textContent.includes('画像を開けません'));
    assert.equal(await page.evaluate(() => accepted), null);
    await picker.setInputFiles({ name: 'invoice.png', mimeType: 'image/png', buffer: qr });
    await waitForQr();
    assert.equal(await page.evaluate(() => accepted), invoice);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (!photoOnly && !inAppBrowser) {
      // Closing and removing a scanner stop the camera as well.
      await page.evaluate(() => window.mode = 'ok');
      await page.getByRole('button', { name: 'カメラを開く', exact: true }).click();
      await page.locator('summary').click();
      await page.waitForFunction(() => !document.querySelector('video').srcObject);
      await page.locator('summary').click();
      await page.getByRole('button', { name: 'カメラを開く', exact: true }).click();
      await page.locator('details').evaluate(el => el.remove());
      await page.waitForFunction(() => streams.every(s => s.getTracks().every(t => t.readyState === 'ended')));
    }
    if (inAppBrowser) {
      assert.deepEqual(await page.evaluate(() => calls), []);
      assert.equal(await video.isVisible(), false);
      await page.locator('summary').click();
      await page.locator('details').evaluate(el => el.remove());
    }
    assert.deepEqual(errors, []);
    console.log(`PASS scanner ${browserType} mobile ${width}px ${profile}: unified buttons, click reset/file retention/reselection, immediate status, 12 MiB/12 MP centre+edge photos, corrupt image recovery, permission${photoOnly || inAppBrowser ? ' (photo/UI only)' : ', autoplay/abort, fallback, video/file QR, stop/close/remove'}`);
    await page.close();
  }
} finally { await browser.close(); }
