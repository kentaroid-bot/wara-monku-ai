import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { makePolicy, displayKeyBytes, rememberInvite, syncPrivateGroups, pendingInvite } from "../mainstream/community-privacy.mjs";
import { openPrivateProfile, privateProfileVersion } from "../shared/private-community.mjs";

const address = () => String(Keypair.generate().publicKey);
function storage(t) {
  const stores = [];
  for (const name of ["localStorage","sessionStorage"]) {
    const old = Object.getOwnPropertyDescriptor(globalThis,name), map = new Map();
    stores.push(map);
    Object.defineProperty(globalThis,name,{configurable:true,value:{
      getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k),
    }});
    t.after(()=>old ? Object.defineProperty(globalThis,name,old) : delete globalThis[name]);
  }
  return stores;
}
async function fixture(mode = 1) {
  const id = address(), owner = address();
  const policy = await makePolicy({visibility:"private",mode,name:"仲間の町",description:"集まり",category:"地域"},
    id,owner,()=>bs58.encode(crypto.getRandomValues(new Uint8Array(32))));
  return {policy,group:{tag:31,id,owner,mode,invite:String(policy.invite),visibility:"private",
    name:"限定公開コミュニティ",description:"",category:"地域",sealed:JSON.parse(policy.bytes).sealed}};
}

test("display decryption is bound to the community and versions bind all policy fields", async () => {
  const {policy,group} = await fixture();
  const key = await displayKeyBytes(policy.code);
  assert.equal((await openPrivateProfile(group,key)).name,"仲間の町");
  await assert.rejects(openPrivateProfile({...group,id:address()},key));
  await assert.rejects(openPrivateProfile(group,crypto.getRandomValues(new Uint8Array(32))));
  const version = await privateProfileVersion(group);
  for (const edit of [{id:address()},{owner:address()},{invite:address()},{mode:2},{sealed:"different"}])
    assert.notEqual(await privateProfileVersion({...group,...edit}),version);
});

test("fresh member browser displays synchronized fields without storing plaintext or receiving invitation keys", async t => {
  const stores = storage(t), {group} = await fixture(), wallet = address();
  const latest = {...group,name:"改名後",description:"新しい説明",category:"学校",joined:true,unlocked:true};
  const result = await syncPrivateGroups([group],wallet,[],async (op,data)=>{
    assert.equal(op,"community-profiles"); assert.deepEqual(data,{groups:[group.id]});
    return {groups:[latest]};
  });
  assert.deepEqual(result.groups,[latest]); assert.equal(result.communitySyncError,"");
  assert.ok(stores.every(s=>s.size===0));
});

test("owner retries a failed profile save on refresh, including private open and approval modes", async t => {
  storage(t);
  for (const mode of [0,1,2]) {
    const {group,policy} = await fixture(mode);
    rememberInvite(group.id,group.owner,policy.code);
    let attempts = 0;
    const api = async (op,body) => {
      if (op === "community-profiles") return {groups:[{...group,joined:true,unlocked:false}]};
      assert.equal(op,"community-save");
      assert.equal(body.code,undefined);
      assert.equal(body.displayKey,Buffer.from(await displayKeyBytes(policy.code)).toString("base64"));
      if (++attempts === 1) throw Error("D1 temporarily unavailable");
      return {group:{...group,...await openPrivateProfile(group,Buffer.from(body.displayKey,"base64")),joined:true,unlocked:true}};
    };
    const failed = await syncPrivateGroups([group],group.owner,[],api);
    assert.match(failed.communitySyncError,/同期が未完了/);
    assert.equal(failed.groups[0].name,"仲間の町");
    const recovered = await syncPrivateGroups([group],group.owner,[],api);
    assert.equal(recovered.communitySyncError,""); assert.equal(recovered.groups[0].name,"仲間の町");
    assert.equal(attempts,2);
  }
});

test("successful member sync finishes an existing invitation without retaining a pending join", async t => {
  storage(t);
  const {group,policy} = await fixture(), wallet = address();
  sessionStorage.setItem(pendingInvite(group.id),policy.code);
  await syncPrivateGroups([group],wallet,[],async()=>({groups:[{...group,name:"仲間の町",joined:true,unlocked:true}]}));
  assert.equal(sessionStorage.getItem(pendingInvite(group.id)),null);
  assert.equal(localStorage.getItem(`wara.private.${wallet}.${group.id}.${group.invite}`),policy.code);
});

test("API outage preserves wallet rows and reports incomplete sync; static invitation previews still work", async t => {
  storage(t);
  const {group,policy} = await fixture(), wallet = address();
  const rows = [{tag:33,group:group.id,to:wallet,status:2}];
  const result = await syncPrivateGroups([group],wallet,rows,async()=>{throw Error("offline");});
  assert.equal(result.groups[0].name,"限定公開コミュニティ");
  assert.match(result.communitySyncError,/最新情報を取得できません/);
  assert.equal((await syncPrivateGroups([group],wallet,[],null)).groups.length,0);
  sessionStorage.setItem(pendingInvite(group.id),policy.code);
  assert.equal((await syncPrivateGroups([group],wallet,[],null)).groups[0].name,"仲間の町");
  // An authenticated outsider receives nothing from D1, but retains an explicit invitation preview.
  assert.equal((await syncPrivateGroups([group],wallet,[],async()=>({groups:[]}))).groups[0].name,"仲間の町");
});

test("profile lookup batches at 32, skips public groups and never saves for a regular member", async t => {
  storage(t);
  const {group,policy} = await fixture(), wallet = address();
  rememberInvite(group.id,wallet,policy.code);
  const groups = Array.from({length:65},(_,i)=>({...group,id:i===0?group.id:address()}));
  const publicGroup = {...group,id:address(),visibility:"public",name:"公開の町"};
  const sizes = [];
  const result = await syncPrivateGroups([...groups,publicGroup],wallet,[],async(op,b)=>{
    assert.equal(op,"community-profiles"); sizes.push(b.groups.length);
    return {groups:groups.filter(g=>b.groups.includes(g.id)).map(g=>({...g,joined:true,unlocked:false}))};
  });
  assert.deepEqual(sizes,[32,32,1]); assert.equal(result.groups.length,66);
  assert.equal(result.groups.at(-1),publicGroup);
  assert.match(result.communitySyncError,/同期を待っています/);
});
