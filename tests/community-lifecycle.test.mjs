import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { getTransactionDecoder } from "@solana/kit";
import bs58 from "bs58";
import { program } from "../mainstream/network.mjs";
import { addr, mintFor, parseRow, join } from "../mainstream/protocol.mjs";
import { makePolicy, privateGroupView, codeKey, invitationUrl, parseInvitation, pendingInvite } from "../mainstream/community-privacy.mjs";
import { communityOpening, communityUpdate } from "../shared/community-metadata.mjs";
import { communityMetadata } from "../worker/community-metadata.mjs";
import { relayPayment } from "../worker/relay.mjs";
import { budgetInstructions, DEVNET_GENESIS } from "../app/protocol.mjs";
import { confirmedMessage, ordinaryMessage } from "../worker/member-transactions.mjs";
import { metadataAddress, METADATA_PROGRAM } from "../scripts/token-metadata.mjs";

const binary = process.env.METADATA_PROGRAM_SO || "private/metaplex-token-metadata.so";
const key = () => Keypair.generate(), generate = () => bs58.encode(key().secretKey.slice(0,32));
const ok = r => assert.ok(!(r instanceof FailedTransactionMetadata), r.toString());
const rejected = r => assert.ok(r instanceof FailedTransactionMetadata);
function storage(t) {
  for (const prop of ["localStorage","sessionStorage"]) {
    const old = Object.getOwnPropertyDescriptor(globalThis, prop), map = new Map();
    Object.defineProperty(globalThis, prop, {configurable:true,value:{
      getItem:k=>map.get(k)??null, setItem:(k,v)=>map.set(k,v), removeItem:k=>map.delete(k)
    }});
    t.after(()=>old ? Object.defineProperty(globalThis,prop,old) : delete globalThis[prop]);
  }
}

