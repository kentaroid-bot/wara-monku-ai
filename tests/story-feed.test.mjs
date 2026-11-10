import test from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { entries, storyReceipt } from "../mainstream/history.mjs";
import { program } from "../mainstream/network.mjs";

const h = text => String(text).replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const by = id => ({name: id === "origin" ? "発行した地域" : "買い物をした地域"});
const shopName = (id, address) => id === "market" && address === "store" ? "お店<test>" : undefined;
function transaction(kusa) {
  const data = Buffer.alloc(kusa ? 25 : 9);
  data[0] = kusa ? 14 : 15;
  data.writeBigUInt64LE(kusa ? 2n : 15n, 1);
  return {meta: {err:null}, transaction: {message: {instructions: [{programId: program, data: bs58.encode(data),
    accounts: kusa ? ["buyer","market","store"] : ["buyer","market","origin","store"]}]}}};
}
test("confirmed kusa stories name the certified store and attribute both shares to the correct reader", () => {
  const tx = transaction(true);
  for (const [reader, expected] of [["buyer", /店に \+180 WARA ／ あなたに \+20 WARA/], ["store", /あなたの店に \+180 WARA ／ お客さんに \+20 WARA/]]) {
    const [row] = entries(tx, "signature", reader);
    const story = storyReceipt(row,h,by,shopName);
    assert.match(story, expected);
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
