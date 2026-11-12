import test from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { Message, PublicKey } from "@solana/web3.js";
import { registerReceipts, createRegisterWatch } from "../mainstream/shop-register-watch.mjs";
import { program } from "../mainstream/network.mjs";

const [buyer, group, shop, other] = [1, 2, 3, 4].map(n => new PublicKey(Buffer.alloc(32, n)));
function transaction(signature, { to = shop, market = group, ina = true, failed = false } = {}) {
  const data = Buffer.alloc(ina ? 25 : 9);
  data[0] = ina ? 14 : 15; data.writeBigUInt64LE(2n, 1);
  const message = new Message({
    header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
    recentBlockhash: String(group), accountKeys: [buyer, market, to, program],
    instructions: [{ programIdIndex: 3, accounts: ina ? [0, 1, 2] : [0, 1, 1, 2], data: bs58.encode(data) }],
  });
  return { meta: { err: failed ? {} : null }, transaction: { message, signatures: [signature] } };
}

test("receipt reader ignores baseline, failures, outgoing and other groups; retries missing receipts", async () => {
  let initial = true, indexed = false, polled = false;
  const calls = [];
  const rpc = {
    async getSignaturesForAddress(address, options) {
      assert.equal(String(address), String(shop));
      if (initial) { initial = false; return [{ signature: "old" }]; }
      assert.equal(options.until, polled ? "pending" : "old");
      if (polled) return [];
      polled = true;
      return ["pending", "failed", "outgoing", "other-group", "bad-meta", "old"].map(signature => ({ signature, err: signature === "failed" ? {} : null }));
    },
    async getTransaction(signature) {
      calls.push(signature);
      if (signature === "pending") return indexed ? transaction(signature) : null;
      return transaction(signature, { to: signature === "outgoing" ? other : shop,
        market: signature === "other-group" ? other : group, failed: signature === "bad-meta" });
    },
  };
  const read = await registerReceipts(rpc, String(shop), String(group));
  assert.deepEqual(await read(), []);
  indexed = true;
  const rows = await read();
  assert.equal(rows.length, 1); assert.equal(rows[0].sig, "pending"); assert.equal(rows[0].n, 2n);
  assert.ok(rows[0].incoming);
  assert.ok(!calls.includes("old") && !calls.includes("failed"));
  assert.deepEqual(await read(), []);
});
test("empty baseline detects a first payment and WARA transfers retain their currency", async () => {
  let initial = true;
  const rpc = { getSignaturesForAddress: async () => initial ? (initial = false, []) : [{ signature: "new" }],
    getTransaction: async sig => transaction(sig, { ina: false }) };
  const read = await registerReceipts(rpc, String(shop), String(group));
  const [row] = await read();
  assert.equal(row.kusa, false); assert.equal(row.n, 2n);
  assert.deepEqual(await read(), []);
});
test("receipt list pagination reaches the baseline without skipping payments", async () => {
  let initial = true;
  const rpc = { async getSignaturesForAddress(_address, options) {
    if (initial) { initial = false; return [{ signature: "old" }]; }
    return options.before ? [{ signature: "paid" }] : Array.from({ length: 20 }, (_, i) => ({ signature: `failed-${i}`, err: {} }));
  }, getTransaction: async sig => transaction(sig) };
  const read = await registerReceipts(rpc, String(shop), String(group));
  assert.equal((await read())[0].sig, "paid");
});

