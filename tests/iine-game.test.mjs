import test from "node:test";
import assert from "node:assert/strict";
import { getTier, clampCount, createIineSound } from "../mainstream/iine-game.mjs";
import { twinCards } from "../mainstream/balances.mjs";
import { invoiceAmount, storeInvoiceUrl, paperCardCode } from "../mainstream/scan.mjs";
import { paymentReaction, thankYouChips, paymentMemo } from "../shared/payment-memo.mjs";
import { soundKey } from "../mainstream/storage-keys.mjs";

test("iine evolves at every tier and all gift reactions remain valid", () => {
  const emojis = ["🌱","👍","👍","✨","✨","💖","🎉","🔥","🌟","👑","🌾"];
  assert.deepEqual(emojis.map((_, n) => getTier(n).emoji), emojis);
  for (const emoji of [...emojis.slice(1),"👌","💕","❤️","😊"]) assert.equal(paymentReaction(emoji),emoji);
  assert.throws(() => paymentReaction("🌱"));
  for (const chip of thankYouChips) assert.equal(paymentMemo(chip),chip);
  assert.equal(clampCount(10,3n),3);
  assert.equal(clampCount(-1),0);
  assert.equal(clampCount(11),10);
  assert.equal(clampCount("invalid"),0);
});

test("audio is optional and storage denial, construction failure and resume rejection are harmless", async () => {
  const envs = [{}, {get localStorage(){throw Error("blocked");}}, {AudioContext:class {constructor(){throw Error("unsupported");}}},
    {AudioContext:class {state="suspended";resume(){return Promise.reject(Error("denied"));}}}];
  for (const env of envs) {
    const sound = createIineSound(env);
    for (const kind of ["tap","bump","reset","success"]) assert.doesNotThrow(() => sound.play(kind,10,true));
    sound.toggle(); sound.play("tap"); sound.toggle(); sound.unlock();
  }
  await new Promise(resolve => setTimeout(resolve,0));
});

test("sound preference persists and the synth rises, chimes and stops while muted", () => {
  const storage = new Map(), frequencies = [], stopped = [];
  const env = {localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)}, AudioContext:class {
    currentTime=0; state="running"; destination={};
    createOscillator(){return {frequency:{setValueAtTime:n=>frequencies.push(n)},connect(){},disconnect(){},start(){},stop:time=>stopped.push(time)};}
    createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}
  }};
  const sound = createIineSound(env);
  sound.play("tap",1); sound.play("tap",10);
  assert.ok(frequencies[1] > frequencies[0]);
  sound.play("tap",3,true); assert.equal(frequencies.length,5);
  sound.play("success"); assert.equal(frequencies.length,9); assert.equal(stopped.length,9);
  sound.toggle(); assert.equal(storage.get(soundKey),"off"); sound.play("tap"); assert.equal(frequencies.length,9);
  assert.equal(createIineSound(env).enabled,false);
});

test("home balance cards link to gift and receive with ten dots and no expiry badges", () => {
  const html = twinCards({remaining:3n,funds:new Map([["g",1234n]])});
  assert.match(html,/<a class="orb kusa ina" href="\/shop\/">/);
  assert.match(html,/<a class="orb wara" href="\/shop\/\?mode=receive">/);
  assert.equal((html.match(/<i class=/g)||[]).length,10);
  assert.match(html,/1,234/); assert.match(html,/相手を選ぶ/); assert.match(html,/ありがとうの結晶/);
  assert.doesNotMatch(html,/24:00|永続|INA/);
  assert.match(twinCards(null),/—/);
});

test("unspecified invoices omit ina; explicit and legacy presets and paper cards stay compatible", () => {
  const origin="https://wara.test", key="11111111111111111111111111111111";
  const base=origin+"/shop/?group="+key+"&store="+key;
  for(const suffix of ["","&ina=0","&ina=11"]) {
    assert.equal(storeInvoiceUrl(base+suffix,origin),base);
    assert.equal(invoiceAmount(new URL(base+suffix).searchParams),null);
  }
  for (const param of ["ina","kusa"]) for(const n of [1,3,5,10]) {
    assert.equal(storeInvoiceUrl(base+"&"+param+"="+n,origin),base+"&ina="+n);
  }
  for (const type of ["ina","kusa"]) assert.equal(paperCardCode("wara:"+type+":"+key,"ina"),key);
});

test("recipient validation keeps the protocol limits with wallet vocabulary", async () => {
  const {certify,split} = await import("../shared/protocol.mjs");
  const {shopFields} = await import("../shared/shop-profile.mjs");
  assert.throws(()=>certify(null,null,null,null,""), /受け取り名は1〜120バイト/);
  assert.throws(()=>certify(null,null,null,null,"あ".repeat(41)), /受け取り名は1〜120バイト/);
  assert.throws(()=>split([{origin:"g",amount:1n}],2n), /この相手に贈れるWARAが不足/);
  assert.throws(()=>shopFields({title:"",caption:"",icon:"🌾",is_test:false}), /受け取り名/);
});

test("wallet screens and service errors use iine and recipient vocabulary", async () => {
  const {readFile}=await import("node:fs/promises");
  const files=["mainstream/index.html","mainstream/balances.mjs","mainstream/screens.mjs","mainstream/main.mjs",
    "mainstream/views/shop.mjs","mainstream/views/community.mjs","mainstream/views/guide.mjs",
    "mainstream/shop-profile.mjs","mainstream/shop-requests.mjs","mainstream/history.mjs","mainstream/scan.mjs",
    "mainstream/memo-ui.mjs","mainstream/member-ui.mjs","shared/shop-profile.mjs","shared/protocol.mjs",
    "worker/shop-profiles.mjs","worker/shop-requests.mjs"];
  for(const file of files) assert.doesNotMatch((await readFile(new URL("../"+file,import.meta.url),"utf8")).replaceAll(/\b(?:SHOP|BUYER)_WARA_PER_INA\b/g,""),/INA|店舗|ショップ|お店|レジ|お会計|支払う|店主/,file);
});