for (const visibility of ["public", "private"]) for (const mode of [0,1,2])
  test(visibility + " × mode " + mode + ": opening, admission and policy rotation", {skip:!existsSync(binary)}, async t => {
    storage(t);
    const svm = new LiteSVM();
    svm.addProgramFromFile(String(program), "target/deploy/straw_protocol.so");
    svm.addProgramFromFile(String(METADATA_PROGRAM), binary);
    const owner = key(), group = key(), guest = key(), outsider = key(), sponsor = key();
    const id = String(group.publicKey), who = owner.publicKey, user = guest.publicKey;
    for (const k of [owner,guest,outsider,sponsor]) svm.airdrop(String(k.publicKey),2_000_000_000n);
    const policy = (vis, m) => makePolicy({visibility:vis,mode:m,name:"春の町",description:"集会所",category:"地域"},id,who,generate);
    const send = (ix, ...signers) => {
      svm.expireBlockhash();
      const tx = new Transaction({feePayer:signers[0].publicKey,recentBlockhash:svm.latestBlockhash()}).add(...ix);
      tx.sign(...signers);
      return svm.sendTransaction(getTransactionDecoder().decode(tx.serialize()));
    };
    const raw = k => Buffer.from(svm.getAccount(String(k)).data);
    const row = () => parseRow(raw(id),id);
    const membership = k => raw(addr(program,"m3",id,k))[65];
    const enter = (k, code) => {
      const inv = code && codeKey(code);
      return send([join(program,k.publicKey,id,k.publicKey,false,inv?.publicKey)],k,...(inv?[inv]:[]));
    };
    const p = await policy(visibility,mode), hidden = visibility === "private";
    const opening = communityOpening(program,who,id,mode,p.invite,p.bytes,
      Number(svm.minimumBalanceForRentExemption(BigInt(66+p.bytes.length))));
    ok(send([...budgetInstructions(),...opening],owner,group));
    const mint = mintFor(program,id), md = metadataAddress(mint);
    const mintBefore = raw(mint), tokenBefore = raw(md);
    assert.deepEqual([row().visibility,row().mode],[visibility,mode]);
    const rpc = {getProgramAccounts:async()=>[{pubkey:group.publicKey}],getAccountInfo:async k=>{
      const a=svm.getAccount(String(k)); return a.exists ? {owner:new PublicKey(a.programAddress),data:Buffer.from(a.data)} : null;
    }};
    const endpoint = new Request("https://wara.monku.ai/api/v3/metadata/"+mint+".json");
    let found, lookups=0;
    rpc.getProgramAccounts = async () => { lookups++; return [{pubkey:group.publicKey}]; };
    t.mock.method(globalThis, "fetch", () => { throw Error("unexpected network access"); });
    const original=Object.getOwnPropertyDescriptor(globalThis,"caches");
    Object.defineProperty(globalThis,"caches",{configurable:true,value:{default:{
      match:async()=>found?.clone(),put:async(_key,response)=>{found=response;}
    }}});
    t.after(()=>original?Object.defineProperty(globalThis,"caches",original):delete globalThis.caches);
    const ctx={waitUntil:()=>{}};
    assert.equal((await (await communityMetadata(endpoint,{},ctx,rpc)).json()).attributes.at(-1).value,hidden?"Private":"Public");
    let linkCode = null;
    if (p.code) {
      const link = new URL(invitationUrl(id,p.code));
      assert.equal(link.search,"");
      linkCode = parseInvitation(link.hash).code;
      if (hidden) {
        assert.equal(await privateGroupView(row(),String(user),[]), null);
        sessionStorage.setItem(pendingInvite(id),linkCode);
        assert.equal((await privateGroupView(row(),String(user),[])).name,"春の町");
      }
    }
    if (mode===1) rejected(enter(guest,null));
    ok(enter(guest,mode===1 ? linkCode : null));
    assert.equal(membership(user), mode===2 ? 1 : 2);

    // Flip visibility and enter invitation mode. No existing token or member
    // account is writable. Test the same canonical message accepted by relay.
    const next = await policy(hidden ? "public" : "private",1);
    const change = (actor,old,newPolicy) => communityUpdate(program,actor,id,old.mode,old.invite,
      newPolicy.mode,newPolicy.invite,newPolicy.bytes);
    rejected(send([change(outsider.publicKey,p,next)],outsider));
    const update = change(who,p,next);
    const tx = new Transaction({feePayer:sponsor.publicKey,recentBlockhash:svm.latestBlockhash()})
      .add(...budgetInstructions(),update);
    const input = tx.serialize({requireAllSignatures:false});
    assert.equal(confirmedMessage(input,String(who),sponsor.publicKey),true);
    assert.equal(ordinaryMessage(input,String(who),"session",null,sponsor.publicKey),false);
    tx.partialSign(owner);
    const relayRpc = {...rpc, getGenesisHash:async()=>DEVNET_GENESIS, isBlockhashValid:async()=>({value:true}),
      simulateTransaction:async signed=>{
        const result=svm.simulateTransaction(getTransactionDecoder().decode(signed.serialize()));
        return {value:{err:result instanceof FailedTransactionMetadata ? result.toString() : null}};
      },
      sendRawTransaction:async raw=>ok(svm.sendTransaction(getTransactionDecoder().decode(raw)))
    };
    await relayPayment({encoded:tx.serialize({requireAllSignatures:false}).toString("base64"),sponsor,member:String(who),
      rpc:relayRpc,receipts:{find:async()=>null,insert:async()=>true},reserveBudget:async()=>{},fail:(_s,m)=>assert.fail(m)});
    rejected(send([update],owner)); // stale settings
    if (p.code) rejected(enter(outsider,p.code));
    if (mode===2) { // formerly pending: must satisfy the new admission policy
      rejected(enter(guest,null)); ok(enter(guest,next.code));
    }
    assert.equal(membership(user),2);

    const rotated = await policy(hidden ? "public" : "private",1);
    ok(send([change(who,next,rotated)],owner));
    rejected(enter(outsider,next.code));
    ok(enter(outsider,rotated.code));
    const approval = await policy(hidden ? "public" : "private",2);
    ok(send([change(who,rotated,approval)],owner));
    const applicant = key(); svm.airdrop(String(applicant.publicKey),1_000_000_000n);
    ok(enter(applicant,null)); assert.equal(membership(applicant.publicKey),1);
    ok(send([join(program,who,id,applicant.publicKey,true)],owner));
    const open = await policy(hidden ? "public" : "private",0);
    ok(send([change(who,approval,open)],owner));
    assert.equal(membership(applicant.publicKey),2);
    assert.deepEqual(raw(mint),mintBefore); assert.deepEqual(raw(md),tokenBefore);
    const response=await communityMetadata(endpoint,{},ctx,rpc);
    const display=await response.json();
    assert.equal(lookups,1);
    // Originally private keeps WARA as its registered name even when listed;
    // formerly public is masked in the current directory without rewriting its token.
    assert.equal(display.name,"WARA"); assert.equal(display.attributes.at(-1).value,hidden?"Public":"Private");
  });