function fixture(read = async () => []) {
  let next = 0;
  const jobs = new Map(), navigation = new EventTarget(), observers = [];
  const timers = { setTimeout(fn, delay) { assert.equal(delay, 5000); jobs.set(++next, fn); return next; },
    clearTimeout(id) { jobs.delete(id); } };
  class Observer {
    constructor(fn) { this.fn = fn; observers.push(this); }
    observe() {} disconnect() { this.disconnected = true; }
  }
  const element = { isConnected: true, ownerDocument: { body: {} } }, payments = [], errors = [];
  const watch = createRegisterWatch({ timers, navigation, Observer, receipts: async () => read });
  const args = { element, address: String(shop), group: String(group), onPayment: rows => payments.push(rows), onError: error => errors.push(error) };
  async function tick() { const [id, fn] = jobs.entries().next().value; jobs.delete(id); await fn(); }
  return { watch, args, jobs, tick, payments, errors, navigation, observers, element };
}
test("watch polls once per interval and stops after one incoming receipt", async () => {
  let calls = 0;
  const f = fixture(async () => ++calls === 1 ? [] : [{ n: 2n }]);
  assert.equal(await f.watch.start(f.args), true);
  await f.tick(); assert.equal(f.jobs.size, 1); assert.equal(f.payments.length, 0);
  await f.tick(); assert.equal(f.jobs.size, 0); assert.equal(f.payments.length, 1);
  assert.ok(f.observers[0].disconnected);
});
for (const event of ["pagehide", "popstate", "hashchange", "remove", "stop"]) test(`watch cleans up on ${event}`, async () => {
  const f = fixture(); await f.watch.start(f.args);
  if (event === "remove") { f.element.isConnected = false; f.observers[0].fn(); }
  else if (event === "stop") f.watch.stop();
  else f.navigation.dispatchEvent(new Event(event));
  assert.equal(f.jobs.size, 0); assert.ok(f.observers[0].disconnected);
});
test("regenerating a QR replaces its timer and observer", async () => {
  const f = fixture(); await f.watch.start(f.args); await f.watch.start(f.args);
  assert.equal(f.jobs.size, 1); assert.ok(f.observers[0].disconnected);
  f.watch.stop(); assert.ok(f.observers[1].disconnected);
});
test("slow polls never overlap and cancellation discards in-flight receipts", async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  await f.watch.start(f.args); const pending = f.tick();
  assert.equal(f.jobs.size, 0);
  f.watch.stop(); resolve([{ n: 2n }]); await pending;
  assert.equal(f.payments.length, 0); assert.equal(f.jobs.size, 0);
});
test("RPC errors retry on the next interval", async () => {
  let first = true;
  const f = fixture(async () => { if (first) { first = false; throw Error("unavailable"); } return [{ n: 1n }]; });
  await f.watch.start(f.args); await f.tick();
  assert.equal(f.errors.length, 1); assert.equal(f.jobs.size, 1);
  await f.tick(); assert.equal(f.payments.length, 1); assert.equal(f.jobs.size, 0);
});
test("cancelling during baseline fetch cannot start a timer", async () => {
  let resolve;
  const f = fixture();
  const watch = createRegisterWatch({ receipts: () => new Promise(done => { resolve = done; }),
    timers: { setTimeout() { assert.fail("cancelled baseline started timer"); }, clearTimeout() {} },
    navigation: f.navigation, Observer: null });
  const starting = watch.start(f.args); watch.stop(); resolve(async () => []);
  assert.equal(await starting, false);
});

test("a stale baseline cannot replace a newer QR watch", async () => {
  let resolveOld, reads = 0;
  const timers = { ids: new Set(), setTimeout() { const id = {}; this.ids.add(id); return id; }, clearTimeout(id) { this.ids.delete(id); } };
  const watch = createRegisterWatch({ timers, navigation: new EventTarget(), Observer: null,
    receipts: async () => ++reads === 1 ? new Promise(done => { resolveOld = done; }) : async () => [] });
  const args = { element: { isConnected: true }, onPayment() {} };
  const old = watch.start(args);
  assert.equal(await watch.start(args), true);
  resolveOld(async () => []);
  assert.equal(await old, false);
  assert.equal(timers.ids.size, 1);
  watch.stop(); assert.equal(timers.ids.size, 0);
});

test("baseline failure releases navigation listeners and can be retried", async () => {
  const navigation = { listeners: new Set(), addEventListener(name) { this.listeners.add(name); }, removeEventListener(name) { this.listeners.delete(name); } };
  const watch = createRegisterWatch({ navigation, Observer: null, receipts: async () => { throw Error("offline"); } });
  await assert.rejects(watch.start({ element: { isConnected: true } }), /offline/);
  assert.equal(navigation.listeners.size, 0);
});
