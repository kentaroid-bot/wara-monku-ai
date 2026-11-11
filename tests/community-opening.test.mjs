import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { getTransactionDecoder } from "@solana/kit";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { budgetInstructions, DEVNET_GENESIS } from "../app/protocol.mjs";
import { metadata, mintFor, parseRow, join } from "../mainstream/protocol.mjs";
import { codeKey, invitationUrl, parseInvitation, privateMetadata, privateGroupView, pendingInvite } from "../mainstream/community-privacy.mjs";
import { communityOpening, tokenFields, avatar } from "../shared/community-metadata.mjs";
import { program } from "../mainstream/network.mjs";
import { metadataAddress, METADATA_PROGRAM, decodeMetadata } from "../scripts/token-metadata.mjs";
import { rentShortfall, sponsoredInstructions } from "../shared/sponsorship.mjs";
import { confirmedMessage, ordinaryMessage } from "../worker/member-transactions.mjs";
import { relayPayment } from "../worker/relay.mjs";
import { communityMetadata } from "../worker/community-metadata.mjs";
import worker from "../worker/index.mjs";

const binary = process.env.METADATA_PROGRAM_SO || "private/metaplex-token-metadata.so";
const pair = () => Keypair.generate();
const request = mint => new Request("https://wara.monku.ai/api/v3/metadata/" + mint + ".json");

test("metadata route rejects malformed mints without auth and validates UTF-8 token names", async () => {
  const res = await worker.fetch(request("invalid!"), {});
  assert.equal(res.status,400);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"),"*");
  assert.equal(tokenFields(program,{name:"稲".repeat(9)}).name,"稲".repeat(9)+" WARA");
  assert.throws(() => tokenFields(program,{name:"稲".repeat(10)}));
});

