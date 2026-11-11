import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { createScanner } from '../app/qr-media.mjs';

const error = name => Object.assign(new Error(name), { name });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function harness(t, getUserMedia, play = async () => {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'warn', () => {});
  const old = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const calls = [], status = [], values = [], attributes = new Map();
  const track = { stop: t.mock.fn() }, media = { getTracks: () => [track] };
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: async c => { calls.push(c); return getUserMedia ? getUserMedia(c, media) : media; },
  } });
  const video = Object.assign(new EventTarget(), { readyState: 0, videoWidth: 0, videoHeight: 0, play,
    setAttribute: (k, v) => attributes.set(k, v) });
  const { modules } = QRCode.create('scanner-test', { errorCorrectionLevel: 'M' });
  const size = (modules.size + 8) * 4;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < modules.size; y++) for (let x = 0; x < modules.size; x++)
    if (modules.get(y, x)) for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
      const i = (((y + 4) * 4 + dy) * size + (x + 4) * 4 + dx) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
    }
  const ctx = { drawImage: t.mock.fn(), getImageData: () => ({ data: pixels, width: size, height: size }) };
  const scanner = createScanner({ video, canvas: { getContext: () => ctx }, onStatus: s => status.push(s),
    onValue: (v, kind) => values.push([v, kind]), onStop() {} });
  t.after(() => { scanner.stop(); if (old) Object.defineProperty(navigator, 'mediaDevices', old); else delete navigator.mediaDevices; });
  return { scanner, video, media, track, calls, status, values, attributes, ctx,
    ready() { video.readyState = 2; video.videoWidth = video.videoHeight = size; } };
}

test('camera sets DOM properties and inline attributes before play', async t => {
  const h = harness(t, null, async () => {
    for (const key of ['muted', 'playsInline', 'autoplay']) assert.equal(h.video[key], true);
    for (const key of ['muted', 'playsinline', 'webkit-playsinline']) assert.equal(h.attributes.get(key), '');
    assert.equal(h.video.srcObject, h.media);
  });
  await h.scanner.start('store');
  assert.deepEqual(h.calls, [{ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false }]);
  h.scanner.stop();
  assert.equal(h.track.stop.mock.callCount(), 1);
  assert.equal(h.video.srcObject, null);
});

for (const name of ['NotAllowedError', 'AbortError']) test(`play ${name} preserves stream and decodes later frames`, async t => {
  const h = harness(t, null, async () => { throw error(name); });
  await h.scanner.start('store');
  assert.equal(h.video.srcObject, h.media);
  assert.equal(h.track.stop.mock.callCount(), 0);
  assert.equal(h.video.controls, true);
  assert.match(h.status.at(-1), /再生ボタン/);
  assert.ok(!h.status.some(s => s.includes('アクセスが許可されていません')));
  t.mock.timers.tick(180);
  assert.equal(h.ctx.drawImage.mock.callCount(), 0);
  h.ready();
  h.video.dispatchEvent(new Event('playing'));
  assert.match(h.status.at(-1), /QR全体/);
  t.mock.timers.tick(180);
  assert.deepEqual(h.values, [['scanner-test', 'store']]);
  assert.equal(h.track.stop.mock.callCount(), 1);
  assert.equal(h.video.srcObject, null);
});

test('pending play promise does not block scanning or cancellation', async t => {
  const pending = deferred();
  const h = harness(t, null, () => pending.promise);
  await h.scanner.start('ina');
  h.ready(); t.mock.timers.tick(180);
  assert.deepEqual(h.values, [['scanner-test', 'ina']]);
  const count = h.status.length;
  pending.reject(error('AbortError')); await Promise.resolve();
  assert.equal(h.status.length, count);
});

for (const name of ['OverconstrainedError', 'ConstraintNotSatisfiedError']) test(`${name} retries once with unrestricted video`, async t => {
  const h = harness(t, (c, media) => { if (c.video !== true) throw error(name); return media; });
  await h.scanner.start('store');
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1], { video: true, audio: false });
  assert.equal(h.video.srcObject, h.media);
});

for (const name of ['NotAllowedError', 'PermissionDeniedError']) test(`getUserMedia ${name} gives permission recovery guidance without retry`, async t => {
  const h = harness(t, () => { throw error(name); });
  await assert.rejects(h.scanner.start('store'), /アドレスバー.*カメラを「許可」にして再試行.*QR画像を選ぶ/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.video.srcObject, null);
});

test('permission failure on fallback retains permission-specific guidance', async t => {
  const h = harness(t, c => { throw error(c.video === true ? 'NotAllowedError' : 'OverconstrainedError'); });
  await assert.rejects(h.scanner.start('store'), /アドレスバー/);
  assert.equal(h.calls.length, 2);
});

test('missing device is not misreported as permission denial or retried', async t => {
  const h = harness(t, () => { throw error('NotFoundError'); });
  await assert.rejects(h.scanner.start('store'), /カメラを開始できません/);
  assert.equal(h.calls.length, 1);
});

test('stop while obtaining a stream releases late media without playing', async t => {
  const pending = deferred(), play = t.mock.fn();
  const h = harness(t, () => pending.promise, play);
  const starting = h.scanner.start('store'); h.scanner.stop(); pending.resolve(h.media); await starting;
  assert.equal(h.track.stop.mock.callCount(), 1);
  assert.equal(play.mock.callCount(), 0);
  assert.equal(h.video.srcObject, null);
});

test('stop before constraint rejection prevents a fallback camera request', async t => {
  const pending = deferred();
  const h = harness(t, () => pending.promise);
  const starting = h.scanner.start('store'); h.scanner.stop(); pending.reject(error('OverconstrainedError')); await starting;
  assert.equal(h.calls.length, 1);
});

test('late play rejection from replaced session cannot alter current scanner', async t => {
  const pending = deferred(); let count = 0;
  const h = harness(t, null, () => ++count === 1 ? pending.promise : Promise.resolve());
  await h.scanner.start('store'); await h.scanner.start('ina');
  const statusCount = h.status.length;
  pending.reject(error('NotAllowedError')); await Promise.resolve();
  assert.equal(h.status.length, statusCount);
  assert.equal(h.video.controls, false);
  assert.equal(h.video.srcObject, h.media);
});
