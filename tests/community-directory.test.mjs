import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { categories, modes, metadata, tok } from "../shared/protocol.mjs";
import { groupCreatedKey } from "../mainstream/storage-keys.mjs";
import { selectableModes, memberCounts, sortPublicGroups, mintSupply, directoryMetrics } from "../mainstream/community-directory.mjs";

const key = () => String(Keypair.generate().publicKey);
const program = Keypair.generate().publicKey;
const groups = ["A", "B", "C"].map(name => ({id:key(), name, owner:"owner"}));
const [a,b,c] = groups;
const memory = () => {const data = new Map(); return {getItem:k=>data.get(k), setItem:(k,v)=>data.set(k,v)};};
const mint = n => {const data=Buffer.alloc(82); data.writeBigUInt64LE(n,36); return {owner:tok,data};};
const ids = groups => groups.map(g=>g.name);

test("expanded categories round-trip and open membership remains a protocol option", () => {
  assert.deepEqual(categories,["地域","学校","職場","サークル","イベント","お店・施設","家族・友人","オンライン","その他"]);
  for (const category of categories) assert.equal(JSON.parse(metadata("名前","説明",category)).category,category);
  assert.deepEqual(modes,["自由参加","招待コード","承認制"]);
  assert.deepEqual(selectableModes(),[1,2]);
  for (const mode of [1,2]) assert.deepEqual(selectableModes({mode}),[1,2]);
  assert.deepEqual(selectableModes({mode:0}),[0,1,2]);
});

test("member sorting counts unique active members including the owner; ties are deterministic", () => {
  const row=(group,to,status=2)=>({tag:33,group:group.id,to,status});
  const rows=[row(b,"owner"),row(b,"one"),row(b,"one"),row(b,"pending",1),row(b,"banned",4),row(c,"left",3),{tag:32,group:c.id,to:"shop",status:2}];
  assert.deepEqual([...memberCounts(groups,rows).values()],[1,2,1]);
  assert.deepEqual(ids(sortPublicGroups(groups,rows)),["B","A","C"]);
  assert.deepEqual(ids(groups),["A","B","C"]);
});

test("WARA sorting preserves u64 precision and handles missing or invalid mint accounts", () => {
  const n=2n**63n;
  assert.equal(mintSupply(mint(n)),n);
  for (const account of [null,{...mint(n),owner:SystemProgram.programId},{owner:tok,data:Buffer.alloc(165)}]) assert.equal(mintSupply(account),0n);
  assert.deepEqual(ids(sortPublicGroups(groups,[],"wara",new Map([[b.id,n],[c.id,n+1n]]))),["C","B","A"]);
});

test("new sorting uses timestamps, consistent slot fallback, and stable unknown ordering", () => {
  const created=new Map([[a.id,{blockTime:10,slot:2}],[b.id,{blockTime:20,slot:3}]]);
  assert.deepEqual(ids(sortPublicGroups(groups,[],"new",undefined,created)),["B","A","C"]);
  created.set(c.id,{blockTime:null,slot:4});
  assert.deepEqual(ids(sortPublicGroups(groups,[],"new",undefined,created)),["C","B","A"]);
});

test("metrics are lazy; supplies batch at 100, exclude private groups and share pending reads", async () => {
  const many=Array.from({length:205},(_,i)=>({id:key(),name:String(i)}));
  const calls=[];
  const rpc={async getMultipleAccountsInfo(keys){calls.push(keys.length); await Promise.resolve(); return keys.map(()=>mint(9n));}};
  const metrics=directoryMetrics({rpc,program});
  await metrics.load("members",many); assert.deepEqual(calls,[]);
  await Promise.all([metrics.load("wara",[...many,{id:key(),visibility:"private"}]),metrics.load("wara",many)]);
  assert.deepEqual(calls,[100,100,5]); assert.equal(metrics.supplies.size,205);
  await metrics.load("wara",many); assert.deepEqual(calls,[100,100,5]);
});