for (const hidden of [false,true]) test((hidden ? "private" : "public") + " opening atomically registers metadata through the fee relay", {skip:!existsSync(binary)}, async t => {
  const svm = new LiteSVM(), owner = pair(), group = pair(), sponsor = pair(), guest = pair();
  svm.addProgramFromFile(String(program),"target/deploy/straw_protocol.so");
  svm.addProgramFromFile(String(METADATA_PROGRAM),binary);
  for (const k of [owner,sponsor,guest]) svm.airdrop(String(k.publicKey),1_000_000_000n);
  const groupId = String(group.publicKey), code = bs58.encode(pair().secretKey.slice(0,32));
  const name = hidden ? "テスト家族" : "秋の市場";
  const bytes = hidden ? await privateMetadata(name,"秘密の説明","地域",code,groupId) : metadata(name,"秋の催し","地域");
  const minimum = size => Number(svm.minimumBalanceForRentExemption(BigInt(size)));
  const mint = mintFor(program,group.publicKey);
  const creation = communityOpening(program,owner.publicKey,group.publicKey,hidden?1:0,
    hidden?codeKey(code).publicKey:owner.publicKey,bytes,minimum(66+bytes.length));
  const base = [...budgetInstructions(),...creation];
  const rpc = {
    getAccountInfo: async pub => {
      const a = svm.getAccount(String(pub));
      return a.exists ? {owner:new PublicKey(a.programAddress),data:Buffer.from(a.data),lamports:Number(a.lamports)} : null;
    },
    getMinimumBalanceForRentExemption:minimum,
    getProgramAccounts:async () => [{pubkey:group.publicKey}],
    getGenesisHash:async () => DEVNET_GENESIS, isBlockhashValid:async () => ({value:true}),
    simulateTransaction:async tx => {
      const result = svm.simulateTransaction(getTransactionDecoder().decode(tx.serialize()));
      assert.ok(!(result instanceof FailedTransactionMetadata),result.toString());
      return {value:{err:null}};
    },
    sendRawTransaction:async raw => {
      const result = svm.sendTransaction(getTransactionDecoder().decode(raw));
      assert.ok(!(result instanceof FailedTransactionMetadata), result.toString());
    },
  };
  const dust = hidden ? minimum(0) : 0;
  if (dust) {
    const deposit = new Transaction({feePayer:guest.publicKey,recentBlockhash:svm.latestBlockhash()})
      .add(SystemProgram.transfer({fromPubkey:guest.publicKey,toPubkey:metadataAddress(mint),lamports:dust}));
    deposit.sign(guest);
    await rpc.sendRawTransaction(deposit.serialize());
  }
  const rent = await rentShortfall(rpc,creation.at(-1));
  assert.equal(rent,minimum(607));
  const open = new Transaction({feePayer:sponsor.publicKey,recentBlockhash:svm.latestBlockhash()})
    .add(...sponsoredInstructions(base,sponsor.publicKey,rent));
  open.partialSign(owner,group);
  const raw = open.serialize({requireAllSignatures:false});
  assert.equal(ordinaryMessage(raw,String(owner.publicKey),"session",null,sponsor.publicKey),false);
  assert.equal(confirmedMessage(raw,String(owner.publicKey),sponsor.publicKey),true);
  const self = new Transaction({feePayer:owner.publicKey,recentBlockhash:svm.latestBlockhash()}).add(...base);
  assert.equal(confirmedMessage(self.serialize({requireAllSignatures:false}),String(owner.publicKey)),true);
  const wrong = Transaction.from(raw);
  wrong.instructions.at(-1).data = Buffer.from(wrong.instructions.at(-1).data);
  wrong.instructions.at(-1).data[wrong.instructions.at(-1).data.length-1] ^= 1;
  assert.equal(confirmedMessage(wrong.serialize({requireAllSignatures:false,verifySignatures:false}),String(owner.publicKey),sponsor.publicKey),false);

  const diverted = Transaction.from(raw);
  // Only the creator charged by CreateV1 may receive the atomic rent reimbursement.
  diverted.instructions[2].keys[1].pubkey = guest.publicKey;
  assert.equal(confirmedMessage(diverted.serialize({requireAllSignatures:false,verifySignatures:false}),String(owner.publicKey),sponsor.publicKey),false);

  const receiptLog = new Map();
  let budget = 0;
  const relay = () => relayPayment({ encoded:raw.toString("base64"), sponsor, member:String(owner.publicKey), rpc,
    receipts:{find:key=>receiptLog.get(key),insert:(key,sig)=>{receiptLog.set(key,sig);return true;}},
    reserveBudget:async()=>{budget++;}, fail:(status,msg)=>{throw Error(status+" "+msg);}});
  const startBalance = (await rpc.getAccountInfo(owner.publicKey)).lamports;
  const first = await relay();
  assert.deepEqual(await relay(),first);
  assert.equal(budget,1);
  const groupAccount=await rpc.getAccountInfo(group.publicKey);
  const md=await rpc.getAccountInfo(metadataAddress(mint));
  const expectedName=hidden?"WARA":name+" WARA";
  assert.equal(decodeMetadata(md.data).name,expectedName);
  assert.equal(decodeMetadata(md.data).uri,request(mint).url);
  assert.equal(startBalance-(await rpc.getAccountInfo(owner.publicKey)).lamports,
    groupAccount.lamports+(await rpc.getAccountInfo(mint)).lamports+md.lamports-dust-rent);
  const res=await communityMetadata(request(mint),{},null,rpc);
  assert.equal(res.status,200);
  assert.match(res.headers.get("Cache-Control"),/public/);
  const body=await res.json();
  assert.equal(body.image,avatar);assert.equal(body.name,expectedName);assert.equal(body.symbol,"WARA");
  assert.equal(body.attributes.at(-1).value,hidden?"Private":"Public");
  assert.equal((await communityMetadata(request(guest.publicKey),{},null,rpc)).status,404);
  if (!hidden) return;
  for (const text of [name,"秘密の説明",code]) {
    assert.ok(!groupAccount.data.includes(Buffer.from(text)));
    assert.ok(!JSON.stringify(body).includes(text));
  }
  const row=parseRow(groupAccount.data,groupId);
  for (const key of ["localStorage","sessionStorage"]) {
    const old=Object.getOwnPropertyDescriptor(globalThis,key), values=new Map();
    Object.defineProperty(globalThis,key,{configurable:true,value:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}});
    t.after(()=> old ? Object.defineProperty(globalThis,key,old) : delete globalThis[key]);
  }
  const who=String(guest.publicKey);
  assert.equal(await privateGroupView(row,who,[]),null);
  sessionStorage.setItem(pendingInvite(groupId),bs58.encode(pair().secretKey.slice(0,32)));
  assert.equal(await privateGroupView(row,who,[]),null);
  const link=new URL(invitationUrl(groupId,code));
  assert.equal(link.search,"");
  assert.deepEqual(parseInvitation(link.hash),{group:groupId,code});
  sessionStorage.setItem(pendingInvite(groupId),code);
  assert.equal((await privateGroupView(row,who,[])).name,name);
  const enter = invite => {
    svm.expireBlockhash();
    const tx=new Transaction({feePayer:guest.publicKey,recentBlockhash:svm.latestBlockhash()})
      .add(join(program,who,groupId,who,false,invite?.publicKey));
    tx.sign(guest,...(invite?[invite]:[]));
    return svm.sendTransaction(getTransactionDecoder().decode(tx.serialize()));
  };
  assert.ok(enter() instanceof FailedTransactionMetadata);
  assert.ok(enter(pair()) instanceof FailedTransactionMetadata);
  assert.ok(!(enter(codeKey(code)) instanceof FailedTransactionMetadata));
  const membership=[{tag:33,group:groupId,to:who,status:2}];
  assert.ok((await privateGroupView(row,who,membership)).joined);
  assert.equal(sessionStorage.getItem(pendingInvite(groupId)),null);
  assert.equal((await privateGroupView(row,who,membership)).description,"秘密の説明");
});
