import test from "node:test";
import assert from "node:assert/strict";
import {paymentConnection} from "../worker/payment-rpc.mjs";
import {requireFreshBlockhash} from "../worker/devnet-rpc.mjs";
import {DEVNET_GENESIS} from "../shared/protocol.mjs";

function setup(t,name,service) {
  const hosts=["primary."+name+".test","secondary."+name+".test"];
  const calls=[];
  t.mock.method(globalThis,"fetch",async (url,init)=>{
    const {id,method,params}=JSON.parse(init.body), side=hosts.indexOf(new URL(url).hostname);
    assert.notEqual(side,-1);
    calls.push([side,method,params]);
    const result=service(side,method,params);
    return result instanceof Response ? result : Response.json({id,jsonrpc:"2.0",result});
  });
  return {calls,rpc:paymentConnection({DEVNET_RPC_URL:"https://"+hosts[0],DEVNET_PAYMENT_FALLBACK_URL:"https://"+hosts[1]})};
}
const fail=(s,m)=>{throw Object.assign(Error(m),{status:s})};
test("payment verifies each Devnet and continues on the working endpoint after a 429",async t=>{
  const {calls,rpc}=setup(t,"limited",(side,method)=>{
    if(method==="getGenesisHash") return DEVNET_GENESIS;
    if(!side) return new Response(null,{status:429});
    if(method==="getMinimumBalanceForRentExemption") return 1000;
    return {context:{slot:1},value:true};
  });
  await requireFreshBlockhash(rpc,DEVNET_GENESIS,fail);
  assert.equal(await rpc.getMinimumBalanceForRentExemption(25),1000);
  assert.deepEqual(calls.map(([s,m])=>[s,m]),[[0,"getGenesisHash"],[0,"isBlockhashValid"],
    [1,"getGenesisHash"],[1,"isBlockhashValid"],[1,"getMinimumBalanceForRentExemption"]]);
});
test("a wrong-chain fallback receives no payment; expiry is a distinct, final result",async t=>{
  const wrong=setup(t,"wrong",(side,m)=>side?"other-genesis":m==="getGenesisHash"?DEVNET_GENESIS:new Response(null,{status:403}));
  await assert.rejects(requireFreshBlockhash(wrong.rpc,DEVNET_GENESIS,fail),{status:503});
  assert.deepEqual(wrong.calls.filter(([s])=>s).map(([,m])=>m),["getGenesisHash"]);
  const expired=setup(t,"expired",(_s,m)=>m==="getGenesisHash"?DEVNET_GENESIS:{context:{slot:1},value:false});
  await assert.rejects(requireFreshBlockhash(expired.rpc,DEVNET_GENESIS,fail),{status:400});
  assert.ok(expired.calls.every(([s])=>s===0));
});
test("broadcast failover submits identical signed bytes, preflight rejection is never retried",async t=>{
  const bytes=Uint8Array.from([10,22,77]), sent=[];
  const {rpc}=setup(t,"broadcast",(s,m,p)=>{
    if(m==="getGenesisHash") return DEVNET_GENESIS;
    sent.push(p[0]); return s?"signature":new Response(null,{status:503});
  });
  assert.equal(await rpc.sendRawTransaction(bytes),"signature");
  assert.deepEqual(sent,[Buffer.from(bytes).toString("base64"),Buffer.from(bytes).toString("base64")]);
  const denied=setup(t,"invalid",(_s,m)=>m==="getGenesisHash"?DEVNET_GENESIS:
    Response.json({jsonrpc:"2.0",id:"ignored",error:{code:-32002,message:"Transaction simulation failed",data:{logs:[]}}}));
  await assert.rejects(denied.rpc.sendRawTransaction(bytes));
  assert.ok(denied.calls.every(([s])=>s===0));
});
test("a JSON rate limit on the rent account uses the verified fallback, not an invalid rent result",async t=>{
  const {rpc,calls}=setup(t,"account",(s,m)=>m==="getGenesisHash"?DEVNET_GENESIS:
    s ? {context:{slot:1},value:null} : Response.json({jsonrpc:"2.0",id:1,error:{code:-32029,message:"rate limited"}}));
  const {PublicKey}=await import("@solana/web3.js");
  assert.equal(await rpc.getAccountInfo(PublicKey.default),null);
  assert.deepEqual(calls.map(([s,m])=>[s,m]),[[0,"getGenesisHash"],[0,"getAccountInfo"],[1,"getGenesisHash"],[1,"getAccountInfo"]]);
});
