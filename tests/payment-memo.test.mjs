import test from "node:test";
import assert from "node:assert/strict";
import {Keypair, Transaction, TransactionMessage} from "@solana/web3.js";
import {budgetInstructions} from "../app/protocol.mjs";
import {entries, storyReceipt} from "../mainstream/history.mjs";
import {program} from "../mainstream/network.mjs";
import {spend} from "../mainstream/protocol.mjs";
import {memoInstruction, paymentMemo, readPaymentMemo} from "../shared/payment-memo.mjs";
import {ordinaryMessage} from "../worker/member-transactions.mjs";

const [buyer,group,shop] = Array.from({length:3},()=>Keypair.generate().publicKey);
const message = "ごちそうさま！ 😋 <3";
const checkout = {group:String(group),store:String(shop),amount:1,memo:message};
const instructions = () => [budgetInstructions()[1],...spend(program,buyer,group,shop,1n,2n,0n,message)];
const makeTx = i => new Transaction({feePayer:buyer,recentBlockhash:String(group)}).add(...i);
const raw = ix => makeTx(ix).serialize({requireAllSignatures:false});

test("memo is bound to a single INA instruction and the paper customer's confirmation",()=>{
  const ix = instructions();
  assert.equal(ordinaryMessage(raw(ix),String(buyer),"card",checkout),true);
  assert.equal(ordinaryMessage(raw(ix),String(buyer),"card",{...checkout,memo:"別の内容"}),false);
  const noMemo = ix.filter(i=>i!==ix.at(-2));
  assert.equal(ordinaryMessage(raw(noMemo),String(buyer),"card",checkout),false);
  for(const invalid of [Buffer.alloc(241,65),Buffer.from([255]),Buffer.from("x\ny")]){
    const bad=instructions(); bad.at(-2).data=invalid;
    assert.equal(ordinaryMessage(raw(bad),String(buyer),"session",null),false);
  }
  const multiple=instructions(); multiple.splice(-1,0,memoInstruction(message));
  assert.equal(ordinaryMessage(raw(multiple),String(buyer),"session",null),false);
  const accounts=instructions(); accounts.at(-2).keys.push({pubkey:buyer,isSigner:true,isWritable:false});
  assert.equal(ordinaryMessage(raw(accounts),String(buyer),"session",null),false);
  assert.equal(paymentMemo(" 🌾 "),"🌾");assert.equal(readPaymentMemo(Buffer.from("🌾".repeat(60))),"🌾".repeat(60));
  assert.throws(()=>paymentMemo("🌾".repeat(61)));
});

test("buyer and store render the confirmed memo as escaped text in legacy and v0 receipts",()=>{
  const tx=makeTx(instructions());
  const versioned=new TransactionMessage({payerKey:buyer,recentBlockhash:String(group),instructions:tx.instructions}).compileToV0Message();
  for(const compiled of [tx.compileMessage(),versioned]) for(const [reader,id] of [[buyer,null],[shop,String(group)]]){
    const [row]=entries({meta:{err:null},transaction:{message:compiled}},"sig",String(reader),id);
    assert.equal(row.memo,message);
    const html=storyReceipt(row,x=>String(x).replaceAll("<","&lt;"),()=>null,()=>"コーヒー屋");
    assert.match(html,/receipt-memo/);assert.match(html,/😋 &lt;3/);
  }
});
