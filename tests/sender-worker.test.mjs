import test from "node:test";
import assert from "node:assert/strict";
import { readFile,readdir } from "node:fs/promises";
import { createHmac,randomBytes } from "node:crypto";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { Transaction,Keypair,PublicKey,ComputeBudgetProgram,SystemProgram } from "@solana/web3.js";
import { getTransactionDecoder } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import manifest from "../shared/deployment.mjs";
import { DEVNET_GENESIS,addr,ata,mintFor,join,spend,transfer,certify,endMembership } from "../shared/protocol.mjs";
import { sponsoredInstructions } from "../shared/sponsorship.mjs";
import { senderWorld } from "./sender-fixture.mjs";

const bundle = (await build({entryPoints:["worker/index.mjs"],bundle:true,write:false,format:"esm",platform:"browser"})).outputFiles[0].text;
async function fixture(t) {
  const w=senderWorld(new PublicKey(manifest.program));w.configure();const group=w.group();
  const pepper=randomBytes(32).toString("hex");
  const hash=(purpose,value)=>createHmac("sha256",pepper).update("wallet-access/trial/"+purpose+"\n"+value).digest("base64");
  const sent=new Map();let offline=false,failClose=false,stealLease=false;
  const account=k=>{const a=w.account(k);return a.exists ? {owner:a.programAddress,data:[Buffer.from(a.data).toString("base64"),"base64"],lamports:Number(a.lamports),executable:a.executable,rentEpoch:0} : null;};
  async function outbound(req) {
    const {id,method,params}=await req.json();
    if(offline)return Response.json({id,jsonrpc:"2.0",error:{code:-32000,message:"unavailable"}});
    const ctx=value=>({context:{slot:1},value});let result;
    switch(method) {
      case "getGenesisHash":result=DEVNET_GENESIS;break;
      case "getAccountInfo":result=ctx(account(params[0]));break;
      case "getMultipleAccounts":
        if(stealLease) {stealLease=false;await db.prepare("UPDATE wallet_tickets SET detail='successor',expires=? WHERE purpose='sender-lock'").bind(Math.floor(Date.now()/1000)+120).run();}
        result=ctx(params[0].map(account));break;
      case "getProgramAccounts":result=w.svm.getProgramAccounts(String(w.program)).map(a=>({pubkey:a.address,account:account(a.address)})).filter(a=>a.account.data[0] && Buffer.from(a.account.data[0],"base64").length===66 &&
        Buffer.from(a.account.data[0],"base64").subarray(33,65).equals(bs58.decode(params[1].filters[1].memcmp.bytes)));break;
      case "getLatestBlockhash":result=ctx({blockhash:w.svm.latestBlockhash(),lastValidBlockHeight:1000});break;
      case "isBlockhashValid":result=ctx(params[0]===w.svm.latestBlockhash());break;
      case "getSignatureStatuses":result=ctx(params[0].map(s=>sent.has(s)?{slot:1,confirmations:1,err:null,confirmationStatus:"confirmed"}:null));break;
      case "sendTransaction": {
        const raw=Buffer.from(params[0],"base64"),tx=Transaction.from(raw);
        if(failClose && tx.instructions.at(-1).data[0]===21)return Response.json({id,jsonrpc:"2.0",error:{code:-32002,message:"recovery unavailable"}});
        const r=w.svm.sendTransaction(getTransactionDecoder().decode(raw));
        if(r instanceof FailedTransactionMetadata)return Response.json({id,jsonrpc:"2.0",error:{code:-32002,message:r.toString()}});
        result=bs58.encode(tx.signature);sent.set(result,tx);break;
      }
      case "simulateTransaction":result=ctx({err:null,logs:[]});break;
      default:throw Error("Unexpected local RPC: "+method);
    }
    return Response.json({id,jsonrpc:"2.0",result});
  }
  const text=value=>({type:"text",value});
  const runtime=new Miniflare({enableDevRegistry:false,workers:[{config:{name:"sender-tests",compatibilityDate:"2026-11-04",manifest:{mainModule:"index.mjs",modules:{"index.mjs":{type:"esm",contents:bundle}}},env:{DB:{type:"d1",id:"DB"},AUTH_MODE:text("trial"),AUTH_PEPPER:text(pepper),WALLET_ACCESS:text("enabled"),FEE_PAYER_SECRET:text(bs58.encode(w.authority.secretKey)),DEVNET_PAYMENT_RPC_URL:text("https://rpc.test"),DEVNET_RPC_URL:text("https://rpc.test")}},dev:{outboundService:{type:"fetcher",handler:outbound}}}]});
  t.after(()=>runtime.dispose());const db=await runtime.getD1Database("DB");
  for(const file of (await readdir("migrations")).filter(f=>/^00(?:0[1-9]|10)_/.test(f)).sort()) {
    const sql=await readFile("migrations/"+file,"utf8");
    for(const stmt of sql.trim().split(/;\s*(?=CREATE |ALTER |$)/).filter(Boolean))await db.prepare(stmt).run();
  }
  const now=Math.floor(Date.now()/1000),pin="123456";
  async function member(type="phantom",pair=Keypair.generate()) {
    const id=crypto.randomUUID(),token=bs58.encode(randomBytes(32)),card=bs58.encode(randomBytes(32));
    await db.prepare("INSERT INTO members(id,realm,address,type,pin_mac,card_key,created) VALUES(?,'trial',?,?,?,?,?)")
      .bind(id,String(pair.publicKey),type,hash("pin",id+":"+pin),type==="phantom"?null:hash("card",card),now).run();
    await db.prepare("INSERT INTO wallet_tickets VALUES(?,'trial','session',?,?)").bind(hash("ticket",token),JSON.stringify({id,revision:1}),now+900).run();
    w.ok(w.send([join(w.program,pair.publicKey,group,pair.publicKey)],...(fund(pair),[pair])));
    w.ok(w.send([join(w.program,w.owner.publicKey,group,pair.publicKey,true)],w.owner));
    return {id,session:token,card,pair,address:String(pair.publicKey)};
  }
  const fund=pair=>w.svm.airdrop(String(pair.publicKey),1_000_000_000n);
  async function post(op,body={},expected=200) {
    const response=await runtime.dispatchFetch("https://wara.test/api/member/"+op,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const json=await response.json();if(expected===null)return {status:response.status,json};
    assert.equal(response.status,expected,op+" "+JSON.stringify(json));return json;
  }
  function tx(instructions) {
    const last=instructions.at(-1),actor=last.keys[0].pubkey;
    const raw=new Transaction({feePayer:w.authority.publicKey,recentBlockhash:w.svm.latestBlockhash()})
      .add(...sponsoredInstructions([ComputeBudgetProgram.setComputeUnitPrice({microLamports:0}),...instructions],w.authority.publicKey,0));
    return {actor,raw,encoded:raw.serialize({requireAllSignatures:false}).toString("base64")};
  }
  const get=id=>db.prepare("SELECT * FROM members WHERE id=?").bind(id).first();
  return {...w,group,db,now,pin,member,post,tx,get,sent,offline:v=>{offline=v;},failClose:v=>{failClose=v;},stealLease:()=>{stealLease=true;}};
}

test("backfill is RPC-first, carries the main quota, races safely and never exposes the main address to cards",async t=>{
  const f=await fixture(t),m=await f.member("paper");f.setPerson(m.address,4,7n);
  f.offline(true);await f.post("session",{session:m.session},503);assert.equal((await f.get(m.id)).sender_address,null);
  f.offline(false);
  const results=await Promise.all([f.post("session",{session:m.session}),f.post("card-info",{card:m.card})]);
  const row=await f.get(m.id),profile=results[0].profile;
  assert.notEqual(profile.senderAddress,m.address);assert.equal(profile.carriedSpent,4);assert.equal(profile.carriedDay,Number(f.day()));
  assert.deepEqual(results[1],{address:row.sender_address});assert.equal(profile.senderAddress,row.sender_address);
  assert.equal(row.revision,1);assert.ok(row.sender_sealed_seed);assert.ok(row.sender_rotated_at>=f.now && row.sender_rotated_at<=f.now+10);
  assert.deepEqual((await f.post("session",{session:m.session})).profile,profile);
  const fields=await f.db.prepare("PRAGMA table_info(retired_sender_accounts)").all();assert.ok(!fields.results.some(r=>r.name==="member_id"));
});

test("Phantom signs only sender spend, validates membership/self/nonce/day/carried quota, and notes reach recipient",async t=>{
  const f=await fixture(t),m=await f.member();f.setPerson(m.address,4);
  const {profile}=await f.post("session",{session:m.session});const sender=profile.senderAddress;
  await f.post("sender-join",{session:m.session,group:String(f.group)});
  await f.post("sender-join",{session:m.session,group:String(f.group)});
  assert.equal(f.account(addr(f.program,"m3",f.group,sender)).data[65],2);
  const pay=(n=2,day=f.day(),nonce=0,shop=f.shop.publicKey,actor=sender)=>f.tx(spend(f.program,actor,f.group,shop,n,day,nonce));
  const transaction=pay();const result=await f.post("sign",{session:m.session,tx:transaction.encoded});
  assert.ok(ed25519.verify(Buffer.from(result.signature,"base64"),transaction.raw.serializeMessage(),bs58.decode(sender)));
  await f.post("sign",{session:m.session,tx:f.tx(transfer(f.program,m.address,f.group,f.shop.publicKey,[{origin:f.group,amount:1n}])).encoded},401);
  for(const target of [m.address,sender])await f.post("sign",{session:m.session,tx:pay(1,f.day(),0,target).encoded},403);
  for(const [n,d,nonce] of [[7,f.day(),0],[1,f.day()+1n,0],[1,f.day(),1]])await f.post("sign",{session:m.session,tx:pay(n,d,nonce).encoded},409);
  await f.post("sign",{session:m.session,tx:pay(1,f.day(),0,f.shop.publicKey,m.address).encoded},401);
  transaction.raw.addSignature(new PublicKey(sender),Buffer.from(result.signature,"base64"));
  const note="ありがとう";
  await f.post("payment-note",{session:m.session,note,tx:transaction.raw.serialize({requireAllSignatures:false}).toString("base64")});
  transaction.raw.partialSign(f.authority);const signature=bs58.encode(transaction.raw.signature);f.sent.set(signature,transaction.raw);
  await f.db.prepare("INSERT INTO relay_receipts VALUES(?,?)").bind(bs58.encode(Buffer.from(result.signature,"base64")),signature).run();
  const cashier=await f.member("phantom",f.shop);
  const received=await f.post("payment-notes",{session:cashier.session,receipts:[{sig:signature,payerSignature:bs58.encode(Buffer.from(result.signature,"base64"))}]});
  assert.deepEqual(received,{notes:[{sig:signature,note}]});
  f.ok(f.send([endMembership(f.program,f.owner.publicKey,f.group,m.pair.publicKey,true)],f.owner));
  await f.post("sign",{session:m.session,tx:pay().encoded},403);
  await f.post("sender-join",{session:m.session,group:String(f.group)},403);
});

test("paper card prepares via cashier and rejects self, unjoined main wallet and transfer signing",async t=>{
  const f=await fixture(t),m=await f.member("paper"),cashier=await f.member("phantom",f.shop);
  const info=await f.post("card-info",{card:m.card});
  await f.post("card-prepare",{card:m.card,group:String(f.group)},401);
  await f.post("card-prepare",{session:m.session,card:m.card,group:String(f.group)},403);
  await f.post("card-prepare",{session:cashier.session,card:m.card,group:String(f.group)});
  const checkout={group:String(f.group),store:String(f.shop.publicKey),amount:1};
  const payment=target=>f.tx(spend(f.program,info.address,f.group,target,1,f.day(),0));
  await f.post("card-sign",{card:m.card,pin:f.pin,checkout,tx:payment(f.shop.publicKey).encoded});
  for(const target of [m.address,info.address])await f.post("card-sign",{card:m.card,pin:f.pin,checkout:{...checkout,store:target},tx:payment(target).encoded},403);
  await f.post("card-sign",{card:m.card,pin:f.pin,checkout,tx:f.tx(transfer(f.program,info.address,f.group,f.shop.publicKey,[{origin:f.group,amount:1n}])).encoded},401);
  f.ok(f.send([endMembership(f.program,m.pair.publicKey,f.group,m.pair.publicKey,false)],m.pair));
  await f.post("card-sign",{card:m.card,pin:f.pin,checkout,tx:payment(f.shop.publicKey).encoded},403);
});

test("card preparation returns the latest carried quota only to the authenticated cashier",async t=>{
  const f=await fixture(t),m=await f.member("paper"),cashier=await f.member("phantom",f.shop);
  const info=await f.post("card-info",{card:m.card});
  const body={session:cashier.session,card:m.card,group:String(f.group)};
  for(const [day,spent] of [[Number(f.day()),6],[Number(f.day()),8],[null,null]]) {
    await f.db.prepare("UPDATE members SET carried_day=?,carried_spent=? WHERE id=?").bind(day,spent,m.id).run();
    const prepared=await f.post("card-prepare",body);
    assert.equal(prepared.carriedDay,day);
    assert.equal(prepared.carriedSpent,Number(spent || 0));
    assert.deepEqual(await f.post("card-info",{card:m.card}),{address:info.address});
  }
});

test("sender join and card preparation reject Base58 groups of the wrong byte length before RPC",async t=>{
  const f=await fixture(t),m=await f.member("paper"),cashier=await f.member("phantom",f.shop);
  await f.post("session",{session:cashier.session});
  await f.post("card-info",{card:m.card});
  f.offline(true);
  for(const group of [bs58.encode(Buffer.alloc(31,255)),bs58.encode(Buffer.alloc(33,1)),"1".repeat(33),"0".repeat(32)]) {
    await f.post("sender-join",{session:cashier.session,group},400);
    await f.post("card-prepare",{session:cashier.session,card:m.card,group},400);
  }
});

test("rotation enforces PIN and 30 days, preserves session and quota, recovers old accounts and retries failures",async t=>{
  const f=await fixture(t),m=await f.member();f.setPerson(m.address,2);
  const {profile}=await f.post("session",{session:m.session}),old=profile.senderAddress;
  await f.post("sender-rotate",{session:m.session,pin:"000000"},401);
  await f.post("sender-rotate",{session:m.session,pin:f.pin},409);
  await f.db.prepare("UPDATE members SET sender_rotated_at=? WHERE id=?").bind(f.now-30*86400+60,m.id).run();
  await f.post("sender-rotate",{session:m.session,pin:f.pin},409);
  await f.post("sender-join",{session:m.session,group:String(f.group)});f.setPerson(old,3,2n);
  await f.db.prepare("UPDATE members SET sender_rotated_at=? WHERE id=?").bind(f.now-30*86400,m.id).run();
  f.offline(true);await f.post("sender-rotate",{session:m.session,pin:f.pin},503);assert.equal((await f.get(m.id)).sender_address,old);f.offline(false);
  f.failClose(true);
  const rotated=await f.post("sender-rotate",{session:m.session,pin:f.pin});
  assert.notEqual(rotated.profile.senderAddress,old);assert.equal(rotated.profile.carriedSpent,5);assert.equal((await f.get(m.id)).revision,1);
  assert.deepEqual((await f.post("session",{session:m.session})).profile,rotated.profile);
  const pending=await f.db.prepare("SELECT * FROM retired_sender_accounts").all();assert.equal(pending.results.length,2);assert.ok(pending.results.every(r=>r.target_address===old && !Object.hasOwn(r,"member_id")));
  f.failClose(false);const balance=f.account(f.authority.publicKey).lamports;
  await f.post("sender-cleanup",{session:m.session});
  assert.equal((await f.db.prepare("SELECT count(*) n FROM retired_sender_accounts").first()).n,0);
  assert.equal(f.account(addr(f.program,"p3",old)).exists,false);assert.equal(f.account(addr(f.program,"m3",f.group,old)).exists,false);
  assert.ok(f.account(f.authority.publicKey).lamports>balance);
  const over=f.tx(spend(f.program,rotated.profile.senderAddress,f.group,f.shop.publicKey,6,f.day(),0));await f.post("sign",{session:m.session,tx:over.encoded},409);
});

test("WARA notes require the main signature while iine notes require the sender signature",async t=>{
  const f=await fixture(t),m=await f.member("paper");
  const {profile}=await f.post("session",{session:m.session});
  const tx=f.tx(transfer(f.program,m.address,f.group,f.shop.publicKey,[{origin:f.group,amount:1n}]));
  tx.raw.partialSign(m.pair);
  await f.post("payment-note",{session:m.session,note:"WARAのお礼",tx:tx.raw.serialize({requireAllSignatures:false}).toString("base64")});
  const payerSig=bs58.encode(tx.raw.signatures.find(s=>String(s.publicKey)===m.address).signature);
  const saved=await f.db.prepare("SELECT * FROM payment_notes WHERE payer_signature=?").bind(payerSig).first();
  assert.equal(saved.note,"WARAのお礼");
  const old=f.tx(spend(f.program,m.address,f.group,f.shop.publicKey,1,f.day(),0));old.raw.partialSign(m.pair);
  await f.post("payment-note",{session:m.session,note:"wrong actor",tx:old.raw.serialize({requireAllSignatures:false}).toString("base64")},400);
  const cashier=await f.member("phantom",f.shop);tx.raw.partialSign(f.authority);
  const signature=bs58.encode(tx.raw.signature);f.sent.set(signature,tx.raw);
  await f.db.prepare("INSERT INTO relay_receipts VALUES(?,?)").bind(payerSig,signature).run();
  assert.deepEqual(await f.post("payment-notes",{session:cashier.session,receipts:[{sig:signature,payerSignature:payerSig}]}),{notes:[{sig:signature,note:"WARAのお礼"}]});
  assert.notEqual(profile.senderAddress,m.address);
});

test("rotation waits for issued signature expiry and serializes concurrent updates without a quota reset",async t=>{
  const f=await fixture(t),m=await f.member();const {profile}=await f.post("session",{session:m.session});
  await f.post("sender-join",{session:m.session,group:String(f.group)});
  const tx=f.tx(spend(f.program,profile.senderAddress,f.group,f.shop.publicKey,1,f.day(),0));
  await f.post("sign",{session:m.session,tx:tx.encoded});
  await f.db.prepare("UPDATE members SET sender_rotated_at=? WHERE id=?").bind(f.now-31*86400,m.id).run();
  assert.match((await f.post("sender-rotate",{session:m.session,pin:f.pin},409)).error,/有効期限/);
  f.svm.expireBlockhash();
  const result=await f.post("sender-rotate",{session:m.session,pin:f.pin});
  assert.notEqual(result.profile.senderAddress,profile.senderAddress);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM wallet_tickets WHERE purpose='sender-signed'").first()).n,0);
  await f.db.prepare("UPDATE members SET sender_rotated_at=? WHERE id=?").bind(f.now-31*86400,m.id).run();
  const request=()=>f.post("sender-rotate",{session:m.session,pin:f.pin},null);
  const concurrent=await Promise.all([request(),request()]);
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
  assert.equal((await f.get(m.id)).revision,1);
});


test("a superseded D1 lease cannot issue a signature, rotate, or release its successor's lock",async t=>{
  const f=await fixture(t),m=await f.member();
  const {profile}=await f.post("session",{session:m.session});
  const tx=f.tx(spend(f.program,profile.senderAddress,f.group,f.shop.publicKey,1,f.day(),0));
  f.stealLease();await f.post("sign",{session:m.session,tx:tx.encoded},409);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM wallet_tickets WHERE purpose='sender-signed'").first()).n,0);
  assert.equal((await f.db.prepare("SELECT detail FROM wallet_tickets WHERE purpose='sender-lock'").first()).detail,"successor");
  await f.db.prepare("DELETE FROM wallet_tickets WHERE purpose='sender-lock'").run();
  await f.db.prepare("UPDATE members SET sender_rotated_at=? WHERE id=?").bind(f.now-31*86400,m.id).run();
  f.stealLease();await f.post("sender-rotate",{session:m.session,pin:f.pin},409);
  assert.equal((await f.get(m.id)).sender_address,profile.senderAddress);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM retired_sender_accounts").first()).n,0);
  assert.equal((await f.db.prepare("SELECT detail FROM wallet_tickets WHERE purpose='sender-lock'").first()).detail,"successor");
});
