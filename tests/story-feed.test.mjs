import test from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { Message, MessageV0, PublicKey } from "@solana/web3.js";
import { entries, paymentHistory, storyReceipt } from "../mainstream/history.mjs";
import { program } from "../mainstream/network.mjs";

const [buyer, market, store, origin] = [1,2,3,4].map(n => new PublicKey(Buffer.alloc(32,n)));
const h = text => String(text).replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const by = id => ({name: id === String(origin) ? "発行した地域" : "買い物をした地域"});
const shopName = (id, address) => id === String(market) && address === String(store) ? "お店<test>" : undefined;

function transaction(ina, signature = "signature") {
  const data = Buffer.alloc(ina ? 25 : 9);
  data[0] = ina ? 14 : 15;
  data.writeBigUInt64LE(ina ? 2n : 15n, 1);
  const header = { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 };
  const recentBlockhash = String(market);
  if (ina) {
    const message = new Message({ header, recentBlockhash, accountKeys: [buyer,market,store,program],
      instructions: [{programIdIndex:3, accounts:[0,1,2], data:bs58.encode(data)}] });
    return {meta:{err:null}, transaction:{signatures:[signature], message}};
  }
  const message = new MessageV0({header, recentBlockhash, staticAccountKeys:[buyer,market,program],
    addressTableLookups:[{accountKey:market, writableIndexes:[0], readonlyIndexes:[1]}],
    compiledInstructions:[{programIdIndex:2, accountKeyIndexes:[0,1,4,3], data}]});
  return {meta:{err:null, loadedAddresses:{writable:[store], readonly:[origin]}}, transaction:{signatures:[signature], message}};
}

test("confirmed INA stories name the certified store and attribute both shares to the correct reader", () => {
  const tx = transaction(true);
  for (const [reader, expected] of [[buyer, /店に \+180 WARA ／ あなたに \+20 WARA/], [store, /あなたの店に \+180 WARA ／ お客さんに \+20 WARA/]]) {
    const [row] = entries(tx, "signature", String(reader));
    const story = storyReceipt(row,h,by,shopName);
    assert.match(story, expected);
    assert.match(story, /2 INA の感謝/);
    assert.match(story, /お店&lt;test&gt;/);
    assert.match(story, /signature\?cluster=devnet/);
  }
  tx.meta.err = {InstructionError:[0,0]};
  assert.deepEqual(entries(tx, "signature", String(buyer)), []);
});
test("paying with existing WARA reports its origin without claiming a new reward", () => {
  const [row] = entries(transaction(false), "signature",String(buyer));
  const story = storyReceipt(row,h,by,shopName);
  assert.match(story, /15 WARA を支払いました/);
  assert.match(story, /発行元：発行した地域/);
  assert.doesNotMatch(story, /\+|結晶化/);
});

test("wallet warmth follows confirmed payment times and retries receipts still being indexed", async t => {
  const good = {signature:"received", blockTime:1234};
  const other = {signature:"other", blockTime:1250};
  const failed = {signature:"failed", blockTime:1300, err:"failed"};
  let indexed = false;
  const getTransaction = t.mock.fn(async sig => {
    assert.notEqual(sig, "failed");
    if (sig === "other") return {meta:{err:null}, transaction:{signatures:[sig], message:new Message({
      accountKeys:[buyer], instructions:[], header:{numRequiredSignatures:1,numReadonlySignedAccounts:0,numReadonlyUnsignedAccounts:0},
      recentBlockhash:String(market)})}};
    return indexed ? transaction(true, sig) : null;
  });
  const times = [];
  const read = paymentHistory(String(store), at => times.push(at), [{
    getSignaturesForAddress:async () => [failed,other,good], getTransaction,
  }]);
  assert.equal((await read()).indexing, true);
  assert.deepEqual(times, []);
  indexed = true;
  const [result] = await Promise.all([read(), read()]);
  assert.equal(result.rows[0].incoming, true);
  assert.equal(result.indexing, false);
  await read();
  assert.deepEqual(times, [1234000, 1234000]);
  assert.deepEqual(getTransaction.mock.calls.map(c => c.arguments[0]), ["other","received","received"]);
});

test("429 keeps completed receipts, pauses requests and resumes in signature order", async t => {
  let now = 100000, throttled = true, listFails = false;
  t.mock.method(Date, "now", () => now);
  const list = Array.from({length:8}, (_, i) => ({signature:String(i),blockTime:100-i}));
  const detailCalls = [];
  const connection = {
    getSignaturesForAddress: t.mock.fn(async () => {
      if (listFails) throw Error("Network unavailable");
      return list;
    }),
    async getTransaction(sig) {
      detailCalls.push(sig);
      if (sig === "2" && throttled) throw Error("429 Too Many Requests");
      return transaction(true, sig);
    },
  };
  const read = paymentHistory(String(store), () => {}, [connection]);
  assert.deepEqual((await read()).rows.map(r => r.sig), ["0","1"]);
  assert.equal((await read()).indexing, true);
  assert.equal(connection.getSignaturesForAddress.mock.callCount(), 1);
  now += 60000;
  listFails = true;
  assert.deepEqual((await read()).rows.map(r => r.sig), ["0","1"]);
  listFails = false;
  throttled = false;
  const partial = await read();
  assert.equal(partial.rows.length, 7);
  assert.equal(partial.indexing, true);
  const full = await read();
  assert.equal(full.indexing, false);
  assert.deepEqual(full.rows.map(r => r.sig), list.map(s => s.signature));
  assert.deepEqual(detailCalls, ["0","1","2","3","4","5","6","7","2"]);
});

test("one transient error does not prevent later receipts in the same refresh", async () => {
  const read = paymentHistory(String(buyer), () => {}, [{
    getSignaturesForAddress:async () => [{signature:"unavailable"},{signature:"confirmed"}],
    async getTransaction(sig) {
      if (sig === "unavailable") throw Error("Network unavailable");
      return transaction(false, sig);
    },
  }]);
  const result = await read();
  assert.equal(result.indexing, true);
  assert.deepEqual(result.rows.map(r => r.sig), ["confirmed"]);
});

test("a rate limit on the first detail read falls back and shares the same receipt cache", async t => {
  const list = [{signature:"payment"}];
  const primary = {
    getSignaturesForAddress:t.mock.fn(async () => list),
    getTransaction:t.mock.fn(async () => { throw Error("429 Too Many Requests"); }),
  };
  const fallback = {
    getSignaturesForAddress:t.mock.fn(async () => list),
    getTransaction:t.mock.fn(async sig => transaction(false, sig)),
  };
  const read = paymentHistory(String(store), () => {}, [primary, fallback]);
  assert.equal((await read()).rows[0].sig, "payment");
  assert.equal((await read()).indexing, false);
  assert.equal(primary.getSignaturesForAddress.mock.callCount(), 1);
  assert.equal(fallback.getSignaturesForAddress.mock.callCount(), 1);
  assert.equal(fallback.getTransaction.mock.callCount(), 1);
});
