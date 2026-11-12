import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { loadState, rpc, program } from "../mainstream/network.mjs";
import { DEVNET_GENESIS } from "../shared/protocol.mjs";
import { enhanceShopProfiles } from "../mainstream/shop-profile.mjs";
import { memberSessionKey, policyDirectoryKey } from "../mainstream/storage-keys.mjs";

function storage(t) {
  for (const name of ["localStorage", "sessionStorage"]) {
    const old = Object.getOwnPropertyDescriptor(globalThis,name), entries = new Map();
    Object.defineProperty(globalThis,name,{configurable:true,value:{
      getItem:k=>entries.get(k)??null, setItem:(k,v)=>entries.set(k,v), removeItem:k=>entries.delete(k),
    }});
    t.after(()=>old ? Object.defineProperty(globalThis,name,old) : delete globalThis[name]);
  }
}
const deferred = () => { let resolve; const promise = new Promise(r=>{resolve=r;}); return {promise,resolve}; };

test("wallet profile synchronization overlaps account reads; directory does not fetch balances", async t => {
  storage(t);
  const who = String(Keypair.generate().publicKey);
  const group = {tag:31,id:String(Keypair.generate().publicKey),owner:who,mode:1,
    invite:who,visibility:"private",sealed:"test"};
  sessionStorage.setItem(policyDirectoryKey(program),JSON.stringify({at:Date.now(),rows:[group]}));
  localStorage.setItem(memberSessionKey,JSON.stringify({session:"test-session",expires:Date.now()+60000,profile:{address:who,managed:true}}));
  t.mock.method(rpc,"getGenesisHash",async()=>DEVNET_GENESIS);
  const balanceStarted = deferred(), syncStarted = deferred(), balances = deferred(), synced = deferred();
  const clock = Buffer.alloc(40); clock.writeBigInt64LE(1700000000n,32);
  const balanceRead = t.mock.method(rpc,"getMultipleAccountsInfo",()=>{balanceStarted.resolve();return balances.promise;});
  t.mock.method(globalThis,"fetch",async (url,init)=>{
    assert.equal(url,"/api/member/community-profiles");
    assert.equal(JSON.parse(init.body).versions.length,1);
    syncStarted.resolve();
    await synced.promise;
    return Response.json({groups:[{...group,name:"同期済み",joined:true,unlocked:true}]});
  });
  const loading = loadState(who);
  // Both must start while both responses are still pending.
  await Promise.all([balanceStarted.promise,syncStarted.promise]);
  balances.resolve([{data:clock},null,null]); synced.resolve();
  assert.equal((await loading).groups[0].name,"同期済み");
  assert.equal((await loadState(who,false,null,true)).groups[0].name,"同期済み");
  assert.equal(balanceRead.mock.callCount(),1);
});

function profileDOM() {
  const label = {dataset:{shopLabel:"shop"},isConnected:true,innerHTML:"元の店"};
  const input = {name:"title",value:"元の店"};
  const editor = {dataset:{shop:"shop"},isConnected:true,focused:false,
    matches:()=>editor.focused,querySelectorAll:()=>[input]};
  const content = {querySelectorAll:()=>[label],querySelector:()=>editor};
  const state = {rows:[{tag:32,id:"shop",name:"元の店"}]};
  const pending = deferred();
  const profiles = {load:async () => { await pending.promise; state.rows[0].name="新しい店"; }};
  return {label,input,editor,content,state,pending,profiles};
}
const escape = value => String(value).replaceAll("<","&lt;");

test("slow shop profiles enhance labels and pristine editor fields after initial content is usable", async () => {
  const f = profileDOM();
  const pending = enhanceShopProfiles(f.profiles,f.state,f.content,escape,()=>true);
  assert.equal(f.label.innerHTML,"元の店");
  f.pending.resolve();
  assert.equal(await pending,"");
  assert.equal(f.label.innerHTML,"新しい店");
  assert.equal(f.input.value,"新しい店");
});
for (const scenario of ["edited", "focused", "busy", "stale", "detached"])
  test(`late shop profiles preserve ${scenario} forms`, async () => {
    const f = profileDOM();
    const pending = enhanceShopProfiles(f.profiles,f.state,f.content,escape,()=>scenario!=="stale");
    if (scenario === "edited") f.input.value="入力途中";
    if (scenario === "focused") f.editor.focused=true;
    if (scenario === "busy") f.editor.dataset.busy="1";
    if (scenario === "detached") {f.editor.isConnected=false;f.label.isConnected=false;}
    f.pending.resolve(); await pending;
    assert.equal(f.input.value,scenario==="edited" ? "入力途中" : "元の店");
    assert.equal(f.label.innerHTML,["stale","detached"].includes(scenario) ? "元の店" : "新しい店");
  });

test("profile errors leave content intact and return a retry notice", async () => {
  const f = profileDOM();
  f.profiles.load=async()=>{throw Error("offline");};
  assert.match(await enhanceShopProfiles(f.profiles,f.state,f.content,escape,()=>true),/店舗プロフィールを取得できません/);
  assert.equal(f.label.innerHTML,"元の店");
  assert.equal(f.input.value,"元の店");
});