test("new dates limit concurrency to three, paginate only full pages, and persist completed history", async () => {
  const storage=memory(), calls=new Map(); let active=0, peak=0;
  const many=Array.from({length:7},(_,i)=>({id:key(),name:String(i)}));
  const rpc={async getSignaturesForAddress(id,options){
    active++; peak=Math.max(peak,active); await new Promise(r=>setTimeout(r,2)); active--;
    const count=calls.get(String(id))||0; calls.set(String(id),count+1);
    assert.equal(options.limit,1000);
    if (count===0) {assert.equal(options.before,undefined); return Array.from({length:1000},()=>({signature:"older",blockTime:20,slot:20}));}
    assert.equal(options.before,"older"); return [{signature:"first",blockTime:null,slot:1}];
  }};
  const metrics=directoryMetrics({rpc,program,storage});
  await Promise.all([metrics.load("new",many),metrics.load("new",many)]);
  assert.equal(peak,3); assert.deepEqual([...calls.values()],many.map(()=>2));
  assert.equal(Object.keys(JSON.parse(storage.getItem(groupCreatedKey(program)))).length,7);
  const cached=directoryMetrics({rpc,program,storage}); await cached.load("new",many);
  assert.deepEqual([...calls.values()],many.map(()=>2));
});

test("partial, failed, empty and cancelled histories are never persisted", async () => {
  for (const scenario of ["full","failure","empty","cancel"]) {
    const storage=memory(); let calls=0, alive=true;
    const rpc={async getSignaturesForAddress(){calls++;
      if(scenario==="failure") throw Error("429");
      if(scenario==="empty") return [];
      if(scenario==="cancel") alive=false;
      return Array.from({length:1000},()=>({signature:"older",blockTime:10,slot:10}));
    }};
    const metrics=directoryMetrics({rpc,program,storage}); await metrics.load("new",[a],()=>alive);
    assert.equal(calls,scenario==="full" ? 5 : 1);
    assert.equal(storage.getItem(groupCreatedKey(program)),undefined);
  }
});

test("storage corruption/denial and failed mint requests safely fall back", async () => {
  const storage={getItem:()=>"bad json",setItem:()=>{throw Error("denied");}};
  const metrics=directoryMetrics({program,storage,rpc:{async getMultipleAccountsInfo(){throw Error("offline");},async getSignaturesForAddress(){return [{blockTime:1,slot:1}];}}});
  await metrics.load("wara",groups); assert.deepEqual([...metrics.supplies.values()],[0n,0n,0n]);
  await metrics.load("new",groups); assert.equal(metrics.created.size,3);
});

test("resetSupplies refreshes cached values and isolates old in-flight results without clearing creation dates", async () => {
  const requests=[];
  const metrics=directoryMetrics({program,rpc:{
    getMultipleAccountsInfo(){return new Promise((resolve,reject)=>requests.push({resolve,reject}));},
    async getSignaturesForAddress(){return [{blockTime:1,slot:1}];},
  }});
  const initial=metrics.load("wara",[a]); requests[0].resolve([mint(1n)]); await initial;
  await metrics.load("new",[a]);
  metrics.resetSupplies();
  assert.equal(metrics.supplies.size,0); assert.equal(metrics.created.size,1);
  await metrics.load("members",[a]); assert.equal(requests.length,1,"reset itself does not fetch");
  const stale=metrics.load("wara",[a]);
  metrics.resetSupplies();
  const fresh=metrics.load("wara",[a]);
  requests[1].resolve([mint(2n)]); await stale;
  assert.equal(metrics.supplies.size,0,"a late old result cannot repopulate the cache");
  assert.equal(metrics.load("wara",[a]),fresh,"old completion cannot clear the new pending request");
  requests[2].resolve([mint(3n)]); await fresh;
  assert.equal(metrics.supplies.get(a.id),3n);
  metrics.resetSupplies(); const failing=metrics.load("wara",[a]);
  metrics.resetSupplies(); const latest=metrics.load("wara",[a]);
  requests[4].resolve([mint(4n)]); await latest;
  requests[3].reject(Error("offline")); await failing;
  assert.equal(metrics.supplies.get(a.id),4n,"a late old failure cannot overwrite fresh supply with zero");
});
