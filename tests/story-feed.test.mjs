import test from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { entries, paymentHistory, storyReceipt } from "../mainstream/history.mjs";
import { program, rpc } from "../mainstream/network.mjs";

const h = text => String(text).replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const by = id => ({name: id === "origin" ? "発行した地域" : "買い物をした地域"});
const shopName = (id, address) => id === "market" && address === "store" ? "お店<test>" : undefined;
function transaction(ina) {
  const data = Buffer.alloc(ina ? 25 : 9);
  data[0] = ina ? 14 : 15;
  data.writeBigUInt64LE(ina ? 2n : 15n, 1);
  return {meta: {err:null}, transaction: {message: {instructions: [{programId: program, data: bs58.encode(data),
    accounts: ina ? ["buyer","market","store"] : ["buyer","market","origin","store"]}]}}};
}
test("confirmed INA stories name the certified store and attribute both shares to the correct reader", () => {
  const tx = transaction(true);
  for (const [reader, expected] of [["buyer", /店に \+180 WARA ／ あなたに \+20 WARA/], ["store", /あなたの店に \+180 WARA ／ お客さんに \+20 WARA/]]) {
    const [row] = entries(tx, "signature", reader);
    const story = storyReceipt(row,h,by,shopName);
    assert.match(story, expected);
    assert.match(story, /2 INA の感謝/);
    assert.match(story, /お店&lt;test&gt;/);
    assert.match(story, /signature\?cluster=devnet/);
  }
  tx.meta.err = {InstructionError:[0,0]};
  assert.deepEqual(entries(tx, "signature", "buyer"), []);
});
test("paying with existing WARA reports its origin without claiming a new reward", () => {
  const [row] = entries(transaction(false), "signature","buyer");
  const story = storyReceipt(row,h,by,shopName);
  assert.match(story, /15 WARA を支払いました/);
  assert.match(story, /発行元：発行した地域/);
  assert.doesNotMatch(story, /\+|結晶化/);
});

test("wallet warmth follows confirmed payment times and retries receipts still being indexed", async t => {
  const address = String(program);
  const good = { signature: "received", blockTime: 1234, err: null };
  const other = { signature: "other", blockTime: 1250, err: null };
  const failed = { signature: "failed", blockTime: 1300, err: "failed" };
  t.mock.method(rpc, "getSignaturesForAddress", async () => [failed, other, good]);
  const tx = transaction(true);
  tx.transaction.message.instructions[0].accounts[2] = address;
  let indexed = false;
  const parsed = t.mock.method(rpc, "getParsedTransactions", async signatures => {
    assert.ok(!signatures.includes("failed"));
    return signatures.map(sig => sig === "other" ? transaction(false) : indexed ? tx : null);
  });
  const times = [];
  const read = paymentHistory(address, at => times.push(at));
  assert.equal((await read()).indexing, true);
  assert.deepEqual(times, []);
  indexed = true;
  const [result] = await Promise.all([read(), read()]);
  assert.equal(result.rows[0].incoming, true);
  assert.equal(result.indexing, false);
  await read();
  assert.deepEqual(times, [1234000, 1234000]);
  assert.equal(parsed.mock.callCount(), 2);
});
